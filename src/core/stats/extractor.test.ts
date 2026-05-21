import { describe, expect, it } from 'vitest'
import type { BatterySpec } from '../types/battery'
import type { DailyStats } from './types'
import { aggregatePeriod, extractDailyStats } from './extractor'

const defaultBattery: BatterySpec = {
  powerMW: 10,
  energyMWh: 40,
  roundTripEfficiency: 0.85,
  dod: 0.9,
  maxCyclesPerDay: 2,
}

const START = '2024-01-15T00:00:00.000Z'

// Helper: build a 24-hour flat price array
function flatPrices(price: number, hours = 24): number[] {
  return Array(hours).fill(price) as number[]
}

describe('extractDailyStats', () => {
  it('flat price day → no windows, all SoC idle at 0', () => {
    const prices = flatPrices(40)
    const result = extractDailyStats(prices, START, defaultBattery)

    expect(result.windows).toHaveLength(0)
    expect(result.socTrace).toHaveLength(25) // H+1 = 24+1
    for (const pt of result.socTrace) {
      expect(pt.mode).toBe('idle')
      expect(pt.socMWh).toBe(0)
    }
  })

  it('single peak/trough → 1 window, charge [0-3], discharge [18-21]', () => {
    // Build 24 prices: hours 0-3 cheap (10), hours 18-21 expensive (80), rest 40
    const prices = Array(24).fill(40) as number[]
    for (let i = 0; i <= 3; i++) prices[i] = 10
    for (let i = 18; i <= 21; i++) prices[i] = 80

    const result = extractDailyStats(prices, START, defaultBattery)

    expect(result.windows.length).toBeGreaterThanOrEqual(1)
    const win = result.windows[0]!

    // Charge block should be hours 0-3
    expect(win.chargeHourIndices).toEqual([0, 1, 2, 3])
    // Discharge block should be hours 18-21
    expect(win.dischargeHourIndices).toEqual([18, 19, 20, 21])

    // effectiveMargin ≈ 80×0.85 − 10 = 58
    expect(win.effectiveMargin).toBeCloseTo(58, 1)
    expect(win.vwapCharge).toBeCloseTo(10, 5)
    expect(win.vwapDischarge).toBeCloseTo(80, 5)
  })

  it('solar shape → 2 windows with maxCyclesPerDay: 2', () => {
    // hours 0-3 cheap (5€), hours 7-10 expensive (70€)
    // hours 12-15 cheap (5€), hours 17-20 expensive (70€), rest 35€
    const prices = Array(24).fill(35) as number[]
    for (let i = 0; i <= 3; i++) prices[i] = 5
    for (let i = 7; i <= 10; i++) prices[i] = 70
    for (let i = 12; i <= 15; i++) prices[i] = 5
    for (let i = 17; i <= 20; i++) prices[i] = 70

    const result = extractDailyStats(prices, START, { ...defaultBattery, maxCyclesPerDay: 2 })

    expect(result.windows).toHaveLength(2)

    // Both windows should have positive effective margin
    for (const win of result.windows) {
      expect(win.effectiveMargin).toBeGreaterThan(0)
    }
  })

  it('maxCyclesPerDay cap enforced: 3 natural cycles pruned to 2', () => {
    // Three symmetric cheap/expensive blocks would produce 3 windows without the cap
    const prices = Array(24).fill(40) as number[]
    for (const i of [0, 1]) prices[i] = 5
    for (const i of [4, 5]) prices[i] = 80
    for (const i of [8, 9]) prices[i] = 5
    for (const i of [12, 13]) prices[i] = 80
    for (const i of [16, 17]) prices[i] = 5
    for (const i of [20, 21]) prices[i] = 80

    const result = extractDailyStats(prices, START, { ...defaultBattery, maxCyclesPerDay: 2 })

    expect(result.windows.length).toBeLessThanOrEqual(2)
    for (const win of result.windows) {
      expect(win.effectiveMargin).toBeGreaterThan(0)
    }
  })

  it('23-hour DST day → no crash, socTrace.length === 24', () => {
    const prices = Array(23).fill(40) as number[]
    const result = extractDailyStats(prices, START, defaultBattery)

    expect(result.hourlyPrices).toHaveLength(23)
    expect(result.socTrace).toHaveLength(24)
  })

  it('25-hour DST day → no crash, socTrace.length === 26', () => {
    const prices = Array(25).fill(40) as number[]
    const result = extractDailyStats(prices, START, defaultBattery)

    expect(result.hourlyPrices).toHaveLength(25)
    expect(result.socTrace).toHaveLength(26)
  })
})

describe('aggregatePeriod', () => {
  it('aggregates 3 synthetic days correctly', () => {
    // Day 1: 0 windows (flat), spread ~0
    const day1 = extractDailyStats(flatPrices(40), '2024-01-01T00:00:00.000Z', defaultBattery)

    // Day 2: 1 window, spread = 50
    const prices2 = Array(24).fill(40) as number[]
    for (let i = 0; i <= 3; i++) prices2[i] = 15
    for (let i = 18; i <= 21; i++) prices2[i] = 65
    const day2 = extractDailyStats(prices2, '2024-01-02T00:00:00.000Z', defaultBattery)

    // Day 3: 2 windows, spread = 60
    const prices3 = Array(24).fill(40) as number[]
    for (let i = 0; i <= 3; i++) prices3[i] = 10
    for (let i = 7; i <= 10; i++) prices3[i] = 70
    for (let i = 12; i <= 15; i++) prices3[i] = 10
    for (let i = 17; i <= 20; i++) prices3[i] = 70
    const day3 = extractDailyStats(prices3, '2024-01-03T00:00:00.000Z', {
      ...defaultBattery,
      maxCyclesPerDay: 2,
    })

    const daily: DailyStats[] = [day1, day2, day3]
    const agg = aggregatePeriod(daily, '2024-Q1')

    expect(agg.dayCount).toBe(3)
    expect(agg.windowCount.histogram[0]).toBe(1)
    expect(agg.windowCount.histogram[1]).toBeGreaterThanOrEqual(1)
    expect(agg.windowCount.histogram[2]).toBeGreaterThanOrEqual(1)

    // spread.mean should be roughly (0 + ~50 + ~60) / 3
    const expectedSpreadMean = (day1.spread + day2.spread + day3.spread) / 3
    expect(agg.spread.mean).toBeCloseTo(expectedSpreadMean, 5)
  })
})
