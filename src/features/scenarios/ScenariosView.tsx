import { useRef, useState, useEffect, useMemo, useCallback } from 'react'
import ReactECharts from 'echarts-for-react'
import type { ECharts } from 'echarts'
import type { PriceSeries } from '../../core/types/prices'
import { runForecast, calibrateFromHistory, generateForecast, PRESET_SCENARIOS, getDefaultProfile } from '../../core/forecast/index'
import type {
  MultiYearForecastOutput,
  SimulationEvent,
  HistoricalCalibration,
  ScenarioProfile,
  YearCapacityParams,
} from '../../core/forecast/index'

// ─── Constants ────────────────────────────────────────────────────────────────

const LS_PREFIX = 'bess-analyzer.scenario.'
const BASE_YEAR = 2026

// ─── LocalStorage helpers ─────────────────────────────────────────────────────

function loadCustomScenarios(): ScenarioProfile[] {
  const result: ScenarioProfile[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(LS_PREFIX)) continue
    try {
      const raw = localStorage.getItem(key)
      if (raw) result.push(JSON.parse(raw) as ScenarioProfile)
    } catch {
      // ignore malformed entries
    }
  }
  return result
}

function saveCustomScenario(profile: ScenarioProfile): void {
  localStorage.setItem(`${LS_PREFIX}${profile.id}`, JSON.stringify(profile))
}

