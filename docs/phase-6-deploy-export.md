# Phase 6 — Results dashboard, export, deploy

**Effort:** 1–2 days
**Goal:** Pull every preceding phase together into a polished results dashboard, ship export/import for full analysis bundles, and deploy publicly.

## Results dashboard (`src/features/results/`)

### Layout

Single page with five sections, vertically stacked, each collapsible:

1. **Headline KPIs** — three large cards: NPV, IRR, LCOS. Plus payback (simple + discounted), total revenue, total throughput, retirement year (if any).
2. **Cashflow** — annual cashflow stacked bar chart (revenue, opex, replacement, capex) overlaid with cumulative discounted cashflow line. Table view toggle.
3. **Battery state** — SoH trajectory line, annual EFC, annual MDC. (From Phase 3 diagnostics, surfaced at the top level.)
4. **Sensitivity** — tornado chart from Phase 5 deterministic sensitivity. Click any row to drill into a 1-D curve.
5. **Monte Carlo** — NPV histogram, CDF, P10/P50/P90, rank-correlation tornado, and convergence diagnostic. Only renders if MC has been run; otherwise shows "Run Monte Carlo" CTA.

### KPI presentation

| KPI | Format | Color cue |
|---|---|---|
| NPV | €X.XX M (or k€ for small numbers) | green if > 0, red if < 0 |
| IRR | XX.X % | green if > WACC, amber if 0–WACC, red if < 0 / n/a |
| LCOS | XX.X €/MWh | neutral |
| Simple payback | XX.X years | green if < projectLife/2 |
| Discounted payback | XX.X years | as above |
| Total revenue (nominal) | €X.X M | neutral |
| Total throughput | XX,XXX MWh | neutral |
| Retirement year | "Year N" or "Operates to end" | red if < projectLifeYears |

Each card has an info-icon tooltip explaining the metric.

### Comparison mode

Toggle to compare two configurations side-by-side. Useful for:
- "What if we change scenario?"
- "What if we change battery size?"
- "Default vs. custom parameters"

Stores up to four named snapshots in localStorage; selecting two displays them side-by-side with all KPIs and charts mirrored.

## Export

### Bundle export (the main deliverable)

A single JSON file capturing the entire analysis state, importable to reproduce results exactly:

```ts
type AnalysisBundle = {
  schemaVersion: 1;
  exportedAt: string;
  appVersion: string;                // from package.json
  inputs: Inputs;                    // Phase 2 parameters
  scenario: Scenario;                // Phase 4 scenario (full, not just id, so custom scenarios travel)
  calibrationWindow: { startUtc: string; endUtc: string };
  rngSeed: number;
  monteCarlo?: MCRequest;            // optional, if MC was configured
  results: {
    financials: FinancialResults;
    streams: AnnualStream[];
    sensitivity?: SensitivityResult;
    monteCarlo?: MCResult;           // outcomes truncated to summary + 200 sampled trials to keep file size sane
  };
  notes: string;                     // free-text user notes
};
```

Buttons:
- **Export bundle (JSON)** — downloads `.json`
- **Import bundle (JSON)** — uploads, validates via Zod, restores all state. Re-runs simulation to confirm reproducibility (results in bundle vs. recomputed must match to within numeric tolerance).

### Per-section exports

- Cashflow table → CSV
- Sensitivity rows → CSV
- Monte Carlo outcomes → CSV (one row per trial)
- All charts → PNG (via ECharts' built-in `getDataURL`)

## Notes panel

A markdown-capable freeform notes field in the dashboard, saved with the bundle. Lets the user annotate decisions and assumptions for thesis writeup or stakeholder review.

## Deployment

### Cloudflare Pages (primary)

1. Connect the GitHub repository.
2. Build command: `npm run build`
3. Output directory: `dist/`
4. Environment: none required.
5. Custom domain optional.

Deploys are atomic; preview URLs available per pull request.

### GitHub Pages (fallback)

GitHub Actions workflow `deploy.yml`:

```yaml
name: deploy
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm ci
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build:data
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: dist }
  deploy:
    needs: build
    permissions:
      pages: write
      id-token: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/deploy-pages@v4
```

Configure Vite for relative paths if deploying under a path prefix (`base: "/bess-analyzer/"` in `vite.config.ts`).

## Polish checklist

- Empty-state messaging when no analysis has been run yet.
- Loading indicators on the MC run (covered in Phase 5; surface progress at the top of the dashboard while running).
- Responsive layout: works on a 1440 × 900 laptop without scrolling for the KPI section. Mobile is not a goal but should not crash.
- Light/dark theme toggle (Tailwind dark mode classes, persisted to localStorage).
- Keyboard navigation: tab order traverses the form, dashboard, and main actions.
- Print stylesheet: dashboard prints to A4 cleanly for thesis appendix.
- Favicon + app icon.
- Page title and meta description appropriate for a public deploy.

## Acceptance criteria

- Dashboard renders correctly with the default `Inputs` and the default scenario.
- Comparison mode works for at least two snapshots.
- Bundle export → import round-trips: imported state produces identical `FinancialResults` to within 1e-9.
- CSV exports parse correctly in Excel (UTF-8 with BOM where applicable; comma delimiter; quoted strings).
- PNG export of each major chart produces a non-empty image.
- Notes are persisted in localStorage and in bundle export.
- The site is publicly reachable at a stable URL (Cloudflare Pages preferred).
- Lighthouse performance score ≥ 90 on the deployed page (achievable with the static + small JSON architecture).
- The README (top-level project README — separate from PLAN.md) explains how to load a saved analysis bundle and the meaning of each KPI. (Note: README creation is the only documentation file produced outside the `docs/` folder, and is needed for the public-facing repo.)

## Out of scope for Phase 6

- Multi-user / cloud-saved analyses — bundle JSON files cover sharing.
- Email / Slack notification of completed Monte Carlo runs.
- PDF report generator with branded layout — print-to-PDF from the browser is sufficient.
- Internationalisation — English-only UI. (Adding Finnish later is a localisation pass, not a Phase 6 deliverable.)
- Authentication / private analyses — the deploy is public; sensitive analyses stay local.
