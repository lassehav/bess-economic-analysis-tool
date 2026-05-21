
# Phase 4 — Unified Scenarios, Structural Forecasts & Event Annotations

**Effort:** 7–10 days  
**Goal:** Implement a hybrid fundamental-stochastic forecasting engine that calibrates additive historical volatility profiles, scales them using multi-year asset trajectories, injects structural binary milestones and stochastic infrastructure outages, models the static-intermittent generation gap, and maps these occurrences as interactive visualization overlays using ECharts annotations.

This phase forms the core mathematical and analytical heart of the application.

---

## Conceptual Model

To accurately reflect modern grid dynamics, we abandon pure multiplier scaling on raw prices, which breaks in negative-price environments. Instead, this engine uses an **Asymmetric Additive-Anomalistic Framework**. 

Every historical day is decomposed into its baseline mean, its positive anomalies (demand peaks/generation scarcity), and its negative anomalies (renewable oversupply). The forecasting engine operates as a hybrid pipeline:


```

[Historical Calibration] ──> [Asymmetric Decomposition]
│
[Macro Trajectories]    ──>          ▼
[Structural Timelines]  ──> [Daily Synthesis Loop] ──> [Synthetic Prices] + [Event Logs]
[Stochastic Outages]    ──>          │
[Supply-Demand Gaps]    ──>          ▼
[ECharts UI Component] ──> Interactive Price Line + Visual Bands

```

The engine outputs a unified data payload containing both the synchronized multi-year hourly price stream and a structured array of discrete execution events used directly by the chart component for rendering visual context.

---

## Data Structures

```ts
// src/core/forecast/types.ts

export type HistoricalCalibration = {
  // [12 months][24 hours] additive normalized shape profile
  diurnalByMonth: number[][];
  // Month-of-year level multipliers relative to annual mean. Length 12, sums to 12.
  monthLevel: number[];
  // Day-of-week multipliers. Length 7, defaults to all-ones if flat.
  dayOfWeekLevel: number[];
  annualMeanPrice: number;
  annualMeanSpread: number;
  // Additive AR(1) parameters calculated in absolute €/MWh space (not log-space)
  residualAr1: number;
  residualSigma: number;
};

export type ScenarioYearParams = {
  yearIndex: number;
  meanLevelMultiplier: number;     // Scales baseline fuel/CO2/demand layer
  peakMultiplier: number;          // M_peak: Amplifies/suppresses positive anomalies
  troughMultiplier: number;        // M_trough: Controls depth/recovery of troughs
  peakDurationMultiplier: number;  // Gamma exponent power transform factor
  
  // Array of time-defined structural flag IDs active in this year
  activeStructuralMilestones: string[];
};

export type SimulationEventType = 'structural' | 'stochastic_outage' | 'fundamental_gap';
export type SimulationEventSeverity = 'info' | 'warning' | 'critical';

export type SimulationEvent = {
  id: string;
  type: SimulationEventType;
  severity: SimulationEventSeverity;
  title: string;
  description: string;
  startHourIndex: number;
  endHourIndex: number;
  affectedAsset?: string;
  metricDelta?: {
    capacityMW?: number;
    priceImpactEur?: number;
  };
};

export type MultiYearForecastOutput = {
  totalHours: number;
  hourlyPrices: number[];
  events: SimulationEvent[];
};

```

---

## Scenario Library Specification

Built-in scenario definitions are human-readable JSON files mapping qualitative structural transitions to quantitative input controls:

| Scenario ID | Market Narrative | Primary Multipliers | Target Event Flags |
| --- | --- | --- | --- |
| `data_center_boom` | Data Center Baseload Buildout | `meanLevel`: 1.15<br>

<br>`peak`: 1.30<br>

<br>`trough`: 0.70 | Triggers shallower troughs as overnight constant demand cleans up negative pricing blocks. |
| `renewable_surge` | Intermittent Wind/Solar Expansion | `meanLevel`: 0.90<br>

<br>`peak`: 1.00<br>

<br>`trough`: 1.60 | Drives aggressive, deep negative pricing runs during high-generation blocks. |
| `status_quo` | Baseline Historical Replication | All multipliers = 1.0 | Standard drift replication. |

---

## Core Algorithmic Pipeline

### 1. Asymmetric Calibration (No Log Dependencies)

1. **Slice & Filter:** Isolate the historical period `[windowStart, windowEnd)`.
2. **Isolate Baseline Components:** Calculate the global annual mean ($\bar{P}_{\text{annual}}$) alongside standard monthly and day-of-week weights.
3. **Additive Residual Fitting:** For each hour $t$, calculate the expected profile price from the diurnal matrix. Compute the residual in absolute terms: $r_t = P_t - P_{\text{expected}, t}$. Fit a standard AR(1) sequence using ordinary least squares (OLS) to extract $\rho$ and $\sigma_\epsilon$ directly in €/MWh space.

### 2. Daily Price Generation Loop

For every year $y \in [1 \dots Y]$ and day $d \in [1 \dots 365]$, execute the following mathematical operations sequentially:

#### Step A: Base Diurnal Transformation via Power Scaling

Extract the normalized baseline diurnal shape $D_h$ for the active month. Apply a continuous power transform to cleanly manipulate peak durations without generating jagged steps:

$$D'_h = (D_h)^\gamma$$

* Where $\gamma = \text{peakDurationMultiplier}$. Renormalize immediately such that $\sum_{h=0}^{23} D'_h = 24$.

#### Step B: Asymmetric Anomaly Mapping

Split the transformed vector into isolated positive and negative deviation channels relative to its unit mean:

