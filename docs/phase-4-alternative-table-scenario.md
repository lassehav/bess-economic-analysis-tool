Here is the updated and expanded plan.md file content. This version incorporates the two specific default capacity scenarios—**High Datacenter Buildout (Generation Lagging)** and **Balanced Green Transition (Synchronized)**—and establishes a robust client-side schema for saving, naming, and persisting custom scenario tables.

```markdown
# Phase 4 — Capacity Scenario Editor, Presets & Physical Price Synthesis Engine

**Effort:** 8–11 days  
**Goal:** Build an interactive multi-year Scenario Editor Table seeded with two distinct default industry presets. Upgrade the calculation engine to dynamically compute price distributions, base price shifts, volatility profiles, and weather-driven extreme shocks directly from these physical metrics, bounded by a $\pm20\%$ behavioral randomizer, and implement a JSON/LocalStorage state persistence pipeline for user-saved scenarios.

---

## Conceptual Model

Instead of forcing users to guess abstract multipliers, the system uses a **Physical Capacity Balance Framework**. The pricing behavior is completely emergent, derived directly from the structural tension between inflexible baseload, flexible loads, dispatchable generation, and intermittent renewables.

The engine translates the table configurations into pricing mechanics using three fundamental laws:
1. **The Baseload Tension:** High constant baseload/cheap eaters drive the structural floor price higher (clearing out negative price hours), while high nuclear capacity shifts the baseline price downward.
2. **The Renewable Volatility Multiplier:** As the total share of wind and solar capacity grows relative to maximum consumption, the system's baseline price distribution widens.
3. **The Dunkelflaute Spike Intensity:** During periods of zero wind or solar generation, the system calculates the physical deficit against maximum power consumption. If dispatchable capacity cannot cover the gap, prices spike exponentially based on the renewable dependency ratio.


```

[Scenario Editor Table Inputs]
(MW Capacities & Loads per Year) ──> [Engine Calibration Layer] ── [Persistence Store] (Save/Load)
│
▼
[Stochastic Weather Sequences]   ──> [Hourly Physical Gap Analysis] ──> [Synthetic Prices + Event Logs]
[Annual Behavioral Randomizer]               │
▼
[ECharts Interactive UI Layer]

```

---

## Data Structures

```ts
// src/core/forecast/types.ts

export type HistoricalCalibration = {
  diurnalByMonth: number[][]; // [12 months][24 hours] additive normalized shape profile
  monthLevel: number[];        // Month-of-year level multipliers (Length 12)
  dayOfWeekLevel: number[];    // Day-of-week multipliers (Length 7)
  annualMeanPrice: number;
  annualMeanSpread: number;
  residualAr1: number;         // Additive AR(1) autocorrelation parameter
  residualSigma: number;       // Base stochastic noise parameter (€/MWh space)
};

export type YearCapacityParams = {
  yearIndex: number;
  maxPowerConsumption: number;    // Peak potential system load (MW)
  constantBaseload: number;       // Inelastic background load + "cheap eaters" (MW)
  solarCapacityMW: number;        // Total installed solar (MW)
  windCapacityMW: number;         // Total installed wind (MW)
  nuclearCapacityMW: number;      // Total operational nuclear capacity (MW)
  priceRandomizer: number;        // Explicit bounding box multiplier [-0.20 to +0.20]
};

export type ScenarioProfile = {
  id: string;
  name: string;
  description: string;
  isPreset: boolean;
  updatedAt: string; // ISO Timestamp
  years: YearCapacityParams[];
};

export type SimulationEventType = 'structural_shift' | 'stochastic_outage' | 'dunkelflaute_shock';
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

## Default Preset Scenarios

The system seeds the interface with two fixed, un-deletable industry narrative configurations spanning a 5-year macro horizon (2026–2030). These form the analytical benchmarks:

### Preset 1: High Datacenter Buildout (Generation Lagging)