function deleteCustomScenario(id: string): void {
  localStorage.removeItem(`${LS_PREFIX}${id}`)
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

function hourIndexToYearDay(h: number): string {
  const year = Math.floor(h / 8760) + 1
  const dayOfYear = Math.floor((h % 8760) / 24) + 1
  return `Y${year} D${dayOfYear}`
}

function profilesAreEqual(a: YearCapacityParams[], b: YearCapacityParams[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const ra = a[i]!
    const rb = b[i]!
    if (
      ra.maxPowerConsumption !== rb.maxPowerConsumption ||
      ra.constantBaseload !== rb.constantBaseload ||
      ra.solarCapacityMW !== rb.solarCapacityMW ||
      ra.windCapacityMW !== rb.windCapacityMW ||
      ra.nuclearCapacityMW !== rb.nuclearCapacityMW ||
      ra.priceRandomizer !== rb.priceRandomizer
    ) {
      return false
    }
  }
  return true
}

// ─── Event badge ─────────────────────────────────────────────────────────────

function EventTypeBadge({ type }: { type: SimulationEvent['type'] }) {
  const label = typeLabel(type)
  const cls =
    type === 'dunkelflaute_shock'
      ? 'bg-orange-50 text-orange-700 border-orange-200'
      : type === 'stochastic_outage'
        ? 'bg-red-50 text-red-700 border-red-200'
        : 'bg-green-50 text-green-700 border-green-200'
  return (
    <span className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${cls}`}>
      {label}
    </span>
  )
}

// ─── Event Card ───────────────────────────────────────────────────────────────

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
        <span className="ml-auto text-gray-400">{hourIndexToYearDay(event.startHourIndex)}</span>
      </div>
      <p className="font-medium text-gray-800 leading-snug">{event.title}</p>
      <p className="mt-0.5 text-gray-500 leading-snug line-clamp-2">{event.description}</p>
      {event.metricDelta?.priceImpactEur !== undefined && event.metricDelta.priceImpactEur !== 0 && (
        <p className="mt-1 font-medium" style={{ color: severityColor(event.severity) }}>
          {event.metricDelta.priceImpactEur > 0 ? '+' : ''}
          {event.metricDelta.priceImpactEur.toFixed(0)} €/MWh
        </p>
      )}
    </button>
  )
}

// ─── Price Forecast Chart ─────────────────────────────────────────────────────

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
      const duration = ev.endHourIndex - ev.startHourIndex
      if (duration < 6) continue
      areas.push([
        {
          xAxis: ev.startHourIndex,
          name: ev.title,
          itemStyle: { color: typeColor(ev.type), borderColor: typeBorderColor(ev.type) },
        },
        { xAxis: ev.endHourIndex },
      ])
    }
    return areas
  }, [output.events])

  const markPointData = useMemo(() => {
    return output.events
      .filter((ev) => ev.endHourIndex - ev.startHourIndex < 6)
      .map((ev) => ({
        coord: [ev.startHourIndex, output.hourlyPrices[ev.startHourIndex] ?? 0],
        name: ev.title,
        symbol: 'pin',
        symbolSize: 18,
        itemStyle: { color: severityColor(ev.severity) },
        label: { show: false },
      }))
  }, [output.events, output.hourlyPrices])

  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis',
        formatter: (params: { value: [number, number] }[]) => {
          const p = params[0]
          if (!p) return ''
          const h = p.value[0]
          const price = p.value[1]
          return `${hourIndexToYearDay(h)}<br/>${price.toFixed(1)} €/MWh`
        },
      },
      grid: { left: 60, right: 20, top: 20, bottom: 50 },
      xAxis: {
        type: 'value',
        name: 'Hour',
        min: 0,
        max: output.totalHours - 1,
        axisLabel: {
          formatter: (v: number) => hourIndexToYearDay(v),
        },
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
          sampling: 'average' as const,
          showSymbol: false,
          lineStyle: { color: '#2563eb', width: 1 },
          itemStyle: { color: '#2563eb' },
          markArea:
            markAreaData.length > 0
              ? {
                  silent: true,
                  data: markAreaData,
                  label: { show: false },
                }
              : undefined,
          markPoint:
            markPointData.length > 0
              ? { data: markPointData }
              : undefined,
        },
      ],
    }),
    [output, markAreaData, markPointData],
  )

  return (
    <ReactECharts
      option={option}
      notMerge
      style={{ height: '100%', minHeight: 420 }}
      onChartReady={onChartReady}
    />
  )
}

// ─── Backtest panel ───────────────────────────────────────────────────────────

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

      const actualSpreads = Array.from({ length: Math.min(365, Math.floor(actual.length / 24)) }, (_, d) => {
        const sl = actual.slice(d * 24, (d + 1) * 24)
        return sl.length ? Math.max(...sl) - Math.min(...sl) : 0
      }).sort((a, b) => a - b)

      let maxDiff = 0
      const n = Math.max(synthSpreads.length, actualSpreads.length)
      for (let i = 0; i < n; i++) {
        const sCdf = (synthSpreads.findIndex((v) => v >= (synthSpreads[i] ?? 0)) + 1) / synthSpreads.length
        const aCdf = actualSpreads.length
          ? (actualSpreads.findIndex((v) => v >= (actualSpreads[i] ?? 0)) + 1) / actualSpreads.length
          : 0
        maxDiff = Math.max(maxDiff, Math.abs(sCdf - aCdf))
      }

      setResult({ synth, actual, monthMeans, ksStat: maxDiff, ksPass: maxDiff < 0.10 })
    } finally {
      setRunning(false)
    }
  }

  const chartOption = useMemo(() => {
    if (!result) return {}
    const synthData = result.synth.map((p, i) => [i, p])
    const actualData = result.actual.map((p, i) => [i, p])
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
          data: synthData,
          large: true,
          largeThreshold: 3000,
          sampling: 'average' as const,
          showSymbol: false,
          lineStyle: { color: '#2563eb', width: 1 },
        },
        {
          name: 'Actual',
          type: 'line',
          data: actualData,
          large: true,
          largeThreshold: 3000,
          sampling: 'average' as const,
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
          <ReactECharts option={chartOption} notMerge style={{ height: 300 }} />

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
                      {m.pass ? (
                        <span className="text-green-600">✓</span>
                      ) : (
                        <span className="text-red-500">✗</span>
                      )}
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

// ─── Save-As Modal ────────────────────────────────────────────────────────────

function SaveAsModal({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string, description: string) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-96 rounded-lg border border-gray-200 bg-white p-6 shadow-xl">
        <h3 className="mb-4 text-sm font-semibold text-gray-900">Save scenario as...</h3>
        <div className="mb-3">
          <label className="mb-1 block text-xs font-medium text-gray-700">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My scenario"
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
            autoFocus
          />
        </div>
        <div className="mb-5">
          <label className="mb-1 block text-xs font-medium text-gray-700">Description</label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Brief description of this scenario..."
            rows={3}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-sm focus:border-blue-500 focus:outline-none resize-none"
          />
        </div>
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
            onClick={() => { if (name.trim()) onConfirm(name.trim(), description.trim()) }}
            disabled={!name.trim()}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Scenario Editor Table ────────────────────────────────────────────────────

type CellError = {
  baseloadTooHigh?: boolean
  renewableRatioHigh?: boolean
}

function ScenarioEditorTable({
  years,
  onChange,
}: {
  years: YearCapacityParams[]
  onChange: (updated: YearCapacityParams[]) => void
}) {
  function updateRow(rowIdx: number, field: keyof Omit<YearCapacityParams, 'yearIndex'>, value: number) {
    const updated = years.map((row, i) =>
      i === rowIdx ? { ...row, [field]: value } : row,
    )
    onChange(updated)
  }

  function propagateDown(rowIdx: number) {
    if (rowIdx >= years.length - 1) return
    const src = years[rowIdx]!
    const updated = years.map((row, i) =>
      i === rowIdx + 1
        ? {
            ...src,
            yearIndex: i,
          }
        : row,
    )
    onChange(updated)
  }

  function getCellErrors(row: YearCapacityParams): CellError {
    const errors: CellError = {}
    if (row.constantBaseload > row.maxPowerConsumption) {
      errors.baseloadTooHigh = true
    }
    if ((row.windCapacityMW + row.solarCapacityMW) > row.maxPowerConsumption * 3) {
      errors.renewableRatioHigh = true
    }
    return errors
  }

  const numInputCls = (hasError: boolean, isWarning = false) =>
    [
      'w-full rounded border px-1.5 py-0.5 text-right text-xs focus:outline-none focus:ring-1',
      hasError
        ? isWarning
          ? 'border-amber-400 bg-amber-50 focus:ring-amber-400'
          : 'border-red-400 bg-red-50 focus:ring-red-400'
        : 'border-gray-200 bg-white focus:ring-blue-400',
    ].join(' ')

  return (
    <div className="overflow-x-auto rounded border border-gray-200">
      <table className="min-w-full text-xs">
        <thead>
          <tr className="border-b border-gray-200 bg-gray-50">
            <th className="px-3 py-2 text-left font-semibold text-gray-700 whitespace-nowrap">Year</th>
            <th className="px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap">
              Max Consumption (MW)
            </th>
            <th className="px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap">
              Constant Baseload (MW)
            </th>
            <th className="px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap">
              Solar (MW)
            </th>
            <th className="px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap">
              Wind (MW)
            </th>
            <th className="px-2 py-2 text-right font-semibold text-gray-700 whitespace-nowrap">
              Nuclear (MW)
            </th>
            <th className="px-2 py-2 text-center font-semibold text-gray-700 whitespace-nowrap">
              Randomizer
            </th>
            <th className="px-2 py-2 text-center font-semibold text-gray-700 whitespace-nowrap w-8"></th>
          </tr>
        </thead>
        <tbody>
          {years.map((row, i) => {
            const errors = getCellErrors(row)
            const displayYear = BASE_YEAR + row.yearIndex
            return (
              <tr key={row.yearIndex} className="border-b border-gray-100 last:border-0 hover:bg-gray-50/60">
                <td className="px-3 py-1.5 font-semibold text-gray-700">{displayYear}</td>

                {/* Max Consumption */}
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    value={row.maxPowerConsumption}
                    min={1000}
                    max={50000}
                    step={100}
                    onChange={(e) => updateRow(i, 'maxPowerConsumption', Number(e.target.value))}
                    className={numInputCls(false)}
                  />
                </td>

                {/* Constant Baseload */}
                <td className="px-2 py-1.5 relative group">
                  <input
                    type="number"
                    value={row.constantBaseload}
                    min={0}
                    max={50000}
                    step={100}
                    onChange={(e) => updateRow(i, 'constantBaseload', Number(e.target.value))}
                    className={numInputCls(errors.baseloadTooHigh === true)}
                  />
                  {errors.baseloadTooHigh && (
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-red-700 px-2 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                      Cannot exceed max consumption
                    </span>
                  )}
                </td>

                {/* Solar */}
                <td className="px-2 py-1.5 relative group">
                  <input
                    type="number"
                    value={row.solarCapacityMW}
                    min={0}
                    max={50000}
                    step={100}
                    onChange={(e) => updateRow(i, 'solarCapacityMW', Number(e.target.value))}
                    className={numInputCls(errors.renewableRatioHigh === true, true)}
                  />
                  {errors.renewableRatioHigh && (
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-amber-700 px-2 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                      High negative-price probability (&gt;300% capacity ratio)
                    </span>
                  )}
                </td>

                {/* Wind */}
                <td className="px-2 py-1.5 relative group">
                  <input
                    type="number"
                    value={row.windCapacityMW}
                    min={0}
                    max={50000}
                    step={100}
                    onChange={(e) => updateRow(i, 'windCapacityMW', Number(e.target.value))}
                    className={numInputCls(errors.renewableRatioHigh === true, true)}
                  />
                  {errors.renewableRatioHigh && (
                    <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded bg-amber-700 px-2 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100 transition-opacity">
                      High negative-price probability (&gt;300% capacity ratio)
                    </span>
                  )}
                </td>

                {/* Nuclear */}
                <td className="px-2 py-1.5">
                  <input
                    type="number"
                    value={row.nuclearCapacityMW}
                    min={0}
                    max={20000}
                    step={100}
                    onChange={(e) => updateRow(i, 'nuclearCapacityMW', Number(e.target.value))}
                    className={numInputCls(false)}
                  />
                </td>

                {/* Randomizer */}
                <td className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="range"
                      min={-0.2}
                      max={0.2}
                      step={0.01}
                      value={row.priceRandomizer}
                      onChange={(e) => updateRow(i, 'priceRandomizer', Number(e.target.value))}
                      className="w-20"
                    />
                    <span className="w-10 text-right text-gray-500">
                      {row.priceRandomizer >= 0 ? '+' : ''}
                      {(row.priceRandomizer * 100).toFixed(0)}%
                    </span>
                  </div>
                </td>

                {/* Propagate button */}
                <td className="px-2 py-1.5 text-center">
                  {i < years.length - 1 && (
                    <button
                      type="button"
                      onClick={() => propagateDown(i)}
                      title="Copy this row to the row below"
                      className="rounded border border-gray-200 px-1.5 py-0.5 text-[10px] text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors"
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

// ─── Main ScenariosView ───────────────────────────────────────────────────────

export default function ScenariosView() {
  const [series, setSeries] = useState<PriceSeries | null>(null)
  const [customScenarios, setCustomScenarios] = useState<ScenarioProfile[]>(() => loadCustomScenarios())
  const [activeProfileId, setActiveProfileId] = useState<string>(PRESET_SCENARIOS[0]!.id)
  const [editingYears, setEditingYears] = useState<YearCapacityParams[]>(() =>
    PRESET_SCENARIOS[0]!.years.map((y) => ({ ...y })),
  )
  const [baselineYears, setBaselineYears] = useState<YearCapacityParams[]>(() =>
    PRESET_SCENARIOS[0]!.years.map((y) => ({ ...y })),
  )
  const [seed, setSeed] = useState(42)
  const [output, setOutput] = useState<MultiYearForecastOutput | null>(null)
  const [running, setRunning] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'forecast' | 'backtest'>('forecast')
  const [showSaveAs, setShowSaveAs] = useState(false)

  const chartInstanceRef = useRef<ECharts | null>(null)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setSeries(data))
      .catch(() => {})
  }, [])

  const allProfiles: ScenarioProfile[] = useMemo(
    () => [...PRESET_SCENARIOS, ...customScenarios],
    [customScenarios],
  )

  const activeProfile = useMemo(
    () => allProfiles.find((p) => p.id === activeProfileId) ?? PRESET_SCENARIOS[0]!,
    [allProfiles, activeProfileId],
  )

  const isDirty = useMemo(
    () => !profilesAreEqual(editingYears, baselineYears),
    [editingYears, baselineYears],
  )

  const handleSelectProfile = useCallback(
    (id: string) => {
      const profile = allProfiles.find((p) => p.id === id) ?? PRESET_SCENARIOS[0]!
      setActiveProfileId(id)
      const copy = profile.years.map((y) => ({ ...y }))
      setEditingYears(copy)
      setBaselineYears(copy.map((y) => ({ ...y })))
      setOutput(null)
    },
    [allProfiles],
  )

  function handleSave() {
    if (activeProfile.isPreset || !isDirty) return
    const updated: ScenarioProfile = {
      ...activeProfile,
      years: editingYears,
      updatedAt: new Date().toISOString(),
    }
    saveCustomScenario(updated)
    setCustomScenarios(loadCustomScenarios())
    setBaselineYears(editingYears.map((y) => ({ ...y })))
  }

  function handleSaveAs(name: string, description: string) {
    const newId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString()
    const newProfile: ScenarioProfile = {
      id: newId,
      name,
      description,
      isPreset: false,
      updatedAt: new Date().toISOString(),
      years: editingYears.map((y) => ({ ...y })),
    }
    saveCustomScenario(newProfile)
    const reloaded = loadCustomScenarios()
    setCustomScenarios(reloaded)
    setActiveProfileId(newId)
    setBaselineYears(editingYears.map((y) => ({ ...y })))
    setShowSaveAs(false)
  }

  function handleExportJson() {
    const exportProfile: ScenarioProfile = {
      ...activeProfile,
      years: editingYears,
    }
    const blob = new Blob([JSON.stringify(exportProfile, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${activeProfile.name.replace(/\s+/g, '-').toLowerCase()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const parsed = JSON.parse(ev.target?.result as string) as ScenarioProfile
        if (!parsed.id || !parsed.name || !Array.isArray(parsed.years)) {
          alert('Invalid scenario file format.')
          return
        }
        // If it was a preset, re-assign a new ID to store as custom
        const importId = parsed.isPreset
          ? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString())
          : parsed.id
        const importProfile: ScenarioProfile = {
          ...parsed,
          id: importId,
          isPreset: false,
          updatedAt: new Date().toISOString(),
        }
        saveCustomScenario(importProfile)
        const reloaded = loadCustomScenarios()
        setCustomScenarios(reloaded)
        handleSelectProfile(importId)
      } catch {
        alert('Failed to parse JSON file.')
      }
    }
    reader.readAsText(file)
    // Reset file input
    e.target.value = ''
  }

  function handleDelete() {
    if (activeProfile.isPreset) return
    deleteCustomScenario(activeProfile.id)
    const reloaded = loadCustomScenarios()
    setCustomScenarios(reloaded)
    handleSelectProfile(PRESET_SCENARIOS[0]!.id)
  }

  function handleRun() {
    if (!series) return
    setRunning(true)
    setTimeout(() => {
      try {
        const profileToRun: ScenarioProfile = {
          ...activeProfile,
          years: editingYears,
        }
        const result = runForecast(series, profileToRun, seed)
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
    const counts: Record<string, number> = { structural_shift: 0, stochastic_outage: 0, dunkelflaute_shock: 0 }
    for (const ev of output.events) counts[ev.type] = (counts[ev.type] ?? 0) + 1
    return counts
  }, [output])

  return (
    <div className="flex flex-col gap-0 h-[calc(100vh-130px)]">
      {showSaveAs && (
        <SaveAsModal
          onConfirm={handleSaveAs}
          onCancel={() => setShowSaveAs(false)}
        />
      )}

      {/* ── Header Toolbar ── */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 px-4 py-2.5">
        <h2 className="text-base font-semibold">Scenarios</h2>

        {/* Profile dropdown + dirty indicator */}
        <div className="flex items-center gap-1">
          {isDirty && (
            <span className="h-2 w-2 rounded-full bg-orange-400" title="Unsaved changes" />
          )}
          <select
            value={activeProfileId}
            onChange={(e) => handleSelectProfile(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-800 focus:border-blue-500 focus:outline-none"
          >
            <optgroup label="Presets">
              {PRESET_SCENARIOS.map((p) => (
                <option key={p.id} value={p.id}>{p.name} (Preset)</option>
              ))}
            </optgroup>
            {customScenarios.length > 0 && (
              <optgroup label="Custom">
                {customScenarios.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {/* Action buttons */}
        <button
          type="button"
          onClick={handleSave}
          disabled={activeProfile.isPreset || !isDirty}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
          title={activeProfile.isPreset ? 'Cannot overwrite a preset — use Save As...' : 'Save changes'}
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => setShowSaveAs(true)}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Save As...
        </button>
        <button
          type="button"
          onClick={handleExportJson}
          className="rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
        >
          Export JSON
        </button>
        <label className="cursor-pointer rounded border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50">
          Import JSON
          <input type="file" accept=".json" className="hidden" onChange={handleImportJson} />
        </label>
        <button
          type="button"
          onClick={handleDelete}
          disabled={activeProfile.isPreset}
          className="rounded border border-red-200 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-40"
          title={activeProfile.isPreset ? 'Cannot delete a preset' : 'Delete this scenario'}
        >
          Delete
        </button>

        <div className="mx-1 h-5 border-l border-gray-200" />

        {/* Seed */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Seed</label>
          <input
            type="number"
            value={seed}
            min={1}
            onChange={(e) => setSeed(parseInt(e.target.value) || 42)}
            className="w-16 rounded border border-gray-300 px-2 py-0.5 text-sm"
          />
        </div>

        {/* Generate button */}
        <button
          type="button"
          onClick={handleRun}
          disabled={!series || running}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {running ? 'Generating...' : 'Generate Forecast'}
        </button>

        {!series && <span className="text-xs text-gray-400">Waiting for price data...</span>}

        {eventCounts && (
          <div className="ml-auto flex gap-3 text-xs text-gray-500">
            <span>
              <span className="font-medium text-orange-600">{eventCounts['dunkelflaute_shock']}</span> dunkelflaute
            </span>
            <span>
              <span className="font-medium text-red-600">{eventCounts['stochastic_outage']}</span> outages
            </span>
          </div>
        )}
      </div>

      {/* ── Scenario description ── */}
      <div className="shrink-0 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-600">
        <span className="font-medium text-gray-800">{activeProfile.name}: </span>
        {activeProfile.description}
        <span className="ml-3 text-gray-400">5-year horizon (2026–2030)</span>
      </div>

      {/* ── Scenario Editor Table ── */}
      <div className="shrink-0 border-b border-gray-200 bg-white px-4 py-3">
        <ScenarioEditorTable years={editingYears} onChange={setEditingYears} />
      </div>

      {/* ── Tab bar ── */}
      <div className="shrink-0 flex border-b border-gray-200">
        {(['forecast', 'backtest'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setActiveTab(t)}
            className={[
              'px-5 py-2 text-sm font-medium',
              activeTab === t
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-black',
            ].join(' ')}
          >
            {t === 'forecast' ? 'Forecast' : 'Backtest'}
          </button>
        ))}
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
            Edit the capacity table above and press Generate Forecast.
          </div>
        ) : (
          <div className="flex h-full">
            {/* ── Price chart (75%) ── */}
            <div className="min-w-0 flex-[3] overflow-hidden border-r border-gray-200 p-3">
              <ForecastChart
                output={output}
                onChartReady={(instance) => {
                  chartInstanceRef.current = instance
                }}
              />
            </div>

            {/* ── Event ledger (25%) ── */}
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