$$A_h^+ = \max(0, D'_h - 1)$$

$$A_h^- = \min(0, D'_h - 1)$$

#### Step C: Recompose & Apply Scenario Scales

Calculate the target daily mean ($\mu_{\text{day}}$) using the macro level adjustments combined with the absolute cross-day AR(1) stochastic noise element ($r_t$):

$$\mu_{\text{day}} = \left( \bar{P}_{\text{annual}} \cdot M_{\text{month}} \cdot W_{\text{weekday}} \cdot \text{multiplier}_{\text{mean}} \right) + r_t$$

Reconstruct the raw 24-hour pricing array by independently scaling the structural positive peaks and negative troughs:

$$P_h = \mu_{\text{day}} + \left( A_h^+ \cdot \text{multiplier}_{\text{peak}} \cdot \bar{S} \right) + \left( A_h^- \cdot \text{multiplier}_{\text{trough}} \cdot \bar{S} \right)$$

* Where $\bar{S}$ represents the historical target spread constant.

#### Step D: Injected Infrastructure Outage Engine

Evaluate independent asset states using an integrated stochastic Markov-switching engine:

* **Generation Assets (e.g., Nuclear Trip):** If a failure rolls true based on arrival probability ($\lambda$), determine outage length via a log-normal distribution: $\tau \sim \text{LogNormal}(\mu, \sigma)$. Apply an immediate, localized price surge: $\Delta P_h = +\text{Value}$. Append a synchronized `SimulationEvent` to the log payload marked as `stochastic_outage`.
* **Interconnector Assets (e.g., Cable Failure):** If an export cable fails during a low-load, high-wind daily profile block, apply a localized price compression factor down to negative boundaries. Append a `SimulationEvent` log entry.

#### Step E: Static-Intermittent Divergence Tracking (The "Gap Factor")

Continuously compute the absolute Supply-Demand Gap Factor ($G_t$) for every step:

$$G_t = L_{\text{constant}, t} - K_{\text{wind}, t} \cdot \omega_t$$

* If $G_t$ breaks severe threshold boundaries (e.g., $G_t \gg \text{Import Limits}$ over a rolling 48-hour period representing a windless winter freeze), apply an exponential markup scalar to the peak hours. Log a `fundamental_gap` event titled `"Windless Winter Wall"`.

---

## UI Chart Component Specifications (`src/features/scenarios/`)

Refactor the price forecast rendering view to absorb both the hourly price payload and the parallel `SimulationEvent[]` log array.

### 1. ECharts Visual Layer Integration

Map event data frames directly to native Apache ECharts configuration blocks:

* **Translucent Background Shading (`markArea`):** Used for long-duration profiles. Shading blocks map across `startHourIndex` and `endHourIndex`. Use light blue (`rgba(59, 130, 246, 0.08)`) for fundamental gaps like winter freezes, and light red (`rgba(239, 68, 68, 0.08)`) for unexpected cable/generation outages.
* **Timeline Anchored Flags (`markPoint`):** Used for short-duration point shocks like sudden generation trips. Rendered as a distinct pin sitting directly at the peak price index coordinate.

### 2. Interactive Navigation Ledger Panel

Implement a split layout layout:

* **Left Column (75% width):** Interactive ECharts canvas windowing the price forecast series line.
* **Right Column (25% width):** A clean, scrollable side-car list showing all engine-generated events chronologically.
* **Click Bindings:** Clicking any event card inside the list fires a programmatic viewport transformation bounding the chart's x-axis zoom domain exactly around the event's `[startHourIndex - 12, endHourIndex + 12]` boundary window.

---

## Backtest Mode Framework

The system includes a rigorous verification interface to evaluate synthetic model outputs out-of-sample against genuine history.

```
[Historical Price Input] ──> Calibrate [Year N-1] ──> Synthesize [Year N] ──> Evaluate Against Real [Year N]

```

### Passing Validation Parameters

The synthetic generator engine passes backtesting requirements if out-of-sample execution clears these three criteria:

1. **Mean Horizon Delta:** Simulated monthly price means track within $\pm15\%$ of actual historical out-of-sample values for at least 10 out of 12 month slots.
2. **Spread Distribution Variance:** The daily volatility spread profile clears a Kolmogorov-Smirnov (KS) statistic threshold of $KS < 0.10$.
3. **BESS Capture Revenue Alignment:** Running a default 2-hour battery dispatch optimization over the synthetic price stream yields an annual arbitrage capture revenue median within $\pm20\%$ of the revenue captured using genuine out-of-sample prices.

---

## Acceptance Criteria

* **Negative Insulated Verification:** Unit testing passes real 2024 Finnish pricing data containing deep negative price blocks through `calibrateFromHistory` without causing `NaN` or `-Infinity` execution breaks.
* **Mean-Preserving Anomaly Check:** Testing verifies that modifying `multiplier_peak` or `multiplier_trough` updates intraday volatility shapes without shifting the underlying baseline daily integrated mean.
* **Visual Label Density Management:** The UI chart component successfully handles 100+ stochastic event entries across a multi-year horizon without labels overlapping or creating layout rendering lags. Frame response times during card-click viewport transitions must stay under 150ms.
* **Deterministic Replications:** Using a fixed random number generator seed yields completely identical price series arrays and synchronized event intervals across separate executions.

---

## Out of Scope for Phase 4

* **Active Web Scraping Integration:** Live monitoring or direct programmatic calling of active Nord Pool or ENTSO-E UMM transparency APIs. All data profiles rely entirely on static, pre-loaded historical files.
* **Multi-Zone Regional Clearing:** Simulating multi-bidding zone transport flows across adjacent Nordic regions. Execution is limited strictly to the FI price zone framework.



