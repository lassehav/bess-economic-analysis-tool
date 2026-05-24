import { useState, useEffect, useCallback } from 'react'
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
// Default inputs (same as SimulationView)
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
// Tornado chart
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
  const rows = result.rows.slice(0, 12)  // top 12

  const labels = rows.map((r) => r.variable.label)
  const lowDeltas = rows.map((r) => r.metricAtLow - base)
  const highDeltas = rows.map((r) => r.metricAtHigh - base)

  const option = {
    grid: { left: 180, right: 20, top: 20, bottom: 40 },
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
      inverse: false,
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
      formatter: (params: unknown) => {
        const items = params as Array<{ seriesName: string; value: number; dataIndex: number }>
        if (!items.length) return ''
        const idx = items[0]!.dataIndex
        const row = rows[idx]!
        const baseVal = formatMetricValue(base, metric)
        const lines = items.map((it) => {
          const delta = it.value >= 0 ? `+${formatMetricValue(it.value, metric)}` : formatMetricValue(it.value, metric)
          return `${it.seriesName}: ${delta}`
        })
        return `<b>${row.variable.label}</b><br/>Base: ${baseVal}<br/>${lines.join('<br/>')}`
      },
    },
    series: [
      {
        name: 'Low',
        type: 'bar',
        stack: 'tornado',
        data: lowDeltas,
        itemStyle: { color: '#ef4444' },
        emphasis: { itemStyle: { color: '#dc2626' } },
      },
      {
        name: 'High',
        type: 'bar',
        stack: 'tornado',
        data: highDeltas,
        itemStyle: { color: '#2563eb' },
        emphasis: { itemStyle: { color: '#1d4ed8' } },
      },
    ],
    markLine: {
      silent: true,
      symbol: 'none',
      data: [{ xAxis: 0, lineStyle: { color: '#6b7280', type: 'solid', width: 1.5 } }],
    },
  }

  return (
    <ReactECharts
      option={option}
      notMerge
      style={{ height: Math.max(280, rows.length * 28 + 60) }}
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
// Variable drill-down chart
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
    grid: { left: 70, right: 20, top: 48, bottom: 40 },
    xAxis: {
      type: 'category',
      data: values.map((v) => {
        if (Math.abs(v) >= 1000) return `${Math.round(v / 1000)}k`
        if (Math.abs(v) >= 1) return v.toFixed(2)
        return v.toFixed(3)
      }),
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
        smooth: false,
        lineStyle: { color: '#7c3aed' },
        itemStyle: { color: '#7c3aed' },
        areaStyle: { color: 'rgba(124, 58, 237, 0.05)' },
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 240 }} />
}

