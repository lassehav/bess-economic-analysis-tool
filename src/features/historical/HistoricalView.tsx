import ReactECharts from 'echarts-for-react'
import { useMemo, useState, useEffect } from 'react'
import type { BatterySpec } from '../../core/types/battery'
import type { PriceSeries } from '../../core/types/prices'
import { getDayPrices } from '../../core/types/prices'
import { extractDailyStats } from '../../core/stats/extractor'
import type { DailyStats } from '../../core/stats/types'
import SliderInput from '../../ui/SliderInput'

// ─── Period types ─────────────────────────────────────────────────────────────

type PeriodType = 'year' | 'quarter' | 'month'
type PeriodKey = string // e.g. "2024", "2024-Q1", "2024-01"

// ─── Battery defaults ─────────────────────────────────────────────────────────

const DEFAULT_BATTERY: BatterySpec = {
  powerMW: 10,
  energyMWh: 40,
  roundTripEfficiency: 0.85,
  dod: 0.9,
  maxCyclesPerDay: 2,
  initialSocMWh: 0,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getDateRange(series: PriceSeries): { minDate: string; maxDate: string } {
  const start = series.startUtc.slice(0, 10)
  const endMs = new Date(series.endUtc).getTime() - 3_600_000
  const end = new Date(endMs).toISOString().slice(0, 10)
  return { minDate: start, maxDate: end }
}

function getDatesForPeriod(series: PriceSeries, periodType: PeriodType, periodKey: PeriodKey): string[] {
  const { minDate, maxDate } = getDateRange(series)
  const dates: string[] = []
  let cur = new Date(minDate + 'T00:00:00.000Z')
  const end = new Date(maxDate + 'T00:00:00.000Z')
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10)
    if (matchesPeriod(iso, periodType, periodKey)) dates.push(iso)
    cur = new Date(cur.getTime() + 86_400_000)
  }
  return dates
}

function matchesPeriod(date: string, periodType: PeriodType, periodKey: PeriodKey): boolean {
  const year = date.slice(0, 4)
  const month = parseInt(date.slice(5, 7), 10)
  const q = Math.ceil(month / 3)
  if (periodType === 'year') return year === periodKey
  if (periodType === 'quarter') return `${year}-Q${q}` === periodKey
  if (periodType === 'month') return date.slice(0, 7) === periodKey
  return false
}

function getAvailablePeriods(series: PriceSeries, periodType: PeriodType): string[] {
  const { minDate, maxDate } = getDateRange(series)
  const seen = new Set<string>()
  let cur = new Date(minDate + 'T00:00:00.000Z')
  const end = new Date(maxDate + 'T00:00:00.000Z')
  while (cur <= end) {
    const iso = cur.toISOString().slice(0, 10)
    const year = iso.slice(0, 4)
    const month = parseInt(iso.slice(5, 7), 10)
    const q = Math.ceil(month / 3)
    let key: string
    if (periodType === 'year') key = year
    else if (periodType === 'quarter') key = `${year}-Q${q}`
    else key = iso.slice(0, 7)
    seen.add(key)
    cur = new Date(cur.getTime() + 86_400_000)
  }
  return Array.from(seen).sort()
}

