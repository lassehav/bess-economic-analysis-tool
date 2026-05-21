# Phase 1 — Data ingestion & historical statistics

**Effort:** 2–3 days
**Goal:** Convert the ENTSO-E CSVs into a structured time series, build the battery-aware statistics extractor, simulate the per-day State-of-Charge (SoC) trace, and ship a historical explorer UI — including a per-day window-overlay view that lets the user visually verify charge/discharge placement and SoC bounds.

## Input data

Three ENTSO-E FI bidding-zone day-ahead CSVs in the repo root:

| File | Period | Resolution | Rows |
|---|---|---|---|
| `GUI_ENERGY_PRICES_202312312300-202412312300.csv` | 2024 (Jan–Dec) | Hourly | 8784 |
| `GUI_ENERGY_PRICES_202412312300-202512312300.csv` | 2025 (Jan–Dec) | 15-min | 35040 |
| `GUI_ENERGY_PRICES_202512312300-202612312300.csv` | 2026 partial (~Jan–May) | 15-min | ~13340 |

Schema (per file):
```
"MTU (CET/CEST)", "Area", "Sequence", "Day-ahead Price (EUR/MWh)", "Intraday Period (CET/CEST)", "Intraday Price (EUR/MWh)"
```

Only `MTU` and `Day-ahead Price` are used. Intraday columns are empty.

## Build-time conversion: `scripts/build-prices-json.ts`

Runs once at build time (`npm run build:data`). Output: `public/data/fi-prices.json`.

### Pipeline

1. Parse all three CSVs with PapaParse.
2. For each row:
   - Parse the `MTU` range start timestamp (format `"DD/MM/YYYY HH:MM:SS - DD/MM/YYYY HH:MM:SS"`, CET/CEST).
   - Convert to UTC ISO timestamp.
   - Parse the price as float.
3. **Downsample 15-min rows to hourly** by averaging the 4 quarters within each hour. (15-min support deferred.)
4. Concatenate into a single time-ordered hourly series.
5. Detect and log gaps (DST changes produce 23/25-hour days — preserve them as-is, do not pad).
6. Write output as JSON.

### Output schema

```ts
type PriceSeries = {
  source: "ENTSO-E FI day-ahead";
  generatedAt: string;       // ISO timestamp of build
  startUtc: string;          // ISO timestamp of first hour
  endUtc: string;            // ISO timestamp of last hour (exclusive)
  resolutionMinutes: 60;
  prices: number[];          // €/MWh, indexed from startUtc
  gaps: Array<{ startUtc: string; endUtc: string; reason: string }>;
};
```

A `prices: number[]` indexed from a known start is dramatically smaller and faster than an array of objects. ~22k floats gzip to ~80 KB.

## Battery specification used by the extractor

The statistics extractor is **battery-aware**. The window-detection result depends on the battery's energy and power ratings, round-trip efficiency, and depth-of-discharge limit. The minimal spec for Phase 1:

```ts
// src/core/types/battery.ts
export type BatterySpec = {
  powerMW: number;             // P_rated
  energyMWh: number;           // E_rated
  roundTripEfficiency: number; // η_RTE, e.g. 0.85
  dod: number;                 // usable fraction, e.g. 0.90
  maxCyclesPerDay: 1 | 2 | 3;  // hard cap on windows per day
  initialSocMWh?: number;      // optional, defaults to 0 at start of each day for Phase 1
};
```

Derived: `D = energyMWh / powerMW` (hours).

Phase 2 will extend `BatterySpec` with cost, degradation, calendar-life parameters etc. Phase 1 only needs operating parameters.

## Data structures

### Window with time boundaries

`WindowStats` now carries explicit start/end indices and timestamps so the visualization can overlay them on the price chart.

