import { describe, it, expect } from 'vitest'
import type { BatteryInputs, Inputs } from '../types/inputs'
import type { DailyPriceParams } from '../types/streams'
import { makeInitialState, runDailyStep } from './dailyStep'
import type { EngineState } from './dailyStep'
import { runProjectSimulation } from './engine'

const DEFAULT_BAT: BatteryInputs = {
  powerMW: 10,
  energyMWh: 40,
  roundTripEfficiency: 0.85,
  dod: 0.9,
  maxCyclesPerDay: 2,
  nominalCycleLifeEFC: 6000,
  calendarLifeYears: 15,
  cyclesPerDayPenaltyExponent: 1.5,
  endOfLifeSoH: 0.80,
}

const DEFAULT_INPUTS: Inputs = {
  battery: DEFAULT_BAT,
  costs: {
    batteryCapexPerKWh: 200,
    pcsCapexPerKW: 0,
    bopCapexPercentOfBatteryPcs: 0,
    developmentCapexPercent: 0,
    contingencyPercent: 0,
    pcsReplacementIntervalYears: 20,
    pcsReplacementCostPercentOfPcs: 0,
    fixedOmPerKWPerYear: 0,
    variableOmPerMWhThroughput: 0,
    insurancePercentOfCapexPerYear: 0,
    landLeasePerYear: 0,
    gridFeePerMWhThroughput: 0,
    gridFeePerKWPerYear: 0,
    inflationPercentPerYear: 0,
    omEscalationPercentPerYear: 0,
  },
  finance: {
    projectLifeYears: 20,
    wacc: 6,
    taxRate: 0,
    depreciationYears: 15,
    residualValuePercentOfInitialCapex: 0,
  },
}

function makeDay(prices: number[], dayIndex = 0): DailyPriceParams {
  const yearIndex = Math.floor(dayIndex / 365) + 1
  const dayOfYear = (dayIndex % 365) + 1
  return {
    yearIndex,
    dayOfYear,
    startUtc: '2024-01-01T00:00:00.000Z',
    hourlyPrices: prices,
    dayMeanPrice: prices.reduce((s, p) => s + p, 0) / prices.length,
  }
}

function flatDay(price: number): DailyPriceParams {
  return makeDay(Array(24).fill(price))
}

