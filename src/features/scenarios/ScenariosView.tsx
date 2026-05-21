import { useRef, useState, useEffect, useMemo } from 'react'
import ReactECharts from 'echarts-for-react'
import type { ECharts } from 'echarts'
import type { PriceSeries } from '../../core/types/prices'
import { runForecast, calibrateFromHistory, generateForecast } from '../../core/forecast/index'
import { SCENARIOS, getScenario } from '../../core/forecast/scenarios'
import type { MultiYearForecastOutput, SimulationEvent, HistoricalCalibration } from '../../core/forecast/index'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function severityColor(s: SimulationEvent['severity']): string {
  if (s === 'critical') return '#dc2626'
  if (s === 'warning') return '#d97706'
  return '#2563eb'
}

function typeColor(t: SimulationEvent['type']): string {
  if (t === 'fundamental_gap') return 'rgba(59,130,246,0.09)'
  if (t === 'stochastic_outage') return 'rgba(239,68,68,0.09)'
  return 'rgba(34,197,94,0.09)'
}

function typeBorderColor(t: SimulationEvent['type']): string {
  if (t === 'fundamental_gap') return 'rgba(59,130,246,0.3)'
  if (t === 'stochastic_outage') return 'rgba(239,68,68,0.3)'
  return 'rgba(34,197,94,0.3)'
}

function typeLabel(t: SimulationEvent['type']): string {
  if (t === 'fundamental_gap') return 'Gap'
  if (t === 'stochastic_outage') return 'Outage'
  return 'Structural'
}

function hourIndexToYearDay(h: number): string {
  const year = Math.floor(h / 8760) + 1
  const dayOfYear = Math.floor((h % 8760) / 24) + 1
  return `Y${year} D${dayOfYear}`
}

// ─── Event badge ─────────────────────────────────────────────────────────────

function EventTypeBadge({ type }: { type: SimulationEvent['type'] }) {
  const label = typeLabel(type)
  const cls =
    type === 'fundamental_gap'
      ? 'bg-blue-50 text-blue-700 border-blue-200'
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
      {event.metricDelta?.priceImpactEur !== undefined && (
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
  // Build markArea data from events — all in one series for performance
  const markAreaData = useMemo(() => {
    const areas: [[object, object]] | [object, object][] = []
    for (const ev of output.events) {
      const duration = ev.endHourIndex - ev.startHourIndex
      if (duration < 6) continue // skip too-short events for markArea
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

  // Build markPoint data for very short events (point shocks)
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
              ? {
                  data: markPointData,
                }
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
  // Derive valid calibration years from actual data range.
  // calibYear N → calibrate on data up to end of N, test on year N+1.
  // Requires N+1 to exist in the series (even partially).
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
      const synthOutput = generateForecast(cal, [getScenario('status_quo').getYearParams(1)], 42)
      const synth = synthOutput.hourlyPrices.slice(0, 8760)

      // Extract actual test year prices
      const testStartMs = new Date(testStart + 'T00:00:00Z').getTime()
      const seriesStartMs = new Date(series.startUtc).getTime()
      const startIdx = Math.round((testStartMs - seriesStartMs) / 3_600_000)
      const actual = series.prices.slice(startIdx, startIdx + 8760)

      if (actual.length < 24) {
        alert(`No actual data found for ${parseInt(calibYear) + 1}. Try a different calibration year.`)
        return
      }

      // Monthly mean comparison (±15% tolerance)
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

      // Kolmogorov-Smirnov statistic on daily spread distributions
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

// ─── Main ScenariosView ───────────────────────────────────────────────────────

export default function ScenariosView() {
  const [series, setSeries] = useState<PriceSeries | null>(null)
  const [scenarioId, setScenarioId] = useState('status_quo')
  const [yearCount, setYearCount] = useState(10)
  const [seed, setSeed] = useState(42)
  const [output, setOutput] = useState<MultiYearForecastOutput | null>(null)
  const [running, setRunning] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'forecast' | 'backtest'>('forecast')

  const chartInstanceRef = useRef<ECharts | null>(null)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setSeries(data))
      .catch(() => {})
  }, [])

  function handleRun() {
    if (!series) return
    setRunning(true)
    // Yield to React for the spinner, then run synchronously
    setTimeout(() => {
      try {
        const result = runForecast(series, scenarioId, yearCount, seed)
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
    const pad = 168 // ±7 days in hours for context
    instance.dispatchAction({
      type: 'dataZoom',
      dataZoomIndex: 0,
      startValue: Math.max(0, event.startHourIndex - pad),
      endValue: Math.min((output?.totalHours ?? 1) - 1, event.endHourIndex + pad),
    })
  }

  const scenario = getScenario(scenarioId)

  // Event counts per type for summary
  const eventCounts = useMemo(() => {
    if (!output) return null
    const counts: Record<string, number> = { structural: 0, stochastic_outage: 0, fundamental_gap: 0 }
    for (const ev of output.events) counts[ev.type] = (counts[ev.type] ?? 0) + 1
    return counts
  }, [output])

  return (
    <div className="flex flex-col gap-0 h-[calc(100vh-130px)]">
      {/* ── Top toolbar ── */}
      <div className="flex shrink-0 items-center gap-3 border-b border-gray-200 px-4 py-3">
        <h2 className="text-base font-semibold">Scenarios</h2>

        {/* Scenario selector */}
        <div className="flex gap-1">
          {SCENARIOS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setScenarioId(s.id)}
              className={[
                'rounded border px-3 py-1 text-xs font-medium transition-colors',
                scenarioId === s.id
                  ? 'border-blue-600 bg-blue-600 text-white'
                  : 'border-gray-300 text-gray-600 hover:border-gray-400',
              ].join(' ')}
            >
              {s.name}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-xs text-gray-500">Years</label>
          <input
            type="number"
            value={yearCount}
            min={1}
            max={25}
            onChange={(e) => setYearCount(Math.max(1, Math.min(25, parseInt(e.target.value) || 10)))}
            className="w-14 rounded border border-gray-300 px-2 py-0.5 text-sm"
          />
        </div>

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

        <button
          type="button"
          onClick={handleRun}
          disabled={!series || running}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {running ? 'Generating...' : 'Generate forecast'}
        </button>

        {!series && <span className="text-xs text-gray-400">Waiting for price data...</span>}

        {eventCounts && (
          <div className="ml-auto flex gap-3 text-xs text-gray-500">
            <span>
              <span className="font-medium text-green-700">{eventCounts['structural']}</span> structural
            </span>
            <span>
              <span className="font-medium text-red-600">{eventCounts['stochastic_outage']}</span> outages
            </span>
            <span>
              <span className="font-medium text-blue-700">{eventCounts['fundamental_gap']}</span> gap events
            </span>
          </div>
        )}
      </div>

      {/* ── Scenario description ── */}
      <div className="shrink-0 border-b border-gray-100 bg-gray-50 px-4 py-2 text-xs text-gray-600">
        <span className="font-medium text-gray-800">{scenario.name}: </span>
        {scenario.description}
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
            Select a scenario and press Generate forecast.
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
