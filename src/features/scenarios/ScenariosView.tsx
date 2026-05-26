import { useRef, useState, useEffect, useMemo, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import type { ECharts } from 'echarts'
import type { PriceSeries } from '../../core/types/prices'
import { runForecast, calibrateFromHistory, generateForecast } from '../../core/forecast/index'
import { PRESET_SCENARIOS, getDefaultProfile } from '../../core/forecast/scenarios'
import type {
  MultiYearForecastOutput,
  SimulationEvent,
  HistoricalCalibration,
  ScenarioProfile,
  YearCapacityParams,
} from '../../core/forecast/index'

const LS_PREFIX = 'bess-analyzer.scenario.'
const BASE_YEAR = 2026

function yearLabel(yearIndex: number): string {
  return String(BASE_YEAR + yearIndex)
}

// ─── LocalStorage helpers ─────────────────────────────────────────────────────

function loadCustomProfiles(): ScenarioProfile[] {
  const result: ScenarioProfile[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(LS_PREFIX)) continue
    try {
      result.push(JSON.parse(localStorage.getItem(key)!) as ScenarioProfile)
    } catch {}
  }
  return result
}

function saveCustomProfile(profile: ScenarioProfile) {
  localStorage.setItem(`${LS_PREFIX}${profile.id}`, JSON.stringify(profile))
}

function deleteCustomProfile(id: string) {
  localStorage.removeItem(`${LS_PREFIX}${id}`)
}

// ─── Formatting helpers ───────────────────────────────────────────────────────

function hourIndexToLabel(h: number): string {
  const yearIdx = Math.floor(h / 8760)
  const dayOfYear = Math.floor((h % 8760) / 24) + 1
  return `${yearLabel(yearIdx)} D${dayOfYear}`
}

function severityColor(s: SimulationEvent['severity']): string {
  if (s === 'critical') return '#dc2626'
  if (s === 'warning') return '#d97706'
  return '#2563eb'
}

function typeColor(t: SimulationEvent['type']): string {
  if (t === 'dunkelflaute_shock') return 'rgba(249,115,22,0.12)'
  if (t === 'stochastic_outage') return 'rgba(239,68,68,0.09)'
  return 'rgba(34,197,94,0.09)'
}

function typeBorderColor(t: SimulationEvent['type']): string {
  if (t === 'dunkelflaute_shock') return 'rgba(249,115,22,0.35)'
  if (t === 'stochastic_outage') return 'rgba(239,68,68,0.3)'
  return 'rgba(34,197,94,0.3)'
}

function typeLabel(t: SimulationEvent['type']): string {
  if (t === 'dunkelflaute_shock') return 'Dunkelflaute'
  if (t === 'stochastic_outage') return 'Outage'
  return 'Structural'
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EventTypeBadge({ type }: { type: SimulationEvent['type'] }) {
  const cls =
    type === 'dunkelflaute_shock'
      ? 'bg-orange-50 text-orange-700 border-orange-200'
      : type === 'stochastic_outage'
        ? 'bg-red-50 text-red-700 border-red-200'
        : 'bg-green-50 text-green-700 border-green-200'
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {typeLabel(type)}
    </span>
  )
}

function EventCard({
  event,
  selected,
  onClick,
}: {
  event: SimulationEvent
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'w-full rounded border px-2.5 py-2 text-left text-xs transition-colors',
        selected
          ? 'border-blue-400 bg-blue-50'
          : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50',
      ].join(' ')}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <EventTypeBadge type={event.type} />
        <span
          className="h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: severityColor(event.severity) }}
        />
        <span className="ml-auto text-gray-400">{hourIndexToLabel(event.startHourIndex)}</span>
      </div>
      <p className="font-medium text-gray-800 leading-snug">{event.title}</p>
      <p className="mt-0.5 text-gray-500 leading-snug line-clamp-2">{event.description}</p>
      {event.metricDelta?.priceImpactEur !== undefined && (
        <p className="mt-1 font-medium" style={{ color: severityColor(event.severity) }}>
          {event.metricDelta.priceImpactEur > 0 ? '+' : ''}
          {event.metricDelta.priceImpactEur.toFixed(0)} €/MWh
        </p>
      )}
    </button>
  )
}

