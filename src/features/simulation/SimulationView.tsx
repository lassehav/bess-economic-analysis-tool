import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import type { Inputs } from '../../core/types/inputs'
import type { AnnualStream, DailyPriceParams } from '../../core/types/streams'
import type { PriceSeries } from '../../core/types/prices'
import type { FinancialResults, CashflowRow } from '../../core/economics/index'
import { inputsSchema } from '../../core/types/schemas'
import { buildHistoricalDays } from '../../core/dispatch/historical'
import { runProjectSimulation } from '../../core/dispatch/engine'
import { computeFinancials, computeCapex } from '../../core/economics/index'
import { calibrateFromHistory, generateForecast } from '../../core/forecast/index'
import { PRESET_SCENARIOS } from '../../core/forecast/scenarios'
import type { ScenarioProfile } from '../../core/forecast/types'

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

type PriceMode = 'historical' | 'scenario'

type SimResult = {
  streams: AnnualStream[]
  retiredAtYear: number | null
  financials: FinancialResults
  priceMode: PriceMode
  scenarioName?: string
}

function loadScenarioFromStorage(): ScenarioProfile {
  try {
    const raw = localStorage.getItem('bess-analyzer.activeScenario')
    if (raw) return JSON.parse(raw) as ScenarioProfile
  } catch { /* ignore */ }
  return PRESET_SCENARIOS[0]!
}

function hourlyToDailyParams(prices: number[], projectLifeYears: number): DailyPriceParams[] {
  const days: DailyPriceParams[] = []
  if (prices.length === 0) return days
  const totalDays = projectLifeYears * 365
  for (let d = 0; d < totalDays; d++) {
    const startH = (d * 24) % prices.length
    const endH = startH + 24
    const slice = endH <= prices.length
      ? prices.slice(startH, endH)
      : [...prices.slice(startH), ...prices.slice(0, endH - prices.length)]
    const mean = slice.reduce((a, b) => a + b, 0) / 24
    days.push({
      yearIndex: Math.floor(d / 365),
      dayOfYear: (d % 365) + 1,
      startUtc: `2026-01-01T00:00:00Z`,
      hourlyPrices: slice,
      dayMeanPrice: mean,
    })
  }
  return days
}

function computeMdcSeries(
  inputs: Inputs,
  streams: AnnualStream[],
): number[] {
  const { energyMWh, dod, nominalCycleLifeEFC } = inputs.battery
  const capex = computeCapex(inputs)
  const lifetimeThroughput = energyMWh * dod * nominalCycleLifeEFC
  const mdc = lifetimeThroughput > 0 ? capex.total / lifetimeThroughput : 0
  return streams.map(() => mdc)
}

function StatusChip({ status }: { status: 'idle' | 'running' | 'done' }) {
  if (status === 'idle') return null
  if (status === 'running') {
    return (
      <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
        Running...
      </span>
    )
  }
  return (
    <span className="rounded bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700">
      Done
    </span>
  )
}

function FinancialChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-center rounded border border-gray-200 px-4 py-2">
      <span className="text-xs text-gray-500">{label}</span>
      <span className="mt-0.5 font-semibold text-sm text-black">{value}</span>
    </div>
  )
}