function buildHistogram(values: number[], bins: number): { x: string[]; counts: number[] } {
  if (values.length === 0) return { x: [], counts: [] }
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return { x: [String(min.toFixed(1))], counts: [values.length] }
  const binSize = (max - min) / bins
  const counts = Array(bins).fill(0) as number[]
  const labels: string[] = []
  for (let i = 0; i < bins; i++) {
    const lo = min + i * binSize
    const hi = lo + binSize
    labels.push(`${lo.toFixed(1)}–${hi.toFixed(1)}`)
    for (const v of values) {
      if (v >= lo && (i === bins - 1 ? v <= hi : v < hi)) counts[i]!++
    }
  }
  return { x: labels, counts }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function LoadingSpinner() {
  return (
    <div className="flex h-64 items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
      <span className="ml-3 text-sm text-gray-500">Loading price data…</span>
    </div>
  )
}

// ─── Chart 1: Time series ─────────────────────────────────────────────────────

function Chart1TimeSeries({
  series,
  periodType,
  periodKey,
}: {
  series: PriceSeries
  periodType: PeriodType
  periodKey: PeriodKey
}) {
  const data = useMemo(() => {
    const dates = getDatesForPeriod(series, periodType, periodKey)
    const points: [string, number][] = []
    for (const date of dates) {
      const day = getDayPrices(series, date)
      if (!day) continue
      for (let h = 0; h < day.prices.length; h++) {
        const ms = new Date(day.dayStartUtc).getTime() + h * 3_600_000
        points.push([new Date(ms).toISOString(), day.prices[h]!])
      }
    }
    return points
  }, [series, periodType, periodKey])

  const option = useMemo(() => ({
    tooltip: { trigger: 'axis', formatter: (params: { value: [string, number] }[]) => {
      const p = params[0]
      if (!p) return ''
      return `${p.value[0]}<br/>${p.value[1].toFixed(2)} €/MWh`
    }},
    xAxis: { type: 'time' },
    yAxis: { type: 'value', name: '€/MWh', nameLocation: 'middle', nameGap: 50 },
    series: [{ type: 'line', data, showSymbol: false, lineStyle: { width: 1, color: '#2563eb' } }],
    dataZoom: [
      { type: 'inside', start: 0, end: 100 },
      { type: 'slider', start: 0, end: 100 },
    ],
    grid: { left: 70, right: 20, bottom: 60 },
  }), [data])

  return <ReactECharts option={option} style={{ height: 300 }} />
}

// ─── Chart 2: Diurnal heatmap ─────────────────────────────────────────────────

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function Chart2DiurnalHeatmap({
  series,
  periodType,
  periodKey,
}: {
  series: PriceSeries
  periodType: PeriodType
  periodKey: PeriodKey
}) {
  const { data, minVal, maxVal } = useMemo(() => {
    const sums: number[][] = Array.from({ length: 12 }, () => Array(24).fill(0) as number[])
    const counts: number[][] = Array.from({ length: 12 }, () => Array(24).fill(0) as number[])
    const dates = getDatesForPeriod(series, periodType, periodKey)
    for (const date of dates) {
      const day = getDayPrices(series, date)
      if (!day) continue
      const month = parseInt(date.slice(5, 7), 10) - 1
      for (let h = 0; h < day.prices.length && h < 24; h++) {
        sums[month]![h]! += day.prices[h]!
        counts[month]![h]!++
      }
    }
    const points: [number, number, number][] = []
    let mn = Infinity, mx = -Infinity
    for (let m = 0; m < 12; m++) {
      for (let h = 0; h < 24; h++) {
        const c = counts[m]![h]!
        if (c > 0) {
          const v = sums[m]![h]! / c
          points.push([h, m, v])
          if (v < mn) mn = v
          if (v > mx) mx = v
        }
      }
    }
    return { data: points, minVal: mn === Infinity ? 0 : mn, maxVal: mx === -Infinity ? 100 : mx }
  }, [series, periodType, periodKey])

  const option = useMemo(() => ({
    tooltip: {
      formatter: (p: { value: [number, number, number] }) =>
        `Hour ${p.value[0]}, ${MONTH_NAMES[p.value[1]] ?? ''}: ${p.value[2].toFixed(2)} €/MWh`,
    },
    xAxis: { type: 'category', data: Array.from({length:24}, (_,i)=>String(i)), name: 'Hour' },
    yAxis: { type: 'category', data: MONTH_NAMES },
    visualMap: { min: minVal, max: maxVal, calculable: true, orient: 'horizontal', left: 'center', bottom: 0, inRange: { color: ['#dbeafe','#2563eb','#1e3a8a'] } },
    series: [{ type: 'heatmap', data, label: { show: false } }],
    grid: { left: 60, right: 20, bottom: 80, top: 10 },
  }), [data, minVal, maxVal])

  return <ReactECharts option={option} style={{ height: 320 }} />
}

// ─── Chart 3: Daily spread distribution ──────────────────────────────────────

function Chart3SpreadDistribution({
  dailyStats,
}: {
  dailyStats: DailyStats[]
}) {
  const { x, counts } = useMemo(() => {
    const spreads = dailyStats.map((d) => d.spread)
    return buildHistogram(spreads, 15)
  }, [dailyStats])

  const option = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: x, name: 'Spread (€/MWh)', axisLabel: { rotate: 45, fontSize: 10 } },
    yAxis: { type: 'value', name: 'Days' },
    series: [{ type: 'bar', data: counts, itemStyle: { color: '#2563eb' } }],
    grid: { left: 60, right: 20, bottom: 80, top: 20 },
  }), [x, counts])

  return <ReactECharts option={option} style={{ height: 280 }} />
}

