# Phase 5 — Sensitivity analysis & Monte Carlo

**Effort:** 3–5 days
**Goal:** Two analysis modes layered on top of the Phase 3 + Phase 4 stack: a deterministic one-variable-at-a-time tornado, and a stochastic Monte Carlo with configurable per-variable distributions and correlation.

## Shared infrastructure

Both analyses repeatedly invoke the full simulation chain:

```
Inputs + Scenario → buildScenarioDays → runProjectSimulation → computeFinancials → metric
```

A single dispatcher exposes the chain as a pure function:

```ts
// src/core/analysis/run.ts

export type SimulationRequest = {
  inputs: Inputs;
  scenario: Scenario;
  calibration: HistoricalCalibration;
  rngSeed: number;
};

export type SimulationOutcome = {
  npv: number;
  irr: number | null;
  lcos: number;
  simplePaybackYears: number | null;
  discountedPaybackYears: number | null;
  totalRevenueNominal: number;
  endOfYearSoH_atYear20: number;
  retiredAtYear: number | null;
};

export function runSingle(req: SimulationRequest): SimulationOutcome;
```

This is the unit that sensitivity and Monte Carlo both call. Average wall-clock target: ≤ 5 ms per call. With a 20-year project and the daily engine, this is achievable in plain JavaScript.

## Sensitivity analysis

### Concept

Tornado chart: one variable at a time, swept symmetrically (e.g. ±30%) from its base value. The metric (default: NPV; user can pick IRR or LCOS) is recomputed at each end of the sweep. The horizontal extent of each bar shows how much that variable moves the metric.

Variables span all three input groups plus the active scenario's most consequential year-1 parameter.

### Default sensitivity variable set

| Group | Variable | Sweep | Notes |
|---|---|---|---|
| Battery | powerMW | ±30% | also rescales auto-coupled energyMWh? No — held independent |
| Battery | energyMWh | ±30% | duration changes |
| Battery | roundTripEfficiency | ±10% | bounded to ≤ 1 |
| Battery | nominalCycleLifeEFC | ±30% | the "usable lifetime" lever the user explicitly called out |
| Battery | calendarLifeYears | ±30% | |
| Battery | activationThreshold | sweep 0.8 → 2.0 | non-linear and asymmetric — handled separately, see below |
| Costs | batteryCapexPerKWh | ±30% | |
| Costs | pcsCapexPerKW | ±30% | |
| Costs | fixedOmPerKWPerYear | ±50% | |
| Finance | wacc | ±30% (additive ±2pp from base) | additive percentage points, not multiplicative |
| Scenario | year1.meanLevelMultiplier | ±20% | the "price forecast" lever |
| Scenario | year1.spreadMultiplier | ±30% | volatility lever |

### Implementation

```ts
// src/core/analysis/sensitivity.ts

export type SensitivityVariable = {
  key: string;                       // e.g. "battery.powerMW" or "scenario.year1.meanLevelMultiplier"
  label: string;
  basePath: string;                  // dot-path into Inputs or Scenario
  sweep:
    | { kind: "multiplicative"; lowFactor: number; highFactor: number }    // base × factor
    | { kind: "additive"; lowDelta: number; highDelta: number }            // base + delta
    | { kind: "absolute"; low: number; high: number };                     // override entirely
};

export type SensitivityResult = {
  metric: "npv" | "irr" | "lcos";
  base: SimulationOutcome;
  rows: Array<{
    variable: SensitivityVariable;
    low: { value: number; outcome: SimulationOutcome };
    high: { value: number; outcome: SimulationOutcome };
    metricAtBase: number;
    metricAtLow: number;
    metricAtHigh: number;
    range: number;                   // |metricAtHigh − metricAtLow|
  }>;
};

export function runSensitivity(
  req: SimulationRequest,
  variables: SensitivityVariable[],
  metric: "npv" | "irr" | "lcos",
): SensitivityResult;
```