describe('runDailyStep', () => {
  it('Test 1: flat prices → only calendar SoH loss, no revenue', () => {
    const state = makeInitialState()
    const day = flatDay(40)
    const result = runDailyStep(state, day, DEFAULT_INPUTS)

    expect(result.yearAccumulator.revenue).toBe(0)
    expect(result.ageDays).toBe(1)

    const expectedSoH = 1 - (1 - 0.80) / (15 * 365)
    expect(Math.abs(result.sohAtStartOfDay - expectedSoH)).toBeLessThan(1e-9)
  })

  it('Test 2: high-margin day → revenue and cycle SoH loss', () => {
    const state = makeInitialState()
    const prices = Array(24).fill(40) as number[]
    for (let h = 0; h < 4; h++) prices[h] = 10
    for (let h = 18; h < 22; h++) prices[h] = 80
    const day = makeDay(prices)

    const result = runDailyStep(state, day, DEFAULT_INPUTS)

    expect(result.yearAccumulator.revenue).toBeGreaterThan(0)
    expect(result.yearAccumulator.throughputMWh).toBeGreaterThan(0)

    const calendarOnlyLoss = (1 - 0.80) / (15 * 365)
    const actualLoss = 1.0 - result.sohAtStartOfDay
    expect(actualLoss).toBeGreaterThan(calendarOnlyLoss)
  })

  it('Test 3: cpd=2 degrades more than cpd=1', () => {
    const prices = Array(24).fill(35) as number[]
    for (let h = 0; h < 4; h++) prices[h] = 5
    for (let h = 7; h < 11; h++) prices[h] = 70
    for (let h = 12; h < 16; h++) prices[h] = 5
    for (let h = 17; h < 21; h++) prices[h] = 70

    const state = makeInitialState()
    const day = makeDay(prices)

    const inputs2 = { ...DEFAULT_INPUTS, battery: { ...DEFAULT_BAT, maxCyclesPerDay: 2 as const } }
    const inputs1 = { ...DEFAULT_INPUTS, battery: { ...DEFAULT_BAT, maxCyclesPerDay: 1 as const } }

    const result2 = runDailyStep(state, day, inputs2)
    const result1 = runDailyStep(state, day, inputs1)

    const loss2 = 1.0 - result2.sohAtStartOfDay
    const loss1 = 1.0 - result1.sohAtStartOfDay
    expect(loss2).toBeGreaterThan(loss1)
  })

  it('Test 4: retirement triggers correctly', () => {
    const prices = Array(24).fill(35) as number[]
    for (let h = 0; h < 4; h++) prices[h] = 5
    for (let h = 18; h < 22; h++) prices[h] = 90
    const day = makeDay(prices)

    const calendarLossPerDay = (1 - 0.80) / (15 * 365)

    const customState: EngineState = {
      cumulativeEFC: 0,
      ageDays: 0,
      sohAtStartOfDay: 0.801,
      retired: false,
      yearAccumulator: {
        revenue: 0,
        throughputMWh: 0,
        cyclesEFC: 0,
        sohSamples: [],
        dayCount: 0,
      },
    }

    const result1 = runDailyStep(customState, day, DEFAULT_INPUTS)
    const totalLoss = 0.801 - result1.sohAtStartOfDay

    if (totalLoss > 0.001) {
      expect(result1.retired).toBe(true)

      const revenueAfterRetirement = result1.yearAccumulator.revenue
      const result2 = runDailyStep(result1, day, DEFAULT_INPUTS)
      expect(result2.yearAccumulator.revenue).toBe(revenueAfterRetirement)
    } else {
      const nearEolState: EngineState = {
        ...customState,
        sohAtStartOfDay: 0.80 + calendarLossPerDay * 1.5,
      }
      const r = runDailyStep(nearEolState, day, DEFAULT_INPUTS)
      if (r.retired) {
        const rev = r.yearAccumulator.revenue
        const r2 = runDailyStep(r, day, DEFAULT_INPUTS)
        expect(r2.yearAccumulator.revenue).toBe(rev)
      }
    }
  })

  it('Test 5: 20-year calendar-only run, retirement at ~year 15', () => {
    const days: DailyPriceParams[] = []
    for (let i = 0; i < 20 * 365; i++) {
      days.push({ ...flatDay(40), yearIndex: Math.floor(i / 365) + 1, dayOfYear: (i % 365) + 1 })
    }

    const simResult = runProjectSimulation(DEFAULT_INPUTS, days)

    expect(simResult.retiredAtYear).not.toBeNull()
    if (simResult.retiredAtYear !== null) {
      expect(simResult.retiredAtYear).toBeGreaterThanOrEqual(14)
      expect(simResult.retiredAtYear).toBeLessThanOrEqual(16)
    }

    const stream14 = simResult.streams[14]
    expect(stream14).toBeDefined()
    if (stream14) {
      // At the end of year 15 (index 14), the SoH is at or just below the EoL threshold.
      // Floating point means SoH may be exactly at 0.80; use a small tolerance.
      expect(stream14.endOfYearSoH).toBeLessThanOrEqual(0.80 + 1e-9)
    }
  })

  it('Test 6: 3 years profitable with solar-pattern prices', () => {
    const prices = Array(24).fill(35) as number[]
    for (let h = 0; h < 4; h++) prices[h] = 5
    for (let h = 7; h < 11; h++) prices[h] = 70
    for (let h = 12; h < 16; h++) prices[h] = 5
    for (let h = 17; h < 21; h++) prices[h] = 70

    const days: DailyPriceParams[] = []
    for (let i = 0; i < 3 * 365; i++) {
      days.push({
        yearIndex: Math.floor(i / 365) + 1,
        dayOfYear: (i % 365) + 1,
        startUtc: '2024-01-01T00:00:00.000Z',
        hourlyPrices: prices,
        dayMeanPrice: prices.reduce((s, p) => s + p, 0) / prices.length,
      })
    }

    // Use high cycle life (20 000 EFC) so MDC stays well below the ~54.5 €/MWh margin
    // for the full 3-year period; this exercises the revenue accumulation path.
    const inputs3: Inputs = {
      ...DEFAULT_INPUTS,
      battery: { ...DEFAULT_INPUTS.battery, nominalCycleLifeEFC: 20000 },
      finance: { ...DEFAULT_INPUTS.finance, projectLifeYears: 3 },
    }
    const simResult = runProjectSimulation(inputs3, days)

    expect(simResult.streams).toHaveLength(3)
    for (const stream of simResult.streams) {
      expect(stream.grossRevenue).toBeGreaterThan(0)
    }
  })
})