// ─── Chart 4: Window-count histogram ─────────────────────────────────────────

function Chart4WindowCount({ dailyStats }: { dailyStats: DailyStats[] }) {
  const counts = useMemo(() => {
    const hist = [0, 0, 0, 0]
    for (const d of dailyStats) {
      const k = Math.min(d.windows.length, 3)
      hist[k]!++
    }
    return hist
  }, [dailyStats])

  const option = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: ['0 windows','1 window','2 windows','3 windows'] },
    yAxis: { type: 'value', name: 'Days' },
    series: [{ type: 'bar', data: counts, itemStyle: { color: '#2563eb' } }],
    grid: { left: 60, right: 20, bottom: 40, top: 20 },
  }), [counts])

  return <ReactECharts option={option} style={{ height: 260 }} />
}

// ─── Chart 7: Effective margin distribution ───────────────────────────────────

function Chart7MarginDistribution({ dailyStats }: { dailyStats: DailyStats[] }) {
  const { x, counts } = useMemo(() => {
    const margins = dailyStats
      .filter((d) => d.windows.length >= 1)
      .map((d) => d.windows[0]!.effectiveMargin)
    return buildHistogram(margins, 15)
  }, [dailyStats])

  const option = useMemo(() => ({
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: x, name: 'Effective Margin (€/MWh)', axisLabel: { rotate: 45, fontSize: 10 } },
    yAxis: { type: 'value', name: 'Windows' },
    series: [{ type: 'bar', data: counts, itemStyle: { color: '#16a34a' } }],
    grid: { left: 60, right: 20, bottom: 80, top: 20 },
  }), [x, counts])

  return <ReactECharts option={option} style={{ height: 280 }} />
}

// ─── Day Inspection — Price + window overlay ──────────────────────────────────

function DayPriceChart({ dayStats }: { dayStats: DailyStats }) {
  const option = useMemo(() => {
    const H = dayStats.hourlyPrices.length
    const hours = Array.from({ length: H }, (_, i) => i)
    const opacities = [0.3, 0.2, 0.1]

    // markAreas for charge and discharge blocks
    const markAreaData: [object, object][] = []
    for (let wi = 0; wi < dayStats.windows.length; wi++) {
      const win = dayStats.windows[wi]!
      const opacity = opacities[wi] ?? 0.1
      const chargeMin = Math.min(...win.chargeHourIndices)
      const chargeMax = Math.max(...win.chargeHourIndices)
      markAreaData.push([
        { xAxis: chargeMin, itemStyle: { color: `rgba(34,197,94,${opacity})` }, name: `W${wi+1} CHARGE ${win.vwapCharge.toFixed(1)}€` },
        { xAxis: chargeMax + 1 },
      ])
      const dischargeMin = Math.min(...win.dischargeHourIndices)
      const dischargeMax = Math.max(...win.dischargeHourIndices)
      markAreaData.push([
        { xAxis: dischargeMin, itemStyle: { color: `rgba(239,68,68,${opacity})` }, name: `W${wi+1} DISCHARGE ${win.effectiveMargin.toFixed(1)}€` },
        { xAxis: dischargeMax + 1 },
      ])
    }

    return {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: hours, name: 'Hour (UTC)' },
      yAxis: { type: 'value', name: '€/MWh' },
      series: [
        {
          type: 'line',
          data: dayStats.hourlyPrices,
          lineStyle: { color: '#1e3a8a', width: 2 },
          showSymbol: false,
          markLine: {
            data: [{ yAxis: dayStats.meanPrice, name: 'Mean', lineStyle: { type: 'dashed', color: '#6b7280' } }],
            label: { formatter: '{b}: {c} €/MWh' },
          },
          markArea: { data: markAreaData, label: { show: true, fontSize: 10 } },
        },
      ],
      grid: { left: 60, right: 20, bottom: 40, top: 20 },
    }
  }, [dayStats])

  return <ReactECharts option={option} style={{ height: 320 }} />
}

