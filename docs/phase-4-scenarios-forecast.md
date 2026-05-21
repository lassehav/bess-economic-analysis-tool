# Phase 4 — Scenarios & forecast

**Effort:** 5–7 days
**Goal:** Calibrate a small set of daily-level price parameters from history, define scenarios as per-year multiplier trajectories on those parameters, generate synthetic `DailyPriceParams[]` for the project lifetime, and validate the approach with a backtest mode.

This phase is the heart of the tool. It is the part most reviewed at thesis defence.

## Conceptual model

A scenario is a function:

```
scenario: (yearIndex, dayOfYear) → DailyPriceParams
```

Internally, it is built from three pieces:

1. **Historical calibration profile.** A representative diurnal shape and month-of-year level adjustment extracted from the bundled FI price data.
2. **Scenario trajectory.** Per-year multipliers and shifts applied to a small set of daily-level parameters.
3. **Stochastic component.** A residual draw that adds realistic day-to-day variability without trying to model weather.

## Calibration: historical aggregate

```ts
// src/core/forecast/calibration.ts

export type HistoricalCalibration = {
  // Mean diurnal shape — relative to daily mean — averaged across all historical days
  // within a month bucket. 12 buckets, each a 24-length vector of normalised factors
  // summing to 24 (so a flat day has all entries = 1).
  diurnalByMonth: number[][];        // [12][24]

  // Month-of-year level multipliers (relative to annual mean). 12 values summing to 12.
  monthLevel: number[];              // [12]

  // Day-of-week multipliers. 7 values summing to 7. (Optional — Phase 4 v1 can use a flat array of ones.)
  dayOfWeekLevel: number[];          // [7]

  // Annual base mean price (€/MWh). Used as the level anchor.
  annualMeanPrice: number;

  // Annual spread (mean of daily max−min) — used to anchor the residual scaling.
  annualMeanSpread: number;

  // AR(1) coefficient on log-residuals from the diurnal+monthly model. Drives persistence
  // of "expensive weeks" and "cheap weeks" in the stochastic component.
  residualAr1: number;

  // Stddev of the AR(1) innovation in log-price space.
  residualSigma: number;
};

export function calibrateFromHistory(
  prices: PriceSeries,
  windowStart: string,               // ISO date — start of calibration period
  windowEnd: string,                 // ISO date — end of calibration period (exclusive)
): HistoricalCalibration;
```

### Calibration algorithm

1. **Slice** the price series to `[windowStart, windowEnd)`. Drop incomplete months at the edges so each bucket is balanced.
2. **Compute annual mean** = mean of all hourly prices in the window.
3. **Compute month-of-year level** = for each month bucket, `mean(prices_in_month) / annualMeanPrice`. Normalise so they sum to 12.
4. **Compute day-of-week level** = same but per weekday. Normalise so they sum to 7. Optional in v1; default to all-ones if disabled.
5. **Compute diurnal shape by month** = for each month bucket: for each hour-of-day `h ∈ [0..23]`, the mean of `price[d, h] / mean(price[d, ·])` over all days `d` in that month. Normalise each row so it sums to 24.
6. **Compute residuals** = for each historical hourly price, divide out the diurnal × month × DoW factors, take the log, subtract the log-annual-mean. The residual is dimensionless.
7. **Fit AR(1)** on the daily-mean of these log-residuals via OLS: `r_t = ρ × r_{t−1} + ε_t`. Estimate `ρ` and `σ_ε`.

The calibration object is small (~600 numbers), serialisable, and deterministic given the input window.

## Daily-level scenario parameters

Each scenario shifts a small parameter vector applied per year:

```ts
// src/core/forecast/scenario.ts

export type ScenarioYearParams = {
  yearIndex: number;
  // Multiplicative level adjustment vs. calibration mean.
  // 1.10 = prices 10% higher than calibration.
  meanLevelMultiplier: number;
  // Multiplicative spread / volatility adjustment.
  // 1.30 = daily spreads 30% wider than calibration.
  spreadMultiplier: number;
  // Multiplicative on residual sigma (intraday and cross-day stochastic component).
  residualSigmaMultiplier: number;
  // Additive shift to negative-hour share. Range [−1, +1]. Negative values reduce
  // negative-price hour frequency (e.g. demand-driven tightening sets this to a
  // large negative number to zero out negative hours).
  negativeHourShareShift: number;
  // Multiplicative on peak duration (hours that the daily high-price block lasts).
  // <1 = sharper, shorter spikes; >1 = longer, flatter peaks.
  peakDurationMultiplier: number;
  // Additive bias to diurnal shape. Shifts mass from one part of the day to another.
  // A value of +0.1 on hours [18..21] (evening peak) and −0.1 on hours [11..14] (midday)
  // represents a "renewable surge" reshape. Encoded as a 24-vector summing to 0.
  diurnalShapeShift: number[];       // [24]
};

export type Scenario = {
  id: string;
  name: string;
  description: string;
  years: ScenarioYearParams[];       // length = projectLifeYears (or longer; extra years ignored)
};
```