* **Narrative:** Aggressive data center development clusters around major Nordic hubs, outstripping the deployment rate of zero-carbon supply generation.
* **Physical Pricing Emergence:** Constant load cleans up historical negative price floors during high-wind intervals, while extreme structural supply deficits create severe price caps and frequent multi-thousand-euro peaks during low-wind freeze patterns.
* **Reference Seed Vector Trends (2026 ──> 2030):**
* `maxPowerConsumption`: 14,000 MW ──> 17,500 MW (+25%)
* `constantBaseload`: 9,500 MW ──> 13,000 MW (+36%)
* `nuclearCapacityMW`: 4,300 MW (Flat, assuming no new builds or extensions)
* `windCapacityMW`: 7,000 MW ──> 8,500 MW (Sluggish infrastructure lag)
* `solarCapacityMW`: 1,000 MW ──> 1,800 MW



### Preset 2: Balanced Green Transition (Synchronized Expansion)

* **Narrative:** Data center and green hydrogen electrolyzer buildouts advance in locked-step coordination with major industrial offshore wind arrays and small modular nuclear deployments.
* **Physical Pricing Emergence:** Baseline prices stay anchored due to high dispatchable capacity, but extreme peak-to-trough spreads emerge. Large blocks of flexible hydrogen assets function as "cheap eaters," acting as a sponge for oversupply while maintaining robust room for high-frequency battery arbitrage.
* **Reference Seed Vector Trends (2026 ──> 2030):**
* `maxPowerConsumption`: 14,000 MW ──> 19,000 MW
* `constantBaseload`: 9,000 MW ──> 11,500 MW (Managed flexible baseline load)
* `nuclearCapacityMW`: 4,300 MW ──> 4,900 MW (SMR block addition by 2029)
* `windCapacityMW`: 7,000 MW ──> 14,500 MW (Aggressive doubling)
* `solarCapacityMW`: 1,000 MW ──> 3,500 MW



---

## UI Specification: Scenario Editor & Persistence Panel

Replace the traditional scenario profile selection dropdowns with a dual-layer workspace view layout containing the editable grid component and action controls.

### 1. Header Actions Toolbar

* **Preset Selector Dropdown:** Allows the user to select from the built-in system scenarios or any saved configurations. Selecting a default preset locks the "Delete" action but permits edits.
* **Save Action Actions:**
* *Save Button:* Overwrites the active configuration (disabled for system presets).
* *Save As... Button:* Spawns a modal window collecting a unique string `name` and descriptive text string. Stores the resulting object array as a custom `ScenarioProfile` inside LocalStorage with `isPreset: false`.


* **Export/Import Actions:** A clean mechanism to download or upload the underlying structural parameter block as a raw `.json` schema file.

### 2. Table Layout Matrix

| Year | Max Consumption (MW) | Constant Baseload (MW) | Solar Capacity (MW) | Wind Capacity (MW) | Nuclear Capacity (MW) | Price Behavior Randomizer |
| --- | --- | --- | --- | --- | --- | --- |
| **2026** | `<input type="number">` | `<input type="number">` | `<input type="number">` | `<input type="number">` | `<input type="number">` | `<input type="slider" min="-0.2" max="0.2">` |
| **2027** | `<input type="number">` | `<input type="number">` | `<input type="number">` | `<input type="number">` | `<input type="number">` | `<input type="slider" min="-0.2" max="0.2">` |
| **2028** | ... | ... | ... | ... | ... | ... |

### UI Component Behaviors

* **Dirty State Tracking Indicator:** If any metric input deviates from the current record base, display a discrete dot marker next to the save actions bar signifying a dirty state workspace.
* **Inline Validation Engine:** Ensures structural boundaries cannot be breached (e.g., `constantBaseload` cannot exceed `maxPowerConsumption`). Emits warning highlights if renewable capacities exceed peak load by more than 300% to signal high negative-price probability.
* **Row Replication Triggers:** A quick-action button on each row labeled "Propagate to Next Year" that clones the current row metrics forward to speed up long-horizon entries.

---

## Core Algorithmic Engine Updates

The pricing synthesis loops over each year $y$ and day $d$, parsing the custom `YearCapacityParams` from the active table matrix.

### Step 1: Base Price Displacement Calculation

Calculate the baseline shift delta ($\Delta \mu_{\text{base}}$) for the year using the physical tension between nuclear supply and constant consumer demand:

$$\Delta \mu_{\text{base}} = \alpha \cdot \left( \frac{\text{constantBaseload}_y - \text{nuclearCapacityMW}_y}{\text{maxPowerConsumption}_y} \right)$$

