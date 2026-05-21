# Phase 2 — Parameter UI & economics core

**Effort:** 2–3 days
**Goal:** A complete parameter input form covering every variable used downstream, and a unit-tested economics module that computes LCOS, NPV, IRR, payback, and a project cashflow schedule from a given annual revenue/throughput stream.

## Design simplifications

The model deliberately collapses several detailed parameters that are hard to source from manufacturer datasheets into single, calibratable values:

1. **Round-trip efficiency rolls up everything** — AC-to-AC conversion, aux/HVAC parasitic load, and self-discharge are not modelled separately. They are absorbed into one `roundTripEfficiency` number representing total energy ratio between grid-in and grid-out. The user picks a value (typically 0.80–0.88) that they would defend in a thesis without needing per-component decomposition.
2. **Degradation has two knobs** — total cycle life and a cycles-per-day penalty. No knee, no DoD exponent, no C-rate factor.
3. **No battery replacement** — the battery degrades, the system retires when SoH < end-of-life, and that's it. Auxiliary equipment (inverter / PCS) replacement is modelled because its lifetime is typically shorter than the project life.

## Full parameter model

```ts
// src/core/types/inputs.ts

export type BatteryInputs = {
  // Sizing
  powerMW: number;                  // P_rated
  energyMWh: number;                // E_rated
  /**
   * Round-trip efficiency, grid-in MWh ÷ grid-out MWh, INCLUDING all parasitic losses
   * (PCS conversion, aux/HVAC, self-discharge over typical cycle).
   * Typical 0.80–0.88 for modern Li-ion at AC-AC grid boundary.
   */
  roundTripEfficiency: number;      // η in (0, 1]
  dod: number;                      // usable fraction, e.g. 0.90

  // Operating limits
  maxCyclesPerDay: 1 | 2 | 3;
  activationThreshold: number;      // MDC multiplier; default 1.0

  // Degradation (simple two-knob model)
  nominalCycleLifeEFC: number;      // EFC to reach EoL SoH at 1 cycle/day
  calendarLifeYears: number;        // years to reach EoL SoH with no cycling
  cyclesPerDayPenaltyExponent: number; // p; effective_EFC_lost = EFC × (cpd / 1)^p
  endOfLifeSoH: number;             // retirement trigger and "EoL SoH" reference, e.g. 0.80
};

export type CostInputs = {
  // CAPEX
  batteryCapexPerKWh: number;       // €/kWh of nameplate energy
  pcsCapexPerKW: number;             // €/kW of power
  bopCapexPercentOfBatteryPcs: number;
  developmentCapexPercent: number;
  contingencyPercent: number;

  // Aux-equipment replacement (NOT battery replacement)
  pcsReplacementIntervalYears: number;   // e.g. 12
  pcsReplacementCostPercentOfPcs: number; // e.g. 80 (% of initial PCS CAPEX, real terms)

  // OPEX
  fixedOmPerKWPerYear: number;
  variableOmPerMWhThroughput: number;
  insurancePercentOfCapexPerYear: number;
  landLeasePerYear: number;
  gridFeePerMWhThroughput: number;
  gridFeePerKWPerYear: number;

  // Escalation
  inflationPercentPerYear: number;
  omEscalationPercentPerYear: number;
};

export type FinanceInputs = {
  projectLifeYears: number;
  wacc: number;
  taxRate: number;
  depreciationYears: number;
  residualValuePercentOfInitialCapex: number;
  vatRecoverable: boolean;
};

export type Inputs = {
  battery: BatteryInputs;
  costs: CostInputs;
  finance: FinanceInputs;
};
```

### Simplified degradation model

Used in Phase 3. Documented here because the parameters live in `BatteryInputs`.

```
SoH(t) = max(0, 1 − loss_calendar(t) − loss_cycle(EFC_cumulative, avg_cpd))

loss_calendar(t) = (1 − endOfLifeSoH) × (t_years / calendarLifeYears)
loss_cycle(EFC, cpd) = (1 − endOfLifeSoH) × (EFC / nominalCycleLifeEFC)
                                          × (cpd / 1)^cyclesPerDayPenaltyExponent
```

Notes:
- Both terms are zero at `t=0` / `EFC=0` and reach `(1 − endOfLifeSoH)` at the rated life points.
- The combined SoH crosses `endOfLifeSoH` somewhere before both rated lives are reached, which is the typical outcome.
- At `cpd = 1`, the penalty term equals 1 and matches the rated cycle life. At `cpd = 2`, with `p = 1.5`, the penalty is `2^1.5 ≈ 2.83` — meaning two cycles per day consumes ~2.83 effective cycles' worth of degradation per actual cycle. Conservative.
- The retirement trigger is `endOfLifeSoH`. After SoH crosses it, the system stops generating revenue for the remainder of the project life. Residual value is still recognised in the final project year.

The penalty exponent `cyclesPerDayPenaltyExponent` is the only non-obvious parameter; default `1.5` is a reasonable midpoint of published Li-ion cycle-vs-rate literature, and it stays a single slider in the UI rather than expanding into separate DoD and C-rate factors.

### Default values