## Built-in scenario library

Each scenario is a JSON file in `src/core/forecast/scenarios/`. The library:

| id | name | trajectory |
|---|---|---|
| `status_quo` | Status Quo | flat — all multipliers = 1, all shifts = 0 |
| `demand_driven_tightening` | Demand-Driven Tightening (default) | level +3%/yr years 1–5 then +1.5%/yr; spread +5%/yr years 1–5 then +2%/yr; negative-hour share shift → −1.0 by year 5; peakDurationMultiplier 0.95 (shorter sharper peaks) |
| `renewable_surge` | Renewable Surge | level −1%/yr years 1–8; spread +6%/yr; diurnal shift: deeper midday troughs, sharper evening peaks; negative-hour share +0.05/yr years 1–5 |
| `balanced_buildout` | Balanced Build-out | level +1%/yr; spread ±0; negative-hour share −0.5 by year 10 |
| `new_nuclear_2035` | New Nuclear post-2035 | step at year `2035 − startYear`: level −10%, spread × 0.8, negative-hour share back to historical |
| `hydrogen_floor` | Hydrogen / Flexible Demand Floor | negative-hour share → 0 by year 3, level +1%/yr, spread flat |

Each scenario file is human-readable JSON that the user can fork and edit. Format:

```json
{
  "id": "demand_driven_tightening",
  "name": "Demand-Driven Tightening",
  "description": "FI default. District-heating boilers and data centers raise levels and volatility; supply response lags.",
  "trajectory": {
    "meanLevelMultiplier": { "years_1_5": 1.03, "years_6_plus": 1.015, "compounding": true },
    "spreadMultiplier":    { "years_1_5": 1.05, "years_6_plus": 1.02,  "compounding": true },
    "negativeHourShareShift": { "linearToYear": 5, "targetShift": -1.0 },
    "peakDurationMultiplier": { "constant": 0.95 },
    "residualSigmaMultiplier": { "constant": 1.0 },
    "diurnalShapeShift": { "constant": [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0] }
  }
}
```

A small expander expands the trajectory JSON into the per-year `ScenarioYearParams[]`.

## Synthetic day generator

```ts
// src/core/forecast/synthDay.ts

export function generateDailyPriceParams(
  calibration: HistoricalCalibration,
  scenarioYear: ScenarioYearParams,
  yearIndex: number,
  dayOfYear: number,
  rng: () => number,                 // injected RNG (seedable; xoshiro128**)
  residualState: { prev: number },   // mutable; carries AR(1) state across days
): DailyPriceParams;
```

### Generation algorithm for one day

Given:
- `calibration` (the historical aggregate)
- `scenarioYear` (the per-year multiplier set)
- `dayOfYear`, used to index month and weekday

Steps:

1. **Pick month** = `monthOf(dayOfYear)`.
2. **Pick weekday** = `weekdayOf(dayOfYear)` (deterministic given a fixed reference year).
3. **Base diurnal** = `calibration.diurnalByMonth[month]`.
4. **Apply scenario reshape** = `baseDiurnal + scenarioYear.diurnalShapeShift`. Renormalise to sum 24.
5. **Apply peak duration** = stretch or sharpen the diurnal shape's high-price hours by `peakDurationMultiplier`. Implementation: identify hours above mean=1 in the reshaped diurnal, then redistribute mass so the number of above-mean hours scales by the multiplier. Renormalise.
6. **Day mean** = `calibration.annualMeanPrice × calibration.monthLevel[month] × calibration.dayOfWeekLevel[weekday] × scenarioYear.meanLevelMultiplier`.
7. **Daily spread scaling** = compute the diurnal shape's intrinsic spread (max − min after renormalising). Scale all hourly values so that `(max − min)` reaches `historical_spread_for_month × scenarioYear.spreadMultiplier` while keeping the mean at `dayMean`.
8. **Residual draw** = `r_t = calibration.residualAr1 × residualState.prev + N(0, calibration.residualSigma × scenarioYear.residualSigmaMultiplier)`. Update `residualState.prev = r_t`.
9. **Apply residual** = multiply all 24 hourly prices by `exp(r_t)` (log-space residual). This shifts the whole day up or down without changing intraday shape.
10. **Apply negative-hour share shift** = if `scenarioYear.negativeHourShareShift` is non-zero, find the lowest-price hours and (a) for negative shift, raise them so they cross zero — by adding a constant such that the number of remaining negative hours matches the target share; (b) for positive shift, lower the cheapest hours symmetrically. Negative-price scenario logic is bounded so that monthly means don't shift wildly.
11. **Return** `DailyPriceParams { yearIndex, dayOfYear, hourlyPrices, dayMeanPrice }`.