* *Where $\alpha$ is a market calibration coefficient ($~80$ €/MWh) optimized during the historical backtest run.* This shifts the entire price distribution upwards when baseload runs hot, or downwards when nuclear capacity dominates the mix.

### Step 2: Renewable Share Volatility Scaling

Compute the year's total intermittent renewable dependency ratio ($R_{\text{renew}}$):

$$R_{\text{renew}} = \frac{\text{windCapacityMW}_y + \text{solarCapacityMW}_y}{\text{maxPowerConsumption}_y}$$

Amplify the standard baseline price deviations using this ratio to account for structural market fragmentation:

$$\text{VolatilityMultiplier} = 1.0 + (\beta \cdot R_{\text{renew}})$$

### Step 3: Hourly Price Composition Loop

For each hour $t$ within the target year sequence:

1. Extract historical weather trace coefficients for wind ($\omega_t \in [0,1]$) and solar ($\sigma_t \in [0,1]$).
2. Calculate total available instantaneous renewable generation:

$$P_{\text{renew}, t} = (\text{windCapacityMW}_y \cdot \omega_t) + (\text{solarCapacityMW}_y \cdot \sigma_t)$$

3. Compute the structural **Physical Supply-Demand Gap Factor ($G_t$)**:

$$G_t = \text{maxPowerConsumption}_y - (\text{nuclearCapacityMW}_y + P_{\text{renew}, t})$$

#### Condition A: The Dunkelflaute Surge ($G_t > 0$ and $\omega_t + \sigma_t < 0.08$)

When renewables bottom out completely during a high-load freeze, trigger a localized price shock scaling non-linearly with the system gap:

$$\text{ShockImpact}_t = \theta \cdot \left( \frac{G_t}{\text{maxPowerConsumption}_y} \right)^2 \cdot \text{VolatilityMultiplier}$$

Log a `dunkelflaute_shock` event into the simulation trace registry labeled `"Windless Winter Freeze"`.

#### Condition B: The Oversupply Saturation Zone ($G_t < -\text{constantBaseload}_y$)

When renewable output overpowers all inflexible baseload assets, compress prices directly into negative boundaries:

$$\text{PriceCompression}_t = \lambda \cdot (G_t + \text{constantBaseload}_y)$$

### Step 4: Recompose and Inject Randomizer

Synthesize the hour’s final price by combining the diurnal shape parameters, structural shocks, and the user's explicit behavior adjustment scalar:

$$P_{\text{final}, t} = \Big( \mu_{\text{day}} + \Delta \mu_{\text{base}} + \text{DiurnalResidual}_t \cdot \text{VolatilityMultiplier} + \text{ShockImpact}_t + \text{PriceCompression}_t \Big) \cdot (1.0 + \text{priceRandomizer}_y)$$

---

## UI Chart Overlays & Event Panel Integration

The ECharts panel matches events directly to the physical causes computed in the engine pipeline:

* **`dunkelflaute_shock` Visualizations:** Rendered as translucent orange/blue columns (`markArea`) shading the temporal spans where the weather vectors collapsed to zero.
* **Side-car Sync Control:** Clicking an event labeled *"Severe Windless Void (2027)"* maps the chart window viewport directly to that specific winter week index, instantly visualising how the pricing curve spiked as a result of the capacity layout designed in the table.

---

## Acceptance Criteria

* **Persistence Store Longevity:** Refreshing or unmounting the React app lifecycle boundary accurately saves and reloads user-defined scenarios from LocalStorage under their exact user-specified name keys.
* **Emergent Structural Trends:** Verification tests confirm that setting `nuclearCapacityMW` to double its historical baseline depresses the annual integrated mean price by $\ge 15\%$ without manual multipliers.
* **Insulated Boundary Checks:** The behavioral randomizer field is strictly constrained within the range $[-0.20, +0.20]$. Entering values outside this range throws a validation block inside the UI editor matrix.
* **Table-to-Graph State Binding:** Altering any individual cell capacity metric in the editable grid triggers an automated background recalculation thread, redrawing the chart line coordinates within a 250ms rendering ceiling.

```

### Next Steps for Implementation
1. Save this comprehensive text payload directly over your project's current plan.md file.
2. Initialize Claude Code inside your command terminal interface and target it directly: @plan.md Please generate the ScenarioProfile seed presets, construct the persistence service layer, and link it to our interactive grid UI component.

```