// ---------------------------------------------------------------------------
// Run history
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
      <h3 className="mb-3 text-sm font-semibold">Run History</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-gray-200 text-left">
              <th className="pb-1.5 font-semibold text-gray-600">Time</th>
              <th className="pb-1.5 font-semibold text-gray-600">Scenario</th>
              <th className="pb-1.5 font-semibold text-gray-600">Metric</th>
              <th className="pb-1.5 text-right font-semibold text-gray-600">Base NPV</th>
              <th className="pb-1.5 text-right font-semibold text-gray-600">Base IRR</th>
              <th className="pb-1.5 text-right font-semibold text-gray-600">Base LCOS</th>
              <th className="pb-1.5 font-semibold text-gray-600">Top driver</th>
            </tr>
          </thead>
          <tbody>
            {[...history].reverse().map((entry) => (
              <tr key={entry.id} className="border-b border-gray-100">
                <td className="py-1.5 text-gray-500">
                  {entry.timestamp.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </td>
                <td className="py-1.5 text-gray-700">{entry.scenarioName}</td>
                <td className="py-1.5 uppercase text-gray-500">{entry.metric}</td>
                <td className="py-1.5 text-right font-medium">
                  {Math.round(entry.baseNpv).toLocaleString('fi-FI')} €
                </td>
                <td className="py-1.5 text-right">
                  {entry.baseIrr !== null ? `${entry.baseIrr.toFixed(2)} %` : '—'}
                </td>
                <td className="py-1.5 text-right">{entry.baseLcos.toFixed(2)} €/MWh</td>
                <td className="py-1.5 text-blue-700 font-medium">{entry.topDriver}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main view
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
  const runIdRef = { current: 0 }

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setPriceSeries(data))
      .catch(() => {})
  }, [])

  const buildRequest = useCallback((): SimulationRequest | null => {
    if (!priceSeries) return null
    const inputs = loadInputsFromStorage()
    const scenario = loadScenarioFromStorage()
    const calibration = calibrateFromHistory(priceSeries)
    return { inputs, scenario, calibration, rngSeed: 42 }
  }, [priceSeries])

  function handleRun() {
    const req = buildRequest()
    if (!req) return
    setStatus('running')
    setResult(null)
    setSelectedVariable(null)

    setTimeout(() => {
      try {
        const res = runSensitivity(req, DEFAULT_SENSITIVITY_VARIABLES, metric)
        setResult(res)
        setStatus('done')

        const scenario = loadScenarioFromStorage()
        const entry: RunHistoryEntry = {
          id: ++runIdRef.current,
          timestamp: new Date(),
          metric,
          scenarioName: scenario.name,
          baseNpv: res.base.npv,
          baseIrr: res.base.irr !== null ? res.base.irr * 100 : null,
          baseLcos: res.base.lcos,
          topDriver: res.rows[0]?.variable.label ?? '—',
        }
        setRunHistory((prev) => [...prev, entry])
      } catch (err) {
        console.error('Sensitivity error:', err)
        setStatus('error')
      }
    }, 0)
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
        console.error('Drill-down error:', err)
      }
    }, 0)
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Context banner */}
      <div className="rounded border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <span className="font-semibold">What this operates on: </span>
        Your <span className="font-medium">Parameters</span> (step 2) and the active{' '}
        <span className="font-medium">Scenario</span> (step 3). The scenario matters because it
        defines the entire synthetic price distribution year-by-year — installed capacity of solar,
        wind, nuclear, and BESS shapes the spread levels, seasonal patterns, and price volatility
        that each simulation year sees. A high-renewables scenario produces lower, more volatile
        spreads; a tight-capacity scenario produces higher spreads. Historical prices are used only
        to calibrate the statistical baseline (mean, std) of the price generator, not as the price
        series itself. Each variable is then perturbed ±20 % around its base value and the full
        simulation is re-run — the tornado chart ranks which variables move NPV/IRR/LCOS the most.
      </div>

      {/* Header / controls */}
      <div className="flex flex-wrap items-center gap-3 border-b border-gray-200 pb-3">
        <h2 className="text-lg font-semibold">Sensitivity Analysis</h2>

        <div className="flex items-center gap-1 rounded border border-gray-300 p-0.5">
          {(['npv', 'irr', 'lcos'] as Metric[]).map((m) => (
            <button
              key={m}
              onClick={() => setMetric(m)}
              className={[
                'rounded px-3 py-1 text-sm font-medium transition-colors',
                metric === m ? 'bg-blue-600 text-white' : 'text-gray-600 hover:text-black',
              ].join(' ')}
            >
              {m.toUpperCase()}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleRun}
          disabled={!priceSeries || status === 'running'}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Run Sensitivity
        </button>

        {status === 'running' && (
          <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
            Computing...
          </span>
        )}
        {status === 'done' && (
          <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
            Done
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

      {status === 'idle' && result === null && (
        <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 text-sm text-gray-400">
          Select a metric and press Run Sensitivity to compute the tornado chart.
        </div>
      )}

      {result !== null && (
        <div className="flex flex-col gap-6">
          {/* Summary chips */}
          <div className="flex flex-wrap gap-3">
            <div className="flex flex-col items-center rounded border border-gray-200 px-4 py-2">
              <span className="text-xs text-gray-500">Base {metric.toUpperCase()}</span>
              <span className="mt-0.5 text-sm font-semibold">
                {formatMetricValue(extractMetric(result.base, metric), metric)}
              </span>
            </div>
            <div className="flex flex-col items-center rounded border border-gray-200 px-4 py-2">
              <span className="text-xs text-gray-500">Variables</span>
              <span className="mt-0.5 text-sm font-semibold">{result.rows.length}</span>
            </div>
            <div className="flex flex-col items-center rounded border border-gray-200 px-4 py-2">
              <span className="text-xs text-gray-500">Max swing</span>
              <span className="mt-0.5 text-sm font-semibold">
                {result.rows[0] ? formatMetricValue(result.rows[0].range, metric) : '—'}
              </span>
            </div>
            <div className="flex flex-col items-center rounded border border-blue-100 bg-blue-50 px-4 py-2">
              <span className="text-xs text-blue-500">Top driver</span>
              <span className="mt-0.5 text-sm font-semibold text-blue-700">
                {result.rows[0]?.variable.label ?? '—'}
              </span>
            </div>
          </div>

          {/* Tornado chart */}
          <div className="rounded border border-gray-200 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">Tornado Chart — {metricLabel(metric)}</h3>
              <span className="text-xs text-gray-400">Click a bar to drill down</span>
            </div>
            <TornadoChart
              result={result}
              metric={metric}
              onSelectVariable={handleSelectVariable}
              selectedKey={selectedVariable?.key ?? null}
            />
          </div>

          {/* Drill-down chart */}
          {selectedVariable && drilldownValues.length > 0 && (
            <div className="rounded border border-purple-200 bg-purple-50 p-4">
              <DrilldownChart
                variable={selectedVariable}
                values={drilldownValues}
                metricValues={drilldownMetrics}
                metric={metric}
              />
            </div>
          )}

          {/* Data table */}
          <div className="rounded border border-gray-200 p-4">
            <h3 className="mb-3 text-sm font-semibold">Sensitivity Table</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-gray-200">
                    <th className="pb-2 text-left font-semibold text-gray-600">Variable</th>
                    <th className="pb-2 text-right font-semibold text-gray-600">Low value</th>
                    <th className="pb-2 text-right font-semibold text-gray-600">
                      {metricLabel(metric)} @ Low
                    </th>
                    <th className="pb-2 text-right font-semibold text-gray-600">
                      {metricLabel(metric)} @ Base
                    </th>
                    <th className="pb-2 text-right font-semibold text-gray-600">
                      {metricLabel(metric)} @ High
                    </th>
                    <th className="pb-2 text-right font-semibold text-gray-600">High value</th>
                    <th className="pb-2 text-right font-semibold text-gray-600">Range</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row) => (
                    <tr
                      key={row.variable.key}
                      className={[
                        'cursor-pointer border-b border-gray-100 hover:bg-gray-50',
                        selectedVariable?.key === row.variable.key ? 'bg-blue-50' : '',
                      ].join(' ')}
                      onClick={() => handleSelectVariable(row.variable)}
                    >
                      <td className="py-1.5 font-medium text-gray-800">{row.variable.label}</td>
                      <td className="py-1.5 text-right text-gray-500">
                        {row.low.value.toFixed(3)}
                      </td>
                      <td className="py-1.5 text-right text-red-600">
                        {formatMetricValue(row.metricAtLow, metric)}
                      </td>
                      <td className="py-1.5 text-right text-gray-700">
                        {formatMetricValue(row.metricAtBase, metric)}
                      </td>
                      <td className="py-1.5 text-right text-blue-600">
                        {formatMetricValue(row.metricAtHigh, metric)}
                      </td>
                      <td className="py-1.5 text-right text-gray-500">
                        {row.high.value.toFixed(3)}
                      </td>
                      <td className="py-1.5 text-right font-semibold text-gray-800">
                        {formatMetricValue(row.range, metric)}
                      </td>
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