```ts
// src/core/stats/types.ts

export type Window = {
  /** Hour-of-day indices [0..23] for the charge block, in order. */
  chargeHourIndices: number[];
  dischargeHourIndices: number[];

  /** Convenience: absolute UTC timestamps of block start/end (exclusive end). */
  chargeStartUtc: string;
  chargeEndUtc: string;
  dischargeStartUtc: string;
  dischargeEndUtc: string;

  /** Volume-weighted prices over the block. */
  vwapCharge: number;          // €/MWh
  vwapDischarge: number;       // €/MWh

  /** Effective per-MWh-discharged margin after RTE losses applied. */
  effectiveMargin: number;     // (vwapDischarge × η_RTE − vwapCharge)

  /** Energy actually moved in this cycle (MWh discharged). */
  effectiveEnergyMWh: number;  // = powerMW × min(D, dischargeHourIndices.length)

  /** Fraction of a full cycle this represents. */
  effectiveEFC: number;        // = effectiveEnergyMWh / (energyMWh × dod)
};
```

### Daily SoC trace

For the overlay visualization and for sanity-checking that no window violates the battery's energy bounds.

```ts
export type SocTracePoint = {
  hourIndex: number;           // 0..24 (25 points: hour-boundaries)
  socMWh: number;              // battery energy at this boundary
  socPct: number;              // socMWh / energyMWh × 100
  mode: "idle" | "charging" | "discharging";
};

export type DailyStats = {
  dateUtc: string;             // "YYYY-MM-DD" of the day (UTC)
  hourlyPrices: number[];      // 23/24/25-length array for visualization
  meanPrice: number;
  minPrice: number;
  maxPrice: number;
  spread: number;
  negativeHourCount: number;
  windows: Window[];           // 0..maxCyclesPerDay entries
  socTrace: SocTracePoint[];   // length = hourlyPrices.length + 1
  /** Sanity flags raised by the SoC simulation. */
  warnings: Array<
    | { kind: "soc_exceeded_capacity"; hourIndex: number; socMWh: number }
    | { kind: "soc_below_zero"; hourIndex: number; socMWh: number }
    | { kind: "discharge_before_charge"; windowIndex: number }
    | { kind: "block_overlap"; windowAIndex: number; windowBIndex: number }
  >;
};
```

The `warnings` array is the visualization's signal source: any warning surfaces a red badge on that day in the explorer.

### Period aggregates

```ts
export type PeriodAggregateStats = {
  periodKey: string;           // "2024-Q1", "2024-07", "2024"
  dayCount: number;
  spread: { mean: number; std: number; p10: number; p50: number; p90: number; skewness: number };
  windowCount: { mean: number; mode: 0 | 1 | 2 | 3; histogram: Record<0 | 1 | 2 | 3, number> };
  secondaryRatio: { mean: number; std: number };
  tertiaryRatio: { mean: number; std: number };
  peakDurationHours: { mean: number; p10: number; p50: number; p90: number };
  meanLevel: number;
  negativeHourShare: number;
  effectiveMarginPerCycle: { mean: number; p10: number; p50: number; p90: number };
};
```

## Statistics extractor (`src/core/stats/`)

### Signatures

```ts
// src/core/stats/extractor.ts

export function extractDailyStats(
  dayPrices: number[],      // 23/24/25 hourly prices for one day
  dayStartUtc: string,      // ISO timestamp of hour 0
  battery: BatterySpec,
): DailyStats;

export function aggregatePeriod(
  daily: DailyStats[],
  periodKey: string,
): PeriodAggregateStats;
```

### Algorithm: `extractDailyStats`

Given `dayPrices` (length H ∈ {23, 24, 25}), `D = battery.energyMWh / battery.powerMW`, and `η = battery.roundTripEfficiency`:

1. **Compute scalars.** `meanPrice`, `minPrice`, `maxPrice`, `spread`, `negativeHourCount`.
2. **Initialise candidate windows.** Set `available = {0..H-1}`.
3. **Iterate window detection** for `i = 1 … battery.maxCyclesPerDay`:
   a. **Enumerate candidate blocks.** A *charge block* is a contiguous run of hours in `available` of length `⌈D⌉`. A *discharge block* is the same. Enumerate all such (charge_start, discharge_start) pairs subject to:
      - The two blocks do not overlap.
      - The two blocks lie entirely within `available`.
      - The charge block ends strictly before the discharge block starts (or vice versa — see (e)).
   b. **Score each candidate.** For each pair, compute VWAP_charge and VWAP_discharge (with fractional last-hour weighting when D is non-integer), then `effective_margin = VWAP_discharge × η − VWAP_charge`. Discard candidates with `effective_margin ≤ 0`.
   c. **Pick the best.** Choose the pair with maximum `effective_margin`. If no positive-margin candidate exists, stop (this and remaining windows are not extracted).
   d. **Record the window** with explicit hour-index lists, timestamps, VWAPs, margin, effective energy (`powerMW × min(D, dischargeHours)`), and effective EFC.
   e. **Note on ordering.** Allow either "charge then discharge" or "discharge then charge" within the day — a battery that ended the previous day charged might discharge into an early-morning peak first, then recharge midday. Both orderings are scored; the better one wins.
   f. **Remove block hours from `available`.** Continue to the next window unless `|available| < 2 × ⌈D⌉`.
4. **Simulate the SoC trace.** Starting from `battery.initialSocMWh ?? 0`, walk through the day's hours in order. For each hour:
   - If the hour is in a window's charge block: `SoC += battery.powerMW × 1h × √η` (charging efficiency = √η for simple symmetric model).
   - If in a discharge block: `SoC −= battery.powerMW × 1h / √η` (discharge converts internal energy to grid energy).
   - Otherwise: idle, `SoC` unchanged.
   - Record `SocTracePoint` at each hour boundary.
5. **Raise warnings.** Compare every `SocTracePoint.socMWh` against `[0, battery.energyMWh × battery.dod]`. Any breach → warning. Also check inter-block ordering (charge must precede discharge within a single window).
6. **Return** the populated `DailyStats`.

#### Notes on the enumeration

- Per day, the candidate space is O(H²) — trivially fast even for 25 hours.
- A simple but effective optimisation: pre-sort hours by price, restrict candidate charge-block starts to those overlapping the bottom-50% of hours, discharge-block starts to those overlapping the top-50%.
- The `⌈D⌉` block-length convention means a 4-hour battery picks contiguous 4-hour blocks. For non-integer D (e.g. 2.5 h), the last hour is fractionally weighted in VWAP and the effective energy is `D × P` rather than `⌈D⌉ × P`. The block in the SoC trace covers `⌈D⌉` hour boundaries but `SoC` rises/falls partially in the last hour.

### Algorithm: `aggregatePeriod`

Standard statistical aggregation across an array of `DailyStats`. Skewness via bias-corrected formula. `secondaryRatio` is computed only over days with ≥ 2 windows; `tertiaryRatio` only over days with 3 windows. `windowCount.histogram[0]` counts days with no profitable window.

## Historical explorer UI (`src/features/historical/`)

The user-facing view. Used for sanity-checking the data and the extractor.

### Layout

Two-pane layout:

- **Left sidebar:** battery-spec controls and period selector. Changes re-run extraction live.
- **Main area:** tabbed views (1) Aggregate, (2) Single-day inspection.

### Sidebar controls

- **Battery power** (MW) — slider + numeric input, default 10 MW
- **Battery energy** (MWh) — slider + numeric input, default 40 MWh
- **Derived duration** D = E/P — read-only display
- **Round-trip efficiency** — slider, default 0.85
- **Depth of discharge** — slider, default 0.90
- **Max cycles per day** — radio 1 / 2 / 3
- **Initial SoC** — slider, default 0 MWh
- **Period selector** — year / quarter / month / single day

### Aggregate views

1. **Time series.** Full hourly price line chart with zoom + pan. ECharts time-axis with dataZoom.
2. **Diurnal heatmap.** X = hour of day, Y = month, color = mean price.
3. **Daily spread distribution.** Histogram of daily spread (max − min) by month / quarter.
4. **Window-count histogram.** Bar chart: days with 0 / 1 / 2 / 3 profitable windows. Re-renders live on battery-spec change.
5. **Negative-hours calendar heatmap.** Days containing any negative-price hour.
6. **Price-duration curve.** Sorted-descending prices vs. % of hours.
7. **Effective-margin distribution.** Histogram of `effectiveMargin` per detected window (best window only). Reveals how spread translates to actual battery revenue at the current spec.