function SoHChart({
  streams,
  endOfLifeSoH,
  retiredAtYear,
}: {
  streams: AnnualStream[]
  endOfLifeSoH: number
  retiredAtYear: number | null
}) {
  const years = streams.map((s) => s.year)
  const sohs = streams.map((s) => s.endOfYearSoH * 100)

  // Floor: 5 pp below the lower of (EoL threshold) and (actual minimum SoH), rounded down to nearest 5
  const minSoHPct = sohs.length > 0 ? Math.min(...sohs) : endOfLifeSoH * 100
  const floorRaw = Math.min(endOfLifeSoH * 100, minSoHPct) - 5
  const yMin = Math.floor(floorRaw / 5) * 5

  const markLines: object[] = [
    {
      silent: true,
      lineStyle: { color: '#ef4444', type: 'dashed' },
      data: [{ yAxis: endOfLifeSoH * 100 }],
    },
  ]

  if (retiredAtYear !== null) {
    markLines.push({
      silent: true,
      lineStyle: { color: '#f97316', type: 'dashed' },
      data: [{ xAxis: retiredAtYear }],
    })
  }

  const option = {
    title: { text: 'SoH Trajectory', textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 50, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: years },
    yAxis: { type: 'value', name: '%', min: yMin, max: 100 },
    series: [
      {
        type: 'line',
        data: sohs,
        smooth: false,
        lineStyle: { color: '#2563eb' },
        itemStyle: { color: '#2563eb' },
        markLine: markLines[0],
      },
      ...(retiredAtYear !== null
        ? [
            {
              type: 'line',
              data: [],
              markLine: markLines[1],
            },
          ]
        : []),
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 260 }} />
}

function BarChart({
  title,
  years,
  values,
  yName,
}: {
  title: string
  years: number[]
  values: number[]
  yName: string
}) {
  const option = {
    title: { text: title, textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 60, right: 20, top: 40, bottom: 30 },
    xAxis: { type: 'category', data: years },
    yAxis: { type: 'value', name: yName },
    series: [
      {
        type: 'bar',
        data: values,
        itemStyle: { color: '#2563eb' },
      },
    ],
  }

  return <ReactECharts option={option} notMerge style={{ height: 260 }} />
}

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-block cursor-default">
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600 select-none">
        i
      </span>
      <span className="absolute left-5 top-0 z-10 hidden w-72 rounded border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-600 shadow-md group-hover:block">
        {text}
      </span>
    </span>
  )
}

function MdcChart({ years, values }: { years: number[]; values: number[] }) {
  const option = {
    grid: { left: 60, right: 20, top: 16, bottom: 30 },
    xAxis: { type: 'category', data: years },
    yAxis: { type: 'value', name: '€/MWh', max: 200 },
    series: [
      {
        type: 'line',
        data: values,
        smooth: false,
        lineStyle: { color: '#2563eb' },
        itemStyle: { color: '#2563eb' },
      },
    ],
  }

  return (
    <div>
      <div className="mb-1 ml-[60px] flex items-center">
        <span className="text-[13px] font-semibold">MDC over Time</span>
        <InfoTooltip
          text={
            'Pure-capital MDC (Marginal Degradation Cost):\n\nMDC = Total CAPEX ÷ (Energy × DoD × Cycle Life EFC)\n\nSpread over total lifetime throughput (MWh). Constant over time — reflects only capital cost per MWh dispatched; O&M and replacement costs are excluded.'
          }
        />
      </div>
      <ReactECharts option={option} notMerge style={{ height: 260 }} />
    </div>
  )
}

// ─── Cashflow table ────────────────────────────────────────────────────────────