function ForecastChart({
  output,
  onChartReady,
}: {
  output: MultiYearForecastOutput
  onChartReady: (instance: ECharts) => void
}) {
  const markAreaData = useMemo(() => {
    const areas: [object, object][] = []
    for (const ev of output.events) {
      // Minimum display width: 7 days (168 h) so zones stay visible at full zoom
      const endHour = Math.max(ev.endHourIndex, ev.startHourIndex + 168)
      areas.push([
        {
          xAxis: ev.startHourIndex,
          name: ev.title,
          itemStyle: { color: typeColor(ev.type), borderColor: typeBorderColor(ev.type) },
        },
        { xAxis: endHour },
      ])
    }
    return areas
  }, [output.events])

  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        formatter: (params: { value: [number, number] }[]) => {
          const p = params[0]
          if (!p) return ''
          return `${hourIndexToLabel(p.value[0])}<br/>${p.value[1].toFixed(1)} €/MWh`
        },
      },
      grid: { left: 60, right: 20, top: 20, bottom: 50 },
      xAxis: {
        type: 'value',
        name: 'Hour',
        min: 0,
        max: output.totalHours - 1,
        axisLabel: { formatter: (v: number) => hourIndexToLabel(v) },
      },
      yAxis: { type: 'value', name: '€/MWh' },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', start: 0, end: 100, height: 20 },
      ],
      series: [
        {
          type: 'line',
          data: output.hourlyPrices.map((p, i) => [i, p]),
          large: true,
          largeThreshold: 5000,
          sampling: 'lttb' as const,
          showSymbol: false,
          lineStyle: { color: '#2563eb', width: 1 },
          itemStyle: { color: '#2563eb' },
          markArea:
            markAreaData.length > 0
              ? { silent: true, data: markAreaData, label: { show: false } }
              : undefined,
        },
      ],
    }),
    [output, markAreaData],
  )

  return (
    <ReactECharts
      option={option}
      notMerge
      style={{ height: '100%', minHeight: 360 }}
      onChartReady={onChartReady}
    />
  )
}

