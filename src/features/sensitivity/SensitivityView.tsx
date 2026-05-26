import { useState, useEffect, useCallback, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import type { Inputs } from '../../core/types/inputs'
import type { PriceSeries } from '../../core/types/prices'
import type { ScenarioProfile } from '../../core/forecast/types'
import { inputsSchema } from '../../core/types/schemas'
import { calibrateFromHistory } from '../../core/forecast/calibrate'
import { PRESET_SCENARIOS } from '../../core/forecast/scenarios'
import {
  runSensitivity,
  runVariableSweep,
  DEFAULT_SENSITIVITY_VARIABLES,
  extractMetric,
} from '../../core/analysis/sensitivity'
import type { SensitivityResult, SensitivityVariable } from '../../core/analysis/sensitivity'
import type { SimulationRequest } from '../../core/analysis/run'

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

type Metric = 'npv' | 'irr' | 'lcos'

function metricLabel(metric: Metric): string {
  if (metric === 'npv') return 'NPV (€)'
  if (metric === 'irr') return 'IRR (%)'
  return 'LCOS (€/MWh)'
}

function formatMetricValue(v: number, metric: Metric): string {
  if (metric === 'npv') return `${Math.round(v).toLocaleString('fi-FI')} €`
  if (metric === 'irr') return `${v.toFixed(2)} %`
  return `${v.toFixed(2)} €/MWh`
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

// ---------------------------------------------------------------------------
// Tornado chart component (Cleaned coordinate system)
// ---------------------------------------------------------------------------
function TornadoChart({
  result,
  metric,
  onSelectVariable,
  selectedKey,
}: {
  result: SensitivityResult
  metric: Metric
  onSelectVariable: (v: SensitivityVariable) => void
  selectedKey: string | null
}) {
  const base = extractMetric(result.base, metric)
  const rows = [...result.rows].slice(0, 12).reverse()

  const labels = rows.map((r) => r.variable.label)
  const lowDeltas = rows.map((r) => r.metricAtLow - base)
  const highDeltas = rows.map((r) => r.metricAtHigh - base)

  const option = {
    grid: { left: 180, right: 30, top: 20, bottom: 40 },
    xAxis: {
      type: 'value',
      name: metricLabel(metric),
      nameLocation: 'middle',
      nameGap: 28,
      axisLine: { lineStyle: { color: '#9ca3af' } },
      splitLine: { lineStyle: { color: '#f3f4f6' } },
    },
    yAxis: {
      type: 'category',
      data: labels,
      axisLabel: {
        fontSize: 11,
        color: (value: string) => {
          const row = rows.find((r) => r.variable.label === value)
          return row && selectedKey === row.variable.key ? '#2563eb' : '#374151'
        },
      },
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        if (!params.length) return ''
        const idx = params[0].dataIndex
        const row = rows[idx]!
        
        // Compute true values instead of raw mathematical deltas
        const lowTrueValue = formatMetricValue(row.metricAtLow, metric)
        const highTrueValue = formatMetricValue(row.metricAtHigh, metric)
        const baseTrueValue = formatMetricValue(base, metric)

        return `<b>${row.variable.label}</b><br/>
                Low Case: ${lowTrueValue} (Val: ${row.low.value.toFixed(2)})<br/>
                Base Case: ${baseTrueValue}<br/>
                High Case: ${highTrueValue} (Val: ${row.high.value.toFixed(2)})`
      },
    },
    series: [
      {
        name: 'Low Input',
        type: 'bar',
        stack: 'tornado',
        data: lowDeltas,
        itemStyle: { color: '#ef4444' },
      },
      {
        name: 'High Input',
        type: 'bar',
        stack: 'tornado',
        data: highDeltas,
        itemStyle: { color: '#2563eb' },
      },
    ],
  }

  return (
    <ReactECharts
      option={option}
      notMerge
      style={{ height: Math.max(280, rows.length * 32 + 60) }}
      onEvents={{
        click: (params: { dataIndex: number }) => {
          const row = rows[params.dataIndex]
          if (row) onSelectVariable(row.variable)
        },
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Drill-down chart component
// ---------------------------------------------------------------------------
function DrilldownChart({
  variable,
  values,
  metricValues,
  metric,
}: {
  variable: SensitivityVariable
  values: number[]
  metricValues: number[]
  metric: Metric
}) {
  const option = {
    title: {
      text: `Drill-down: ${variable.label}`,
      textStyle: { fontSize: 13, fontWeight: 600 },
    },
    grid: { left: 80, right: 30, top: 48, bottom: 40 },
    xAxis: {
      type: 'category',
      data: values.map((v) => (Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : v.toFixed(2))),
      name: variable.label,
      nameLocation: 'middle',
      nameGap: 28,
    },
    yAxis: {
      type: 'value',
      name: metricLabel(metric),
    },
    tooltip: { trigger: 'axis' },
    series: [
      {
        type: 'line',
        data: metricValues,
        smooth: true,
        lineStyle: { color: '#7c3aed', width: 2 },
        itemStyle: { color: '#7c3aed' },
        areaStyle: { color: 'rgba(124, 58, 237, 0.04)' },
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 240 }} />
}

// ---------------------------------------------------------------------------
// Run History
// ---------------------------------------------------------------------------
type RunHistoryEntry = {
  id: number
  timestamp: Date
  metric: Metric
  scenarioName: string
  baseNpv: number
  baseIrr: number | null
  baseLcos: number
  topDriver: string
}

function RunHistoryTable({ history }: { history: RunHistoryEntry[] }) {
  if (history.length === 0) return null
  return (
    <div className="rounded border border-gray-200 p-4">
      <h3 className="mb-3 text-sm font-semibold">Run History Log</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="pb-2 font-semibold">Execution Time</th>
              <th className="pb-2 font-semibold">Target Scenario</th>
              <th className="pb-2 font-semibold">Active Metric</th>
              <th className="pb-2 text-right font-semibold">Base NPV</th>
              <th className="pb-2 text-right font-semibold">Base IRR</th>
              <th className="pb-2 text-right font-semibold">Base LCOS</th>
              <th className="pb-2 font-semibold pl-4">Primary Volatility Driver</th>
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((entry) => (
              <tr key={entry.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-2 text-gray-500">
                  {entry.timestamp.toLocaleTimeString('fi-FI')}
                </td>
                <td className="py-2 text-gray-700 font-medium">{entry.scenarioName}</td>
                <td className="py-2 uppercase font-semibold text-gray-600">{entry.metric}</td>
                <td className="py-2 text-right font-medium text-gray-900">
                  {Math.round(entry.baseNpv).toLocaleString('fi-FI')} €
                </td>
                <td className="py-2 text-right text-gray-700">
                  {entry.baseIrr !== null && entry.baseIrr >= -100 ? `${entry.baseIrr.toFixed(2)} %` : '—'}
                </td>
                <td className="py-2 text-right text-gray-700 font-medium">{entry.baseLcos.toFixed(2)} €/MWh</td>
                <td className="py-2 text-blue-700 font-medium pl-4">{entry.topDriver}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main View Container
// ---------------------------------------------------------------------------
export default function SensitivityView() {
  const [priceSeries, setPriceSeries] = useState<PriceSeries | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [metric, setMetric] = useState<Metric>('npv')
  const [result, setResult] = useState<SensitivityResult | null>(null)
  const [selectedVariable, setSelectedVariable] = useState<SensitivityVariable | null>(null)
  const [drilldownValues, setDrilldownValues] = useState<number[]>([])
  const [drilldownMetrics, setDrilldownMetrics] = useState<number[]>([])
  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([])
  const [copied, setCopied] = useState(false)
  const runIdRef = useRef(0)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setPriceSeries(data))
      .catch((err) => console.error('Failed to load static price series profiles:', err))
  }, [])

  const buildRequest = useCallback((): SimulationRequest | null => {
    if (!priceSeries) return null
    return {
      inputs: loadInputsFromStorage(),
      scenario: loadScenarioFromStorage(),
      calibration: calibrateFromHistory(priceSeries),
      rngSeed: 42,
    }
  }, [priceSeries])

  // Core execution engine encapsulated to prevent multi-tab parameter data bleed
  const executeSimulationSweep = useCallback((targetMetric: Metric) => {
    const req = buildRequest()
    if (!req) return

    setStatus('running')
    setSelectedVariable(null)

    setTimeout(() => {
      try {
        const res = runSensitivity(req, DEFAULT_SENSITIVITY_VARIABLES, targetMetric)
        setResult(res)
        setStatus('done')

        const scenario = loadScenarioFromStorage()
        const entry: RunHistoryEntry = {
          id: ++runIdRef.current,
          timestamp: new Date(),
          metric: targetMetric,
          scenarioName: scenario.name,
          baseNpv: res.base.npv,
          baseIrr: res.base.irr !== null ? res.base.irr * 100 : null,
          baseLcos: res.base.lcos,
          topDriver: res.rows[0]?.variable.label ?? '—',
        }
        setRunHistory((prev) => [...prev, entry])
      } catch (err) {
        console.error('Sensitivity core run exception:', err)
        setStatus('error')
      }
    }, 50)
  }, [buildRequest])

  // EFFECT FIX: Auto-compute calculations whenever the user switches active dashboard tabs
  useEffect(() => {
    if (priceSeries && result !== null) {
      executeSimulationSweep(metric)
    }
  }, [metric, priceSeries, executeSimulationSweep])

  function getSensJSON() {
    if (!result) return null
    return JSON.stringify({ exportedAt: new Date().toISOString(), metric, result }, null, 2)
  }

  function handleExportJSON() {
    const json = getSensJSON()
    if (!json) return
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bess-sensitivity.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleCopyJSON() {
    const json = getSensJSON()
    if (!json) return
    navigator.clipboard.writeText(json).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  function handleExplicitRun() {
    executeSimulationSweep(metric)
  }

  function handleSelectVariable(variable: SensitivityVariable) {
    const req = buildRequest()
    if (!req) return
    setSelectedVariable(variable)

    setTimeout(() => {
      try {
        const sweep = runVariableSweep(req, variable, metric)
        setDrilldownValues(sweep.values)
        setDrilldownMetrics(sweep.outcomes.map((o) => extractMetric(o, metric)))
      } catch (err) {
        console.error('Drilldown processing loop exception:', err)
      }
    }, 0)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Context banner */}
      <div className="rounded border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <span className="font-semibold">What this operates on: </span>
        Your <span className="font-medium">Parameters</span> and the active{' '}
        <span className="font-medium">Scenario Profile</span>. Changing metric tabs will automatically
        re-evaluate the underlying sensitivity parameters to keep your views perfectly synced.
      </div>

      {/* Control panel headers */}
      <div className="flex flex-wrap items-center justify-between border-b border-gray-200 pb-3 gap-3">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">Sensitivity Analysis</h2>
          <div className="flex items-center gap-1 rounded border border-gray-300 p-0.5 bg-white">
            {(['npv', 'irr', 'lcos'] as Metric[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMetric(m)}
                className={[
                  'rounded px-3 py-1 text-xs font-semibold uppercase transition-all',
                  metric === m ? 'bg-blue-600 text-white shadow-sm' : 'text-gray-600 hover:text-black hover:bg-gray-50',
                ].join(' ')}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExplicitRun}
            disabled={!priceSeries || status === 'running'}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            {result === null ? 'Run Sensitivity' : 'Recalculate Current View'}
          </button>

          {status === 'running' && <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 animate-pulse">Computing Matrix...</span>}
          {status === 'done' && <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">Done</span>}
          {status === 'error' && <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">Execution Error</span>}
          {!priceSeries && <span className="text-xs text-gray-400">Waiting for historical connection logs...</span>}
          {result && (
            <>
              <button type="button" onClick={handleExportJSON} className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50">Export JSON</button>
              <button type="button" onClick={handleCopyJSON} className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50">{copied ? 'Copied!' : 'Copy JSON'}</button>
            </>
          )}
        </div>
      </div>

      {result === null && status !== 'running' && (
        <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 bg-gray-50 text-sm text-gray-400">
          Select your primary target metric optimization objective above and press Run Sensitivity.
        </div>
      )}

      {result !== null && (
        <div className="flex flex-col gap-6">
          {/* Dashboard Metric Summary KPI Chips */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="flex flex-col rounded border border-gray-200 bg-white p-3">
              <span className="text-xs font-medium text-gray-500 uppercase">Base {metric}</span>
              <span className="mt-1 text-base font-bold text-gray-900">
                {formatMetricValue(extractMetric(result.base, metric), metric)}
              </span>
            </div>
            <div className="flex flex-col rounded border border-gray-200 bg-white p-3">
              <span className="text-xs font-medium text-gray-500 uppercase">Total Dimensions</span>
              <span className="mt-1 text-base font-bold text-gray-900">{result.rows.length} Variables</span>
            </div>
            <div className="flex flex-col rounded border border-gray-200 bg-white p-3">
              <span className="text-xs font-medium text-gray-500 uppercase">Max Swing Range</span>
              <span className="mt-1 text-base font-bold text-gray-900">
                {result.rows[0] ? formatMetricValue(result.rows[0].range, metric) : '—'}
              </span>
            </div>
            <div className="flex flex-col rounded border border-blue-100 bg-blue-50 p-3">
              <span className="text-xs font-medium text-blue-600 uppercase">Top Volatility Driver</span>
              <span className="mt-1 text-base font-bold text-blue-800 truncate">
                {result.rows[0]?.variable.label ?? '—'}
              </span>
            </div>
          </div>

          {/* Tornado Visual Panel */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-bold text-gray-900">Tornado Chart Distribution — {metricLabel(metric)}</h3>
              <span className="text-xs text-gray-400">Click variable name axis label to isolate sweep tracking contours</span>
            </div>
            <TornadoChart
              result={result}
              metric={metric}
              onSelectVariable={handleSelectVariable}
              selectedKey={selectedVariable?.key ?? null}
            />
          </div>

          {/* Drilldown Contour Visual Panel */}
          {selectedVariable && drilldownValues.length > 0 && (
            <div className="rounded border border-purple-200 bg-purple-50 p-4 transition-all">
              <DrilldownChart
                variable={selectedVariable}
                values={drilldownValues}
                metricValues={drilldownMetrics}
                metric={metric}
              />
            </div>
          )}

          {/* Tabular Data Grid Panel */}
          <div className="rounded border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-bold text-gray-900">Isolated Sensitivity Data Grid</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs text-left">
                <thead>
                  <tr className="border-b border-gray-200 text-gray-500">
                    <th className="pb-2 font-semibold">Variable Name Target</th>
                    <th className="pb-2 text-right font-semibold">Low Value</th>
                    <th className="pb-2 text-right font-semibold">{metric.toUpperCase()} @ Low</th>
                    <th className="pb-2 text-right font-semibold">Baseline Target</th>
                    <th className="pb-2 text-right font-semibold">{metric.toUpperCase()} @ High</th>
                    <th className="pb-2 text-right font-semibold">High Value</th>
                    <th className="pb-2 text-right font-semibold">Absolute Delta Swing</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr
                      key={row.variable.key}
                      className={[
                        'cursor-pointer border-b border-gray-100 hover:bg-gray-50 transition-colors',
                        selectedVariable?.key === row.variable.key ? 'bg-blue-50/70 font-medium' : '',
                      ].join(' ')}
                      onClick={() => handleSelectVariable(row.variable)}
                    >
                      <td className="py-2 font-medium text-gray-900">{row.variable.label}</td>
                      <td className="py-2 text-right text-gray-500 font-mono">{row.low.value.toLocaleString('fi-FI', { maximumFractionDigits: 2 })}</td>
                      <td className="py-2 text-right font-medium text-red-600 font-mono">{formatMetricValue(row.metricAtLow, metric)}</td>
                      <td className="py-2 text-right text-gray-900 font-mono">{formatMetricValue(row.metricAtBase, metric)}</td>
                      <td className="py-2 text-right font-medium text-blue-600 font-mono">{formatMetricValue(row.metricAtHigh, metric)}</td>
                      <td className="py-2 text-right text-gray-500 font-mono">{row.high.value.toLocaleString('fi-FI', { maximumFractionDigits: 2 })}</td>
                      <td className="py-2 text-right font-bold text-gray-900 font-mono">{formatMetricValue(row.range, metric)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      <RunHistoryTable history={runHistory} />
    </div>
  )
}