function exportCashflowCsv(inputs: Inputs, streams: AnnualStream[], financials: FinancialResults) {
  const rows = financials.cashflow
  const cap = financials.capex

  const cell = (v: number | string) => {
    const s = String(v)
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s
  }

  const colHeaders = ['Line Item', ...rows.map((r) => (r.year === 0 ? 'Const. (Year 0)' : `Year ${r.year}`))]

  type LineRow = [string, ...(number | string)[]]

  const dataRows: LineRow[] = [
    ['--- Revenue ---'],
    ['Gross Revenue (€)', ...rows.map((r) => r.year === 0 ? '' : Math.round(r.revenue))],
    ['--- Capital Expenditure ---'],
    ['Battery cells (€)', ...rows.map((r) => r.year === 0 ? -Math.round(cap.battery) : '')],
    ['PCS / inverter (€)', ...rows.map((r) => r.year === 0 ? -Math.round(cap.pcs) : '')],
    ['BoP (€)', ...rows.map((r) => r.year === 0 ? -Math.round(cap.bop) : '')],
    ['Development (€)', ...rows.map((r) => r.year === 0 ? -Math.round(cap.development) : '')],
    ['Contingency (€)', ...rows.map((r) => r.year === 0 ? -Math.round(cap.contingency) : '')],
    ['Total CAPEX (€)', ...rows.map((r) => r.year === 0 ? -Math.round(cap.total) : '')],
    ['--- Operating Expenses ---'],
    ['Fixed O&M (€)', ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.fixedOM))],
    ['Variable O&M (€)', ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.variableOM))],
    ['Insurance (€)', ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.insurance))],
    ['Land Lease (€)', ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.landLease))],
    ['Grid Fees (€)', ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.gridFees))],
    ['Total OPEX (€)', ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.opex))],
    ['PCS Replacement (€)', ...rows.map((r) => r.year === 0 || r.pcsReplacement === 0 ? '' : -Math.round(r.pcsReplacement))],
    ['--- Profitability ---'],
    ['EBITDA (€)', ...rows.map((r) => r.year === 0 ? '' : Math.round(r.ebitda))],
    [`Depreciation (${inputs.finance.depreciationYears}yr SL) (€)`, ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.depreciation))],
    ['EBIT (€)', ...rows.map((r) => r.year === 0 ? '' : Math.round(r.ebit))],
    ['Net Operating Loss Carryforward (€)', ...rows.map((r) => r.year === 0 || r.nolCarryforward === 0 ? '' : -Math.round(r.nolCarryforward))],
    [`Income Tax (${inputs.finance.taxRate}%) (€)`, ...rows.map((r) => r.year === 0 ? '' : -Math.round(r.tax))],
    ['Residual Value (€)', ...rows.map((r) => r.residualValue === 0 ? '' : Math.round(r.residualValue))],
    ['--- Cash Flow ---'],
    ['Net Cash Flow (€)', ...rows.map((r) => Math.round(r.cashflow))],
    [`Discount Factor (WACC ${inputs.finance.wacc}%)`, ...rows.map((r) => r.discountFactor.toFixed(4))],
    ['Discounted Cash Flow (€)', ...rows.map((r) => Math.round(r.discountedCashflow))],
    ['Cumulative DCF / NPV (€)', ...rows.map((r) => Math.round(r.cumulativeDiscountedCashflow))],
    ['--- Operational ---'],
    ['Throughput (MWh)', ...rows.map((r) => {
      if (r.year === 0) return ''
      const s = streams.find((s) => s.year === r.year)
      return s && s.throughputMWh > 0 ? Math.round(s.throughputMWh) : ''
    })],
    ['EFC (full cycles)', ...rows.map((r) => {
      if (r.year === 0) return ''
      const s = streams.find((s) => s.year === r.year)
      return s && s.cyclesEFC > 0 ? s.cyclesEFC.toFixed(1) : ''
    })],
    ['SoH at year-end (%)', ...rows.map((r) => {
      if (r.year === 0) return ''
      const s = streams.find((s) => s.year === r.year)
      return s ? (s.endOfYearSoH * 100).toFixed(1) : ''
    })],
  ]

  const lines = [
    colHeaders.map(cell).join(','),
    ...dataRows.map((row) => row.map(cell).join(',')),
  ]

  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'bess-cashflow.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function CurrCell({ v, sign }: { v: number; sign: 'cost' | 'revenue' | 'pnl' | 'capital' }) {
  const abs = Math.abs(Math.round(v)).toLocaleString('fi-FI') + ' €'
  if (v === 0) return <span className="text-gray-300">—</span>
  if (sign === 'cost') return <span className="text-red-600">−{abs}</span>
  if (sign === 'revenue') return <span className="text-green-700">{abs}</span>
  if (sign === 'capital') {
    return v < 0
      ? <span className="text-red-600">−{Math.abs(Math.round(v)).toLocaleString('fi-FI')} €</span>
      : <span className="text-green-700">{abs}</span>
  }
  return v > 0
    ? <span className="text-green-700">{abs}</span>
    : <span className="text-red-600">−{Math.abs(Math.round(v)).toLocaleString('fi-FI')} €</span>
}

