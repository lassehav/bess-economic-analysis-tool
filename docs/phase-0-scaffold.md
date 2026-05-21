# Phase 0 — Scaffold

**Effort:** ½ day
**Goal:** A buildable empty SPA with the chosen stack, lint/test/format set up, and a working static-deploy pipeline.

## Stack choices (final)

| Concern | Choice | Rationale |
|---|---|---|
| Build tool | **Vite** | Fast dev server, simple static output |
| Framework | **React 18 + TypeScript** | Component model, broad ecosystem |
| Styling | **Tailwind CSS** | Speed without committing to a component library |
| Charts | **ECharts** (via `echarts-for-react`) | Better at large datasets, candlestick/heatmap support, more control than Recharts |
| Forms / validation | **react-hook-form** + **Zod** | Performant + schema validation reusable in calculator boundary |
| State | **Zustand** | Simple, no boilerplate; serializable for localStorage save/load |
| CSV | **PapaParse** | Used at build time only |
| Math | Plain TS; **`mathjs`** only if needed for stats not in plain JS | Avoid bloat |
| Tests | **Vitest** + **@testing-library/react** | Native Vite integration |
| Lint | **ESLint** + **Prettier** | Standard |
| Deploy | **Cloudflare Pages** (primary) or **GitHub Pages** (fallback) | Free, fast, simple |

## Project structure

```
bess-analyzer/
├── public/
│   └── data/
│       └── fi-prices.json          # built artifact (Phase 1)
├── src/
│   ├── app/                        # top-level App, routing if any
│   │   ├── App.tsx
│   │   └── main.tsx
│   ├── features/                   # feature-scoped UI + logic
│   │   ├── historical/             # Phase 1
│   │   ├── parameters/             # Phase 2
│   │   ├── simulation/             # Phase 3
│   │   ├── scenarios/              # Phase 4
│   │   ├── sensitivity/            # Phase 5
│   │   ├── montecarlo/             # Phase 5
│   │   └── results/                # Phase 6
│   ├── core/                       # pure logic (no React)
│   │   ├── economics/              # LCOS, NPV, IRR, payback
│   │   ├── battery/                # SoH, MDC, degradation
│   │   ├── dispatch/               # window detection, daily dispatch
│   │   ├── stats/                  # historical statistics extractor
│   │   ├── forecast/               # synthetic parameter generator
│   │   └── types/                  # shared TS types
│   ├── ui/                         # shared presentational components
│   ├── state/                      # Zustand stores
│   └── styles/                     # Tailwind config inputs
├── scripts/
│   └── build-prices-json.ts        # one-time CSV → JSON converter
├── docs/                           # plan + phase specs (this file)
├── tests/                          # cross-cutting integration tests
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
├── .eslintrc.cjs
├── .prettierrc
└── PLAN.md
```

**Convention:** `src/core/` is React-free pure TypeScript. All calculator logic lives there. `src/features/` contains UI that calls into `src/core/`. This boundary makes unit testing trivial and allows the calculation engine to be reused (e.g., from a CLI later if wanted).

## TypeScript configuration

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`
- Path alias `@/*` → `src/*`

## Setup tasks

1. `npm create vite@latest bess-analyzer -- --template react-ts`
2. Install deps: `react-hook-form zod zustand echarts echarts-for-react papaparse tailwindcss postcss autoprefixer`
3. Dev deps: `vitest @testing-library/react @testing-library/jest-dom @types/papaparse eslint prettier eslint-config-prettier`
4. Configure Tailwind (`npx tailwindcss init -p`)
5. Configure path alias in `tsconfig.json` and `vite.config.ts`
6. Configure Vitest (`vitest.config.ts` or inline in `vite.config.ts`)
7. Add `.editorconfig`, `.gitignore`, `.prettierignore`
8. Create skeleton `App.tsx` showing a "BESS Analyzer" header and tab placeholder for each feature folder
9. Add a "smoke test" in Vitest that imports `App` and renders it
10. Add npm scripts: `dev`, `build`, `preview`, `test`, `test:watch`, `typecheck`, `lint`, `format`
11. Set up Cloudflare Pages project (or GitHub Pages workflow) pointing at the repo's `dist/`

## CI (optional but recommended)

GitHub Actions workflow that runs on every PR:
- `npm ci`
- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`

## Acceptance criteria

- `npm run dev` opens a working page showing the placeholder header
- `npm run build` produces a `dist/` folder
- `npm run test` passes the smoke test
- `npm run typecheck` passes with zero errors
- A deployed preview URL is reachable (Cloudflare Pages or GitHub Pages)
- Folder layout matches the convention above; `src/core/` exists and is empty-but-typed

## Out of scope for Phase 0

- Any actual feature logic (parameters, simulation, charts) — those belong to later phases
- CSV parsing — Phase 1
- Styling beyond a basic header — later phases
- Routing — defer until needed (the app may fit on a single page with tabs)
