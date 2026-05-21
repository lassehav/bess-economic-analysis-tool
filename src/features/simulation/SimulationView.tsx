import { useState, useEffect } from 'react'
import ReactECharts from 'echarts-for-react'
import type { Inputs } from '../../core/types/inputs'
import type { AnnualStream, DailyPriceParams } from '../../core/types/streams'
import type { PriceSeries } from '../../core/types/prices'
import type { FinancialResults } from '../../core/economics/index'
import { inputsSchema } from '../../core/types/schemas'
import { buildHistoricalDays } from '../../core/dispatch/historical'
import { runProjectSimulation } from '../../core/dispatch/engine'
import { computeFinancials, computeCapex } from '../../core/economics/index'

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

type SimResult = {
  streams: AnnualStream[]
  retiredAtYear: number | null
  financials: FinancialResults
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

export default function SimulationView() {
  const [priceSeries, setPriceSeries] = useState<PriceSeries | null>(null)
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS)
  const [replayStartDate, setReplayStartDate] = useState('2024-01-01')
  const [result, setResult] = useState<SimResult | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [cyclicWrap, setCyclicWrap] = useState(false)

  useEffect(() => {
    fetch('/data/fi-prices.json')
      .then((r) => r.json())
      .then((data: PriceSeries) => setPriceSeries(data))
      .catch(() => {})

    try {
      const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? '')
      const parsed = inputsSchema.safeParse(raw)
      if (parsed.success) {
        setInputs(parsed.data)
      }
    } catch {
      // ignore
    }
  }, [])

  function handleRun() {
    if (!priceSeries) return
    setStatus('running')
    setCyclicWrap(false)
    try {
      const days: DailyPriceParams[] = buildHistoricalDays(
        priceSeries,
        replayStartDate,
        inputs.finance.projectLifeYears,
        () => setCyclicWrap(true),
      )
      const sim = runProjectSimulation(inputs, days)
      const financials = computeFinancials(inputs, sim.streams)
      setResult({ streams: sim.streams, retiredAtYear: sim.retiredAtYear, financials })
      setStatus('done')
    } catch {
      setStatus('idle')
    }
  }

  const fmt0 = (v: number) =>
    v.toLocaleString('fi-FI', { maximumFractionDigits: 0 })
  const fmt2 = (v: number) => v.toFixed(2)
  const fmt1 = (v: number) => v.toFixed(1)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3 border-b border-gray-200 pb-3">
        <h2 className="text-lg font-semibold">Simulation</h2>
        <button
          type="button"
          onClick={handleRun}
          disabled={!priceSeries || status === 'running'}
          className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40"
        >
          Run simulation
        </button>
        <StatusChip status={status} />
        {!priceSeries && (
          <span className="text-xs text-gray-400">Waiting for price data...</span>
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

          <div className="rounded border border-gray-200 p-3">
            <h3 className="mb-2 text-sm font-semibold">Data Source</h3>
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
              Historical data cycled: price history is shorter than the project life and has been
              repeated.
            </div>
          )}
        </aside>

        <div className="min-w-0 flex-1 flex flex-col gap-4">
          {status === 'idle' && result === null ? (
            <div className="flex h-64 items-center justify-center rounded-lg border border-gray-200 text-sm text-gray-400">
              Configure parameters and press Run simulation.
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
                    <FinancialChip
                      label="NPV"
                      value={`${fmt0(result.financials.npv)} €`}
                    />
                    <FinancialChip
                      label="IRR"
                      value={
                        result.financials.irr !== null
                          ? `${(result.financials.irr * 100).toFixed(1)} %`
                          : '—'
                      }
                    />
                    <FinancialChip
                      label="LCOS"
                      value={`${fmt2(result.financials.lcos)} €/MWh`}
                    />
                    <FinancialChip
                      label="Simple payback"
                      value={
                        result.financials.simplePaybackYears !== null
                          ? `${fmt1(result.financials.simplePaybackYears)} yr`
                          : '—'
                      }
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