| Group | Parameter | Default | Rationale |
|---|---|---|---|
| Battery | powerMW | 10 | demo size |
| Battery | energyMWh | 40 | 4-hour duration |
| Battery | roundTripEfficiency | 0.85 | AC-AC including parasitics |
| Battery | dod | 0.90 | modern LFP |
| Battery | maxCyclesPerDay | 2 | allow multi-cycle, capped |
| Battery | activationThreshold | 1.0 | break-even gate |
| Battery | nominalCycleLifeEFC | 6000 | LFP industry standard at EoL 80% |
| Battery | calendarLifeYears | 15 | manufacturer warranty class |
| Battery | cyclesPerDayPenaltyExponent | 1.5 | literature midpoint |
| Battery | endOfLifeSoH | 0.80 | conventional EoL |
| Costs | batteryCapexPerKWh | 200 | 2026 indicative |
| Costs | pcsCapexPerKW | 80 | 2026 indicative |
| Costs | bopCapexPercentOfBatteryPcs | 20 | typical |
| Costs | developmentCapexPercent | 8 | EPC + permits |
| Costs | contingencyPercent | 10 | standard |
| Costs | pcsReplacementIntervalYears | 12 | typical inverter life |
| Costs | pcsReplacementCostPercentOfPcs | 80 | real-terms allowance |
| Costs | fixedOmPerKWPerYear | 6 | typical |
| Costs | variableOmPerMWhThroughput | 0.5 | typical |
| Costs | insurancePercentOfCapexPerYear | 0.5 | typical |
| Costs | landLeasePerYear | 0 | site-specific |
| Costs | gridFeePerMWhThroughput | 1.0 | placeholder; user refines |
| Costs | gridFeePerKWPerYear | 0 | placeholder |
| Costs | inflationPercentPerYear | 2.0 | ECB target |
| Costs | omEscalationPercentPerYear | 0.5 | real escalation |
| Finance | projectLifeYears | 20 | typical |
| Finance | wacc | 6.0 | Nordic infrastructure |
| Finance | taxRate | 20 | Finnish corporate tax |
| Finance | depreciationYears | 15 | tax-life heuristic |
| Finance | residualValuePercentOfInitialCapex | 5 | conservative |
| Finance | vatRecoverable | true | typical commercial entity |

All defaults are user-editable.

## Validation (Zod schemas)

Each input has a Zod schema with:
- Numeric range checks (e.g. `roundTripEfficiency` in `(0, 1]`).
- Cross-field invariants (e.g. `endOfLifeSoH` in `(0, 1)`, `pcsReplacementIntervalYears ≤ projectLifeYears + 5`).
- Coercion from form strings to numbers.

A single `parseInputs(unknown): Result<Inputs, ZodError>` function is used at the form boundary.

## Economics core (`src/core/economics/`)

Pure functions. No React. No I/O. All consume fully-resolved `Inputs` plus the annual revenue/throughput stream produced by Phase 3.

### Annual stream contract

```ts
// src/core/types/streams.ts
export type AnnualStream = {
  year: number;                     // 1..projectLifeYears
  grossRevenue: number;             // €, arbitrage revenue this year
  throughputMWh: number;             // MWh discharged this year (already reflects η losses)
  cyclesEFC: number;                 // equivalent full cycles this year
  endOfYearSoH: number;
  capacityMWh: number;               // usable capacity, year-average
  retired: boolean;                  // true for the year SoH drops below EoL, and all later years
};
```

Phase 3 produces an `AnnualStream[]`. Phase 2 consumes it.

### Functions

```ts
// src/core/economics/index.ts

export type CapexBreakdown = {
  battery: number;
  pcs: number;
  bop: number;
  development: number;
  contingency: number;
  total: number;
};

export function computeCapex(inputs: Inputs): CapexBreakdown;

export type AnnualOpex = {
  year: number;
  fixedOM: number;
  variableOM: number;
  insurance: number;
  landLease: number;
  gridFees: number;
  total: number;
};

export function computeAnnualOpex(
  inputs: Inputs,
  stream: AnnualStream,
): AnnualOpex;

export type AnnualPcsReplacement = {
  year: number;
  pcsReplacementCost: number;       // non-zero only on replacement years
};

export function computeAnnualPcsReplacement(
  inputs: Inputs,
  capex: CapexBreakdown,
  yearIndex: number,
): AnnualPcsReplacement;

export type CashflowRow = {
  year: number;
  revenue: number;
  opex: number;
  pcsReplacement: number;
  capex: number;                    // year 0 only
  residualValue: number;            // final year only
  ebitda: number;
  ebit: number;
  tax: number;
  cashflow: number;
  discountedCashflow: number;
  cumulativeDiscountedCashflow: number;
};

export function buildCashflow(
  inputs: Inputs,
  streams: AnnualStream[],
): CashflowRow[];

export type FinancialResults = {
  capex: CapexBreakdown;
  cashflow: CashflowRow[];
  totalRevenueNominal: number;
  totalThroughputMWh: number;
  npv: number;                      // discounted at WACC
  irr: number | null;
  simplePaybackYears: number | null;
  discountedPaybackYears: number | null;
  lcos: number;                     // €/MWh, see formula below
};

export function computeFinancials(
  inputs: Inputs,
  streams: AnnualStream[],
): FinancialResults;
```