// ─── Day Inspection — SoC trace ───────────────────────────────────────────────

function SocTraceChart({ dayStats, battery }: { dayStats: DailyStats; battery: BatterySpec }) {
  const option = useMemo(() => {
    const pts = dayStats.socTrace

    // Background shading from window blocks — green for charge, orange for discharge
    const markAreaData: [object, object][] = []
    for (const win of dayStats.windows) {
      if (win.chargeHourIndices.length > 0) {
        markAreaData.push([
          { xAxis: Math.min(...win.chargeHourIndices), itemStyle: { color: 'rgba(34,197,94,0.15)' } },
          { xAxis: Math.max(...win.chargeHourIndices) + 1 },
        ])
      }
      if (win.dischargeHourIndices.length > 0) {
        markAreaData.push([
          { xAxis: Math.min(...win.dischargeHourIndices), itemStyle: { color: 'rgba(234,88,12,0.15)' } },
          { xAxis: Math.max(...win.dischargeHourIndices) + 1 },
        ])
      }
    }

    // Warning scatter dots
    const warnPts = dayStats.warnings
      .filter((w) => w.kind === 'soc_exceeded_capacity' || w.kind === 'soc_below_zero')
      .map((w) => {
        const pt = pts.find((p) => p.hourIndex === (w as { hourIndex: number }).hourIndex)
        return pt ? [pt.hourIndex, pt.socPct] : null
      })
      .filter((p): p is [number, number] => p !== null)

    const series: object[] = [
      {
        type: 'line',
        data: pts.map((p) => [p.hourIndex, p.socPct]),
        lineStyle: { color: '#2563eb', width: 2 },
        itemStyle: { color: '#2563eb' },
        showSymbol: false,
        markLine: {
          symbol: 'none',
          data: [
            { yAxis: 0, name: '0%', lineStyle: { color: '#ef4444', type: 'solid' } },
            { yAxis: battery.dod * 100, name: `DoD ${(battery.dod * 100).toFixed(0)}%`, lineStyle: { color: '#ef4444', type: 'dashed' } },
            { yAxis: 100, name: '100%', lineStyle: { color: '#9ca3af', type: 'dashed' } },
          ],
          label: { show: true, position: 'end', fontSize: 10 },
        },
        markArea: markAreaData.length > 0 ? { data: markAreaData } : undefined,
      },
    ]

    if (warnPts.length > 0) {
      series.push({ type: 'scatter', data: warnPts, itemStyle: { color: '#ef4444' }, symbolSize: 10 })
    }

    return {
      tooltip: {
        trigger: 'axis',
        formatter: (p: { value: [number, number] }[]) => {
          if (!p.length || !p[0]) return ''
          const val = p[0].value
          return `Hour ${val[0]}: ${val[1].toFixed(1)}%`
        },
      },
      xAxis: { type: 'value', name: 'Hour', min: 0, max: pts.length - 1 },
      yAxis: { type: 'value', name: 'SoC %', min: 0, max: 105 },
      series,
      grid: { left: 60, right: 20, bottom: 40, top: 20 },
    }
  }, [dayStats, battery])

  return <ReactECharts option={option} notMerge style={{ height: 260 }} />
}

// ─── Day Inspection — Side panel ─────────────────────────────────────────────