Implementation: clone `req`, mutate the chosen field via the dot-path, run `runSingle`, restore. Order rows by `range` descending for tornado display.

### Activation-threshold sweep

The activation-threshold is non-monotonic and asymmetric (too low burns cycles cheaply; too high leaves money on the table). Treat it specially: instead of a ±X% sweep, run 11 points evenly across [0.6, 2.0], plot the metric as a curve, and identify the optimum within that range. Surface the optimum value in the results UI.

### Tornado chart UI

- Centred at the base metric value (e.g. base NPV)
- Each row a horizontal bar extending left to `metricAtLow` and right to `metricAtHigh`
- Bars sorted by `range` descending (largest at top)
- Hover shows exact values
- Click on a row → drills into a 1-D sensitivity curve for that variable (11-point sweep)

### Acceptance criteria for sensitivity

- All listed default variables sweep without errors.
- Activation-threshold curve is U-shaped (or monotone in degenerate cases) and the optimum is correctly identified.
- Each variable's range matches a hand-computed estimate within 5% for two variables (powerMW and wacc).

## Monte Carlo analysis

### Concept

For each Monte Carlo trial:
1. Sample every flagged input from its configured distribution (respecting any cross-input correlations).
2. Generate a fresh synthetic price series with its own RNG seed.
3. Run the full simulation chain.
4. Record the outcome.

After N trials, present distributional outputs: histogram, CDF, P10/P50/P90, probability metrics (e.g. P(NPV > 0)), and scatter plots of (NPV vs each varied input).

### Configurable distributions

```ts
// src/core/analysis/montecarlo.ts

export type MCDistribution =
  | { kind: "fixed"; value: number }
  | { kind: "uniform"; low: number; high: number }
  | { kind: "triangular"; low: number; mode: number; high: number }
  | { kind: "normal"; mean: number; stddev: number; clipLow?: number; clipHigh?: number }
  | { kind: "lognormal"; meanLog: number; sigmaLog: number; clipLow?: number; clipHigh?: number }
  | { kind: "discrete"; values: number[]; weights: number[] };

export type MCVariableConfig = {
  key: string;                       // dot-path into Inputs or Scenario
  label: string;
  distribution: MCDistribution;
};

export type MCCorrelation = {
  varA: string;
  varB: string;
  rho: number;                       // Pearson correlation in [−1, +1]
};

export type MCRequest = {
  base: SimulationRequest;
  variables: MCVariableConfig[];
  correlations: MCCorrelation[];     // optional; ignored if empty
  trials: number;                    // e.g. 5000
  rngSeed: number;
};

export type MCResult = {
  outcomes: SimulationOutcome[];
  sampledInputs: Array<Record<string, number>>;  // per trial; one entry per varied variable
  summary: {
    npv: { mean: number; std: number; p10: number; p50: number; p90: number; min: number; max: number };
    irr: { p10: number | null; p50: number | null; p90: number | null; pPositive: number };
    lcos: { mean: number; p10: number; p50: number; p90: number };
    pNpvPositive: number;
    pRetiresEarly: number;           // fraction of trials retiring before projectLifeYears
  };
  convergence: {
    trialsTo90PctStable: number | null;  // trials needed before running mean of NPV stabilises within ±2% over a 500-trial window
  };
};

export function runMonteCarlo(req: MCRequest): MCResult;
```

### Sampling with correlations

If `correlations` is empty: sample each variable independently from its distribution.

If correlations are specified:
1. Build a target correlation matrix `R` over the variables.
2. Sanity-check `R` is positive semi-definite; if not, nearest-PSD via Higham's algorithm (in-house implementation; cheap for small matrices).
3. Generate standard normal vectors `Z` and apply Cholesky decomposition: `X = L · Z` where `L L^T = R`.
4. Map each `X_i` through the inverse CDF of its target marginal distribution (the Iman–Conover / NORTA trick).

