import type {
  HistoricalCalibration,
  ScenarioYearParams,
  MultiYearForecastOutput,
  SimulationEvent,
} from './types'
import { makePrng, makeNormalPrng } from './prng'
import { MILESTONE_LABELS, MILESTONE_DESCRIPTIONS } from './scenarios'

// Non-leap-year cumulative day-of-year thresholds by month (1-indexed days)
const MONTH_DAY_ENDS = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]

function dayOfYearToMonthIdx(dayOfYear: number): number {
  const d = ((dayOfYear - 1) % 365) + 1
  for (let m = 0; m < 12; m++) {
    if (d <= MONTH_DAY_ENDS[m]!) return m
  }
  return 11
}

// Wind capacity factor: peaks in winter, lowest in midsummer (Finnish seasonal pattern)
const WIND_CF_BY_MONTH = [0.40, 0.38, 0.32, 0.28, 0.24, 0.20, 0.18, 0.21, 0.27, 0.32, 0.36, 0.42]


type ActiveOutage = {
  daysRemaining: number
  priceImpact: number
  asset: 'nuclear' | 'cable'
}

export function generateForecast(
  calibration: HistoricalCalibration,
  yearParams: ScenarioYearParams[],
  seed = 42,
): MultiYearForecastOutput {
  const uniform = makePrng(seed)
  const normal = makeNormalPrng(uniform)

  const {
    diurnalByMonth,
    monthLevel,
    dayOfWeekLevel,
    annualMeanPrice,
    annualMeanSpread,
    residualAr1,
    residualSigma,
  } = calibration

  const totalYears = yearParams.length
  const totalHours = totalYears * 365 * 24
  const hourlyPrices = new Float64Array(totalHours)
  const events: SimulationEvent[] = []

  let ar1State = 0
  let eventCounter = 0
  const activeOutages: ActiveOutage[] = []
  // Wall state: daysRemaining counts down across the full event; multiplier fixed at onset
  let winterWallDaysRemaining = 0
  let winterWallMultiplier = 1.0
  // Seasonal winter character — rolled once per year, applies to all winter months
  let winterSeasonType: 'mild' | 'normal' | 'cold' = 'normal'
  let winterSeasonMultiplier = 1.0
  const firedMilestones = new Set<string>()

  for (let y = 0; y < totalYears; y++) {
    const params = yearParams[y]!
    const { meanLevelMultiplier, peakMultiplier, troughMultiplier, peakDurationMultiplier } = params
    const yearHourBase = y * 365 * 24

    // Structural milestone events — fire once on the first year they become active
    for (const milestoneId of params.activeStructuralMilestones) {
      if (!firedMilestones.has(milestoneId)) {
        firedMilestones.add(milestoneId)
        events.push({
          id: `structural-${milestoneId}`,
          type: 'structural',
          severity: 'info',
          title: MILESTONE_LABELS[milestoneId] ?? milestoneId,
          description: MILESTONE_DESCRIPTIONS[milestoneId] ?? '',
          startHourIndex: yearHourBase,
          endHourIndex: yearHourBase + 8760,
        })
      }
    }

    // Per-year arrival rates for stochastic assets
    const nuclearArrivalPerDay = 3 / 365
    const cableArrivalPerDay = 2 / 365

    // Roll seasonal winter character: 25% mild, 25% cold, 50% normal
    // Applies to all isWinterMonth days (Oct=9, Nov=10, Dec=11, Jan=0, Feb=1, Mar=2)
    const winterRoll = uniform()
    const winterEventStart = yearHourBase + 304 * 24 // Nov 1
    const winterEventEnd = Math.min(yearHourBase + 8760 + 59 * 24, totalHours - 1) // ~Feb 28 next year
    if (winterRoll < 0.25) {
      winterSeasonType = 'mild'
      winterSeasonMultiplier = 0.55 + uniform() * 0.20 // 0.55–0.75× of normal winter prices
      events.push({
        id: `mild-winter-y${y + 1}`,
        type: 'fundamental_gap',
        severity: 'info',
        title: 'Mild Winter Season',
        description: `Anomalously warm winter with above-average wind output and reduced heating demand. Electricity prices suppressed to ${(winterSeasonMultiplier * 100).toFixed(0)}% of normal for Nov–Feb. Short cold spells remain possible.`,
        startHourIndex: winterEventStart,
        endHourIndex: winterEventEnd,
        metricDelta: { priceImpactEur: -(annualMeanPrice * (1 - winterSeasonMultiplier)) },
      })
    } else if (winterRoll < 0.50) {
      winterSeasonType = 'cold'
      winterSeasonMultiplier = 1.35 + uniform() * 0.45 // 1.35–1.80× of normal winter prices
      events.push({
        id: `cold-winter-y${y + 1}`,
        type: 'fundamental_gap',
        severity: 'warning',
        title: 'Cold Winter Season',
        description: `Below-average temperatures and reduced wind output sustain elevated demand throughout winter. Prices at ${(winterSeasonMultiplier * 100).toFixed(0)}% of normal for Nov–Feb. If a Windless Winter Wall also triggers, prices will compound severely.`,
        startHourIndex: winterEventStart,
        endHourIndex: winterEventEnd,
        metricDelta: { priceImpactEur: annualMeanPrice * (winterSeasonMultiplier - 1) },
      })
    } else {
      winterSeasonType = 'normal'
      winterSeasonMultiplier = 1.0
    }

    for (let d = 0; d < 365; d++) {
      const dayOfYear = d + 1
      const monthIdx = dayOfYearToMonthIdx(dayOfYear)
      const dowIdx = ((y * 365 + d) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6
      const hourBase = yearHourBase + d * 24

      // ── AR(1) daily mean residual ────────────────────────────────────────────
      ar1State = residualAr1 * ar1State + residualSigma * normal()

      // ── Step A: Power-transform diurnal shape ────────────────────────────────
      const baseShape = diurnalByMonth[monthIdx] ?? diurnalByMonth[0]!
      const gamma = peakDurationMultiplier
      const transformed: number[] = []
      for (let h = 0; h < 24; h++) {
        const v = baseShape[h] ?? 1
        // Avoid negative base; floor at 0.01 to keep transform well-defined
        transformed.push(Math.pow(Math.max(0.01, v), gamma))
      }
      const tSum = transformed.reduce((s, v) => s + v, 0)
      const tScale = tSum > 0 ? 24 / tSum : 1
      const D = transformed.map((v) => v * tScale)

      // ── Step B: Asymmetric anomaly channels ──────────────────────────────────
      const Apos = D.map((v) => Math.max(0, v - 1))
      const Aneg = D.map((v) => Math.min(0, v - 1))

      // ── Step C: Reconstruct 24-hour prices ───────────────────────────────────
      const isWinterMonth = monthIdx >= 10 || monthIdx <= 2
      const mLevel = monthLevel[monthIdx] ?? 1
      const wLevel = dayOfWeekLevel[dowIdx] ?? 1
      const muDayBase = annualMeanPrice * mLevel * wLevel * meanLevelMultiplier + ar1State
      // Mild/cold winter seasons shift the daily mean for all winter months
      const muDay = isWinterMonth ? muDayBase * winterSeasonMultiplier : muDayBase

      const dayPrices: number[] = []
      for (let h = 0; h < 24; h++) {
        dayPrices.push(
          muDay +
            Apos[h]! * peakMultiplier * annualMeanSpread +
            Aneg[h]! * troughMultiplier * annualMeanSpread,
        )
      }

      // ── Step D: Stochastic infrastructure outages ────────────────────────────

      // Consume existing outages (apply effects, decrement counters)
      const stillActive: ActiveOutage[] = []
      for (const outage of activeOutages) {
        for (let h = 0; h < 24; h++) {
          if (outage.asset === 'nuclear') {
            // Nuclear trip amplifies prices above daily mean (scarcity hours)
            if (dayPrices[h]! > muDay) {
              dayPrices[h] = dayPrices[h]! + outage.priceImpact
            } else {
              dayPrices[h] = dayPrices[h]! + outage.priceImpact * 0.25
            }
          } else {
            // Cable fault compresses prices (oversupply trapped in zone)
            dayPrices[h] = dayPrices[h]! + outage.priceImpact
          }
        }
        outage.daysRemaining--
        if (outage.daysRemaining > 0) stillActive.push(outage)
      }
      activeOutages.length = 0
      activeOutages.push(...stillActive)

      // Roll for new nuclear outage
      if (uniform() < nuclearArrivalPerDay) {
        const durationDays = Math.max(1, Math.round(Math.exp(Math.log(2) + 0.5 * normal())))
        const impact = 20 + uniform() * 25
        activeOutages.push({ daysRemaining: durationDays, priceImpact: impact, asset: 'nuclear' })
        events.push({
          id: `outage-nuclear-${++eventCounter}`,
          type: 'stochastic_outage',
          severity: 'warning',
          title: 'Nuclear Generation Trip',
          description: `Loviisa or Olkiluoto unit forced outage. Estimated duration: ${durationDays}d. Peak hour impact: +${impact.toFixed(0)} €/MWh.`,
          startHourIndex: hourBase,
          endHourIndex: hourBase + durationDays * 24,
          affectedAsset: 'nuclear',
          metricDelta: { capacityMW: 900, priceImpactEur: impact },
        })
      }

      // Roll for cable/interconnector fault — more probable in winter high-wind conditions
      const windCf = WIND_CF_BY_MONTH[monthIdx] ?? 0.30
      const isWinterHighWind = (monthIdx >= 10 || monthIdx <= 2) && windCf > 0.35
      const cableProb = cableArrivalPerDay * (isWinterHighWind ? 1.6 : 0.7)
      if (uniform() < cableProb) {
        const durationDays = Math.max(1, Math.round(Math.exp(Math.log(1) + 0.4 * normal())))
        const impact = -(12 + uniform() * 20) * (isWinterHighWind ? 1.4 : 0.8)
        activeOutages.push({ daysRemaining: durationDays, priceImpact: impact, asset: 'cable' })
        events.push({
          id: `outage-cable-${++eventCounter}`,
          type: 'stochastic_outage',
          severity: 'info',
          title: 'Interconnector Fault (EstLink/NordBalt)',
          description: `Export cable fault during ${isWinterHighWind ? 'high-wind winter' : 'normal'} conditions. Duration: ~${durationDays}d. Price compression: ${impact.toFixed(0)} €/MWh.`,
          startHourIndex: hourBase,
          endHourIndex: hourBase + durationDays * 24,
          affectedAsset: 'cable',
          metricDelta: { priceImpactEur: impact },
        })
      }

      // ── Step E: Windless Winter Wall (Poisson arrival) ───────────────────────
      // ~1 event per 4 years across the Nov–Feb window (~120 winter days/year).
      // When a cold winter season is also active, wall intensity is 30% higher.
      const WALL_PER_WINTER_DAY = 1.0 / (4.0 * 120)
      if (isWinterMonth && winterWallDaysRemaining === 0 && uniform() < WALL_PER_WINTER_DAY) {
        const wallDurationDays = 5 + Math.round(uniform() * 25) // 5–30 days
        winterWallMultiplier = 2.5 + uniform() * 1.5 // 2.5×–4.0×; fixed for the entire event
        winterWallDaysRemaining = wallDurationDays
        const wallEndHour = Math.min(hourBase + wallDurationDays * 24, totalHours - 1)
        const isColdWall = winterSeasonType === 'cold'
        const effectiveMult = isColdWall ? winterWallMultiplier * 1.3 : winterWallMultiplier
        const baseMean = annualMeanPrice * (isColdWall ? winterSeasonMultiplier : 1.0)
        events.push({
          id: `gap-winter-wall-${++eventCounter}`,
          type: 'fundamental_gap',
          severity: 'critical',
          title: isColdWall ? 'Windless Winter Wall + Cold Winter (Severe)' : 'Windless Winter Wall',
          description: `Windless arctic high-pressure lasting ${wallDurationDays} days. Demand exceeds Finnish generation + all import capacity. Prices surge to ~${(baseMean * effectiveMult).toFixed(0)}–${(baseMean * effectiveMult * 1.8).toFixed(0)} €/MWh.${isColdWall ? ' Cold winter simultaneously active — combined effect severe.' : ''} Historical parallel: Jan–Feb 2025 (~180 €/MWh avg).`,
          startHourIndex: hourBase,
          endHourIndex: wallEndHour,
          metricDelta: { priceImpactEur: baseMean * (effectiveMult - 1) },
        })
      }

      // Apply wall markup every day while active; cold winter adds 30% extra intensity
      if (winterWallDaysRemaining > 0) {
        const wallEffect =
          winterSeasonType === 'cold' ? winterWallMultiplier * 1.3 : winterWallMultiplier
        for (let h = 0; h < 24; h++) {
          // Floor at 20 €/MWh — no negative prices during arctic scarcity
          dayPrices[h] = Math.max(20, dayPrices[h]! * wallEffect)
        }
        winterWallDaysRemaining--
      }

      // Write day prices to output
      for (let h = 0; h < 24; h++) {
        hourlyPrices[hourBase + h] = dayPrices[h] ?? 0
      }
    }
  }

  return {
    totalHours,
    hourlyPrices: Array.from(hourlyPrices),
    events,
  }
}
