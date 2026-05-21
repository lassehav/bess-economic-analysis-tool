# Phase 3 — Daily simulation engine

**Effort:** 3 days
**Goal:** Roll the per-day window detector from Phase 1 forward across the full project lifetime, applying the MDC dispatch gate and the simplified non-linear degradation model. Produce the `AnnualStream[]` consumed by the economics core.

## Engine boundary

```
            inputs (Inputs from Phase 2)
                          │
                          ▼
            daily price parameters
            (one entry per day across project life;
             produced by Phase 4's scenario engine,
             or by replaying historical days for backtest)
                          │
                          ▼
            ┌────────────────────────────────┐
            │   daily simulation loop        │
            │   per day:                     │
            │     extractWindows(...)        │  ← Phase 1 algorithm
            │     compute MDC                │
            │     dispatch gate              │
            │     accumulate revenue, EFC    │
            │     update SoH                 │
            │     check retirement           │
            └────────────────────────────────┘
                          │
                          ▼
            AnnualStream[]
            (consumed by Phase 2 economics)
```

The simulation is fully deterministic given its inputs. Stochasticity lives upstream in Phase 4's scenario / Monte Carlo layer.

## Input contracts

### `DailyPriceParams`

Phase 4 produces a `DailyPriceParams[]` of length `projectLifeYears × 365` (or 366 for leap years; the engine just treats years uniformly as 365 days for simplicity — this rounding is negligible vs. forecast uncertainty).

```ts
// src/core/types/streams.ts
export type DailyPriceParams = {
  yearIndex: number;                 // 1..projectLifeYears
  dayOfYear: number;                 // 1..365
  // Hourly prices for the day. The engine still needs the 24-hour shape to
  // run extractWindows. Phase 4 generates these from the scenario's daily-level
  // parameters by sampling a representative diurnal shape and rescaling.
  hourlyPrices: number[];           // length 24
  // Reference value used by the engine for the average grid price that year
  // (passed through to support reporting and Phase 4 calibration checks).
  dayMeanPrice: number;
};
```

**Why hourly prices appear here despite the daily-resolution philosophy:** the window-detection algorithm needs a price shape to identify charge/discharge blocks. Phase 4 does not forecast hourly prices — it generates a synthetic *daily-level shape* per day from the scenario's distributional parameters plus a stochastic component, calibrated to historical diurnal patterns. The engine then treats the resulting 24 numbers as the day's price profile. This keeps the dispatch logic identical between historical-replay mode and scenario-projection mode.

### `Inputs`

The same `Inputs` object from Phase 2 (battery + costs + finance).

## Engine state

```ts
// src/core/dispatch/state.ts
type EngineState = {
  cumulativeEFC: number;
  ageDays: number;
  sohAtStartOfDay: number;          // updated daily
  retired: boolean;
  // accumulators reset each year
  yearAccumulator: {
    revenue: number;
    throughputMWh: number;
    cyclesEFC: number;
    sohSamples: number[];           // for year-average capacity
    dayCount: number;
  };
};
```

## Daily step

```ts
// src/core/dispatch/dailyStep.ts

export function runDailyStep(
  state: EngineState,
  day: DailyPriceParams,
  inputs: Inputs,
): EngineState;
```

### Algorithm

1. **Skip if retired.** If `state.retired`, return state with `ageDays + 1` (calendar aging continues but is moot for retired systems).
2. **Run window detection** using Phase 1's `extractDailyStats` with `state.sohAtStartOfDay` applied to the battery's effective energy:
   ```ts
   const effectiveBattery = {
     ...inputs.battery,
     energyMWh: inputs.battery.energyMWh * state.sohAtStartOfDay,
   };
   const daily = extractDailyStats(day.hourlyPrices, day.startUtc, effectiveBattery);
   ```