function BacktestPanel({ series }: { series: PriceSeries }) {
  const startYear = new Date(series.startUtc).getUTCFullYear()
  const endYear = new Date(series.endUtc).getUTCFullYear()
  const calibYears = Array.from(
    { length: Math.max(0, endYear - startYear) },
    (_, i) => String(startYear + i),
  )

  const [result, setResult] = useState<{
    synth: number[]
    actual: number[]
    monthMeans: { month: string; synth: number; actual: number; delta: number; pass: boolean }[]
    ksStat: number
    ksPass: boolean
  } | null>(null)
  const [running, setRunning] = useState(false)
  const [calibYear, setCalibYear] = useState(calibYears[0] ?? String(startYear))

  function run() {
    setRunning(true)
    try {
      const calibEnd = `${calibYear}-12-31`
      const testStart = `${parseInt(calibYear) + 1}-01-01`
      const cal: HistoricalCalibration = calibrateFromHistory(series, undefined, calibEnd)
      const synthOutput = generateForecast(cal, getDefaultProfile(), 42)
      const synth = synthOutput.hourlyPrices.slice(0, 8760)

      const testStartMs = new Date(testStart + 'T00:00:00Z').getTime()
      const seriesStartMs = new Date(series.startUtc).getTime()
      const startIdx = Math.round((testStartMs - seriesStartMs) / 3_600_000)
      const actual = series.prices.slice(startIdx, startIdx + 8760)

      if (actual.length < 24) {
        alert(`No actual data found for ${parseInt(calibYear) + 1}. Try a different calibration year.`)
        return
      }

      const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
      const MONTH_STARTS = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334].map((d) => d * 24)
      const MONTH_ENDS = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365].map((d) => d * 24)

      const monthMeans = MONTH_NAMES.map((name, m) => {
        const s = MONTH_STARTS[m]!
        const e = MONTH_ENDS[m]!
        const sSlice = synth.slice(s, Math.min(e, synth.length))
        const aSlice = actual.slice(s, Math.min(e, actual.length))
        const sMean = sSlice.length ? sSlice.reduce((a, b) => a + b, 0) / sSlice.length : 0
        const aMean = aSlice.length ? aSlice.reduce((a, b) => a + b, 0) / aSlice.length : 0
        const delta = aMean !== 0 ? (sMean - aMean) / Math.abs(aMean) : 0
        return { month: name, synth: sMean, actual: aMean, delta, pass: Math.abs(delta) <= 0.15 }
      })

      const synthSpreads = Array.from({ length: 365 }, (_, d) => {
        const sl = synth.slice(d * 24, (d + 1) * 24)
        return sl.length ? Math.max(...sl) - Math.min(...sl) : 0
      }).sort((a, b) => a - b)

      const actualSpreads = Array.from(
        { length: Math.min(365, Math.floor(actual.length / 24)) },
        (_, d) => {
          const sl = actual.slice(d * 24, (d + 1) * 24)
          return sl.length ? Math.max(...sl) - Math.min(...sl) : 0
        },
      ).sort((a, b) => a - b)

      let maxDiff = 0
      const n = Math.max(synthSpreads.length, actualSpreads.length)
      for (let i = 0; i < n; i++) {
        const sCdf = (synthSpreads.findIndex((v) => v >= (synthSpreads[i] ?? 0)) + 1) / synthSpreads.length
        const aCdf = actualSpreads.length
          ? (actualSpreads.findIndex((v) => v >= (actualSpreads[i] ?? 0)) + 1) / actualSpreads.length
          : 0
        maxDiff = Math.max(maxDiff, Math.abs(sCdf - aCdf))
      }

      setResult({ synth, actual, monthMeans, ksStat: maxDiff, ksPass: maxDiff < 0.1 })
    } finally {
      setRunning(false)
    }
  }

  const chartOption = useMemo(() => {
    if (!result) return {}
    return {
      legend: { data: ['Synthetic', 'Actual'], top: 0 },
      tooltip: { trigger: 'axis' },
      grid: { left: 60, right: 20, top: 30, bottom: 50 },
      xAxis: { type: 'value', name: 'Hour', min: 0, max: 8759 },
      yAxis: { type: 'value', name: '€/MWh' },
      dataZoom: [
        { type: 'inside', start: 0, end: 100 },
        { type: 'slider', start: 0, end: 100, height: 20 },
      ],
      series: [
        {
          name: 'Synthetic',
          type: 'line',
          data: result.synth.map((p, i) => [i, p]),
          large: true,
          largeThreshold: 3000,
          sampling: 'lttb' as const,
          showSymbol: false,
          lineStyle: { color: '#2563eb', width: 1 },
        },
        {
          name: 'Actual',
          type: 'line',
          data: result.actual.map((p, i) => [i, p]),
          large: true,
          largeThreshold: 3000,
          sampling: 'lttb' as const,
          showSymbol: false,
          lineStyle: { color: '#ef4444', width: 1, opacity: 0.7 },
        },
      ],
    }
  }, [result])

  const passCount = result?.monthMeans.filter((m) => m.pass).length ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium">Calibrate on data up to year</label>
        <select
          value={calibYear}
          onChange={(e) => setCalibYear(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
          disabled={calibYears.length === 0}
        >
          {calibYears.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        <span className="text-xs text-gray-500">
          → test on {parseInt(calibYear) + 1}
          {parseInt(calibYear) + 1 === endYear ? ' (partial year)' : ''}
        </span>
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {running ? 'Running...' : 'Run backtest'}
        </button>
      </div>

      {result && (
        <>
          <ReactECharts option={chartOption} notMerge style={{ height: 280 }} />
          <div className="flex items-center gap-4 text-sm">
            <span>
              Monthly mean:{' '}
              <span className={passCount >= 10 ? 'font-semibold text-green-700' : 'font-semibold text-red-600'}>
                {passCount}/12 within ±15%
              </span>{' '}
              <span className="text-gray-500">(pass ≥ 10)</span>
            </span>
            <span>
              KS statistic:{' '}
              <span className={result.ksPass ? 'font-semibold text-green-700' : 'font-semibold text-red-600'}>
                {result.ksStat.toFixed(3)}
              </span>{' '}
              <span className="text-gray-500">(pass &lt; 0.10)</span>
            </span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="py-1 pr-3 text-left font-semibold">Month</th>
                  <th className="py-1 pr-3 text-right font-semibold">Synth (€/MWh)</th>
                  <th className="py-1 pr-3 text-right font-semibold">Actual (€/MWh)</th>
                  <th className="py-1 pr-3 text-right font-semibold">Δ</th>
                  <th className="py-1 text-center font-semibold">Pass</th>
                </tr>
              </thead>
              <tbody>
                {result.monthMeans.map((m) => (
                  <tr key={m.month} className="border-b border-gray-100">
                    <td className="py-0.5 pr-3 font-medium">{m.month}</td>
                    <td className="py-0.5 pr-3 text-right">{m.synth.toFixed(1)}</td>
                    <td className="py-0.5 pr-3 text-right">{m.actual.toFixed(1)}</td>
                    <td className={`py-0.5 pr-3 text-right ${m.pass ? 'text-gray-700' : 'text-red-600 font-medium'}`}>
                      {(m.delta * 100).toFixed(1)}%
                    </td>
                    <td className="py-0.5 text-center">
                      {m.pass ? <span className="text-green-600">✓</span> : <span className="text-red-500">✗</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Scenario Editor Table ────────────────────────────────────────────────────

type RowWarning = { field: string; message: string; level: 'error' | 'warning' }

function getRowWarnings(row: YearCapacityParams): RowWarning[] {
  const w: RowWarning[] = []
  if (row.constantBaseload > row.maxPowerConsumption) {
    w.push({ field: 'constantBaseload', message: 'Cannot exceed max consumption', level: 'error' })
  }
  if (row.windCapacityMW + row.solarCapacityMW > row.maxPowerConsumption * 3) {
    w.push({
      field: 'renewables',
      message: 'High negative-price probability (>300% capacity ratio)',
      level: 'warning',
    })
  }
  return w
}

function NumInput({
  value,
  onChange,
  highlight,
  title,
}: {
  value: number
  onChange: (v: number) => void
  highlight?: 'error' | 'warning' | null
  title?: string | undefined
}) {
  const cls = highlight === 'error'
    ? 'border-red-400 bg-red-50 focus:ring-red-300'
    : highlight === 'warning'
      ? 'border-amber-400 bg-amber-50 focus:ring-amber-300'
      : 'border-gray-300 bg-white focus:ring-blue-300'
  return (
    <input
      type="number"
      value={value}
      title={title}
      onChange={(e) => {
        const v = parseFloat(e.target.value)
        if (!isNaN(v)) onChange(v)
      }}
      className={`w-24 rounded border px-2 py-0.5 text-right text-xs focus:outline-none focus:ring-1 ${cls}`}
    />
  )
}

function ScenarioTable({
  rows,
  onUpdate,
  onPropagate,
}: {
  rows: YearCapacityParams[]
  onUpdate: (rowIdx: number, field: keyof Omit<YearCapacityParams, 'yearIndex'>, value: number) => void
  onPropagate: (rowIdx: number) => void
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="py-1.5 pl-3 pr-2 text-left font-semibold text-gray-600">Year</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600">Max Consumption (MW)</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600">Constant Baseload (MW)</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600">Solar (MW)</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600">Wind (MW)</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600">Nuclear (MW)</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600">BESS (MWh)</th>
            <th className="py-1.5 px-2 text-right font-semibold text-gray-600" title="Price-responsive demand that absorbs surplus before curtailment (district heating boilers, P2H electrolyzers, thermal storage)">Flex Load (MW)</th>
            <th className="py-1.5 px-2 text-center font-semibold text-gray-600 w-36">Randomizer</th>
            <th className="py-1.5 px-2 w-6"></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const warnings = getRowWarnings(row)
            const baseloadError = warnings.find((w) => w.field === 'constantBaseload')
            const renewableWarn = warnings.find((w) => w.field === 'renewables')
            return (
              <tr key={row.yearIndex} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-1 pl-3 pr-2 font-semibold text-gray-700">{yearLabel(row.yearIndex)}</td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.maxPowerConsumption}
                      onChange={(v) => onUpdate(i, 'maxPowerConsumption', v)}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.constantBaseload}
                      onChange={(v) => onUpdate(i, 'constantBaseload', v)}
                      highlight={baseloadError ? 'error' : null}
                      title={baseloadError?.message}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.solarCapacityMW}
                      onChange={(v) => onUpdate(i, 'solarCapacityMW', v)}
                      highlight={renewableWarn ? 'warning' : null}
                      title={renewableWarn?.message}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.windCapacityMW}
                      onChange={(v) => onUpdate(i, 'windCapacityMW', v)}
                      highlight={renewableWarn ? 'warning' : null}
                      title={renewableWarn?.message}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.nuclearCapacityMW}
                      onChange={(v) => onUpdate(i, 'nuclearCapacityMW', v)}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.bessCapacityMWh ?? 1000}
                      onChange={(v) => onUpdate(i, 'bessCapacityMWh', v)}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex justify-end">
                    <NumInput
                      value={row.flexibleLoadMW ?? 0}
                      onChange={(v) => onUpdate(i, 'flexibleLoadMW', v)}
                    />
                  </div>
                </td>
                <td className="py-1 px-2">
                  <div className="flex items-center gap-1.5 justify-center">
                    <input
                      type="range"
                      min={0}
                      max={0.2}
                      step={0.01}
                      value={row.priceRandomizer}
                      onChange={(e) => onUpdate(i, 'priceRandomizer', parseFloat(e.target.value))}
                      className="w-20 h-1.5 accent-blue-600"
                    />
                    <span className="w-10 text-right text-gray-600 font-mono">
                      ±{(row.priceRandomizer * 100).toFixed(0)}%
                    </span>
                  </div>
                </td>
                <td className="py-1 px-2">
                  {i < rows.length - 1 && (
                    <button
                      type="button"
                      onClick={() => onPropagate(i)}
                      title="Propagate values to next year"
                      className="rounded px-1.5 py-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 text-[10px]"
                    >
                      ↓
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ─── Save As Modal ────────────────────────────────────────────────────────────

function SaveAsModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string, description: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 rounded-lg border border-gray-200 bg-white p-5 shadow-xl">
        <h3 className="mb-4 text-sm font-semibold text-gray-800">Save Scenario As...</h3>
        <label className="mb-1 block text-xs font-medium text-gray-600">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My custom scenario"
          className="mb-3 w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
          autoFocus
        />
        <label className="mb-1 block text-xs font-medium text-gray-600">Description (optional)</label>
        <textarea
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          rows={2}
          placeholder="Brief description of this scenario..."
          className="mb-4 w-full rounded border border-gray-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-blue-400"
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!name.trim()}
            onClick={() => onConfirm(name.trim(), desc.trim())}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Main ScenariosView ───────────────────────────────────────────────────────

function getProjectLifeYears(): number {
  try {
    const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? 'null')
    if (typeof raw?.finance?.projectLifeYears === 'number') return raw.finance.projectLifeYears
  } catch { /* ignore */ }
  return 25
}

function buildInitialRows(): YearCapacityParams[] {
  const profile = getDefaultProfile()
  const n = getProjectLifeYears()
  const rows = [...profile.years]
  while (rows.length < n) {
    const last = rows[rows.length - 1]!
    rows.push({ ...last, yearIndex: rows.length })
  }
  return rows.slice(0, n)
}

export default function ScenariosView({
  onNavigateToSimulation,
  forecastOutput,
  onForecastOutputChange,
}: {
  onNavigateToSimulation?: () => void
  forecastOutput: MultiYearForecastOutput | null
  onForecastOutputChange: (output: MultiYearForecastOutput | null) => void
}) {
  const output = forecastOutput
  const setOutput = onForecastOutputChange

  const [series, setSeries] = useState<PriceSeries | null>(null)
  const [tableRows, setTableRows] = useState<YearCapacityParams[]>(buildInitialRows)
  const [baselineJson, setBaselineJson] = useState<string>(() => JSON.stringify(buildInitialRows()))
  const [activeMeta, setActiveMeta] = useState<Omit<ScenarioProfile, 'years'>>(() => {
    const p = getDefaultProfile()
    return { id: p.id, name: p.name, description: p.description, isPreset: p.isPreset, updatedAt: p.updatedAt }
  })
  const [customProfiles, setCustomProfiles] = useState<ScenarioProfile[]>(loadCustomProfiles)
  const [seed, setSeed] = useState(42)
  const [running, setRunning] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'forecast' | 'backtest'>('forecast')
  const [showSaveAs, setShowSaveAs] = useState(false)

  const chartInstanceRef = useRef<ECharts | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setSeries(data))
      .catch(() => {})
  }, [])

  const isDirty = JSON.stringify(tableRows) !== baselineJson
  const allProfiles: ScenarioProfile[] = [...PRESET_SCENARIOS, ...customProfiles]

  const loadProfile = useCallback((profile: ScenarioProfile) => {
    setTableRows([...profile.years])
    setBaselineJson(JSON.stringify(profile.years))
    setActiveMeta({ id: profile.id, name: profile.name, description: profile.description, isPreset: profile.isPreset, updatedAt: profile.updatedAt })
  }, [])

  function updateRow(rowIdx: number, field: keyof Omit<YearCapacityParams, 'yearIndex'>, value: number) {
    setTableRows((prev) => {
      const next = [...prev]
      next[rowIdx] = { ...next[rowIdx]!, [field]: value }
      return next
    })
  }

  function propagateRow(rowIdx: number) {
    setTableRows((prev) => {
      const next = [...prev]
      if (rowIdx < next.length - 1) {
        next[rowIdx + 1] = { ...next[rowIdx]!, yearIndex: rowIdx + 1 }
      }
      return next
    })
  }

  function handleSave() {
    if (activeMeta.isPreset) return
    const updated: ScenarioProfile = { ...activeMeta, years: tableRows, updatedAt: new Date().toISOString() }
    saveCustomProfile(updated)
    setCustomProfiles((prev) => prev.map((p) => (p.id === activeMeta.id ? updated : p)))
    setBaselineJson(JSON.stringify(tableRows))
    setActiveMeta((prev) => ({ ...prev, updatedAt: updated.updatedAt }))
  }

  function handleSaveAs(name: string, description: string) {
    const id = Date.now().toString()
    const newProfile: ScenarioProfile = {
      id, name, description, isPreset: false,
      updatedAt: new Date().toISOString(),
      years: tableRows,
    }
    saveCustomProfile(newProfile)
    setCustomProfiles((prev) => [...prev, newProfile])
    setBaselineJson(JSON.stringify(tableRows))
    setActiveMeta({ id, name, description, isPreset: false, updatedAt: newProfile.updatedAt })
    setShowSaveAs(false)
  }

  function handleDelete() {
    if (activeMeta.isPreset) return
    deleteCustomProfile(activeMeta.id)
    setCustomProfiles((prev) => prev.filter((p) => p.id !== activeMeta.id))
    loadProfile(getDefaultProfile())
  }

  function handleExport() {
    const profile: ScenarioProfile = { ...activeMeta, years: tableRows }
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeMeta.name.replace(/[^a-z0-9]/gi, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string) as ScenarioProfile
        if (!parsed.years || !Array.isArray(parsed.years)) throw new Error('Invalid profile')
        const imported: ScenarioProfile = {
          ...parsed,
          id: Date.now().toString(),
          isPreset: false,
          updatedAt: new Date().toISOString(),
        }
        saveCustomProfile(imported)
        setCustomProfiles((prev) => [...prev, imported])
        loadProfile(imported)
      } catch {
        alert('Invalid or unrecognised scenario JSON file.')
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  function handleRun() {
    if (!series) return
    setRunning(true)
    setTimeout(() => {
      try {
        const profile: ScenarioProfile = { ...activeMeta, years: tableRows }
        localStorage.setItem('bess-analyzer.activeScenario', JSON.stringify(profile))
        const result = runForecast(series, profile, seed)
        setOutput(result)
        setSelectedEventId(null)
      } finally {
        setRunning(false)
      }
    }, 0)
  }

  function handleEventClick(event: SimulationEvent) {
    setSelectedEventId(event.id)
    const instance = chartInstanceRef.current
    if (!instance) return
    const pad = 168
    instance.dispatchAction({
      type: 'dataZoom',
      dataZoomIndex: 0,
      startValue: Math.max(0, event.startHourIndex - pad),
      endValue: Math.min((output?.totalHours ?? 1) - 1, event.endHourIndex + pad),
    })
  }

  const eventCounts = useMemo(() => {
    if (!output) return null
    const counts: Record<string, number> = { dunkelflaute_shock: 0, stochastic_outage: 0, structural_shift: 0 }
    for (const ev of output.events) counts[ev.type] = (counts[ev.type] ?? 0) + 1
    return counts
  }, [output])

  return (
    <div className="flex flex-col h-[calc(100vh-130px)]">
      {showSaveAs && (
        <SaveAsModal onConfirm={handleSaveAs} onCancel={() => setShowSaveAs(false)} />
      )}

      {/* ── Header toolbar ── */}
      <div className="shrink-0 flex items-center gap-2 border-b border-gray-200 px-4 py-2 flex-wrap">
        <h2 className="text-base font-semibold mr-1">Scenarios</h2>

        {/* Profile selector */}
        <div className="flex items-center gap-1.5">
          <select
            value={activeMeta.id}
            onChange={(e) => {
              const found = allProfiles.find((p) => p.id === e.target.value)
              if (found) loadProfile(found)
            }}
            className="rounded border border-gray-300 px-2 py-1 text-xs"
          >
            <optgroup label="Presets">
              {PRESET_SCENARIOS.map((p) => (
                <option key={p.id} value={p.id}>{p.name} (Preset)</option>
              ))}
            </optgroup>
            {customProfiles.length > 0 && (
              <optgroup label="Saved">
                {customProfiles.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
          {isDirty && (
            <span title="Unsaved changes" className="h-2 w-2 rounded-full bg-orange-400 shrink-0" />
          )}
        </div>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleSave}
            disabled={activeMeta.isPreset || !isDirty}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => setShowSaveAs(true)}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            Save As...
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            Export JSON
          </button>
          <label className="cursor-pointer rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50">
            Import JSON
            <input
              ref={importInputRef}
              type="file"
              accept=".json"
              onChange={handleImport}
              className="hidden"
            />
          </label>
          <button
            type="button"
            onClick={handleDelete}
            disabled={activeMeta.isPreset}
            className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
          >
            Delete
          </button>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-500">Years</label>
            <input
              type="number"
              min={1}
              max={40}
              value={tableRows.length}
              onChange={(e) => {
                const n = Math.max(1, Math.min(40, parseInt(e.target.value) || 1))
                setTableRows((prev) => {
                  if (n === prev.length) return prev
                  if (n < prev.length) return prev.slice(0, n)
                  const next = [...prev]
                  while (next.length < n) {
                    const last = next[next.length - 1]!
                    next.push({ ...last, yearIndex: next.length })
                  }
                  return next
                })
              }}
              className="w-14 rounded border border-gray-300 px-2 py-0.5 text-sm"
            />
            <span className="text-xs text-gray-400">
              ({yearLabel(0)}–{yearLabel(tableRows.length - 1)})
            </span>
          </div>
          <div className="flex items-center gap-1">
            <label className="text-xs text-gray-500">Seed</label>
            <input
              type="number"
              value={seed}
              min={1}
              onChange={(e) => setSeed(parseInt(e.target.value) || 42)}
              className="w-16 rounded border border-gray-300 px-2 py-0.5 text-sm"
            />
          </div>
          <button
            type="button"
            onClick={handleRun}
            disabled={!series || running}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            {running ? 'Generating...' : 'Generate forecast'}
          </button>
          {output && onNavigateToSimulation && (
            <button
              type="button"
              onClick={onNavigateToSimulation}
              className="rounded border border-blue-600 px-4 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50"
            >
              Move to Simulation →
            </button>
          )}
          {!series && <span className="text-xs text-gray-400">Loading data...</span>}
        </div>
      </div>

      {/* ── Scenario description ── */}
      <div className="shrink-0 border-b border-gray-100 bg-gray-50 px-4 py-1.5 text-xs text-gray-600">
        <span className="font-medium text-gray-800">{activeMeta.name}: </span>
        {activeMeta.description}
      </div>

      {/* ── Scenario Editor Table ── */}
      <div className="shrink-0 border-b border-gray-200 max-h-[220px] overflow-y-auto">
        <ScenarioTable rows={tableRows} onUpdate={updateRow} onPropagate={propagateRow} />
      </div>

      {/* ── Tab bar ── */}
      <div className="shrink-0 flex border-b border-gray-200">
        {(['forecast', 'backtest'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={[
              'px-5 py-2 text-sm font-medium',
              activeTab === t ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500 hover:text-black',
            ].join(' ')}
          >
            {t === 'forecast' ? 'Forecast' : 'Backtest'}
          </button>
        ))}
        {eventCounts && (
          <div className="ml-auto flex items-center gap-3 px-4 text-xs text-gray-500">
            <span>
              <span className="font-medium text-orange-600">{eventCounts['dunkelflaute_shock']}</span> dunkelflaute
            </span>
            <span>
              <span className="font-medium text-red-600">{eventCounts['stochastic_outage']}</span> outages
            </span>
            <span>
              <span className="font-medium text-green-700">{eventCounts['structural_shift']}</span> structural
            </span>
          </div>
        )}
      </div>

      {/* ── Main content ── */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === 'backtest' ? (
          <div className="h-full overflow-y-auto p-4">
            {series ? (
              <BacktestPanel series={series} />
            ) : (
              <p className="text-sm text-gray-400">Loading price data...</p>
            )}
          </div>
        ) : !output ? (
          <div className="flex h-full items-center justify-center text-sm text-gray-400">
            Configure the scenario table above and press Generate forecast.
          </div>
        ) : (
          <div className="flex h-full">
            {/* Price chart (75%) */}
            <div className="min-w-0 flex-[3] overflow-hidden border-r border-gray-200 p-3">
              <ForecastChart
                output={output}
                onChartReady={(instance) => { chartInstanceRef.current = instance }}
              />
            </div>

            {/* Event ledger (25%) */}
            <div className="w-72 shrink-0 flex flex-col overflow-hidden">
              <div className="shrink-0 border-b border-gray-200 px-3 py-2">
                <p className="text-xs font-semibold text-gray-700">
                  Events ({output.events.length}) — click to zoom
                </p>
              </div>
              <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1.5">
                {output.events.length === 0 ? (
                  <p className="text-xs text-gray-400 p-2">No events generated.</p>
                ) : (
                  output.events.map((ev) => (
                    <EventCard
                      key={ev.id}
                      event={ev}
                      selected={selectedEventId === ev.id}
                      onClick={() => handleEventClick(ev)}
                    />
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