### LCOS formula

```
LCOS = NPV(total lifecycle costs) / NPV(discharged energy)

where:
  per-year cost   = year-0 CAPEX + opex_y + pcsReplacement_y − (residual on final year)
  per-year energy = stream[y].throughputMWh
  both discounted at WACC
```

Independent of realised price spread — LCOS is a cost number, not a profitability number. Profitability is captured by NPV, IRR, and payback.

### IRR computation

Newton–Raphson on the unleveraged free cash flow. Initial guess = WACC. Iterations capped at 50, tolerance 1e-7. Return `null` if no sign change in cashflow or if iteration fails to converge.

### Payback computation

- **Simple payback** = first year where cumulative undiscounted cashflow turns positive. Fractional interpolation within the year. Return `null` if it never recovers.
- **Discounted payback** = analogous on cumulative discounted cashflow.

### PCS replacement schedule

Replacement occurs at years `pcsReplacementIntervalYears, 2 × pcsReplacementIntervalYears, …` while within project life. Cost = `pcs × (pcsReplacementCostPercentOfPcs / 100)` in real terms, then inflated to the replacement year via `inflationPercentPerYear`.

### Escalation handling

Opex line items are escalated by `(1 + inflation/100)^year × (1 + omEscalation/100)^year` where applicable. Grid fees and insurance escalate with inflation only. Revenue from Phase 3 is in nominal terms for the year it occurs and is not re-escalated here.

## Parameter UI (`src/features/parameters/`)

### Layout

Multi-section form with collapsible groups:

1. **Battery sizing & operation** (powerMW, energyMWh, RTE, DoD, maxCyclesPerDay, activationThreshold)
2. **Battery degradation** (nominalCycleLifeEFC, calendarLifeYears, cyclesPerDayPenaltyExponent, endOfLifeSoH)
3. **CAPEX** (battery, PCS, BoP, development, contingency)
4. **PCS replacement** (interval, cost %)
5. **OPEX** (fixed, variable, insurance, land, grid fees, escalation)
6. **Finance** (life, WACC, tax, depreciation, residual, VAT)

Each input has:
- Label, units, tooltip explaining what it represents
- Numeric input with min/max enforced by Zod
- For headline inputs (powerMW, energyMWh, wacc, batteryCapexPerKWh, RTE, nominalCycleLifeEFC): a slider in addition to the numeric input
- For computed/derived values: read-only display

### Presets

Top-of-form preset dropdown:
- "LFP 4-hour utility BESS (default)"
- "LFP 2-hour fast-cycling"
- "NMC 1-hour peaking"
- "Long-duration LFP 8-hour"

Each preset is a complete `Inputs` object loaded by name. The user can clone any preset to a custom name and save it to localStorage.

### Save / load

- Parameter sets saved to `localStorage` under `bess-analyzer.parameters.{name}`.
- "Save current" button → prompts for a name, saves the current form state.
- "Load" dropdown → loads a saved set.
- "Export JSON" → downloads the current set.
- "Import JSON" → uploads and validates via Zod.

## Live derived display

A read-only "Derived values" panel beside the form, updated in real time:

- Total CAPEX (€ and €/kWh of nameplate)
- Duration D = energyMWh / powerMW
- Pure-capital MDC (€/MWh discharged) = `capex.total / (energyMWh × dod × nominalCycleLifeEFC)`
- Year at which SoH = 0.90, 0.85, EoL — back-solved from the degradation formula assuming 1 cycle/day
- Capacity at EoL (MWh)

This is the user's instant-feedback panel — tweaking `nominalCycleLifeEFC` shows the MDC move and the projected SoH trajectory shift.

## Acceptance criteria

- All parameters editable in the UI with validation.
- Zod schemas reject out-of-range and inconsistent inputs with clear error messages on the affected field.
- Presets load all parameters; saving and loading from localStorage round-trips correctly.
- JSON import/export round-trips correctly.
- `computeCapex`, `computeAnnualOpex`, `computeAnnualPcsReplacement`, `buildCashflow`, `computeFinancials` are unit-tested with synthetic streams:
  - All-zero revenue → NPV strictly negative, IRR `null`.
  - Constant revenue, no degradation → NPV matches closed-form annuity formula within 1e-6.
  - Known LCOS test vector (200 €/kWh CAPEX, 6000 cycles, 90% DoD, no O&M, 0% discount → LCOS ≈ 37.04 €/MWh).
  - IRR within 1e-5 of a reference implementation on the same cashflow.
- Discounted payback ≥ simple payback in all tests (sanity).
- Derived values panel updates within 50 ms of any input change.

## Out of scope for Phase 2

- Any historical or synthetic price series — Phase 1 / 4.
- The simulation engine that produces `AnnualStream` — Phase 3.
- Sensitivity / Monte Carlo — Phase 5.
- Results dashboards beyond the live derived values panel — Phase 6.
- Tax treatment of replacement capex (assumed expensed in year; deferred tax not modelled).
- Leverage / debt service — equity-only project NPV/IRR.