3. **Compute MDC.**
   ```
   remaining_throughput_MWh =
       inputs.battery.energyMWh × state.sohAtStartOfDay × inputs.battery.dod
       × max(0, nominalCycleLifeEFC × (sohAtStartOfDay − endOfLifeSoH) / (1 − endOfLifeSoH) − cumulativeEFC)
   ```
   `MDC = capex.total / remaining_throughput_MWh`
   - The remaining-throughput formula is a linear interpolation: the battery has `nominalCycleLifeEFC` worth of throughput between SoH = 1.0 and SoH = `endOfLifeSoH`, and we project linearly how much is left.
   - If the denominator is zero or negative (the battery is at or past EoL by SoH definition), MDC → ∞ and no window will pass the gate.
4. **Apply MDC gate per window.** Iterate windows sorted by `effectiveMargin` descending:
   ```
   threshold = MDC × activationThreshold
   for w in daily.windows.sortedDescByEffectiveMargin():
       if (w.effectiveMargin > threshold) and (windows_taken < maxCyclesPerDay):
           accept w
       else:
           break  // sorted, so done
   ```
5. **Accumulate day's contribution.** For each accepted window:
   ```
   day_revenue += w.effectiveEnergyMWh × w.effectiveMargin    // €
   day_throughput += w.effectiveEnergyMWh                      // MWh discharged
   day_EFC += w.effectiveEFC
   ```
6. **Apply degradation.** Compute today's effective cycles-per-day:
   ```
   cpd_today = number_of_accepted_windows  (0, 1, 2, or 3)
   ```
   Apply the simplified model:
   ```
   loss_calendar_today = (1 − endOfLifeSoH) / (calendarLifeYears × 365)
   loss_cycle_today    = (1 − endOfLifeSoH) × (day_EFC / nominalCycleLifeEFC)
                         × (max(cpd_today, 1) / 1)^cyclesPerDayPenaltyExponent
   ```
   Note `max(cpd_today, 1)` ensures days with no cycles don't get a fractional penalty boost; if `cpd_today = 0` then `day_EFC = 0` anyway, so this is mostly defensive.
   ```
   state.sohAtStartOfDay -= (loss_calendar_today + loss_cycle_today)
   ```
7. **Check retirement.** If `state.sohAtStartOfDay < endOfLifeSoH`, mark `state.retired = true` and stop generating revenue for subsequent days. The retirement happens immediately, mid-year if applicable.
8. **Update accumulators and counters.**
   ```
   state.cumulativeEFC += day_EFC
   state.ageDays += 1
   yearAccumulator.{revenue, throughputMWh, cyclesEFC} += today
   yearAccumulator.sohSamples.push(state.sohAtStartOfDay)
   yearAccumulator.dayCount += 1
   ```

### Year boundary

At day 365 of each year (or at retirement):

```ts
// src/core/dispatch/yearClose.ts
function closeYear(state: EngineState, yearIndex: number, inputs: Inputs): AnnualStream {
  const avgSoH = mean(state.yearAccumulator.sohSamples);
  return {
    year: yearIndex,
    grossRevenue: state.yearAccumulator.revenue,
    throughputMWh: state.yearAccumulator.throughputMWh,
    cyclesEFC: state.yearAccumulator.cyclesEFC,
    endOfYearSoH: state.sohAtStartOfDay,
    capacityMWh: inputs.battery.energyMWh * avgSoH * inputs.battery.dod,
    retired: state.retired,
  };
}
```

Then reset `yearAccumulator` and continue.

## Engine entry point

```ts
// src/core/dispatch/engine.ts

export type EngineOptions = {
  rngSeed?: number;                  // optional, for reproducibility when Phase 4 injects stochastic days
};

export function runProjectSimulation(
  inputs: Inputs,
  days: DailyPriceParams[],          // length = projectLifeYears × 365
  options?: EngineOptions,
): {
  streams: AnnualStream[];           // length = projectLifeYears
  retiredAtYear: number | null;      // year in which retirement occurred
  retiredAtDay: number | null;       // day-within-year of retirement
};
```

### Cross-day SoC