This produces samples with the correct marginals and approximately the correct correlation.

### RNG

Use a seedable PRNG (xoshiro128**) so a given `(rngSeed, trials)` pair always produces the same MCResult. This is required for reproducibility (thesis defence and unit tests).

### Default Monte Carlo configuration

Pre-configured set of variables and reasonable distributions:

| Variable | Distribution | Defaults |
|---|---|---|
| `costs.batteryCapexPerKWh` | normal | mean = current, σ = 15% of mean, clip ≥ 0.5 × mean |
| `costs.pcsCapexPerKW` | normal | mean = current, σ = 10% of mean |
| `battery.nominalCycleLifeEFC` | triangular | low = 0.7 × base, mode = base, high = 1.3 × base |
| `battery.calendarLifeYears` | triangular | low = 0.8 × base, mode = base, high = 1.2 × base |
| `battery.roundTripEfficiency` | normal | mean = current, σ = 0.02, clip [0.7, 0.95] |
| `finance.wacc` | normal | mean = current, σ = 1.0 (percentage points), clip [2, 12] |
| `scenario.year1.meanLevelMultiplier` | lognormal | meanLog = ln(current), σ_log = 0.15 |
| `scenario.year1.spreadMultiplier` | lognormal | meanLog = ln(current), σ_log = 0.20 |

Default correlations:
- `costs.batteryCapexPerKWh` ↔ `costs.pcsCapexPerKW`: +0.5 (supply-chain co-movement)
- `scenario.year1.meanLevelMultiplier` ↔ `scenario.year1.spreadMultiplier`: +0.3 (tight markets are both higher-mean and higher-volatility)

The user can enable/disable any variable and edit any distribution.

### Convergence diagnostic

The result includes `convergence.trialsTo90PctStable`. Compute by running the analysis in a single pass, after each trial recording the running mean of NPV, then walking through and finding the trial index `t` after which `mean[t:t+500]` stays within `mean_final ± 2%`. If never, return `null` — the UI shows a warning that the chosen `trials` may be too few.

### Performance

Per trial: ~5 ms = 5000 trials → 25 s. For interactive UX:
- Default trials = 2000 (~10 s).
- Run inside a **Web Worker** with progress reporting. UI shows a progress bar.
- Cancel button to abort early; partial results displayed.

### Monte Carlo UI

- **Configuration panel**: list of MC variables with toggle (enable/disable), distribution editor inline, correlation matrix editor.
- **Run button** + trials slider + seed input.
- **Results**:
  - NPV histogram with P10/P50/P90 markers
  - NPV CDF
  - "Probability of NPV > 0" gauge
  - Tornado-style sensitivity from MC (rank-correlation of NPV with each input) — complements Phase 5's deterministic tornado
  - Scatter matrix (small): NPV vs each varied input
  - Convergence chart: running mean of NPV vs trial number
  - Retirement-year histogram (when does the battery retire across trials?)

### Acceptance criteria for Monte Carlo

- Pure-uniform single-variable MC produces NPV mean within 1% of `runSingle` at the distribution's mean for ≥ 1000 trials.
- Reproducibility: same `rngSeed` produces identical `outcomes` to bit precision.
- Correlation injection: empirical correlation in `sampledInputs` matches target within ±0.05 for ≥ 2000 trials.
- 2000-trial run completes in ≤ 15 s on a mid-range laptop.
- Convergence diagnostic correctly identifies the trial count after which mean NPV stabilises.
- Cancellation works mid-run with no UI lockup.

## Out of scope for Phase 5

- Optimisation (find the input combination that maximises NPV) — could be added later via grid search or differential evolution.
- Bayesian calibration — too heavy for browser.
- Scenario-of-scenarios (MC across multiple scenarios) — the user chooses one scenario per MC run. Multi-scenario comparison is via separate MC runs.
- Time-varying correlation across years — only year-1 multipliers are sampled; later-year multipliers move proportionally with year-1 by default.
