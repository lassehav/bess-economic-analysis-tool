# BESS LCOS & Economic Profitability Analyzer — Plan

A client-side single-page application that evaluates the levelized cost of storage (LCOS) and economic profitability of a battery energy storage system (BESS) operating arbitrage in the Finnish (FI) bidding zone.

## Scope

- **Revenue stream:** Day-ahead arbitrage only. Reserve markets (FCR-N / FCR-D / aFRR) are explicitly out of scope.
- **Geography:** FI bidding zone. Historical data: ENTSO-E day-ahead prices for 2024–2026 partial (~2.5 years), already in repo.
- **Deployment:** Fully static SPA, zero compute cost. No backend required.
- **Audience:** Demo and thesis-grade analytical tool. Not for live investment decisions.

## Design philosophy

1. **Daily resolution.** The simulation steps day-by-day. Hourly/15-min simulation is rejected: at multi-year horizons it amounts to modeling weather noise and offers spurious precision.
2. **Parameterized scenarios over hourly forecasting.** Future price series are not predicted hour-by-hour. Instead, historical data is reduced to a small set of daily parameters (spread distribution, window count, peak duration, negative-hour share, level, volatility), and scenarios are defined as per-year trajectories of multipliers applied to these parameters.
3. **Battery-duration aware.** Arb-window detection adjusts to the battery's energy-to-power ratio `D = E_rated / P_rated`. Volume-weighted average prices (VWAP) are used over the D cheapest / D most expensive hours of each historical day. Short spikes against long-duration batteries yield only partial-capacity captures.
4. **Marginal Degradation Cost (MDC) gate.** Dispatch decisions are gated by `effective_margin × η_RTE > MDC × activation_threshold`, where MDC is recomputed each day from replacement CAPEX and remaining throughput. This makes degradation an active dispatch decision, not a passive cost, and naturally idles the battery on low-spread days.
5. **Non-linear degradation with knee.** SoH follows a square-root-of-time calendar term plus a cycle term modulated by DoD, cycles-per-day, and a knee acceleration once SoH crosses a threshold.
6. **Transparency over sophistication.** Every parameter is user-visible and user-tunable. No fitted black-box models. All assumptions defensible at thesis quality.

## Architecture overview

```
┌────────────────────────────────────────────────────────────────┐
│ Browser (static SPA — Vite + React + TypeScript)               │
│                                                                │
│  ┌──────────────┐   ┌─────────────────┐   ┌─────────────────┐  │
│  │ Parameter UI │   │ Historical data │   │ Scenario editor │  │
│  └──────┬───────┘   │ + statistics    │   └────────┬────────┘  │
│         │           └────────┬────────┘            │           │
│         │                    │                     │           │
│         ▼                    ▼                     ▼           │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Daily simulation engine                                 │   │
│  │   per day: window detection → MDC gate → dispatch →     │   │
│  │            degradation → revenue                        │   │
│  └────────────────────────┬────────────────────────────────┘   │
│                           │                                    │
│         ┌─────────────────┼──────────────────┐                 │
│         ▼                 ▼                  ▼                 │
│  ┌─────────────┐  ┌──────────────┐   ┌────────────────────┐    │
│  │ Economics   │  │ Sensitivity  │   │ Monte Carlo        │    │
│  │ LCOS/NPV/   │  │ tornado      │   │ (configurable      │    │
│  │ IRR/payback │  │              │   │  distributions)    │    │
│  └─────────────┘  └──────────────┘   └────────────────────┘    │
│                           │                                    │
│                           ▼                                    │
│                  ┌────────────────────┐                        │
│                  │ Results + export   │                        │
│                  └────────────────────┘                        │
└────────────────────────────────────────────────────────────────┘
```

All computation runs in the browser. The historical data is bundled at build time as a parsed JSON blob. No API calls, no server-side state.

## Stack

- Vite + React + TypeScript
- Tailwind CSS
- Recharts (or ECharts — decision in Phase 0) for visualization
- PapaParse for one-time CSV ingestion at build time
- Zod for parameter validation
- Vitest for unit tests on calculation functions
- Cloudflare Pages or GitHub Pages for deployment