Phase 1 simulates SoC within a single day starting from `initialSocMWh`. For the multi-day engine, **SoC is reset to 0 at the start of each day**. Rationale: the daily-resolution philosophy treats each day as independent for dispatch; carrying SoC across days would re-introduce the kind of hourly path dependence the model rejects. The economics impact of this simplification is small for daily-arbitrage-only operation, where most days fully cycle and end at the same starting state.

If the user later wants weekly carry-over (e.g. for a "fill the battery on Sunday, discharge through the week" pattern), it can be added as a Phase 4 scenario refinement. Not in scope here.

## Historical-replay mode

For backtest / sanity checks, the engine also runs against the historical price series directly without any scenario layer.

```ts
// src/core/dispatch/historical.ts

export function buildHistoricalDays(
  prices: PriceSeries,
  startUtc: string,
  yearCount: number,
): DailyPriceParams[];
```

Slices the historical price series into 365-day chunks starting at `startUtc`. If `yearCount × 365` exceeds the available history, the remaining days are taken from the beginning of the series (cyclic) — with a warning surfaced in the UI.

A user choosing historical replay sees what the configured battery would have earned if deployed on, e.g., 2024-01-01 with no future projection. This is a useful "what would have happened" check.

## Determinism and performance

- The engine is a pure reducer. Same inputs → same outputs.
- ~7300 day-steps per 20-year run × O(1) work per step = milliseconds total.
- No Web Workers needed at Phase 3. Phase 5 (Monte Carlo) reuses this engine in a tight loop and is still trivially fast.

## Wiring to economics

```ts
// src/features/simulation/runFull.ts
const days = phase4.buildScenarioDays(scenario, inputs);   // or buildHistoricalDays(...)
const { streams } = runProjectSimulation(inputs, days);
const financials = computeFinancials(inputs, streams);
// → display in Phase 6 results dashboard
```

## Visualisations introduced in Phase 3

A "Simulation diagnostics" view, separate from the historical explorer:

1. **SoH trajectory** over project life — line chart, with the EoL threshold and (if applicable) retirement year marked.
2. **Annual EFC stacked by `cpd_today`** — bar chart showing how many of each year's cycles came from single-window vs. multi-window days.
3. **Annual revenue and throughput** — twin bar/line chart.
4. **MDC over time** — line chart showing how the dispatch gate hardens as the battery ages.
5. **Activation rate** — % of days where at least one window passed the MDC gate, per year.
6. **Spot check** — random-day inspector identical to Phase 1's single-day view, but operating on any day of the simulated project (so the user can spot-check a day in year 12 with degraded capacity).

## Acceptance criteria

- `runDailyStep` is unit-tested:
  - Day with no profitable windows → state unchanged except `ageDays` and calendar SoH loss.
  - Day with one high-margin window → revenue, throughput, EFC update; SoH drops by the expected amount.
  - Day at `cpd = 2` shows higher per-cycle SoH loss than `cpd = 1` (factor matches `2^p`).
  - Retirement triggers correctly when SoH crosses `endOfLifeSoH`; subsequent calls leave revenue at zero.
- `runProjectSimulation` end-to-end test:
  - 20-year run on synthetic constant-spread days reproduces SoH trajectory matching the analytical degradation formula within 1e-6.
  - 20-year run on historical replay against 2024 prices produces non-zero revenue years, with retirement no earlier than year 8 at default parameters.
- All visualisations render against engine output without errors.
- Full simulation (20 years × 365 days) runs in < 50 ms on a mid-range laptop.
- The "Simulation diagnostics → SoH trajectory" chart matches a hand-computed degradation curve for a known parameter set within plotting tolerance.

## Out of scope for Phase 3

- Scenario generation — Phase 4.
- Backtest validation (calibrate 2024 → predict 2025 → compare) — Phase 4 builds on the historical-replay primitive.
- Monte Carlo — Phase 5 wraps this engine.
- Cross-day SoC, weekly cycles, complex dispatch strategies — explicitly excluded.