The RNG is seedable so Monte Carlo runs are reproducible.

## Scenario engine entry point

```ts
// src/core/forecast/engine.ts

export function buildScenarioDays(
  calibration: HistoricalCalibration,
  scenario: Scenario,
  projectLifeYears: number,
  rngSeed: number,
): DailyPriceParams[];
```

Iterates years 1..projectLifeYears, days 1..365, calling `generateDailyPriceParams` and carrying AR(1) state across days within a year. AR(1) state resets at year boundaries (a soft constraint — we don't want one extreme year locking in another).

## Backtest mode (first-class feature)

The model's credibility hinges on being able to demonstrate that it reproduces historical statistics out-of-sample. The UI exposes a dedicated "Backtest" view.

### Procedure

1. Calibrate on a chosen window (e.g. 2024-01-01 → 2025-01-01).
2. Generate synthetic days for the held-out window (e.g. 2025-01-01 → 2026-01-01) using `status_quo` scenario.
3. Compute per-month aggregate statistics on both the synthetic and the real held-out data: mean, spread, window-count distribution, negative-hour share, daily-revenue-per-MW-of-power-rating from the dispatch engine.
4. Render side-by-side comparison plots:
   - **Monthly mean price**: actual vs. synthetic, with shaded P10–P90 band over multiple Monte Carlo paths.
   - **Daily spread distribution**: KDE overlay.
   - **Window-count histogram**: bar comparison.
   - **Negative-hour share by month**.
   - **Annual revenue** for the default battery: actual vs. synthetic distribution.

### Acceptance metrics

The backtest passes if:
- Synthetic monthly means lie within ±15% of actual on at least 10 of 12 months.
- Daily spread distribution KS-statistic < 0.10.
- Annual revenue median within ±20% of actual.

These are loose, deliberately. The model is not asked to predict 2025 from 2024; it is asked to *reproduce statistical regularities* — a much lower bar that matches the model's actual purpose.

Failing the backtest is informative — it tells the user the calibration window was atypical or the calibration approach has a bug.

## Scenario UI (`src/features/scenarios/`)

### Layout

A single-page editor with:

- **Scenario picker** at the top — dropdown of built-in scenarios + saved custom scenarios.
- **Scenario metadata** — name, description (editable for custom scenarios).
- **Trajectory editor** — per-year multipliers visualised as line charts. Each chart has draggable points or a numeric table view. Six charts:
  - Mean level multiplier
  - Spread multiplier
  - Residual sigma multiplier
  - Negative-hour share shift
  - Peak duration multiplier
  - Diurnal shape shift heatmap (24 × N years)
- **Preview panel** — given the current scenario and calibration, generate one synthetic year and plot a representative week to give the user immediate visual feedback.
- **Compare scenarios** — multi-select scenarios → side-by-side preview of synthetic-year statistics.

### Save / load

Custom scenarios save to `localStorage` under `bess-analyzer.scenarios.{id}`. Import/export as JSON for sharing.

## Acceptance criteria

- `calibrateFromHistory` is unit-tested:
  - Constant-price history → all multipliers = 1, all shifts = 0, `residualSigma ≈ 0`.
  - History with known monthly pattern → `monthLevel` matches the pattern within 1e-6.
  - History with known AR(1) residuals → estimated `residualAr1` within 0.05 of true.
- `generateDailyPriceParams` is unit-tested:
  - Flat calibration + status quo scenario + zero residual → flat hourly day at `annualMeanPrice`.
  - Calibration with sharp evening peak + peakDurationMultiplier = 2 → output day has roughly twice as many above-mean hours in the evening.
  - meanLevelMultiplier = 1.5 → output day mean = 1.5 × calibration day mean (within residual noise).
- `buildScenarioDays` produces `projectLifeYears × 365` entries, all well-formed.
- All six built-in scenarios load, expand, and generate days without errors.
- Backtest view renders all four comparison charts on real data and reports the acceptance metrics.
- Scenario trajectory editor: changes propagate to preview within 100 ms.
- Synthetic day generation: 20 years × 365 days runs in < 100 ms.

## Out of scope for Phase 4

- Multi-region forecasting — FI bidding zone only.
- Weather-driven correlations — explicitly excluded.
- 15-min resolution synthesis — deferred.
- LLM-assisted scenario narratives — would require a backend; deferred.
- Cross-year residual persistence — AR(1) resets at year boundaries by design.