## Phases

| # | Title | Estimated effort | Deliverable |
|---|---|---|---|
| 0 | [Scaffold](docs/phase-0-scaffold.md) | ½ day | Buildable empty app, deploy pipeline |
| 1 | [Data ingestion & historical statistics](docs/phase-1-data-statistics.md) | 2 days | Statistics extractor + historical explorer UI |
| 2 | [Parameter UI & economics core](docs/phase-2-parameters-economics.md) | 2–3 days | Forms + LCOS/NPV/IRR calculators (unit tested) |
| 3 | [Daily simulation engine](docs/phase-3-simulation-engine.md) | 3 days | Multi-year day-step simulator with MDC gate + non-linear degradation |
| 4 | [Scenarios & forecast](docs/phase-4-scenarios-forecast.md) | 5–7 days | Scenario library, trajectory editor, synthetic parameter generator, backtest validation |
| 5 | [Sensitivity & Monte Carlo](docs/phase-5-sensitivity-montecarlo.md) | 3–5 days | Tornado chart + MC with configurable distributions |
| 6 | [Results, export, deploy](docs/phase-6-deploy-export.md) | 1–2 days | Polished UI, CSV/JSON export, public deployment |

Total: ~17–24 days of focused work.

## Default scenario thesis (FI market)

The pre-selected scenario is **Demand-Driven Tightening**, reflecting:

- > 3 GW of district-heating electric boilers installed in the last year
- Substantial data center pipeline planned for 10–15 years
- Both drivers raise levels and volatility
- Supply response (wind, solar, batteries, possibly new nuclear, hydrogen/e-fuels) follows with a multi-year lag

Scenario library also includes Status Quo, Renewable Surge, Balanced Build-out, New Nuclear (post-~2035), and Hydrogen / Flexible Demand Floor. All are editable; users can clone and modify, or define a fully custom multiplier trajectory.

## Glossary

| Term | Definition |
|---|---|
| **BESS** | Battery Energy Storage System |
| **LCOS** | Levelized Cost of Storage (€/MWh discharged) — total NPV of system costs divided by NPV of energy throughput |
| **SoH** | State of Health — fraction of original capacity remaining (1.0 = new, 0.80 = typical EoL convention) |
| **DoD** | Depth of Discharge — fraction of capacity used per cycle |
| **EFC** | Equivalent Full Cycle — one full charge + discharge at rated DoD |
| **RTE** | Round-Trip Efficiency — fraction of energy retained from grid-in to grid-out |
| **MDC** | Marginal Degradation Cost (€/MWh discharged) — replacement value of the capacity consumed per MWh of throughput |
| **VWAP** | Volume-Weighted Average Price |
| **D** | Battery duration = E_rated / P_rated (hours) |
| **Arb window** | A paired charge block and subsequent discharge block within a single day |
| **Activation threshold** | Multiplier on MDC that gates dispatch; default 1.0, operators typically 1.5–2.0 |
| **Knee point** | SoH threshold (default 0.80) below which degradation rate accelerates |

## Open decisions tracker

These are settled as of this writing. Re-open if requirements shift.

| Decision | Resolution | Date |
|---|---|---|
| Revenue streams | Arbitrage only | 2026-05-21 |
| Backend | None | 2026-05-21 |
| Simulation resolution | Daily | 2026-05-21 |
| Forecast approach | Parameterized scenarios with multiplier trajectories | 2026-05-21 |
| Arb-window detection | Battery-duration aware, VWAP over top-D / bottom-D hours | 2026-05-21 |
| Dispatch gate | MDC × activation_threshold | 2026-05-21 |
| Degradation | Non-linear, sqrt-time calendar + cycle term + DoD/C-rate factors + knee | 2026-05-21 |
| Hourly engine | Skipped entirely | 2026-05-21 |
| Backtest as first-class feature | Pending user input — assumed yes for now | — |
| 15-min data support | Deferred; downsample to hourly during ingestion | 2026-05-21 |