### Single-day inspection view (the new requirement)

The critical visual-verification view. Selecting a date from a calendar or the aggregate charts opens this view.

Layout: two stacked charts sharing the X-axis (hour-of-day, 0..23 or 0..24 on DST days).

#### Top chart: price + window overlay

- **Background:** hourly price as a line + faint area chart, €/MWh on the Y-axis.
- **Window overlays:** for each `Window` in `DailyStats.windows`:
  - A **green** translucent rectangle spanning `chargeHourIndices`, labelled `"W{i} CHARGE — VWAP {vwapCharge.toFixed(1)} €/MWh"`.
  - A **red/orange** translucent rectangle spanning `dischargeHourIndices`, labelled `"W{i} DISCHARGE — VWAP {vwapDischarge.toFixed(1)} €/MWh, margin {effectiveMargin.toFixed(1)} €/MWh"`.
  - Each window gets a slightly different shade (window 1 = strongest, window 3 = lightest) so multi-window days remain readable.
- **Annotations:** dashed horizontal line at the day's mean price; markers at the absolute min and max hours.

#### Bottom chart: SoC trace

- **Line chart** of `SocTracePoint.socPct` against hour-of-day, plotted at hour boundaries (25 points for a 24-hour day).
- **Reference lines:**
  - 0 % (red) — empty
  - `dod × 100 %` (red) — usable upper limit
  - 100 % (grey) — nameplate capacity ceiling
- **Color the line by mode** — green segments while charging, red while discharging, grey while idle. (ECharts: piecewise visualMap on a hidden `mode` data dimension.)
- **Warning badges** rendered as red dots at any `SocTracePoint` whose `socMWh` falls outside `[0, dod × energyMWh]`.

This view directly answers the user's verification questions:

- Are the charge blocks placed at the cheap hours?
- Are the discharge blocks placed at the expensive hours?
- Does the discharge block ever come before its paired charge block?
- Does SoC stay within `[0, dod × energyMWh]` at all times?
- For multi-window days: are the windows temporally distinct, or does the algorithm spuriously double-count?

If any of these answers look wrong on real data, the algorithm has a bug — fix it before moving to Phase 3.

#### Single-day inspection: side panel

A read-only panel listing each window's full record (charge hours, discharge hours, VWAPs, margin, EFC). Plus an aggregate row showing the day's total revenue (per MWh of P_rated), total EFC, and any warnings.

## Acceptance criteria

- `npm run build:data` produces `public/data/fi-prices.json` with ~22,000 hourly entries spanning 2024-01-01 to ~2026-05-21.
- The output file gzips to under 200 KB.
- `extractDailyStats` is unit-tested with hand-crafted day fixtures:
  - Flat-price day → 0 windows, idle SoC trace.
  - One peak / one trough → 1 window with expected VWAPs and SoC swing.
  - Solar-shaped (cheap night → expensive morning → cheap midday → expensive evening) → 2 windows.
  - Triple-shaped → 3 windows (within `maxCyclesPerDay`).
  - Pathological case: discharge enumerated before charge → algorithm picks the better ordering or marks the window invalid.
  - DST 23-hour and 25-hour days → no crash, SoC trace length matches.
- `aggregatePeriod` is unit-tested for arithmetic correctness against a small synthetic set.
- The single-day inspection view renders correctly for at least 10 sampled real days (manual visual check by user).
- All seven aggregate visualizations render against the real data without errors.
- Window detection + SoC simulation for a single day runs in < 5 ms; aggregate explorer remains responsive when battery-spec sliders are moved.

## Out of scope for Phase 1

- 15-min resolution in the engine (deferred).
- Live ENTSO-E API pulls (deferred; data is bundled).
- Any forecast / scenario / dispatch decisions involving MDC — Phases 3–4. (Phase 1 ignores MDC entirely; it just identifies the best windows by spread.)
- Battery degradation — Phase 3.
- Multi-day SoC carry-over (each day starts from `initialSocMWh`) — Phase 3 will simulate cross-day state.
- Economics (LCOS, NPV, etc.) — Phase 2.
