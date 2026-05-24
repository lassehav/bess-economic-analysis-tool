import type { Inputs } from '../types/inputs'
import type { DailyPriceParams } from '../types/streams'
import type { BatterySpec } from '../types/battery'
import { extractDailyStats } from '../stats/extractor'
import { computeCapex } from '../economics/index'

export type EngineState = {
  cumulativeEFC: number
  cumulativeEffectiveEFC: number
  ageDays: number
  sohAtStartOfDay: number
  retired: boolean
  yearAccumulator: {
    revenue: number
    throughputMWh: number
    cyclesEFC: number
    sohSamples: number[]
    dayCount: number
  }
}

export function makeInitialState(): EngineState {
  return {
    cumulativeEFC: 0,
    cumulativeEffectiveEFC: 0,
    ageDays: 0,
    sohAtStartOfDay: 1.0,
    retired: false,
    yearAccumulator: {
      revenue: 0,
      throughputMWh: 0,
      cyclesEFC: 0,
      sohSamples: [],
      dayCount: 0,
    },
  }
}

export function runDailyStep(
  state: EngineState,
  day: DailyPriceParams,
  inputs: Inputs,
): EngineState {
  if (state.retired) {
    return { ...state, ageDays: state.ageDays + 1 }
  }

  const effectiveBattery: BatterySpec = {
    powerMW: inputs.battery.powerMW,
    energyMWh: inputs.battery.energyMWh * state.sohAtStartOfDay,
    roundTripEfficiency: inputs.battery.roundTripEfficiency,
    dod: inputs.battery.dod,
    maxCyclesPerDay: inputs.battery.maxCyclesPerDay,
    initialSocMWh: 0,
  }

  const daily = extractDailyStats(day.hourlyPrices, day.startUtc, effectiveBattery, 0)

  const { endOfLifeSoH, nominalCycleLifeEFC, energyMWh, dod } = inputs.battery
  const sqrtEta = Math.sqrt(inputs.battery.roundTripEfficiency)

  // Constant capital-recovery MDC: full CAPEX / planned lifetime throughput.
  // Using remaining throughput here creates a death spiral (MDC rises → fewer cycles →
  // revenue collapses long before physical EoL). The constant rate matches the
  // "pure-capital MDC" shown in the Phase 2 derived panel.
  // mdcInternal is in €/MWh-internal; effectiveMargin is in €/MWh-grid-charge.
  // 1 MWh grid charge → sqrtEta MWh internal, so the threshold in grid-charge units is mdcInternal × sqrtEta.
  const capexTotal = computeCapex(inputs).total
  const lifetimeThroughputMWh = energyMWh * dod * nominalCycleLifeEFC
  const mdcInternal = lifetimeThroughputMWh > 0 ? capexTotal / lifetimeThroughputMWh : Infinity
  const activationMult = inputs.battery.activationThreshold ?? 1.0
  const mdcThreshold = mdcInternal * sqrtEta * activationMult

  const sortedWindows = daily.windows
    .slice()
    .sort((a, b) => b.effectiveMargin - a.effectiveMargin)

  const acceptedWindows: typeof sortedWindows = []
  for (const w of sortedWindows) {
    if (w.effectiveMargin > mdcThreshold) {
      acceptedWindows.push(w)
    } else {
      break
    }
  }
  let dayRevenue = 0
  let dayThroughputMWh = 0
  let dayEFC = 0

  for (const w of acceptedWindows) {
    dayRevenue += w.effectiveMargin * (w.effectiveEnergyMWh / sqrtEta)
    dayThroughputMWh += w.effectiveEnergyMWh * sqrtEta
    dayEFC += w.effectiveEFC
  }

  const cpdToday = acceptedWindows.length

  // Cycle-rate stress factor: doing N windows/day stresses the cell beyond what EFC count
  // alone captures. Exponent-1 so that 1 window = factor 1 (no extra penalty).
  const stressFactor =
    dayEFC > 0
      ? Math.pow(Math.max(cpdToday, 1), inputs.battery.cyclesPerDayPenaltyExponent - 1)
      : 1
  const effectiveDayEFC = dayEFC * stressFactor
  const newCumEffectiveEFC = state.cumulativeEffectiveEFC + effectiveDayEFC

  // Degradation: "8000 EFC OR 20 calendar years, whichever comes first."
  // Use max() so the faster-aging dimension drives SoH; additive would double-count
  // when both mechanisms run simultaneously and give unrealistically short life.
  const calendarFraction = (state.ageDays + 1) / (inputs.battery.calendarLifeYears * 365)
  const cycleFraction = newCumEffectiveEFC / nominalCycleLifeEFC
  const newSoH = Math.max(1 - (1 - endOfLifeSoH) * Math.max(calendarFraction, cycleFraction), 0)

  const retired = newSoH < endOfLifeSoH

  const acc = state.yearAccumulator

  return {
    cumulativeEFC: state.cumulativeEFC + dayEFC,
    cumulativeEffectiveEFC: newCumEffectiveEFC,
    ageDays: state.ageDays + 1,
    sohAtStartOfDay: newSoH,
    retired,
    yearAccumulator: {
      revenue: acc.revenue + dayRevenue,
      throughputMWh: acc.throughputMWh + dayThroughputMWh,
      cyclesEFC: acc.cyclesEFC + dayEFC,
      sohSamples: [...acc.sohSamples, newSoH],
      dayCount: acc.dayCount + 1,
    },
  }
}
