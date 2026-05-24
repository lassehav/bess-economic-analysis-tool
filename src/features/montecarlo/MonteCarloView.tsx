import { useState, useEffect, useRef, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import type { Inputs } from '../../core/types/inputs'
import type { PriceSeries } from '../../core/types/prices'
import type { ScenarioProfile } from '../../core/forecast/types'
import { inputsSchema } from '../../core/types/schemas'
import { calibrateFromHistory } from '../../core/forecast/calibrate'
import { PRESET_SCENARIOS } from '../../core/forecast/scenarios'
import type { MCResult, MCVariableConfig, MCRequest } from '../../core/analysis/montecarlo'
import { DEFAULT_MC_VARIABLES, DEFAULT_MC_CORRELATIONS, histogram } from '../../core/analysis/montecarlo'
import type { SimulationRequest } from '../../core/analysis/run'
import MCWorker from '../../core/analysis/mc.worker.ts?worker'

// ---------------------------------------------------------------------------
// Default inputs (same as other views)
// ---------------------------------------------------------------------------

const DEFAULT_INPUTS: Inputs = {
  battery: {
    powerMW: 10,
    energyMWh: 40,
    roundTripEfficiency: 0.85,
    dod: 0.9,
    maxCyclesPerDay: 2,
    nominalCycleLifeEFC: 6000,
    calendarLifeYears: 15,
    cyclesPerDayPenaltyExponent: 1.5,
    endOfLifeSoH: 0.80,
  },
  costs: {
    batteryCapexPerKWh: 200,
    pcsCapexPerKW: 80,
    bopCapexPercentOfBatteryPcs: 20,
    developmentCapexPercent: 8,
    contingencyPercent: 10,
    pcsReplacementIntervalYears: 12,
    pcsReplacementCostPercentOfPcs: 80,
    fixedOmPerKWPerYear: 6,
    variableOmPerMWhThroughput: 0.5,
    insurancePercentOfCapexPerYear: 0.5,
    landLeasePerYear: 0,
    gridFeePerMWhThroughput: 1.0,
    gridFeePerKWPerYear: 0,
    inflationPercentPerYear: 2.0,
    omEscalationPercentPerYear: 0.5,
  },
  finance: {
    projectLifeYears: 20,
    wacc: 6.0,
    taxRate: 20,
    depreciationYears: 15,
    residualValuePercentOfInitialCapex: 5,
  },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadInputsFromStorage(): Inputs {
  try {
    const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? '')
    const parsed = inputsSchema.safeParse(raw)
    if (parsed.success) return parsed.data as Inputs
  } catch {
    // ignore
  }
  return DEFAULT_INPUTS
}

function loadScenarioFromStorage(): ScenarioProfile {
  try {
    const raw = localStorage.getItem('bess-analyzer.activeScenario')
    if (raw) return JSON.parse(raw) as ScenarioProfile
  } catch {
    // ignore
  }
  return PRESET_SCENARIOS[0]!
}

function fmt0(v: number): string {
  return v.toLocaleString('fi-FI', { maximumFractionDigits: 0 })
}

function fmtPct(v: number): string {
  return `${(v * 100).toFixed(1)} %`
}

// ---------------------------------------------------------------------------
// Metric chip
// ---------------------------------------------------------------------------

function MetricChip({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div
      className={[
        'flex flex-col items-center rounded border px-4 py-2',
        accent ? 'border-blue-200 bg-blue-50' : 'border-gray-200',
      ].join(' ')}
    >
      <span className={`text-xs ${accent ? 'text-blue-500' : 'text-gray-500'}`}>{label}</span>
      <span className={`mt-0.5 text-sm font-semibold ${accent ? 'text-blue-700' : 'text-black'}`}>
        {value}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Histogram chart
// ---------------------------------------------------------------------------

function HistogramChart({
  values,
  title,
  xName,
  bins = 30,
  color = '#2563eb',
}: {
  values: number[]
  title: string
  xName: string
  bins?: number
  color?: string
}) {
  const { x, counts } = histogram(values, bins)

  const option = {
    title: { text: title, textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 50, right: 20, top: 40, bottom: 40 },
    xAxis: {
      type: 'category',
      data: x.map((v) => fmt0(v)),
      name: xName,
      nameLocation: 'middle',
      nameGap: 28,
      axisLabel: { rotate: 30, fontSize: 10 },
    },
    yAxis: { type: 'value', name: 'Count' },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const items = params as Array<{ name: string; value: number }>
        if (!items.length) return ''
        return `${xName} ≈ ${items[0]!.name}<br/>Count: ${items[0]!.value}`
      },
    },
    series: [
      {
        type: 'bar',
        data: counts,
        itemStyle: { color },
        barCategoryGap: '2%',
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 260 }} />
}

// ---------------------------------------------------------------------------
// CDF chart
// ---------------------------------------------------------------------------

function CdfChart({ values, title }: { values: number[]; title: string }) {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const data = sorted.map((v, i) => [v, ((i + 1) / n) * 100])

  const option = {
    title: { text: title, textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'value', name: 'NPV (€)', nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'value', name: 'Cumulative %', min: 0, max: 100 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const items = params as Array<{ value: [number, number] }>
        if (!items.length) return ''
        return `NPV: ${fmt0(items[0]!.value[0])} €<br/>CDF: ${items[0]!.value[1].toFixed(1)} %`
      },
    },
    series: [
      {
        type: 'line',
        data,
        showSymbol: false,
        lineStyle: { color: '#2563eb' },
        areaStyle: { color: 'rgba(37, 99, 235, 0.08)' },
        markLine: {
          silent: true,
          data: [{ yAxis: 50, lineStyle: { color: '#9ca3af', type: 'dashed' } }],
        },
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 260 }} />
}

// ---------------------------------------------------------------------------
// Convergence chart
// ---------------------------------------------------------------------------

function ConvergenceChart({
  npvValues,
  stableAt,
}: {
  npvValues: number[]
  stableAt: number | null
}) {
  // Running mean series (every 10th point for performance)
  const step = Math.max(1, Math.floor(npvValues.length / 200))
  const data: [number, number][] = []
  let sum = 0
  for (let i = 0; i < npvValues.length; i++) {
    sum += npvValues[i]!
    if (i % step === 0 || i === npvValues.length - 1) {
      data.push([i + 1, sum / (i + 1)])
    }
  }

  const markLines: object[] = []
  if (stableAt !== null) {
    markLines.push({
      xAxis: stableAt,
      label: { formatter: `Stable @${stableAt}` },
      lineStyle: { color: '#16a34a', type: 'dashed' },
    })
  }

  const option = {
    title: {
      text: 'Convergence: Running Mean NPV',
      textStyle: { fontSize: 13, fontWeight: 600 },
    },
    grid: { left: 70, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'value', name: 'Trial #', nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'value', name: 'Running mean NPV (€)' },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const items = params as Array<{ value: [number, number] }>
        if (!items.length) return ''
        return `Trial ${items[0]!.value[0]}: ${fmt0(items[0]!.value[1])} €`
      },
    },
    series: [
      {
        type: 'line',
        data,
        showSymbol: false,
        lineStyle: { color: '#7c3aed' },
        markLine: markLines.length > 0 ? { silent: true, data: markLines } : undefined,
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 240 }} />
}

// ---------------------------------------------------------------------------
// Retirement histogram
// ---------------------------------------------------------------------------

function RetirementChart({ outcomes }: { outcomes: MCResult['outcomes'] }) {
  const retired = outcomes.filter((o) => o.retiredAtYear !== null)
  if (retired.length === 0) return null

  const counts: Record<number, number> = {}
  for (const o of retired) {
    const y = o.retiredAtYear!
    counts[y] = (counts[y] ?? 0) + 1
  }
  const years = Object.keys(counts)
    .map(Number)
    .sort((a, b) => a - b)

  const option = {
    title: {
      text: 'Early Retirement Distribution',
      textStyle: { fontSize: 13, fontWeight: 600 },
    },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: years.map(String), name: 'Year' },
    yAxis: { type: 'value', name: 'Count' },
    tooltip: { trigger: 'axis' },
    series: [
      {
        type: 'bar',
        data: years.map((y) => counts[y]!),
        itemStyle: { color: '#f97316' },
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 220 }} />
}

// ---------------------------------------------------------------------------
// Variable configuration row
// ---------------------------------------------------------------------------

function DistLegend() {
  return (
    <div className="rounded border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600">
      <span className="font-semibold text-gray-700">Distribution parameters: </span>
      <span className="font-medium">μ</span> = mean (center of the distribution) ·{' '}
      <span className="font-medium">σ</span> = standard deviation (spread/width) ·{' '}
      <span className="font-medium">μ_ln / σ_ln</span> = mean and std of the underlying log, used
      for log-normal variables that must stay positive (e.g., CAPEX, O&M) — roughly,{' '}
      <span className="font-medium">μ_ln ≈ ln(median)</span> and larger σ_ln means a fatter upper
      tail. Triangular uses <span className="font-medium">(low, mode, high)</span>.
    </div>
  )
}

function VariableRow({
  variable,
  enabled,
  onToggle,
}: {
  variable: MCVariableConfig
  enabled: boolean
  onToggle: () => void
}) {
  const d = variable.distribution

  function distSummary(): string {
    switch (d.kind) {
      case 'fixed': return `Fixed: ${d.value.toFixed(2)}`
      case 'uniform': return `Uniform [${d.low.toFixed(2)}, ${d.high.toFixed(2)}]`
      case 'triangular': return `Triangular (low=${d.low.toFixed(1)}, mode=${d.mode.toFixed(1)}, high=${d.high.toFixed(1)})`
      case 'normal': return `Normal μ=${d.mean.toFixed(2)}, σ=${d.stddev.toFixed(2)}`
      case 'lognormal': return `Log-normal μ_ln=${d.meanLog.toFixed(2)}, σ_ln=${d.sigmaLog.toFixed(2)}`
      case 'discrete': return `Discrete (${d.values.length} values)`
    }
  }

  return (
    <div className="flex items-center gap-3 border-b border-gray-100 py-1.5">
      <input
        type="checkbox"
        checked={enabled}
        onChange={onToggle}
        className="h-4 w-4 rounded border-gray-300 text-blue-600"
      />
      <span className="w-36 text-sm font-medium text-gray-800">{variable.label}</span>
      <span className="text-xs text-gray-500">{distSummary()}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

type WorkerStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

export default function MonteCarloView() {
  const [priceSeries, setPriceSeries] = useState<PriceSeries | null>(null)
  const [trials, setTrials] = useState(2000)
  const [seed, setSeed] = useState(42)
  const [showConfig, setShowConfig] = useState(true)
  const [showCorrelations, setShowCorrelations] = useState(false)
  const [status, setStatus] = useState<WorkerStatus>('idle')
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<MCResult | null>(null)
  const [enabledKeys, setEnabledKeys] = useState<Set<string>>(new Set())
  const [defaultVars, setDefaultVars] = useState<MCVariableConfig[]>([])

  const workerRef = useRef<Worker | null>(null)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setPriceSeries(data))
      .catch(() => {})
  }, [])

  // Initialise default variables once price series is available
  useEffect(() => {
    if (!priceSeries) return
    const inputs = loadInputsFromStorage()
    const scenario = loadScenarioFromStorage()
    const calibration = calibrateFromHistory(priceSeries)
    const baseReq: SimulationRequest = { inputs, scenario, calibration, rngSeed: 42 }
    const vars = DEFAULT_MC_VARIABLES(baseReq)
    setDefaultVars(vars)
    setEnabledKeys(new Set(vars.map((v) => v.key)))
  }, [priceSeries])

  const buildMCRequest = useCallback((): MCRequest | null => {
    if (!priceSeries || defaultVars.length === 0) return null
    const inputs = loadInputsFromStorage()
    const scenario = loadScenarioFromStorage()
    const calibration = calibrateFromHistory(priceSeries)
    const base: SimulationRequest = { inputs, scenario, calibration, rngSeed: seed }
    const variables = defaultVars.filter((v) => enabledKeys.has(v.key))
    return {
      base,
      variables,
      correlations: DEFAULT_MC_CORRELATIONS.filter(
        (c) => enabledKeys.has(c.varA) && enabledKeys.has(c.varB),
      ),
      trials,
      rngSeed: seed,
    }
  }, [priceSeries, defaultVars, enabledKeys, trials, seed])

  function handleRun() {
    const req = buildMCRequest()
    if (!req) return

    // Terminate any existing worker
    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }

    setStatus('running')
    setProgress(0)
    setResult(null)

    const worker = new MCWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; completed?: number; total?: number; result?: MCResult; error?: string }
      if (msg.type === 'progress') {
        setProgress(((msg.completed ?? 0) / (msg.total ?? 1)) * 100)
      } else if (msg.type === 'result') {
        setResult(msg.result ?? null)
        setStatus('done')
        setProgress(100)
        workerRef.current = null
      } else if (msg.type === 'error') {
        console.error('MC worker error:', msg.error)
        setStatus('error')
        workerRef.current = null
      }
    }

    worker.onerror = (e: ErrorEvent) => {
      console.error('MC worker uncaught:', e)
      setStatus('error')
      workerRef.current = null
    }

    worker.postMessage(req)
  }

  function handleCancel() {
    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }
    setStatus('cancelled')
  }

  function toggleVariable(key: string) {
    setEnabledKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const summary = result?.summary

  const completedTrials = Math.round((progress / 100) * trials)

  return (
    <div className="flex flex-col gap-4">
      {/* Context banner */}
      <div className="rounded border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <span className="font-semibold">What this operates on: </span>
        Your <span className="font-medium">Parameters</span> (step 2) and the active{' '}
        <span className="font-medium">Scenario</span> (step 3). Unlike sensitivity (one variable at
        a time), Monte Carlo samples <span className="italic">all</span> stochastic variables
        simultaneously using their full distributions and the correlation matrix — producing a
        realistic joint distribution of outcomes. Each trial runs a complete 20-year simulation.
        Historical prices are used only for calibrating the price generator baseline.
      </div>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 pb-3">
        <h2 className="text-lg font-semibold">Monte Carlo Simulation</h2>

        <button
          type="button"
          onClick={handleRun}
          disabled={!priceSeries || status === 'running'}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Run Monte Carlo
        </button>

        {status === 'done' && (
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            Done — {trials} trials
          </span>
        )}
        {status === 'cancelled' && (
          <span className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">
            Cancelled
          </span>
        )}
        {status === 'error' && (
          <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
            Error
          </span>
        )}
        {!priceSeries && (
          <span className="text-xs text-gray-400">Waiting for price data...</span>
        )}
      </div>

      {/* Progress bar — shown while running */}
      {status === 'running' && (
        <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-blue-800">
              Running… {completedTrials} / {trials} trials ({progress.toFixed(0)} %)
            </span>
            <button
              type="button"
              onClick={handleCancel}
              className="rounded border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100"
            >
              Cancel
            </button>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-blue-200">
            <div
              className="h-full rounded-full bg-blue-600 transition-all duration-300"
              style={{ width: `${progress.toFixed(0)}%` }}
            />
          </div>
        </div>
      )}

      {/* Configuration panel */}
      <div className="rounded border border-gray-200">
        <button
          type="button"
          onClick={() => setShowConfig((v) => !v)}
          className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-semibold hover:bg-gray-50"
        >
          <span>Configuration</span>
          <span className="text-gray-400">{showConfig ? '▲' : '▼'}</span>
        </button>

        {showConfig && (
          <div className="border-t border-gray-200 px-4 pb-4 pt-3">
            <div className="flex flex-wrap gap-6">
              {/* Trials slider */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-600">
                  Trials: <span className="text-black">{trials}</span>
                </label>
                <input
                  type="range"
                  min={100}
                  max={5000}
                  step={100}
                  value={trials}
                  onChange={(e) => setTrials(Number(e.target.value))}
                  className="w-48"
                />
                <div className="flex justify-between text-xs text-gray-400">
                  <span>100</span>
                  <span>5000</span>
                </div>
              </div>

              {/* Seed */}
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-600">RNG Seed</label>
                <input
                  type="number"
                  value={seed}
                  onChange={(e) => setSeed(Number(e.target.value))}
                  className="w-24 rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>

            {/* Variables */}
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                Stochastic Variables ({enabledKeys.size} / {defaultVars.length} enabled)
              </h4>
              <DistLegend />
              <div className="mt-2 max-h-64 overflow-y-auto">
                {defaultVars.map((v) => (
                  <VariableRow
                    key={v.key}
                    variable={v}
                    enabled={enabledKeys.has(v.key)}
                    onToggle={() => toggleVariable(v.key)}
                  />
                ))}
              </div>
            </div>

            {/* Correlations (advanced) */}
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowCorrelations((v) => !v)}
                className="text-xs text-blue-600 hover:underline"
              >
                {showCorrelations ? 'Hide' : 'Show'} correlations
              </button>
              {showCorrelations && (
                <div className="mt-2 overflow-x-auto">
                  <table className="text-xs">
                    <thead>
                      <tr className="border-b border-gray-200">
                        <th className="pb-1 text-left font-semibold text-gray-600">Variable A</th>
                        <th className="pb-1 px-4 text-left font-semibold text-gray-600">Variable B</th>
                        <th className="pb-1 text-right font-semibold text-gray-600">ρ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {DEFAULT_MC_CORRELATIONS.map((c, i) => (
                        <tr key={i} className="border-b border-gray-100">
                          <td className="py-1 text-gray-700">{c.varA}</td>
                          <td className="py-1 px-4 text-gray-700">{c.varB}</td>
                          <td className="py-1 text-right font-medium">{c.rho.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Results */}
      {result === null && status === 'idle' && (
        <div className="flex h-48 items-center justify-center rounded-lg border border-gray-200 text-sm text-gray-400">
          Configure and press Run Monte Carlo to start.
        </div>
      )}

      {summary && result && (
        <div className="flex flex-col gap-6">
          {/* Key metric chips */}
          <div className="flex flex-wrap gap-3">
            <MetricChip label="P10 NPV" value={`${fmt0(summary.npv.p10)} €`} />
            <MetricChip label="P50 NPV" value={`${fmt0(summary.npv.p50)} €`} accent />
            <MetricChip label="P90 NPV" value={`${fmt0(summary.npv.p90)} €`} />
            <MetricChip label="P(NPV > 0)" value={fmtPct(summary.pNpvPositive)} accent={summary.pNpvPositive > 0.5} />
            <MetricChip
              label="IRR P50"
              value={summary.irr.p50 !== null ? `${summary.irr.p50.toFixed(1)} %` : '—'}
            />
            <MetricChip label="LCOS P50" value={`${summary.lcos.p50.toFixed(2)} €/MWh`} />
            <MetricChip label="P(Early retire)" value={fmtPct(summary.pRetiresEarly)} />
            {result.convergence.trialsTo90PctStable !== null && (
              <MetricChip
                label="Stable @"
                value={`trial ${result.convergence.trialsTo90PctStable}`}
              />
            )}
          </div>

          {/* NPV stats strip */}
          <div className="rounded border border-gray-200 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              NPV Distribution Statistics
            </h3>
            <div className="flex flex-wrap gap-4 text-sm">
              <span><span className="text-gray-500">Mean:</span> {fmt0(summary.npv.mean)} €</span>
              <span><span className="text-gray-500">Std:</span> {fmt0(summary.npv.std)} €</span>
              <span><span className="text-gray-500">Min:</span> {fmt0(summary.npv.min)} €</span>
              <span><span className="text-gray-500">Max:</span> {fmt0(summary.npv.max)} €</span>
            </div>
          </div>

          {/* Charts */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded border border-gray-200 p-4">
              <HistogramChart
                values={result.outcomes.map((o) => o.npv)}
                title="NPV Distribution"
                xName="NPV (€)"
              />
            </div>
            <div className="rounded border border-gray-200 p-4">
              <CdfChart
                values={result.outcomes.map((o) => o.npv)}
                title="NPV Cumulative Distribution"
              />
            </div>
            <div className="rounded border border-gray-200 p-4">
              <HistogramChart
                values={result.outcomes.map((o) => o.lcos)}
                title="LCOS Distribution"
                xName="LCOS (€/MWh)"
                color="#7c3aed"
              />
            </div>
            <div className="rounded border border-gray-200 p-4">
              <ConvergenceChart
                npvValues={result.outcomes.map((o) => o.npv)}
                stableAt={result.convergence.trialsTo90PctStable}
              />
            </div>
          </div>

          {/* Retirement chart */}
          {summary.pRetiresEarly > 0 && (
            <div className="rounded border border-gray-200 p-4">
              <RetirementChart outcomes={result.outcomes} />
            </div>
          )}

          {/* IRR distribution (if available) */}
          {result.outcomes.some((o) => o.irr !== null) && (
            <div className="rounded border border-gray-200 p-4">
              <HistogramChart
                values={result.outcomes.filter((o) => o.irr !== null).map((o) => o.irr! * 100)}
                title="IRR Distribution"
                xName="IRR (%)"
                color="#16a34a"
              />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
