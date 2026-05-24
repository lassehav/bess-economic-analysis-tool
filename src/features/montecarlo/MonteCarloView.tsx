import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
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
// Default inputs
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
    pcsCapex: 800_000,
    bopCapex: 1_760_000,
    developmentCapexPercent: 8,
    contingencyPercent: 10,
    pcsReplacementIntervalYears: 12,
    pcsReplacementCostPercentOfPcs: 80,
    fixedOmPerYear: 60_000,
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
// Standardized Financial Metric Chips
// ---------------------------------------------------------------------------
function MetricChip({ label, value, accent, tooltip }: { label: string; value: string; accent?: boolean; tooltip?: string }) {
  return (
    <div
      title={tooltip}
      className={[
        'flex flex-col items-center rounded border px-4 py-2 cursor-help',
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
// Retirement histogram
// ---------------------------------------------------------------------------

function RetirementChart({ outcomes, projectLifeYears }: { outcomes: MCResult['outcomes']; projectLifeYears: number }) {
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
      text: 'Early Retirement Distribution (SoH falls below threshold before the end of project life)',
      textStyle: { fontSize: 13, fontWeight: 600 },
    },
    grid: { left: 50, right: 20, top: 40, bottom: 45 },
    xAxis: { type: 'category', data: years.map(String), name: `Retirement year (of ${projectLifeYears})`, nameLocation: 'middle', nameGap: 28 },
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
// Distribution legend
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

// ---------------------------------------------------------------------------
// Variable configuration row
// ---------------------------------------------------------------------------

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

type WorkerStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

export default function MonteCarloView() {
  const [priceSeries, setPriceSeries] = useState<PriceSeries | null>(null)
  const [trials, setTrials] = useState(300)
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

  // Fix: Derive variables layout configuration directly from the source of truth to avoid state desyncs
  const activeVariablesPayload = useMemo(() => {
    return defaultVars.filter((v) => enabledKeys.has(v.key))
  }, [defaultVars, enabledKeys])

  const activeCorrelationsPayload = useMemo(() => {
    return DEFAULT_MC_CORRELATIONS.filter(
      (c) => enabledKeys.has(c.varA) && enabledKeys.has(c.varB)
    )
  }, [enabledKeys])

  const handleRun = useCallback(() => {
    if (!priceSeries || defaultVars.length === 0) return

    if (workerRef.current) {
      workerRef.current.terminate()
    }

    setStatus('running')
    setProgress(0)
    setResult(null)

    const inputs = loadInputsFromStorage()
    const scenario = loadScenarioFromStorage()
    const calibration = calibrateFromHistory(priceSeries)
    const base: SimulationRequest = { inputs, scenario, calibration, rngSeed: seed }

    // Fix: Explicit payload compilation stops asynchronous race conditions
    const req: MCRequest = {
      base,
      variables: activeVariablesPayload,
      correlations: activeCorrelationsPayload,
      trials,
      rngSeed: seed,
    }

    const worker = new MCWorker()
    workerRef.current = worker

    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as { type: string; completed?: number; total?: number; result?: MCResult; error?: string }
      if (msg.type === 'progress') {
        setProgress(((msg.completed ?? 0) / (msg.total ?? 1)) * 100)
      } else if (msg.type === 'result') {
        const r = msg.result ?? null
        setResult(r)
        setStatus('done')
        setProgress(100)
        workerRef.current = null
        if (r) {
          try {
            // Persist summary + outcomes (skip sampledInputs — not needed downstream)
            localStorage.setItem('bess-analyzer.mcResult', JSON.stringify({
              summary: r.summary,
              convergence: r.convergence,
              outcomes: r.outcomes,
            }))
          } catch { /* storage full — non-fatal */ }
        }
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
  }, [priceSeries, defaultVars, activeVariablesPayload, activeCorrelationsPayload, trials, seed])

  const handleCancel = useCallback(() => {
    if (workerRef.current) {
      workerRef.current.terminate()
      workerRef.current = null
    }
    setStatus('cancelled')
  }, [])

  const toggleVariable = useCallback((key: string) => {
    setEnabledKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const summary = result?.summary
  const completedTrials = Math.round((progress / 100) * trials)

  return (
    <div className="flex flex-col gap-4">
      {/* Context banner */}
      <div className="rounded border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <span className="font-semibold">What this operates on: </span>
        Your <span className="font-medium">Parameters</span> and the active{' '}
        <span className="font-medium">Scenario</span>. Unlike sensitivity (one variable at
        a time), Monte Carlo samples <span className="italic">all</span> stochastic variables
        simultaneously using their full distributions and the correlation matrix — producing a
        realistic joint distribution of outcomes. Each trial runs a complete 20-year simulation.
      </div>

      {/* Header Layout */}
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
        {status === 'done' && <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Done — {trials} trials</span>}
        {status === 'cancelled' && <span className="rounded bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700">Cancelled</span>}
        {status === 'error' && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Error</span>}
      </div>

      {/* Progress Bar Container */}
      {status === 'running' && (
        <div className="rounded border border-blue-200 bg-blue-50 px-4 py-3">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="font-medium text-blue-800">Running… {completedTrials} / {trials} trials ({progress.toFixed(0)} %)</span>
            <button type="button" onClick={handleCancel} className="rounded border border-blue-300 px-3 py-1 text-xs text-blue-700 hover:bg-blue-100">Cancel</button>
          </div>
          <div className="h-3 w-full overflow-hidden rounded-full bg-blue-200">
            <div className="h-full rounded-full bg-blue-600 transition-all duration-300" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}

      {/* Configuration Section */}
      <div className="rounded border border-gray-200">
        <button type="button" onClick={() => setShowConfig((v) => !v)} className="flex w-full items-center justify-between px-4 py-2.5 text-sm font-semibold hover:bg-gray-50">
          <span>Configuration Parameters</span>
          <span className="text-gray-400">{showConfig ? '▲' : '▼'}</span>
        </button>

        {showConfig && (
          <div className="border-t border-gray-200 px-4 pb-4 pt-3">
            <div className="flex flex-wrap gap-6">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-600">Trials: <span className="text-black">{trials}</span></label>
                <input type="range" min={100} max={5000} step={100} value={trials} onChange={(e) => setTrials(Number(e.target.value))} className="w-48" />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-gray-600">RNG Seed</label>
                <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="w-24 rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-600 focus:outline-none" />
              </div>
            </div>

            <div className="mt-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Stochastic Variables ({enabledKeys.size} / {defaultVars.length} enabled)</h4>
              <DistLegend />
              <div className="mt-2 max-h-64 overflow-y-auto">
                {defaultVars.map((v) => (
                  <VariableRow key={v.key} variable={v} enabled={enabledKeys.has(v.key)} onToggle={() => toggleVariable(v.key)} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Output Presentation Layout */}
      {summary && result && (
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap gap-3">
            {/* Fix: Standardized project finance risk terminology mapping */}
            <MetricChip label="P90 (90% of trials produced an NPV above this value)" tooltip="Conservative Case (90% probability of exceeding this NPV)" value={`${fmt0(summary.npv.p10)} €`} />
            <MetricChip label="P50 Median" tooltip="Base Case (50% probability of exceeding this NPV)" value={`${fmt0(summary.npv.p50)} €`} accent />
            <MetricChip label="P10 (Only 10% of trials exceeded this)" tooltip="Optimistic Case (10% probability of exceeding this NPV)" value={`${fmt0(summary.npv.p90)} €`} />
            <MetricChip label="P(NPV > 0)" value={fmtPct(summary.pNpvPositive)} accent={summary.pNpvPositive > 0.5} />
            <MetricChip label="IRR P50" value={summary.irr.p50 !== null ? `${summary.irr.p50.toFixed(1)} %` : '—'} />
            <MetricChip label="LCOS P50" value={`${summary.lcos.p50.toFixed(2)} €/MWh`} />
          </div>

          <div className="rounded border border-gray-200 p-3">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">NPV Distribution Statistics</h3>
            <div className="flex flex-wrap gap-4 text-sm">
              <span><span className="text-gray-500">Mean:</span> {fmt0(summary.npv.mean)} €</span>
              <span><span className="text-gray-500">StdDev:</span> {fmt0(summary.npv.std)} €</span>
              <span><span className="text-gray-500">Min Outflow:</span> {fmt0(summary.npv.min)} €</span>
              <span><span className="text-gray-500">Max Outflow:</span> {fmt0(summary.npv.max)} €</span>
            </div>
          </div>

          {/* Charts Presentation Grid */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            <div className="rounded border border-gray-200 p-4"><HistogramChart values={result.outcomes.map((o) => o.npv)} title="NPV Distribution Profile" xName="NPV (€)" /></div>
            <div className="rounded border border-gray-200 p-4"><CdfChart values={result.outcomes.map((o) => o.npv)} title="NPV Probability Curve (CDF)" /></div>
            <div className="rounded border border-gray-200 p-4">
              <HistogramChart values={result.outcomes.map((o) => o.lcos)} title="LCOS Distribution" xName="LCOS (€/MWh)" color="#7c3aed" />
            </div>
            <div className="rounded border border-gray-200 p-4">
              
            </div>
          </div>

          {summary.pRetiresEarly > 0 && (
            <div className="rounded border border-gray-200 p-4">
              <RetirementChart outcomes={result.outcomes} projectLifeYears={loadInputsFromStorage().finance.projectLifeYears} />
            </div>
          )}

          {result.outcomes.some((o) => o.irr !== null) && (
            <div className="rounded border border-gray-200 p-4">
              <HistogramChart values={result.outcomes.filter((o) => o.irr !== null).map((o) => o.irr! * 100)} title="IRR Distribution" xName="IRR (%)" color="#16a34a" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}