function CashflowTable({
  inputs,
  streams,
  financials,
}: {
  inputs: Inputs
  streams: AnnualStream[]
  financials: FinancialResults
}) {
  const rows: CashflowRow[] = financials.cashflow
  const cap = financials.capex

  const anyLandLease = rows.some((r) => r.landLease > 0)
  const anyPcsReplacement = rows.some((r) => r.pcsReplacement > 0)
  const anyResidualValue = rows.some((r) => r.residualValue > 0)

  function SectionHdr({ label }: { label: string }) {
    return (
      <tr>
        <td className="sticky left-0 z-10 bg-gray-100 px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500 border-r border-gray-200 whitespace-nowrap">
          {label}
        </td>
        {rows.map((_, i) => <td key={i} className="bg-gray-100 py-1" />)}
      </tr>
    )
  }

  function Row({
    label,
    bold,
    topBorder,
    indent,
    cells,
  }: {
    label: string
    bold?: boolean
    topBorder?: boolean
    indent?: boolean
    cells: (row: CashflowRow, stream: AnnualStream | undefined) => React.ReactNode
  }) {
    return (
      <tr className={`border-b border-gray-100 hover:bg-gray-50 ${topBorder ? 'border-t border-t-gray-300' : ''}`}>
        <td
          className={`sticky left-0 z-10 bg-white py-1.5 pr-4 text-xs whitespace-nowrap border-r border-gray-200 ${bold ? 'font-semibold text-gray-900' : 'text-gray-600'} ${indent ? 'pl-6' : 'pl-3'}`}
        >
          {label}
        </td>
        {rows.map((row, i) => {
          const stream = streams.find((s) => s.year === row.year)
          return (
            <td key={i} className="py-1.5 px-2.5 text-right text-xs font-mono whitespace-nowrap">
              {cells(row, stream)}
            </td>
          )
        })}
      </tr>
    )
  }

  const dash = <span className="text-gray-300">—</span>

  return (
    <div className="rounded border border-gray-200">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <h3 className="text-sm font-semibold">Cash Flow Statement</h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400">Nominal €, one row per project year</span>
          <button
            type="button"
            onClick={() => exportCashflowCsv(inputs, streams, financials)}
            className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
          >
            Export CSV
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table
          className="w-full border-collapse"
          style={{ minWidth: `${Math.max(700, rows.length * 68 + 220)}px` }}
        >
          <thead>
            <tr className="border-b-2 border-gray-300 bg-gray-50">
              <th className="sticky left-0 z-10 bg-gray-50 border-r border-gray-200 px-3 py-2 text-left text-xs font-semibold text-gray-600 whitespace-nowrap">
                Line item
              </th>
              {rows.map((r) => (
                <th
                  key={r.year}
                  className={`px-2.5 py-2 text-right text-xs font-semibold whitespace-nowrap ${r.year === 0 ? 'text-gray-400' : 'text-gray-700'}`}
                >
                  {r.year === 0 ? 'Const.' : `Yr ${r.year}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {/* ── Revenue ─────────────────────────────────────── */}
            <SectionHdr label="Revenue" />
            <Row
              label="Gross Revenue"
              bold
              cells={(r) => r.year === 0 ? dash : <CurrCell v={r.revenue} sign="revenue" />}
            />

            {/* ── CAPEX ───────────────────────────────────────── */}
            <SectionHdr label="Capital Expenditure (Year 0)" />
            <Row indent label="Battery cells"    cells={(r) => r.year === 0 ? <span className="text-red-600">−{Math.round(cap.battery).toLocaleString('fi-FI')} €</span> : dash} />
            <Row indent label="PCS / inverter"   cells={(r) => r.year === 0 ? <span className="text-red-600">−{Math.round(cap.pcs).toLocaleString('fi-FI')} €</span> : dash} />
            <Row indent label="BoP"              cells={(r) => r.year === 0 ? <span className="text-red-600">−{Math.round(cap.bop).toLocaleString('fi-FI')} €</span> : dash} />
            <Row indent label="Development"      cells={(r) => r.year === 0 ? <span className="text-red-600">−{Math.round(cap.development).toLocaleString('fi-FI')} €</span> : dash} />
            <Row indent label="Contingency"      cells={(r) => r.year === 0 ? <span className="text-red-600">−{Math.round(cap.contingency).toLocaleString('fi-FI')} €</span> : dash} />
            <Row bold  label="Total CAPEX"       cells={(r) => r.year === 0 ? <span className="font-semibold text-red-600">−{Math.round(cap.total).toLocaleString('fi-FI')} €</span> : dash} />

            {/* ── Operating Expenses ──────────────────────────── */}
            <SectionHdr label="Operating Expenses (inflation-escalated)" />
            <Row indent label="Fixed O&M"        cells={(r) => r.year === 0 ? dash : <CurrCell v={r.fixedOM}      sign="cost" />} />
            <Row indent label="Variable O&M"     cells={(r) => r.year === 0 ? dash : <CurrCell v={r.variableOM}   sign="cost" />} />
            <Row indent label="Insurance"        cells={(r) => r.year === 0 ? dash : <CurrCell v={r.insurance}    sign="cost" />} />
            {anyLandLease && (
              <Row indent label="Land Lease"     cells={(r) => r.year === 0 ? dash : <CurrCell v={r.landLease}    sign="cost" />} />
            )}
            <Row indent label="Grid Fees"        cells={(r) => r.year === 0 ? dash : <CurrCell v={r.gridFees}     sign="cost" />} />
            <Row bold  label="Total OPEX"        cells={(r) => r.year === 0 ? dash : <CurrCell v={r.opex}         sign="cost" />} />
            {anyPcsReplacement && (
              <Row indent label="PCS Replacement" cells={(r) => r.year === 0 ? dash : <CurrCell v={r.pcsReplacement} sign="cost" />} />
            )}

            {/* ── P&L ─────────────────────────────────────────── */}
            <SectionHdr label="Profitability" />
            <Row bold  label="EBITDA"            cells={(r) => r.year === 0 ? dash : <CurrCell v={r.ebitda} sign="pnl" />} />
            <Row indent label={`Depreciation (${inputs.finance.depreciationYears} yr SL)`} cells={(r) => r.year === 0 ? dash : <CurrCell v={r.depreciation} sign="cost" />} />
            <Row bold  label="EBIT"              cells={(r) => r.year === 0 ? dash : <CurrCell v={r.ebit}   sign="pnl" />} />
            <Row indent label="NOL Carryforward" cells={(r) => r.year === 0 || r.nolCarryforward === 0 ? dash : <CurrCell v={-r.nolCarryforward} sign="cost" />} />
            <Row indent label={`Income Tax (${inputs.finance.taxRate} %)`} cells={(r) => r.year === 0 ? dash : <CurrCell v={r.tax} sign="cost" />} />

            {/* ── Terminal value ───────────────────────────────── */}
            {anyResidualValue && (
              <>
                <SectionHdr label="Terminal Value" />
                <Row label="Residual Value" cells={(r) => <CurrCell v={r.residualValue} sign="revenue" />} />
              </>
            )}

            {/* ── Cash flow ────────────────────────────────────── */}
            <SectionHdr label="Cash Flow" />
            <Row bold topBorder label="Net Cash Flow"    cells={(r) => <CurrCell v={r.cashflow}            sign="pnl" />} />
            <Row indent label={`Discount factor (WACC ${inputs.finance.wacc} %)`} cells={(r) => <span className="text-gray-500">{r.discountFactor.toFixed(4)}</span>} />
            <Row bold  label="Discounted Cash Flow"      cells={(r) => <CurrCell v={r.discountedCashflow}  sign="pnl" />} />
            <Row bold  label="Cumulative DCF (→ NPV)"
              cells={(r) => {
                const v = r.cumulativeDiscountedCashflow
                const abs = Math.abs(Math.round(v)).toLocaleString('fi-FI') + ' €'
                return v >= 0
                  ? <span className="font-semibold text-green-700">{abs}</span>
                  : <span className="font-semibold text-red-600">−{abs}</span>
              }}
            />

            {/* ── Operational ──────────────────────────────────── */}
            <SectionHdr label="Operational Metrics" />
            <Row
              label="Throughput (MWh)"
              cells={(r, s) =>
                r.year === 0 || !s || s.throughputMWh === 0
                  ? dash
                  : <span className="text-gray-700">{Math.round(s.throughputMWh).toLocaleString('fi-FI')}</span>
              }
            />
            <Row
              label="EFC (full cycles)"
              cells={(r, s) =>
                r.year === 0 || !s || s.cyclesEFC === 0
                  ? dash
                  : <span className="text-gray-700">{s.cyclesEFC.toFixed(1)}</span>
              }
            />
            <Row
              label="SoH at year end"
              cells={(r, s) => {
                if (r.year === 0 || !s) return dash
                const pct = s.endOfYearSoH * 100
                const eolPct = inputs.battery.endOfLifeSoH * 100
                const cls =
                  pct > eolPct + 10 ? 'text-green-700' :
                  pct > eolPct      ? 'text-orange-600' :
                                      'text-red-600'
                return <span className={cls}>{pct.toFixed(1)} %</span>
              }}
            />
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ──────────────────────────────────────────────────────────────────────────────

export default function SimulationView() {
  const [priceSeries, setPriceSeries] = useState<PriceSeries | null>(null)
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS)
  const [priceMode, setPriceMode] = useState<PriceMode>('scenario')
  const [replayStartDate, setReplayStartDate] = useState('2024-01-01')
  const [scenarioRngSeed, setScenarioRngSeed] = useState(42)
  const [result, setResult] = useState<SimResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [cyclicWrap, setCyclicWrap] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setPriceSeries(data))
      .catch(() => {})

    try {
      const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? '')
      const parsed = inputsSchema.safeParse(raw)
      if (parsed.success) setInputs(parsed.data)
    } catch { /* ignore */ }
  }, [])

  function getSimJSON() {
    if (!result) return null
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      priceMode: result.priceMode,
      scenarioName: result.scenarioName,
      retiredAtYear: result.retiredAtYear,
      financials: result.financials,
      streams: result.streams,
    }, null, 2)
  }

  function handleExportJSON() {
    const json = getSimJSON()
    if (!json) return
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bess-simulation.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleCopyJSON() {
    const json = getSimJSON()
    if (!json) return
    navigator.clipboard.writeText(json).then(() => setCopied(true)).catch(() => {})
    setTimeout(() => setCopied(false), 1500)
  }

  function handleRun() {
    if (!priceSeries) return
    setStatus('running')
    setCyclicWrap(false)

    // Re-read inputs from localStorage so changes made in Parameters tab are picked up.
    let currentInputs = inputs
    try {
      const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? '')
      const parsed = inputsSchema.safeParse(raw)
      if (parsed.success) {
        currentInputs = parsed.data
        setInputs(parsed.data)
      }
    } catch { /* ignore */ }

    try {
      let days: DailyPriceParams[]
      let scenarioName: string | undefined

      if (priceMode === 'scenario') {
        const scenario = loadScenarioFromStorage()
        scenarioName = scenario.name
        const calibration = calibrateFromHistory(priceSeries)
        const forecast = generateForecast(calibration, scenario, scenarioRngSeed)
        // Use the scenario's own year count so the full scenario is used without cycling.
        const scenarioYears = scenario.years.length
        days = hourlyToDailyParams(forecast.hourlyPrices, scenarioYears)
      } else {
        days = buildHistoricalDays(
          priceSeries,
          replayStartDate,
          currentInputs.finance.projectLifeYears,
          () => setCyclicWrap(true),
        )
      }

      const sim = runProjectSimulation(currentInputs, days)
      const financials = computeFinancials(currentInputs, sim.streams)
      setResult({ streams: sim.streams, retiredAtYear: sim.retiredAtYear, financials, priceMode, ...(scenarioName ? { scenarioName } : {}) })
      setStatus('done')
    } catch {
      setStatus('idle')
    }
  }

  const fmt0 = (v: number) => v.toLocaleString('fi-FI', { maximumFractionDigits: 0 })
  const fmt2 = (v: number) => v.toFixed(2)
  const fmt1 = (v: number) => v.toFixed(1)

  return (
    <div className="flex flex-col gap-4">
      {/* Context banner */}
      <div className="rounded border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
        <span className="font-semibold">What this operates on: </span>
        Your <span className="font-medium">Parameters</span> (step 2) are always used. Choose a
        price source below:{' '}
        <span className="font-medium">Historical</span> replays real Finnish spot prices cyclically,{' '}
        <span className="font-medium">Scenario</span> generates synthetic prices from the forecast
        you built in step 3.
      </div>

      <div className="flex items-center gap-3 border-b border-gray-200 pb-3">
        <h2 className="text-lg font-semibold">Simulation</h2>

        {/* Price source toggle */}
        <div className="flex items-center gap-1 rounded border border-gray-300 p-0.5">
          {(['historical', 'scenario'] as PriceMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setPriceMode(m)}
              className={[
                'rounded px-3 py-1 text-sm font-medium transition-colors capitalize',
                priceMode === m ? 'bg-blue-600 text-white' : 'text-gray-600 hover:text-black',
              ].join(' ')}
            >
              {m === 'historical' ? 'Historical (replayed)' : 'Scenario forecast'}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={handleRun}
          disabled={!priceSeries || status === 'running'}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Run simulation
        </button>
        <StatusChip status={status} />
        {!priceSeries && <span className="text-xs text-gray-400">Waiting for price data...</span>}
        {result && (
          <>
            <button type="button" onClick={handleExportJSON} className="ml-auto rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50">Export JSON</button>
            <button type="button" onClick={handleCopyJSON} className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50">{copied ? 'Copied!' : 'Copy JSON'}</button>
          </>
        )}
      </div>

      <div className="flex gap-4">
        <aside className="w-64 shrink-0 flex flex-col gap-3">
          <div className="rounded border border-gray-200 p-3">
            <h3 className="mb-2 text-sm font-semibold">Key Parameters</h3>
            <div className="flex flex-col gap-1 text-xs">
              <div className="flex justify-between">
                <span className="text-gray-500">Power</span>
                <span>{inputs.battery.powerMW} MW</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Energy</span>
                <span>{inputs.battery.energyMWh} MWh</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Efficiency</span>
                <span>{(inputs.battery.roundTripEfficiency * 100).toFixed(0)} %</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Max Cycles/day</span>
                <span>{inputs.battery.maxCyclesPerDay}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Project life</span>
                <span>{inputs.finance.projectLifeYears} yr</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">WACC</span>
                <span>{inputs.finance.wacc} %</span>
              </div>
            </div>
          </div>

          {priceMode === 'historical' ? (
            <>
              <div className="rounded border border-gray-200 p-3">
                <h3 className="mb-2 text-sm font-semibold">Historical Data</h3>
                {priceSeries ? (
                  <div className="text-xs text-gray-500">
                    <p>{priceSeries.source}</p>
                    <p className="mt-1">
                      {priceSeries.startUtc.slice(0, 10)} — {priceSeries.endUtc.slice(0, 10)}
                    </p>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">Loading...</p>
                )}
              </div>
              <div className="rounded border border-gray-200 p-3">
                <h3 className="mb-2 text-sm font-semibold">Replay Start</h3>
                <input
                  type="date"
                  value={replayStartDate}
                  onChange={(e) => setReplayStartDate(e.target.value)}
                  className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
              {cyclicWrap && (
                <div className="rounded border border-orange-200 bg-orange-50 p-2 text-xs text-orange-700">
                  Historical data cycled: price history is shorter than the project life and has
                  been repeated.
                </div>
              )}
            </>
          ) : (
            <div className="rounded border border-gray-200 p-3">
              <h3 className="mb-2 text-sm font-semibold">Scenario</h3>
              {(() => {
                const sc = loadScenarioFromStorage()
                const scYears = sc.years.length
                const projYears = inputs.finance.projectLifeYears
                return (
                  <>
                    <p className="text-xs text-gray-700 font-medium">{sc.name}</p>
                    <p className="mt-0.5 text-xs text-gray-500">
                      {scYears}-year scenario. Change it in the Scenarios tab.
                    </p>
                    {scYears < projYears && (
                      <div className="mt-2 rounded border border-orange-200 bg-orange-50 p-2 text-xs text-orange-700">
                        Scenario covers {scYears} yr but project life is {projYears} yr. Years{' '}
                        {scYears + 1}–{projYears} will use the last scenario year's market
                        conditions (steady-state assumption).
                      </div>
                    )}
                  </>
                )
              })()}
              <div className="mt-2">
                <label className="text-xs font-medium text-gray-600">
                  RNG Seed: <span className="text-black">{scenarioRngSeed}</span>
                </label>
                <input
                  type="number"
                  value={scenarioRngSeed}
                  onChange={(e) => setScenarioRngSeed(Number(e.target.value))}
                  className="mt-1 w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-600 focus:outline-none"
                />
              </div>
            </div>
          )}
        </aside>

        <div className="min-w-0 flex-1 flex flex-col gap-4">
          {result && result.priceMode === 'scenario' && result.scenarioName && (
            <div className="rounded border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800">
              Scenario: <span className="font-semibold">{result.scenarioName}</span>
            </div>
          )}

          {status === 'idle' && result === null ? (
            <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 text-sm text-gray-400">
              Choose a price source and press Run simulation.
            </div>
          ) : (
            <>
              {result && (
                <>
                  <SoHChart
                    streams={result.streams}
                    endOfLifeSoH={inputs.battery.endOfLifeSoH}
                    retiredAtYear={result.retiredAtYear}
                  />
                  <BarChart
                    title="Annual Revenue"
                    years={result.streams.map((s) => s.year)}
                    values={result.streams.map((s) => Math.round(s.grossRevenue))}
                    yName="€"
                  />
                  <BarChart
                    title="Annual Throughput"
                    years={result.streams.map((s) => s.year)}
                    values={result.streams.map((s) => Math.round(s.throughputMWh))}
                    yName="MWh"
                  />
                  <BarChart
                    title="Annual EFC"
                    years={result.streams.map((s) => s.year)}
                    values={result.streams.map((s) => Math.round(s.cyclesEFC * 100) / 100)}
                    yName="EFC"
                  />
                  <MdcChart
                    years={result.streams.map((s) => s.year)}
                    values={computeMdcSeries(inputs, result.streams)}
                  />

                  <div className="flex flex-wrap gap-3 border-t border-gray-200 pt-4">
                    <FinancialChip label="NPV" value={`${fmt0(result.financials.npv)} €`} />
                    <FinancialChip
                      label="IRR"
                      value={
                        result.financials.irr !== null
                          ? `${(result.financials.irr * 100).toFixed(1)} %`
                          : '—'
                      }
                    />
                    <FinancialChip label="LCOS" value={`${fmt2(result.financials.lcos)} €/MWh`} />
                    <FinancialChip
                      label="Simple payback"
                      value={
                        result.financials.simplePaybackYears !== null
                          ? `${fmt1(result.financials.simplePaybackYears)} yr`
                          : '—'
                      }
                    />
                  </div>
                  <CashflowTable
                    inputs={inputs}
                    streams={result.streams}
                    financials={result.financials}
                  />
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