function DayInspectionPanel({ dayStats, battery }: { dayStats: DailyStats; battery: BatterySpec }) {
  const sqrtEta = Math.sqrt(battery.roundTripEfficiency)
  // effectiveEnergyMWh = cEnergy * sqrtEta (internal stored)
  // gridChargeMWh      = cEnergy            = effectiveEnergyMWh / sqrtEta
  // gridDischargeMWh   = cEnergy * eta      = effectiveEnergyMWh * sqrtEta
  // netRevenue         = cEnergy * effectiveMargin
  const totalChargeMWh    = dayStats.windows.reduce((s, w) => s + w.effectiveEnergyMWh / sqrtEta, 0)
  const totalDischargeMWh = dayStats.windows.reduce((s, w) => s + w.effectiveEnergyMWh * sqrtEta, 0)
  const totalNetRevenue   = dayStats.windows.reduce((s, w) => s + w.effectiveMargin * (w.effectiveEnergyMWh / sqrtEta), 0)
  const totalEFC          = dayStats.windows.reduce((s, w) => s + w.effectiveEFC, 0)

  return (
    <div className="flex flex-col gap-3 text-xs">
      {dayStats.warnings.length > 0 && (
        <div className="rounded bg-red-50 px-2 py-1 font-medium text-red-700">
          {dayStats.warnings.length} warning{dayStats.warnings.length > 1 ? 's' : ''}
        </div>
      )}
      {dayStats.windows.length === 0 && (
        <p className="text-gray-400">No arbitrage windows found.</p>
      )}
      {dayStats.windows.map((win, i) => (
        <div key={i} className="rounded border border-gray-200 p-2">
          <p className="font-semibold text-blue-600">Window {i + 1}</p>
          <p className="text-gray-600">Charge: h{Math.min(...win.chargeHourIndices)}–h{Math.max(...win.chargeHourIndices) + 1}</p>
          <p className="text-gray-600">VWAP charge: {win.vwapCharge.toFixed(2)} €/MWh</p>
          <p className="text-gray-600">Discharge: h{Math.min(...win.dischargeHourIndices)}–h{Math.max(...win.dischargeHourIndices) + 1}</p>
          <p className="text-gray-600">VWAP discharge: {win.vwapDischarge.toFixed(2)} €/MWh</p>
          <p className="font-medium text-green-700">Margin: {win.effectiveMargin.toFixed(2)} €/MWh</p>
          <p className="text-gray-600">EFC: {win.effectiveEFC.toFixed(3)}</p>
        </div>
      ))}
      {dayStats.windows.length > 0 && (
        <div className="rounded border border-gray-100 bg-gray-50 p-2">
          <p className="mb-1 font-semibold">Day Summary</p>
          <p className="text-gray-600">Charged: <span className="font-medium text-black">{totalChargeMWh.toFixed(2)} MWh</span></p>
          <p className="text-gray-600">Discharged: <span className="font-medium text-black">{totalDischargeMWh.toFixed(2)} MWh</span></p>
          <p className="text-gray-600">Net revenue: <span className="font-medium text-green-700">{totalNetRevenue.toFixed(2)} €</span></p>
          <p className="text-gray-600">Total EFC: <span className="font-medium text-black">{totalEFC.toFixed(3)}</span></p>
        </div>
      )}
    </div>
  )
}

// ─── Main HistoricalView ──────────────────────────────────────────────────────

