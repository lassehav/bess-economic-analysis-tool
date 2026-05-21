import type { HistoricalCalibration, ScenarioProfile, MultiYearForecastOutput, SimulationEvent } from './types'
import { makePrng, makeNormalPrng } from './prng'

const MONTH_DAY_ENDS = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]

function dayOfYearToMonthIdx(dayOfYear: number): number {
  const d = ((dayOfYear - 1) % 365) + 1
  for (let m = 0; m < 12; m++) {
    if (d <= MONTH_DAY_ENDS[m]!) return m
  }
  return 11
}

// Finnish seasonal wind capacity factors (Jan–Dec)
const WIND_CF_BY_MONTH = [0.42, 0.40, 0.35, 0.28, 0.22, 0.18, 0.16, 0.20, 0.27, 0.33, 0.38, 0.43]

// Solar: [sunrise_hour, sunset_hour] per month and peak insolation CF
const SOLAR_WINDOW: [number, number][] = [
  [9, 15], [8, 16], [7, 18], [6, 19], [5, 21], [4, 22],
  [5, 21], [6, 20], [7, 18], [8, 16], [9, 15], [10, 14],
]
const SOLAR_PEAK_CF = [0.05, 0.10, 0.20, 0.35, 0.50, 0.65, 0.65, 0.55, 0.35, 0.18, 0.07, 0.04]

function solarCF(m: number, h: number, insolation: number): number {
  const [sunStart, sunEnd] = SOLAR_WINDOW[m]!
  if (h < sunStart || h >= sunEnd) return 0
  const phase = (h - sunStart + 0.5) / (sunEnd - sunStart)
  return Math.max(0, insolation * SOLAR_PEAK_CF[m]! * Math.sin(Math.PI * phase))
}

export function generateForecast(
  calibration: HistoricalCalibration,
  profile: ScenarioProfile,
  seed = 42,
): MultiYearForecastOutput {
  const uniform = makePrng(seed)
  const normal = makeNormalPrng(uniform)

  const { diurnalByMonth, monthLevel, dayOfWeekLevel, annualMeanPrice, residualAr1, residualSigma } = calibration

  const totalYears = profile.years.length
  const totalHours = totalYears * 365 * 24
  const hourlyPrices = new Float64Array(totalHours)
  const events: SimulationEvent[] = []

  let ar1State = 0
  let eventCounter = 0

  for (let y = 0; y < totalYears; y++) {
    const params = profile.years[y]!
    const { maxPowerConsumption, constantBaseload, windCapacityMW, solarCapacityMW, nuclearCapacityMW, priceRandomizer } = params
    const yearHourBase = y * 365 * 24

    // Step 1: Year-level structural parameters
    const deltaBase = 80 * (constantBaseload - nuclearCapacityMW) / maxPowerConsumption
    const Rrenew = (windCapacityMW + solarCapacityMW) / maxPowerConsumption
    const volatilityMult = 1.0 + 0.6 * Rrenew

    let dunkelflauteStartHour: number | null = null

    for (let d = 0; d < 365; d++) {
      const m = dayOfYearToMonthIdx(d + 1)
      const dow = (y * 365 + d) % 7
      const hourBase = yearHourBase + d * 24

      // AR(1) daily residual in €/MWh space
      ar1State = residualAr1 * ar1State + residualSigma * normal()

      // Daily stochastic weather draws
      const omega_daily = Math.max(0.02, Math.min(0.95, WIND_CF_BY_MONTH[m]! + 0.12 * normal()))
      const insolation_daily = Math.max(0.05, Math.min(1.5, 1.0 + 0.3 * normal()))

      for (let h = 0; h < 24; h++) {
        const hourIdx = hourBase + h

        const omega_h = Math.max(0.01, Math.min(0.98, omega_daily + 0.03 * normal()))
        const sigma_h = solarCF(m, h, insolation_daily)

        const Prenew = windCapacityMW * omega_h + solarCapacityMW * sigma_h
        const Gt = maxPowerConsumption - (nuclearCapacityMW + Prenew)

        // Condition A: Dunkelflaute shock
        let shockImpact = 0
        const isDunkelflaute = Gt > 0 && (omega_h + sigma_h) < 0.08

        if (isDunkelflaute) {
          shockImpact = 500 * Math.pow(Gt / maxPowerConsumption, 2) * volatilityMult
          if (dunkelflauteStartHour === null) {
            dunkelflauteStartHour = hourIdx
          }
        } else if (dunkelflauteStartHour !== null) {
          const durationH = hourIdx - dunkelflauteStartHour
          const avgImpact = 500 * Math.pow((maxPowerConsumption - nuclearCapacityMW) / maxPowerConsumption, 2) * volatilityMult
          events.push({
            id: `dunkelflaute-${++eventCounter}`,
            type: 'dunkelflaute_shock',
            severity: 'critical',
            title: 'Windless Winter Freeze',
            description: `Zero-wind/solar period lasting ${Math.round(durationH / 24)} day(s). Physical supply gap drives extreme scarcity prices.`,
            startHourIndex: dunkelflauteStartHour,
            endHourIndex: hourIdx,
            metricDelta: { priceImpactEur: Math.round(avgImpact) },
          })
          dunkelflauteStartHour = null
        }

        // Condition B: Oversupply compression
        let priceCompression = 0
        if (Gt < -constantBaseload) {
          priceCompression = 0.015 * (Gt + constantBaseload)  // negative
        }

        // Base hourly price from calibration diurnal shape
        const diurnalRow = diurnalByMonth[m] ?? diurnalByMonth[0]!
        const mu_h = annualMeanPrice * (monthLevel[m] ?? 1) * (dayOfWeekLevel[dow % 7] ?? 1) * (diurnalRow[h] ?? 1)

        const rawPrice = (mu_h + deltaBase + ar1State * volatilityMult + shockImpact + priceCompression) * (1.0 + priceRandomizer)
        hourlyPrices[hourIdx] = Math.max(-500, Math.min(4000, rawPrice))
      }
    }

    // Close any dunkelflaute event that spans year boundary
    if (dunkelflauteStartHour !== null) {
      const endHour = yearHourBase + 365 * 24
      const durationH = endHour - dunkelflauteStartHour
      events.push({
        id: `dunkelflaute-${++eventCounter}`,
        type: 'dunkelflaute_shock',
        severity: 'critical',
        title: 'Windless Winter Freeze',
        description: `Zero-wind/solar period lasting ${Math.round(durationH / 24)} day(s).`,
        startHourIndex: dunkelflauteStartHour,
        endHourIndex: endHour,
        metricDelta: { priceImpactEur: Math.round(500 * volatilityMult) },
      })
      dunkelflauteStartHour = null
    }
  }

  return {
    totalHours,
    hourlyPrices: Array.from(hourlyPrices),
    events,
  }
}
