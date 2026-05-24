import { useState, useEffect, useCallback, useRef } from 'react'
import ReactECharts from 'echarts-for-react'
import type EChartsReact from 'echarts-for-react'
import type { Inputs } from '../../core/types/inputs'
import type { AnnualStream } from '../../core/types/streams'
import type { PriceSeries } from '../../core/types/prices'
import type { ScenarioProfile } from '../../core/forecast/types'
import type { FinancialResults, CashflowRow } from '../../core/economics/index'
import { inputsSchema } from '../../core/types/schemas'
import { calibrateFromHistory, generateForecast } from '../../core/forecast/index'
import { PRESET_SCENARIOS } from '../../core/forecast/scenarios'
import { runProjectSimulation } from '../../core/dispatch/engine'
import { computeFinancials } from '../../core/economics/index'
import {
  runSensitivity,
  DEFAULT_SENSITIVITY_VARIABLES,
  extractMetric,
} from '../../core/analysis/sensitivity'
import type { SensitivityResult } from '../../core/analysis/sensitivity'
import type { SimulationRequest } from '../../core/analysis/run'
import { histogram } from '../../core/analysis/montecarlo'
import type { MCResult } from '../../core/analysis/montecarlo'
import type { SimulationOutcome } from '../../core/analysis/run'

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

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------
function loadInputsFromStorage(): Inputs {
  try {
    const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? '')
    const parsed = inputsSchema.safeParse(raw)
    if (parsed.success) return parsed.data as Inputs
  } catch { /* ignore */ }
  return DEFAULT_INPUTS
}

function loadScenarioFromStorage(): ScenarioProfile {
  try {
    const raw = localStorage.getItem('bess-analyzer.activeScenario')
    if (raw) return JSON.parse(raw) as ScenarioProfile
  } catch { /* ignore */ }
  return PRESET_SCENARIOS[0]!
}