export default function HistoricalView() {
  const [series, setSeries] = useState<PriceSeries | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [battery, setBattery] = useState<BatterySpec>(DEFAULT_BATTERY)
  const [mdc, setMdc] = useState(0)
  const [periodType, setPeriodType] = useState<PeriodType>('year')
  const [periodKey, setPeriodKey] = useState<PeriodKey>('2024')
  const [selectedDate, setSelectedDate] = useState<string>('2024-01-15')
  const [activeTab, setActiveTab] = useState<'aggregate' | 'day'>('aggregate')

  // Load data
  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<PriceSeries>
      })
      .then((data) => {
        setSeries(data)
        // Advance to first full UTC day (startUtc may be mid-day, e.g. 22:00 UTC on Dec 31)
        const startDate = new Date(data.startUtc)
        const firstFullDay =
          startDate.getUTCHours() === 0
            ? data.startUtc.slice(0, 10)
            : new Date(
                startDate.getTime() + (24 - startDate.getUTCHours()) * 3_600_000,
              ).toISOString().slice(0, 10)
        setPeriodKey(firstFullDay.slice(0, 4))
        setSelectedDate(firstFullDay)
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false))
  }, [])

  // Compute daily stats for the selected period
  const dailyStats = useMemo<DailyStats[]>(() => {
    if (!series) return []
    const dates = getDatesForPeriod(series, periodType, periodKey)
    return dates.flatMap((date) => {
      const day = getDayPrices(series, date)
      if (!day) return []
      return [extractDailyStats(day.prices, day.dayStartUtc, battery, mdc)]
    })
  }, [series, periodType, periodKey, battery, mdc])

  // Available period options
  const periodOptions = useMemo(() => {
    if (!series) return []
    return getAvailablePeriods(series, periodType)
  }, [series, periodType])

  // Selected day stats
  const selectedDayStats = useMemo<DailyStats | null>(() => {
    if (!series) return null
    const day = getDayPrices(series, selectedDate)
    if (!day) return null
    return extractDailyStats(day.prices, day.dayStartUtc, battery, mdc)
  }, [series, selectedDate, battery, mdc])

  const D = battery.energyMWh / battery.powerMW

  // Battery spec updaters
  const setBatteryField = <K extends keyof BatterySpec>(key: K, value: BatterySpec[K]) => {
    setBattery((prev) => ({ ...prev, [key]: value }))
  }

  if (loading) return <LoadingSpinner />
  if (error) return <div className="p-8 text-red-600">Error loading price data: {error}</div>
  if (!series) return null

  return (
    <div className="flex h-[calc(100vh-130px)] gap-0">
      {/* ── Left sidebar ── */}
      <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-r border-gray-200 p-4">
        <h2 className="text-sm font-semibold">Battery Spec</h2>

        <SliderInput
          label="Power"
          unit="MW"
          value={battery.powerMW}
          onChange={(v) => setBatteryField('powerMW', v)}
          min={1}
          max={100}
          step={1}
        />
        <SliderInput
          label="Energy"
          unit="MWh"
          value={battery.energyMWh}
          onChange={(v) => setBatteryField('energyMWh', v)}
          min={1}
          max={500}
          step={1}
        />
        <SliderInput
          label="Duration D = E/P"
          unit="h"
          value={parseFloat(D.toFixed(2))}
          onChange={() => undefined}
          min={0}
          max={10}
          step={0.01}
          readOnly
        />
        <SliderInput
          label="Round-trip efficiency"
          unit="η"
          value={battery.roundTripEfficiency}
          onChange={(v) => setBatteryField('roundTripEfficiency', v)}
          min={0.7}
          max={0.95}
          step={0.01}
        />
        <SliderInput
          label="Depth of discharge"
          unit="DoD"
          value={battery.dod}
          onChange={(v) => setBatteryField('dod', v)}
          min={0.5}
          max={1.0}
          step={0.01}
        />

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Max cycles / day</label>
          <div className="flex gap-2">
            {([1, 2, 3] as const).map((n) => (
              <button
                key={n}
                onClick={() => setBatteryField('maxCyclesPerDay', n)}
                className={[
                  'flex-1 rounded border py-1 text-sm font-medium',
                  battery.maxCyclesPerDay === n
                    ? 'border-blue-600 bg-blue-50 text-blue-600'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400',
                ].join(' ')}
              >
                {n}
              </button>
            ))}
          </div>
        </div>

        <SliderInput
          label="Initial SoC"
          unit="MWh"
          value={battery.initialSocMWh ?? 0}
          onChange={(v) => setBatteryField('initialSocMWh', v)}
          min={0}
          max={battery.energyMWh}
          step={1}
        />

        <SliderInput
          label="Marginal Degradation Cost"
          unit="€/MWh"
          value={mdc}
          onChange={setMdc}
          min={0}
          max={100}
          step={0.5}
        />

        <hr className="border-gray-200" />
        <h2 className="text-sm font-semibold">Period</h2>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Period type</label>
          <select
            value={periodType}
            onChange={(e) => {
              const t = e.target.value as PeriodType
              setPeriodType(t)
              if (series) {
                const opts = getAvailablePeriods(series, t)
                if (opts.length > 0) setPeriodKey(opts[0]!)
              }
            }}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
          >
            <option value="year">Year</option>
            <option value="quarter">Quarter</option>
            <option value="month">Month</option>
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Period</label>
          <select
            value={periodKey}
            onChange={(e) => setPeriodKey(e.target.value)}
            className="w-full rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {periodOptions.map((opt) => (
              <option key={opt} value={opt}>{opt}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-gray-700">Inspect day (UTC)</label>
          <div className="flex items-center gap-1">
            <button
              onClick={() => {
                const d = new Date(selectedDate + 'T00:00:00.000Z')
                d.setUTCDate(d.getUTCDate() - 1)
                const s = d.toISOString().slice(0, 10)
                if (s >= getDateRange(series).minDate) setSelectedDate(s)
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-gray-300 text-gray-600 hover:border-gray-400 hover:text-black"
              title="Previous day"
            >
              ‹
            </button>
            <input
              type="date"
              value={selectedDate}
              min={getDateRange(series).minDate}
              max={getDateRange(series).maxDate}
              onChange={(e) => { if (e.target.value) setSelectedDate(e.target.value) }}
              className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-1 text-sm"
            />
            <button
              onClick={() => {
                const d = new Date(selectedDate + 'T00:00:00.000Z')
                d.setUTCDate(d.getUTCDate() + 1)
                const s = d.toISOString().slice(0, 10)
                if (s <= getDateRange(series).maxDate) setSelectedDate(s)
              }}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-gray-300 text-gray-600 hover:border-gray-400 hover:text-black"
              title="Next day"
            >
              ›
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Tab bar */}
        <div className="flex border-b border-gray-200">
          {(['aggregate', 'day'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setActiveTab(t)}
              className={[
                'px-5 py-2.5 text-sm font-medium',
                activeTab === t
                  ? 'border-b-2 border-blue-600 text-blue-600'
                  : 'text-gray-500 hover:text-black',
              ].join(' ')}
            >
              {t === 'aggregate' ? 'Aggregate' : 'Day Inspection'}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {activeTab === 'aggregate' && (
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
              {/* Chart 1 */}
              <div className="rounded border border-gray-200 p-3 xl:col-span-2">
                <h3 className="mb-2 text-sm font-semibold">1 — Hourly Price Time Series</h3>
                <Chart1TimeSeries series={series} periodType={periodType} periodKey={periodKey} />
              </div>

              {/* Chart 2 */}
              <div className="rounded border border-gray-200 p-3">
                <h3 className="mb-2 text-sm font-semibold">2 — Diurnal Heatmap (mean price)</h3>
                <Chart2DiurnalHeatmap series={series} periodType={periodType} periodKey={periodKey} />
              </div>

              {/* Chart 3 */}
              <div className="rounded border border-gray-200 p-3">
                <h3 className="mb-2 text-sm font-semibold">3 — Daily Spread Distribution</h3>
                <Chart3SpreadDistribution dailyStats={dailyStats} />
              </div>

              {/* Chart 4 */}
              <div className="rounded border border-gray-200 p-3">
                <h3 className="mb-2 text-sm font-semibold">4 — Window-Count Histogram</h3>
                <Chart4WindowCount dailyStats={dailyStats} />
              </div>

              {/* Chart 5 — stub */}
              <div className="flex h-64 items-center justify-center rounded border border-gray-200 p-3">
                <div className="text-center text-gray-400">
                  <p className="text-base font-medium">5 — Revenue Distribution</p>
                  <p className="mt-1 text-sm">Coming soon</p>
                </div>
              </div>

              {/* Chart 6 — stub */}
              <div className="flex h-64 items-center justify-center rounded border border-gray-200 p-3">
                <div className="text-center text-gray-400">
                  <p className="text-base font-medium">6 — EFC Distribution</p>
                  <p className="mt-1 text-sm">Coming soon</p>
                </div>
              </div>

              {/* Chart 7 */}
              <div className="rounded border border-gray-200 p-3">
                <h3 className="mb-2 text-sm font-semibold">7 — Effective Margin Distribution</h3>
                <Chart7MarginDistribution dailyStats={dailyStats} />
              </div>
            </div>
          )}

          {activeTab === 'day' && (
            <div>
              {selectedDayStats ? (
                <div className="flex gap-4">
                  {/* Charts column */}
                  <div className="flex min-w-0 flex-1 flex-col gap-4">
                    <div className="rounded border border-gray-200 p-3">
                      <h3 className="mb-2 text-sm font-semibold">
                        Price + Windows — {selectedDate}
                      </h3>
                      <DayPriceChart dayStats={selectedDayStats} />
                    </div>
                    <div className="rounded border border-gray-200 p-3">
                      <h3 className="mb-2 text-sm font-semibold">SoC Trace</h3>
                      <SocTraceChart dayStats={selectedDayStats} battery={battery} />
                    </div>
                  </div>
                  {/* Side panel */}
                  <aside className="w-56 shrink-0 rounded border border-gray-200 p-3">
                    <h3 className="mb-2 text-sm font-semibold">Window Details</h3>
                    <DayInspectionPanel dayStats={selectedDayStats} battery={battery} />
                  </aside>
                </div>
              ) : (
                <p className="text-gray-400">
                  No data for {selectedDate}. Enter a date in YYYY-MM-DD format.
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
