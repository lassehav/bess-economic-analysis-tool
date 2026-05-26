# BESS Analyzer

A browser-based economic analysis tool for Battery Energy Storage Systems (BESS) operating in the Finnish day-ahead electricity market. Built as a thesis project at OAMK.

The tool walks through a seven-step workflow — from historical market data exploration to Monte Carlo risk quantification — and outputs key investment metrics (NPV, IRR, LCOS) for a user-defined battery project.

---

## What it does

**Step 1 — Historical Data**
Loads real Finnish spot price data (Nord Pool FI area) and measures the actual arbitrage opportunity: daily spread statistics, price volatility, and how much a battery could have earned dispatching on historical prices.

**Step 2 — Parameters**
Define the battery system (power MW, energy MWh, round-trip efficiency, cycle life) and the full cost structure: CAPEX breakdown (battery cells, PCS, BoP, development, contingency), annual OPEX (O&M, insurance, land lease, grid fees), and project finance assumptions (WACC, tax rate, depreciation, project life).

**Step 3 — Scenarios**
Build a multi-year market forecast. The scenario engine synthesises future hourly prices from grid capacity parameters (solar, wind, nuclear, BESS, flexible load) calibrated to Finnish historical patterns. Includes stochastic events: dunkelflaute shocks, generation outages, and demand spikes. Three preset profiles are provided (baseline, bearish, bullish); the scenario table is fully editable year-by-year.

**Step 4 — Simulation**
Run a deterministic projection across the project lifetime using either historical prices or the synthetic scenario. The dispatch engine applies a daily maximum-spread heuristic with State of Health degradation. Outputs annual cashflows, cumulative NPV curve, and a full cashflow table.

**Step 5 — Sensitivity**
One-at-a-time sensitivity analysis across all key parameters. Shows which inputs (CAPEX, WACC, spread, cycle life, etc.) have the largest impact on NPV, IRR, and LCOS.

**Step 6 — Monte Carlo**
Correlated sampling of uncertain parameters across thousands of trials (runs in a Web Worker). Outputs probability distributions for NPV, IRR, and LCOS; percentile table (P10/P50/P90); and a risk summary.

**Step 7 — Results**
Consolidated summary of all metrics with export.

---

## Tech stack

- React 18 + TypeScript
- Vite (build tool)
- Tailwind CSS
- ECharts (charts)
- Zustand (state)
- Zod + React Hook Form (parameter validation)
- Vitest (unit tests)

Runs entirely in the browser — no backend, no API keys, no server.

---

## Installation

Requires [Node.js](https://nodejs.org/) 18 or later.

```bash
git clone https://github.com/lassehav/bess-economic-analysis-tool.git
cd bess-economic-analysis-tool
npm install
```

---

## Running locally

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

---

## Building for production

```bash
npm run build
```

Output goes to `dist/`. Any static host works (Cloudflare Pages, Vercel, GitHub Pages, Nginx).

---

## Running tests

```bash
npm test
```

---

## Data

Historical Finnish spot price CSV files (Nord Pool FI area, hourly) are included in the repository root. The app loads them directly in the browser via PapaParse — no pre-processing required.