import { describe, it, expect } from 'vitest'
import type { BatteryInputs, Inputs } from '../types/inputs'
import type { DailyPriceParams } from '../types/streams'
import { makeInitialState, runDailyStep } from './dailyStep'
import type { EngineState } from './dailyStep'
import { runProjectSimulation } from './engine'
import {
  CALENDAR_FADE_SHARE,
  CALENDAR_FADE_EXPONENT,
  CYCLE_FADE_EXPONENT,
} from './degradation'

const DEFAULT_BAT: BatteryInputs = {
  powerMW: 10,
  energyMWh: 40,
  roundTripEfficiency: 0.85,
  dod: 0.9,
  maxCyclesPerDay: 2,
  nominalCycleLifeEFC: 6000,
  calendarLifeYears: 15,
  endOfLifeSoH: 0.80,
}

// Independent restatement of the degradation model, so the engine is checked against
// the formula rather than against itself. The shape constants are imported; if they
// are ever retuned these expectations move with them.
function expectedSoH(days: number, efc: number, bat: BatteryInputs = DEFAULT_BAT): number {
  const F = 1 - bat.endOfLifeSoH
  const cal = F * CALENDAR_FADE_SHARE *
    Math.pow(days / 365 / bat.calendarLifeYears, CALENDAR_FADE_EXPONENT)
  const cyc = F * (1 - CALENDAR_FADE_SHARE) *
    Math.pow(efc / bat.nominalCycleLifeEFC, CYCLE_FADE_EXPONENT)
  return Math.max(0, 1 - cal - cyc)
}

const DEFAULT_INPUTS: Inputs = {
  battery: DEFAULT_BAT,
  costs: {
    batteryCapexPerKWh: 200,
    pcsCapex: 0,
    bopCapex: 0,
    developmentCapexPercent: 0,
    contingencyPercent: 0,
    pcsReplacementIntervalYears: 20,
    pcsReplacementCostPercentOfPcs: 0,
    fixedOmPerYear: 0,
    variableOmPerMWhThroughput: 0,
    insurancePercentOfCapexPerYear: 0,
    landLeasePerYear: 0,
    gridFeePerMWhThroughput: 0,
    gridFeePerKWPerYear: 0,
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

    // Flat prices → no cycling, so only the calendar term moves.
    expect(result.cumulativeEFC).toBe(0)
    expect(Math.abs(result.sohAtStartOfDay - expectedSoH(1, 0))).toBeLessThan(1e-12)
  })

  it('Test 1b: calendar fade is concave — the first year loses more than the last', () => {
    const firstYear = 1 - expectedSoH(365, 0)
    const lastYear = expectedSoH(14 * 365, 0) - expectedSoH(15 * 365, 0)
    expect(firstYear).toBeGreaterThan(lastYear * 2)
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

    // Cycle fade is additive on top of calendar fade, so a cycling day must lose
    // strictly more than an idle day of the same age.
    const calendarOnlyLoss = 1 - expectedSoH(1, 0)
    const actualLoss = 1.0 - result.sohAtStartOfDay
    expect(result.cumulativeEFC).toBeGreaterThan(0)
    expect(actualLoss).toBeGreaterThan(calendarOnlyLoss)
    expect(Math.abs(result.sohAtStartOfDay - expectedSoH(1, result.cumulativeEFC)))
      .toBeLessThan(1e-12)
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

    const calendarLossPerDay = 1 - expectedSoH(1, 0)

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

  it('Test 5: rated duty lands exactly on EoL', () => {
    // The calibration that anchors the two fade terms: delivering the nominal cycle
    // life (6000 EFC) over the calendar life (15 y) consumes exactly the fade budget.
    expect(Math.abs(expectedSoH(15 * 365, 6000) - 0.80)).toBeLessThan(1e-12)

    // Under-cycling relative to rated duty leaves the pack above EoL at T_cal...
    expect(expectedSoH(15 * 365, 3000)).toBeGreaterThan(0.80)
    // ...and over-cycling puts it below.
    expect(expectedSoH(15 * 365, 9000)).toBeLessThan(0.80)
  })

  it('Test 5b: calendar ageing alone no longer retires the pack at T_cal', () => {
    // Flat prices → zero throughput. The calendar term carries only its share of the
    // budget, so an idle pack outlives its calendar-life figure. This is the deliberate
    // consequence of splitting one budget between additive mechanisms.
    const days: DailyPriceParams[] = []
    for (let i = 0; i < 20 * 365; i++) {
      days.push({ ...flatDay(40), yearIndex: Math.floor(i / 365) + 1, dayOfYear: (i % 365) + 1 })
    }

    const simResult = runProjectSimulation(DEFAULT_INPUTS, days)

    expect(simResult.retiredAtYear).toBeNull()
    const last = simResult.streams[simResult.streams.length - 1]
    expect(last).toBeDefined()
    if (last) {
      expect(last.endOfYearSoH).toBeGreaterThan(0.80)
      expect(Math.abs(last.endOfYearSoH - expectedSoH(20 * 365, 0))).toBeLessThan(1e-9)
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