function loadNotesFromStorage(): string {
  try {
    return localStorage.getItem('bess-analyzer.notes') ?? ''
  } catch { return '' }
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------
function fmtEur(v: number): string {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)} M€`
  if (abs >= 1_000) return `${(v / 1_000).toFixed(1)} k€`
  return `${Math.round(v)} €`
}

function fmtIrr(v: number | null): string {
  if (v === null || isNaN(v)) return 'N/A'
  return `${(v * 100).toFixed(1)} %`
}

function fmtPayback(v: number | null): string {
  if (v === null) return 'Does not recover'
  return `${v.toFixed(1)} yr`
}

function fmtMWh(v: number): string {
  return `${Math.round(v).toLocaleString('fi-FI')} MWh`
}

// ---------------------------------------------------------------------------
// hourlyToDailyParams (replicated from run.ts which doesn't export it)
// ---------------------------------------------------------------------------
function hourlyToDailyParams(
  prices: number[],
  projectLifeYears: number,
): import('../../core/types/streams').DailyPriceParams[] {
  const days: import('../../core/types/streams').DailyPriceParams[] = []
  if (prices.length === 0) return days
  const totalDays = projectLifeYears * 365
  for (let d = 0; d < totalDays; d++) {
    const startH = (d * 24) % prices.length
    const endH = startH + 24
    const slice =
      endH <= prices.length
        ? prices.slice(startH, endH)
        : [...prices.slice(startH), ...prices.slice(0, endH - prices.length)]
    const mean = slice.reduce((a, b) => a + b, 0) / 24
    days.push({
      yearIndex: Math.floor(d / 365),
      dayOfYear: (d % 365) + 1,
      startUtc: '2026-01-01T00:00:00Z',
      hourlyPrices: slice,
      dayMeanPrice: mean,
    })
  }
  return days
}

// ---------------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------------
type AnalysisBundle = {
  schemaVersion: 1
  exportedAt: string
  appVersion: '0.1.0'
  inputs: Inputs
  scenario: ScenarioProfile
  rngSeed: number
  results: {
    financials: FinancialResults
    streams: AnnualStream[]
  }
  notes: string
}

function downloadJson(obj: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function downloadCashflowCsv(cashflow: CashflowRow[]) {
  const bom = '﻿'
  const headers = [
    'year',
    'revenue',
    'opex',
    'pcsReplacement',
    'cashflow',
    'discountedCashflow',
    'cumulativeDiscountedCashflow',
  ]
  const rows = cashflow
    .filter((r) => r.year > 0)
    .map((r) =>
      [
        r.year,
        Math.round(r.revenue),
        Math.round(r.opex),
        Math.round(r.pcsReplacement),
        Math.round(r.cashflow),
        Math.round(r.discountedCashflow),
        Math.round(r.cumulativeDiscountedCashflow),
      ].join(','),
    )
  const csv = bom + [headers.join(','), ...rows].join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'bess-cashflow.csv'
  a.click()
  URL.revokeObjectURL(url)
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------
function Section({
  title,
  defaultOpen = true,
  children,
}: {
  title: string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-gray-900 dark:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
      >
        <span>{title}</span>
        <span className="text-gray-400 dark:text-gray-500 text-xs font-normal">{open ? '▲ collapse' : '▼ expand'}</span>
      </button>
      {open && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4">
          {children}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 1: Headline KPIs
// ---------------------------------------------------------------------------
function KpiCard({
  label,
  value,
  color,
  tooltip,
}: {
  label: string
  value: string
  color: 'green' | 'red' | 'amber' | 'neutral'
  tooltip: string
}) {
  const colorClasses = {
    green: 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20',
    red: 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20',
    amber: 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20',
    neutral: 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-700/30',
  }
  const textClasses = {
    green: 'text-green-700 dark:text-green-400',
    red: 'text-red-600 dark:text-red-400',
    amber: 'text-amber-700 dark:text-amber-400',
    neutral: 'text-gray-900 dark:text-gray-100',
  }
  return (
    <div
      className={`rounded border p-3 flex flex-col gap-1 ${colorClasses[color]}`}
      title={tooltip}
    >
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">{label}</span>
      <span className={`text-lg font-bold ${textClasses[color]}`}>{value}</span>
    </div>
  )
}

function HeadlineKpis({
  financials,
  retiredAtYear,
  inputs,
}: {
  financials: FinancialResults
  retiredAtYear: number | null
  inputs: Inputs
}) {
  const { npv, irr, lcos, simplePaybackYears, discountedPaybackYears, totalRevenueNominal, totalThroughputMWh } = financials
  const wacc = inputs.finance.wacc / 100
  const projectLife = inputs.finance.projectLifeYears

  const irrColor: 'green' | 'amber' | 'red' =
    irr === null ? 'red' : irr > wacc ? 'green' : irr >= 0 ? 'amber' : 'red'

  const paybackColor: 'green' | 'amber' | 'neutral' =
    simplePaybackYears !== null && simplePaybackYears < projectLife / 2 ? 'green' : 'amber'

  const retirementColor: 'red' | 'green' =
    retiredAtYear !== null && retiredAtYear < projectLife ? 'red' : 'green'
  const retirementValue =
    retiredAtYear !== null && retiredAtYear < projectLife
      ? `Year ${retiredAtYear}`
      : 'Full life'

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        label="NPV"
        value={fmtEur(npv)}
        color={npv >= 0 ? 'green' : 'red'}
        tooltip="Net Present Value: sum of all discounted cash flows. Positive = project creates value above the cost of capital."
      />
      <KpiCard
        label="IRR"
        value={fmtIrr(irr)}
        color={irrColor}
        tooltip="Internal Rate of Return: the discount rate at which NPV = 0. Compare to WACC — if IRR > WACC the project is financially viable."
      />
      <KpiCard
        label="LCOS"
        value={`${lcos.toFixed(2)} €/MWh`}
        color="neutral"
        tooltip="Levelised Cost of Storage: NPV of all costs divided by NPV-weighted throughput energy. Lower is better."
      />
      <KpiCard
        label="Simple Payback"
        value={fmtPayback(simplePaybackYears)}
        color={paybackColor}
        tooltip={`Undiscounted payback period. Green if < ${(projectLife / 2).toFixed(0)} years (half project life).`}
      />
      <KpiCard
        label="Discounted Payback"
        value={fmtPayback(discountedPaybackYears)}
        color="neutral"
        tooltip="The year in which cumulative discounted cash flow first turns positive."
      />
      <KpiCard
        label="Total Revenue"
        value={fmtEur(totalRevenueNominal)}
        color="neutral"
        tooltip="Sum of nominal gross revenues over the full project life."
      />
      <KpiCard
        label="Total Throughput"
        value={fmtMWh(totalThroughputMWh)}
        color="neutral"
        tooltip="Total energy discharged over the project life (MWh). Used in LCOS denominator."
      />
      <KpiCard
        label="Battery Retirement"
        value={retirementValue}
        color={retirementColor}
        tooltip={
          retiredAtYear !== null && retiredAtYear < projectLife
            ? `Battery reached end-of-life SoH at year ${retiredAtYear}, before project end at year ${projectLife}. Revenue drops to zero after retirement.`
            : 'Battery survived the full project life without hitting the end-of-life SoH threshold.'
        }
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 2: Cashflow chart + table toggle
// ---------------------------------------------------------------------------
function CashflowSection({
  cashflow,
  chartRef,
}: {
  cashflow: CashflowRow[]
  chartRef: React.RefObject<EChartsReact | null>
}) {
  const [showTable, setShowTable] = useState(false)

  const opRows = cashflow.filter((r) => r.year > 0)
  const years = opRows.map((r) => r.year)
  const revenue = opRows.map((r) => Math.round(r.revenue))
  const opex = opRows.map((r) => -Math.round(r.opex))
  const pcsRepl = opRows.map((r) => -Math.round(r.pcsReplacement))
  const cumDcf = cashflow.map((r) => ({ year: r.year, v: Math.round(r.cumulativeDiscountedCashflow) }))

  const option = {
    grid: { left: 80, right: 80, top: 40, bottom: 40 },
    legend: { data: ['Revenue', 'OPEX', 'PCS Replacement', 'Cumulative DCF'], bottom: 0 },
    xAxis: { type: 'category', data: years, name: 'Year' },
    yAxis: [
      {
        type: 'value',
        name: '€',
        axisLine: { lineStyle: { color: '#6b7280' } },
        splitLine: { lineStyle: { color: '#f3f4f6' } },
      },
      {
        type: 'value',
        name: 'Cum. DCF (€)',
        axisLine: { lineStyle: { color: '#7c3aed' } },
        splitLine: { show: false },
      },
    ],
    tooltip: { trigger: 'axis' },
    series: [
      {
        name: 'Revenue',
        type: 'bar',
        stack: 'cf',
        data: revenue,
        itemStyle: { color: '#22c55e' },
      },
      {
        name: 'OPEX',
        type: 'bar',
        stack: 'cf',
        data: opex,
        itemStyle: { color: '#ef4444' },
      },
      {
        name: 'PCS Replacement',
        type: 'bar',
        stack: 'cf',
        data: pcsRepl,
        itemStyle: { color: '#f97316' },
      },
      {
        name: 'Cumulative DCF',
        type: 'line',
        yAxisIndex: 1,
        data: cumDcf.filter((d) => d.year > 0).map((d) => d.v),
        smooth: false,
        lineStyle: { color: '#7c3aed', width: 2 },
        itemStyle: { color: '#7c3aed' },
        symbol: 'none',
      },
    ],
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setShowTable(false)}
          className={`rounded px-3 py-1 text-xs font-semibold ${!showTable ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
        >
          Chart
        </button>
        <button
          type="button"
          onClick={() => setShowTable(true)}
          className={`rounded px-3 py-1 text-xs font-semibold ${showTable ? 'bg-blue-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
        >
          Table
        </button>
      </div>

      {!showTable && (
        <ReactECharts
          ref={chartRef as React.RefObject<EChartsReact>}
          option={option}
          notMerge
          style={{ height: 320 }}
        />
      )}

      {showTable && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs text-left border-collapse">
            <thead>
              <tr className="border-b-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700">
                <th className="px-3 py-2 font-semibold text-gray-600 dark:text-gray-300">Year</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">Revenue</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">OPEX</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">PCS Repl.</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">Net CF</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">Discounted CF</th>
                <th className="px-3 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">Cumulative DCF</th>
              </tr>
            </thead>
            <tbody>
              {opRows.map((r) => (
                <tr key={r.year} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-3 py-1.5 font-medium text-gray-700 dark:text-gray-300">{r.year}</td>
                  <td className="px-3 py-1.5 text-right font-mono text-green-700 dark:text-green-400">{Math.round(r.revenue).toLocaleString('fi-FI')} €</td>
                  <td className="px-3 py-1.5 text-right font-mono text-red-600 dark:text-red-400">−{Math.round(r.opex).toLocaleString('fi-FI')} €</td>
                  <td className="px-3 py-1.5 text-right font-mono text-gray-600 dark:text-gray-400">{r.pcsReplacement > 0 ? `−${Math.round(r.pcsReplacement).toLocaleString('fi-FI')} €` : '—'}</td>
                  <td className={`px-3 py-1.5 text-right font-mono ${r.cashflow >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {r.cashflow >= 0 ? '' : '−'}{Math.abs(Math.round(r.cashflow)).toLocaleString('fi-FI')} €
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono ${r.discountedCashflow >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {r.discountedCashflow >= 0 ? '' : '−'}{Math.abs(Math.round(r.discountedCashflow)).toLocaleString('fi-FI')} €
                  </td>
                  <td className={`px-3 py-1.5 text-right font-mono font-semibold ${r.cumulativeDiscountedCashflow >= 0 ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                    {r.cumulativeDiscountedCashflow >= 0 ? '' : '−'}{Math.abs(Math.round(r.cumulativeDiscountedCashflow)).toLocaleString('fi-FI')} €
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 3: Battery State
// ---------------------------------------------------------------------------
function BatteryStateSection({
  streams,
  endOfLifeSoH,
  retiredAtYear,
}: {
  streams: AnnualStream[]
  endOfLifeSoH: number
  retiredAtYear: number | null
}) {
  const years = streams.map((s) => s.year)
  const sohs = streams.map((s) => +(s.endOfYearSoH * 100).toFixed(2))
  const efcs = streams.map((s) => +s.cyclesEFC.toFixed(1))

  const minSoH = sohs.length > 0 ? Math.min(...sohs) : endOfLifeSoH * 100
  const yMin = Math.floor((Math.min(endOfLifeSoH * 100, minSoH) - 5) / 5) * 5

  const sohOption = {
    grid: { left: 50, right: 20, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: years, name: 'Year' },
    yAxis: { type: 'value', name: 'SoH %', min: yMin, max: 100 },
    tooltip: { trigger: 'axis' },
    series: [
      {
        name: 'SoH',
        type: 'line',
        data: sohs,
        smooth: false,
        lineStyle: { color: '#2563eb' },
        itemStyle: { color: '#2563eb' },
        markLine: {
          silent: true,
          data: [
            { yAxis: endOfLifeSoH * 100, lineStyle: { color: '#ef4444', type: 'dashed' } },
            ...(retiredAtYear !== null ? [{ xAxis: retiredAtYear, lineStyle: { color: '#f97316', type: 'dashed' } }] : []),
          ],
        },
      },
    ],
  }

  const efcOption = {
    grid: { left: 60, right: 20, top: 36, bottom: 30 },
    xAxis: { type: 'category', data: years, name: 'Year' },
    yAxis: { type: 'value', name: 'EFC' },
    tooltip: { trigger: 'axis' },
    series: [
      {
        name: 'Annual EFC',
        type: 'bar',
        data: efcs,
        itemStyle: { color: '#0ea5e9' },
      },
    ],
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">SoH Trajectory</h3>
          <ReactECharts option={sohOption} notMerge style={{ height: 220 }} />
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide">Annual EFC</h3>
          <ReactECharts option={efcOption} notMerge style={{ height: 220 }} />
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700">
              <th className="px-2 py-2 text-left font-semibold text-gray-600 dark:text-gray-300">Year</th>
              <th className="px-2 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">SoH (%)</th>
              <th className="px-2 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">EFC</th>
              <th className="px-2 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">Throughput (MWh)</th>
              <th className="px-2 py-2 text-right font-semibold text-gray-600 dark:text-gray-300">Capacity (MWh)</th>
            </tr>
          </thead>
          <tbody>
            {streams.map((s) => {
              const sohPct = s.endOfYearSoH * 100
              const eolPct = endOfLifeSoH * 100
              const sohCls =
                sohPct > eolPct + 10 ? 'text-green-700 dark:text-green-400' :
                sohPct > eolPct ? 'text-amber-600 dark:text-amber-400' :
                'text-red-600 dark:text-red-400'
              return (
                <tr key={s.year} className="border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50">
                  <td className="px-2 py-1.5 font-medium text-gray-700 dark:text-gray-300">{s.year}</td>
                  <td className={`px-2 py-1.5 text-right font-mono ${sohCls}`}>{sohPct.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-gray-700 dark:text-gray-300">{s.cyclesEFC.toFixed(1)}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-gray-700 dark:text-gray-300">{Math.round(s.throughputMWh).toLocaleString('fi-FI')}</td>
                  <td className="px-2 py-1.5 text-right font-mono text-gray-700 dark:text-gray-300">{s.capacityMWh.toFixed(1)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 4: Sensitivity tornado (lazy — run on button click)
// ---------------------------------------------------------------------------
function SensitivitySection({ buildRequest }: { buildRequest: () => SimulationRequest | null }) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<SensitivityResult | null>(null)

  function handleRun() {
    const req = buildRequest()
    if (!req) return
    setStatus('running')
    setTimeout(() => {
      try {
        const res = runSensitivity(req, DEFAULT_SENSITIVITY_VARIABLES, 'npv')
        setResult(res)
        setStatus('done')
      } catch (err) {
        console.error('Results sensitivity error:', err)
        setStatus('error')
      }
    }, 50)
  }

  if (status === 'idle' || result === null) {
    return (
      <div className="flex flex-col items-center gap-3 py-8">
        <p className="text-sm text-gray-500 dark:text-gray-400">
          Sensitivity analysis is not yet computed for the current scenario. Click below to run it (takes ~1–2 seconds).
        </p>
        <button
          type="button"
          onClick={handleRun}
          disabled={status === 'running'}
          className="rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          {status === 'running' ? 'Computing...' : 'Run Sensitivity Analysis'}
        </button>
        {status === 'error' && <span className="text-xs text-red-600">Computation failed. Try again.</span>}
      </div>
    )
  }

  const base = extractMetric(result.base, 'npv')
  const rows = [...result.rows].slice(0, 12).reverse()
  const labels = rows.map((r) => r.variable.label)
  const lowDeltas = rows.map((r) => r.metricAtLow - base)
  const highDeltas = rows.map((r) => r.metricAtHigh - base)

  const tornadoOption = {
    grid: { left: 180, right: 40, top: 20, bottom: 40 },
    xAxis: {
      type: 'value',
      name: 'NPV delta (€)',
      nameLocation: 'middle',
      nameGap: 28,
      axisLine: { lineStyle: { color: '#9ca3af' } },
      splitLine: { lineStyle: { color: '#f3f4f6' } },
    },
    yAxis: {
      type: 'category',
      data: labels,
      axisLabel: { fontSize: 11, color: '#374151' },
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params: any) => {
        if (!params.length) return ''
        const idx = params[0].dataIndex
        const row = rows[idx]!
        return `<b>${row.variable.label}</b><br/>
                Low: ${fmtEur(row.metricAtLow)}<br/>
                Base: ${fmtEur(base)}<br/>
                High: ${fmtEur(row.metricAtHigh)}`
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
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          NPV tornado — delta from base case ({fmtEur(base)}). Sorted by range descending.
        </p>
        <button
          type="button"
          onClick={handleRun}
          className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
        >
          Recalculate
        </button>
      </div>
      <ReactECharts
        option={tornadoOption}
        notMerge
        style={{ height: Math.max(280, rows.length * 32 + 60) }}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 5: Monte Carlo results (read from localStorage)
// ---------------------------------------------------------------------------

type StoredMCResult = {
  summary: MCResult['summary']
  convergence: MCResult['convergence']
  outcomes: SimulationOutcome[]
}

function loadMCResult(): StoredMCResult | null {
  try {
    const raw = localStorage.getItem('bess-analyzer.mcResult')
    if (!raw) return null
    return JSON.parse(raw) as StoredMCResult
  } catch { return null }
}

function MCStatChip({
  label,
  value,
  accent,
  tooltip,
}: {
  label: string
  value: string
  accent?: boolean
  tooltip?: string
}) {
  return (
    <div
      title={tooltip}
      className={[
        'flex flex-col items-center rounded border px-4 py-2',
        accent
          ? 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20'
          : 'border-gray-200 dark:border-gray-700',
      ].join(' ')}
    >
      <span className={`text-xs ${accent ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}>{label}</span>
      <span className={`mt-0.5 text-sm font-semibold ${accent ? 'text-blue-700 dark:text-blue-300' : 'text-gray-900 dark:text-gray-100'}`}>{value}</span>
    </div>
  )
}

function MCSection() {
  const [mc, setMc] = useState<StoredMCResult | null>(() => loadMCResult())

  // Refresh when the tab becomes visible (user may have just run MC)
  useEffect(() => {
    function onVisibility() {
      if (document.visibilityState === 'visible') setMc(loadMCResult())
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  if (!mc) {
    return (
      <div className="flex flex-col items-center gap-3 rounded border border-dashed border-gray-300 dark:border-gray-600 py-8 px-4 text-center">
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">No Monte Carlo results yet.</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Go to the <span className="font-semibold">Monte Carlo</span> tab, run a simulation, then return here.
        </p>
        <button
          type="button"
          onClick={() => setMc(loadMCResult())}
          className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 dark:text-gray-300"
        >
          Refresh
        </button>
      </div>
    )
  }

  const { summary, outcomes, convergence } = mc
  const npvValues = outcomes.map((o) => o.npv)
  const { x: histX, counts: histCounts } = histogram(npvValues, 30)

  const histOption = {
    title: { text: 'NPV Distribution', textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 50, right: 20, top: 40, bottom: 50 },
    xAxis: {
      type: 'category',
      data: histX.map((v) => Math.round(v).toLocaleString('fi-FI')),
      name: 'NPV (€)',
      nameLocation: 'middle',
      nameGap: 32,
      axisLabel: { rotate: 30, fontSize: 9 },
    },
    yAxis: { type: 'value', name: 'Count' },
    tooltip: { trigger: 'axis' },
    series: [{ type: 'bar', data: histCounts, itemStyle: { color: '#2563eb' }, barCategoryGap: '2%' }],
  }

  const sorted = [...npvValues].sort((a, b) => a - b)
  const cdfData = sorted.map((v, i) => [v, ((i + 1) / sorted.length) * 100])
  const cdfOption = {
    title: { text: 'NPV Cumulative Distribution (CDF)', textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 60, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'value', name: 'NPV (€)', nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'value', name: 'Cumulative %', min: 0, max: 100 },
    tooltip: { trigger: 'axis' },
    series: [{
      type: 'line',
      data: cdfData,
      showSymbol: false,
      lineStyle: { color: '#2563eb' },
      areaStyle: { color: 'rgba(37,99,235,0.08)' },
      markLine: {
        silent: true,
        data: [{ yAxis: 50, lineStyle: { color: '#9ca3af', type: 'dashed' } }],
      },
    }],
  }

  const runningMean: [number, number][] = []
  let sum = 0
  const step = Math.max(1, Math.floor(npvValues.length / 200))
  for (let i = 0; i < npvValues.length; i++) {
    sum += npvValues[i]!
    if (i % step === 0 || i === npvValues.length - 1) runningMean.push([i + 1, sum / (i + 1)])
  }
  const convergenceOption = {
    title: { text: 'Convergence: Running Mean NPV', textStyle: { fontSize: 13, fontWeight: 600 } },
    grid: { left: 70, right: 20, top: 40, bottom: 40 },
    xAxis: { type: 'value', name: 'Trial #', nameLocation: 'middle', nameGap: 28 },
    yAxis: { type: 'value', name: 'Running mean NPV (€)' },
    tooltip: { trigger: 'axis' },
    series: [{
      type: 'line',
      data: runningMean,
      showSymbol: false,
      lineStyle: { color: '#7c3aed' },
      ...(convergence.trialsTo90PctStable !== null ? {
        markLine: {
          silent: true,
          data: [{
            xAxis: convergence.trialsTo90PctStable,
            label: { formatter: `Stable @${convergence.trialsTo90PctStable}` },
            lineStyle: { color: '#16a34a', type: 'dashed' },
          }],
        },
      } : {}),
    }],
  }

  const fmt0 = (v: number) => Math.round(v).toLocaleString('fi-FI')

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <MCStatChip label="P90 Downside" value={`${fmt0(summary.npv.p10)} €`} tooltip="Conservative case — 90% of trials exceeded this NPV" />
        <MCStatChip label="P50 Median" value={`${fmt0(summary.npv.p50)} €`} accent tooltip="Base case — median NPV across all trials" />
        <MCStatChip label="P10 Upside" value={`${fmt0(summary.npv.p90)} €`} tooltip="Optimistic case — only 10% of trials exceeded this NPV" />
        <MCStatChip label="P(NPV > 0)" value={`${(summary.pNpvPositive * 100).toFixed(1)} %`} accent={summary.pNpvPositive > 0.5} />
        <MCStatChip label="IRR P50" value={summary.irr.p50 !== null ? `${(summary.irr.p50 * 100).toFixed(1)} %` : '—'} />
        <MCStatChip label="LCOS P50" value={`${summary.lcos.p50.toFixed(2)} €/MWh`} />
        <MCStatChip label="Trials" value={outcomes.length.toLocaleString()} />
        {convergence.trialsTo90PctStable !== null && (
          <MCStatChip label="Stable at" value={`${convergence.trialsTo90PctStable} trials`} tooltip="Trial count at which the running mean NPV stabilised within 90% band" />
        )}
      </div>

      <div className="rounded border border-gray-100 dark:border-gray-700 p-3 text-xs text-gray-500 dark:text-gray-400">
        <span className="font-medium text-gray-700 dark:text-gray-300">NPV distribution: </span>
        Mean {fmt0(summary.npv.mean)} € · StdDev {fmt0(summary.npv.std)} € · Min {fmt0(summary.npv.min)} € · Max {fmt0(summary.npv.max)} €
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
          <ReactECharts option={histOption} notMerge style={{ height: 260 }} />
        </div>
        <div className="rounded border border-gray-200 dark:border-gray-700 p-3">
          <ReactECharts option={cdfOption} notMerge style={{ height: 260 }} />
        </div>
        <div className="rounded border border-gray-200 dark:border-gray-700 p-3 xl:col-span-2">
          <ReactECharts option={convergenceOption} notMerge style={{ height: 220 }} />
        </div>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setMc(loadMCResult())}
          className="rounded border border-gray-300 dark:border-gray-600 px-3 py-1 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 dark:text-gray-300"
        >
          Refresh from latest MC run
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export toolbar
// ---------------------------------------------------------------------------
function ExportToolbar({
  inputs,
  scenario,
  streams,
  financials,
  notes,
  chartRef,
  onImport,
}: {
  inputs: Inputs
  scenario: ScenarioProfile
  streams: AnnualStream[]
  financials: FinancialResults
  notes: string
  chartRef: React.RefObject<EChartsReact | null>
  onImport: (bundle: AnalysisBundle) => void
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleExportJson() {
    const bundle: AnalysisBundle = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      inputs,
      scenario,
      rngSeed: 42,
      results: { financials, streams },
      notes,
    }
    downloadJson(bundle, `bess-analysis-${new Date().toISOString().slice(0, 10)}.json`)
  }

  function handleExportCsv() {
    downloadCashflowCsv(financials.cashflow)
  }

  function handleExportPng() {
    if (!chartRef.current) return
    const instance = chartRef.current.getEchartsInstance()
    const url = instance.getDataURL({ type: 'png', pixelRatio: 2 })
    const a = document.createElement('a')
    a.href = url
    a.download = 'bess-cashflow-chart.png'
    a.click()
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const bundle = JSON.parse(ev.target?.result as string) as AnalysisBundle
        if (bundle.schemaVersion !== 1) {
          alert('Unsupported bundle schema version.')
          return
        }
        const parsed = inputsSchema.safeParse(bundle.inputs)
        if (!parsed.success) {
          alert('Invalid inputs in bundle.')
          return
        }
        onImport(bundle)
      } catch {
        alert('Failed to parse bundle JSON.')
      }
    }
    reader.readAsText(file)
    // Reset so the same file can be re-imported
    e.target.value = ''
  }

  return (
    <div className="results-export-toolbar flex flex-wrap items-center gap-2 rounded border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 px-4 py-2">
      <span className="text-xs font-semibold text-gray-500 dark:text-gray-400 mr-2">Export:</span>
      <button
        type="button"
        onClick={handleExportJson}
        className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
        title="Export full analysis bundle as JSON"
      >
        Bundle (JSON)
      </button>
      <button
        type="button"
        onClick={handleImportClick}
        className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
        title="Import a previously exported JSON bundle"
      >
        Import (JSON)
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleFileChange}
        className="hidden"
      />
      <button
        type="button"
        onClick={handleExportCsv}
        className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
        title="Download cashflow table as CSV (UTF-8 BOM for Excel)"
      >
        Cashflow (CSV)
      </button>
      <button
        type="button"
        onClick={handleExportPng}
        className="rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-1 text-xs text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-600 transition-colors"
        title="Export cashflow chart as PNG"
      >
        Chart (PNG)
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Notes panel
// ---------------------------------------------------------------------------
function NotesPanel() {
  const [value, setValue] = useState(() => loadNotesFromStorage())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value
    setValue(v)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      localStorage.setItem('bess-analyzer.notes', v)
    }, 500)
  }

  return (
    <div className="results-notes-panel flex flex-col gap-2">
      <label className="text-sm font-semibold text-gray-700 dark:text-gray-300">
        Notes
        <span className="ml-2 text-xs font-normal text-gray-400 dark:text-gray-500">(saved to browser storage automatically)</span>
      </label>
      <textarea
        value={value}
        onChange={handleChange}
        rows={5}
        placeholder="Add analysis notes, assumptions, or observations here..."
        className="w-full rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:border-blue-500 focus:outline-none resize-y"
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main ResultsView
// ---------------------------------------------------------------------------
type SimResult = {
  inputs: Inputs
  scenario: ScenarioProfile
  streams: AnnualStream[]
  retiredAtYear: number | null
  financials: FinancialResults
}

export default function ResultsView() {
  const [priceSeries, setPriceSeries] = useState<PriceSeries | null>(null)
  const [result, setResult] = useState<SimResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const chartRef = useRef<EChartsReact | null>(null)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setPriceSeries(data))
      .catch((err) => console.error('Failed to load price data:', err))
  }, [])

  const runSimulation = useCallback(
    (inputs: Inputs, scenario: ScenarioProfile, priceSeries: PriceSeries) => {
      setStatus('running')
      try {
        const calibration = calibrateFromHistory(priceSeries)
        const forecast = generateForecast(calibration, scenario, 42)
        const days = hourlyToDailyParams(forecast.hourlyPrices, inputs.finance.projectLifeYears)
        const sim = runProjectSimulation(inputs, days)
        const financials = computeFinancials(inputs, sim.streams)
        setResult({ inputs, scenario, streams: sim.streams, retiredAtYear: sim.retiredAtYear, financials })
        setStatus('done')
      } catch (err) {
        console.error('Results simulation error:', err)
        setStatus('error')
      }
    },
    [],
  )

  // Auto-run on mount once price data is ready
  useEffect(() => {
    if (!priceSeries) return
    const inputs = loadInputsFromStorage()
    const scenario = loadScenarioFromStorage()
    runSimulation(inputs, scenario, priceSeries)
  }, [priceSeries, runSimulation])

  function handleRerun() {
    if (!priceSeries) return
    const inputs = loadInputsFromStorage()
    const scenario = loadScenarioFromStorage()
    runSimulation(inputs, scenario, priceSeries)
  }

  const buildRequest = useCallback((): SimulationRequest | null => {
    if (!priceSeries || !result) return null
    return {
      inputs: result.inputs,
      scenario: result.scenario,
      calibration: calibrateFromHistory(priceSeries),
      rngSeed: 42,
    }
  }, [priceSeries, result])

  function handleImport(bundle: AnalysisBundle) {
    localStorage.setItem('bess-analyzer.inputs', JSON.stringify(bundle.inputs))
    localStorage.setItem('bess-analyzer.activeScenario', JSON.stringify(bundle.scenario))
    if (bundle.notes) localStorage.setItem('bess-analyzer.notes', bundle.notes)
    if (priceSeries) {
      runSimulation(bundle.inputs, bundle.scenario, priceSeries)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 dark:border-gray-700 pb-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Results Dashboard</h2>
          {result && (
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              Scenario: <span className="font-medium">{result.scenario.name}</span>
              {' · '}
              {result.inputs.battery.powerMW} MW / {result.inputs.battery.energyMWh} MWh
              {' · '}
              {result.inputs.finance.projectLifeYears} yr project life
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {status === 'running' && (
            <span className="rounded bg-blue-100 dark:bg-blue-900/40 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300 animate-pulse">
              Computing...
            </span>
          )}
          {status === 'error' && (
            <span className="rounded bg-red-100 dark:bg-red-900/40 px-2 py-0.5 text-xs font-medium text-red-700 dark:text-red-300">
              Error
            </span>
          )}
          <button
            type="button"
            onClick={handleRerun}
            disabled={!priceSeries || status === 'running'}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 transition-colors"
          >
            Re-run
          </button>
        </div>
      </div>

      {status === 'idle' && !result && (
        <div className="flex h-48 items-center justify-center rounded-lg border border-gray-200 dark:border-gray-700 text-sm text-gray-400 dark:text-gray-500">
          {priceSeries ? 'Click Re-run to compute results.' : 'Loading price data...'}
        </div>
      )}

      {result && (
        <>
          {/* Export toolbar */}
          <ExportToolbar
            inputs={result.inputs}
            scenario={result.scenario}
            streams={result.streams}
            financials={result.financials}
            notes={loadNotesFromStorage()}
            chartRef={chartRef}
            onImport={handleImport}
          />

          {/* Section 1 */}
          <Section title="1. Headline KPIs">
            <HeadlineKpis
              financials={result.financials}
              retiredAtYear={result.retiredAtYear}
              inputs={result.inputs}
            />
          </Section>

          {/* Section 2 */}
          <Section title="2. Cashflow">
            <CashflowSection cashflow={result.financials.cashflow} chartRef={chartRef} />
          </Section>

          {/* Section 3 */}
          <Section title="3. Battery State">
            <BatteryStateSection
              streams={result.streams}
              endOfLifeSoH={result.inputs.battery.endOfLifeSoH}
              retiredAtYear={result.retiredAtYear}
            />
          </Section>

          {/* Section 4 */}
          <Section title="4. Sensitivity (Tornado)" defaultOpen={false}>
            <SensitivitySection buildRequest={buildRequest} />
          </Section>

          {/* Section 5 */}
          <Section title="5. Monte Carlo" defaultOpen={false}>
            <MCSection />
          </Section>

          {/* Notes */}
          <NotesPanel />
        </>
      )}
    </div>
  )
}
