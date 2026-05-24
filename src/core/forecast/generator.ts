import type {
  HistoricalCalibration,
  MultiYearForecastOutput,
  ScenarioProfile,
  SimulationEvent,
} from './types'
import { makePrng, makeNormalPrng } from './prng'

const MONTH_DAY_ENDS = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]

function dayOfYearToMonthIdx(dayOfYear: number): number {
  const d = ((dayOfYear - 1) % 365) + 1
  for (let m = 0; m < 12; m++) {
    if (d <= MONTH_DAY_ENDS[m]!) return m
  }
  return 11
}

function isSummerMonth(monthIdx: number): boolean {
  return monthIdx >= 3 && monthIdx <= 8
}

type PlannedOutage = {
  startDay: number
  endDay: number
  assetType: 'nuclear' | 'wind'
  reductionFraction: number
  emitted: boolean
}

type PlannedDunkelflaute = {
  startDay: number
  endDay: number
  emitted: boolean
}

function planOutages(totalDays: number, uniform: () => number): PlannedOutage[] {
  const outages: PlannedOutage[] = []
  let nextStart = Math.floor((0.5 + uniform() * 2.0) * 365)
  while (nextStart < totalDays) {
    const duration = 7 + Math.floor(uniform() * 25) 
    const assetType = uniform() < 0.6 ? 'nuclear' : 'wind'
    const reductionFraction = 0.3 + uniform() * 0.4 
    outages.push({ startDay: nextStart, endDay: nextStart + duration, assetType, reductionFraction, emitted: false })
    nextStart = nextStart + duration + Math.floor((1.5 + uniform() * 2.0) * 365)
  }
  return outages
}

function planDunkelflauteEvents(totalDays: number, uniform: () => number): PlannedDunkelflaute[] {
  const events: PlannedDunkelflaute[] = []
  let nextStart = Math.floor((2.0 + uniform() * 2.0) * 365)
  while (nextStart < totalDays) {
    const yearIdx = Math.floor(nextStart / 365)
    const dayInYear = nextStart - yearIdx * 365 
    const octStart = yearIdx * 365 + 273 
    const snapped = (dayInYear > 90 && dayInYear < 273) ? octStart : nextStart
    if (snapped >= totalDays) break

    const duration = 5 + Math.floor(uniform() * 10) 
    events.push({ startDay: snapped, endDay: snapped + duration, emitted: false })
    nextStart = snapped + duration + Math.floor((4.0 + uniform() * 2.0) * 365)
  }
  return events
}

export function generateForecast(
  calibration: HistoricalCalibration,
  profile: ScenarioProfile,
  seed: number,
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

  const yearParams = profile.years
  const totalYears = yearParams.length
  const totalDays = totalYears * 365
  const totalHours = totalDays * 24
  const hourlyPrices = new Float64Array(totalHours)
  const events: SimulationEvent[] = []

  const outages = planOutages(totalDays, uniform)
  const dunkelflauteEvents = planDunkelflauteEvents(totalDays, uniform)

  const dailyNuclearMultiplier = new Float32Array(totalDays).fill(1.0)
  const dailyWindMultiplier = new Float32Array(totalDays).fill(1.0)
  const dailyDunkelflauteActive = new Uint8Array(totalDays).fill(0)

  for (const outage of outages) {
    const end = Math.min(totalDays, outage.endDay)
    for (let day = outage.startDay; day < end; day++) {
      if (outage.assetType === 'nuclear') {
        dailyNuclearMultiplier[day] = 1.0 - outage.reductionFraction
      } else {
        dailyWindMultiplier[day] = 1.0 - outage.reductionFraction
      }
    }
  }

  for (const df of dunkelflauteEvents) {
    const end = Math.min(totalDays, df.endDay)
    for (let day = df.startDay; day < end; day++) {
      dailyDunkelflauteActive[day] = 1
    }
  }

  let ar1State = 0
  let eventCounter = 0
  let persistentWindState = 0.7
  let inOversupplyEvent = false
  let oversupplyStartHour = 0
  let consecutiveNegativeHours = 0 

  const BESS_ROUND_TRIP_EFFICIENCY = 0.85
  const BESS_CHARGE_EFFICIENCY = Math.sqrt(BESS_ROUND_TRIP_EFFICIENCY) 
  const BESS_DISCHARGE_EFFICIENCY = Math.sqrt(BESS_ROUND_TRIP_EFFICIENCY)
  let bessSoCMWh = 0

  for (let y = 0; y < totalYears; y++) {
    const params = yearParams[y]!
    const {
      maxPowerConsumption,
      constantBaseload,
      solarCapacityMW,
      windCapacityMW,
      nuclearCapacityMW,
      priceRandomizer,
    } = params

    const BESS_MAX_CAPACITY_MWH = params.bessCapacityMWh ?? 1000
    const BESS_MAX_POWER_MW = BESS_MAX_CAPACITY_MWH / 4
    const FLEXIBLE_LOAD_MW = params.flexibleLoadMW ?? 0

    // ─── CRITICAL SYSTEMIC EQUILIBRIUM ADJUSTMENT ───────────────────────────
    const systemBessRatio = BESS_MAX_CAPACITY_MWH / 1000
    const systemLoadRatio = constantBaseload / 9500

    // Much more aggressive structural dampening factor. 
    // As BESS scales to 2,000MWh, this drops from 1.0 down toward 0.35
    const peakSpreadDampener = Math.max(
      0.20,
      1.0 / (1.0 + 0.85 * (systemBessRatio - 1.0) + 0.4 * (systemLoadRatio - 1.0))
    )

    const yearHourBase = y * 365 * 24

    for (let d = 0; d < 365; d++) {
      const currentDay = y * 365 + d
      const dayOfYear = d + 1
      const monthIdx = dayOfYearToMonthIdx(dayOfYear)
      const dowIdx = (currentDay % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6
      const hourBase = yearHourBase + d * 24

      ar1State = residualAr1 * ar1State + residualSigma * normal()
      persistentWindState = 0.85 * persistentWindState + 0.15 * uniform()
      const dailyWindCf = 0.05 + persistentWindState * 0.9

      const dailyInsolation = isSummerMonth(monthIdx)
        ? 0.4 + uniform() * 0.6
        : 0.1 + uniform() * 0.4

      const baseShape = diurnalByMonth[monthIdx] ?? diurnalByMonth[0]!
      const mLevel = monthLevel[monthIdx] ?? 1
      const wLevel = dayOfWeekLevel[dowIdx] ?? 1
      
      // Lift the structural baseline floor price as constant datacenters gobble up capacity
      const meanShiftFactor = 1.0 + 0.18 * (systemLoadRatio - 1.0)
      const effectiveMeanPrice = annualMeanPrice * (params.meanLevelMultiplier ?? 1.0) * meanShiftFactor
      const effectiveMeanSpread = annualMeanSpread * (params.spreadMultiplier ?? 1.0)
      const muDayBase = effectiveMeanPrice * mLevel * wLevel

      let effectiveNuclearMW = Math.round(nuclearCapacityMW * dailyNuclearMultiplier[currentDay]!)
      let effectiveWindCapMW = Math.round(windCapacityMW * dailyWindMultiplier[currentDay]!)
      const isDunkelflauteDay = dailyDunkelflauteActive[currentDay] === 1

      if (isDunkelflauteDay) {
        effectiveWindCapMW = Math.round(effectiveWindCapMW * 0.15)
      }

      for (const outage of outages) {
        if (currentDay === outage.startDay && !outage.emitted) {
          outage.emitted = true
          const assetLabel = outage.assetType === 'nuclear' ? 'Nuclear Plant' : 'Wind Farm'
          const deratePct = Math.round(outage.reductionFraction * 100)
          const durationDays = outage.endDay - outage.startDay
          events.push({
            id: `outage-${++eventCounter}`,
            type: 'stochastic_outage',
            severity: 'warning',
            title: `${assetLabel} Forced Outage`,
            description: `Unplanned ${durationDays}-day derating: ${deratePct}% of ${outage.assetType} capacity offline.`,
            startHourIndex: hourBase,
            endHourIndex: Math.min(totalHours, hourBase + durationDays * 24),
            affectedAsset: outage.assetType,
            metricDelta: {
              capacityMW: Math.round((outage.assetType === 'nuclear' ? nuclearCapacityMW : windCapacityMW) * outage.reductionFraction),
            },
          })
          break
        }
      }

      for (const df of dunkelflauteEvents) {
        if (currentDay === df.startDay && !df.emitted) {
          df.emitted = true
          const durationDays = df.endDay - df.startDay
          events.push({
            id: `dunkelflaute-${++eventCounter}`,
            type: 'dunkelflaute_shock',
            severity: 'critical',
            title: 'Windless Winter Freeze',
            description: `${durationDays}-day grid-wide wind lull. Dispatchable backup fully loaded, prices elevated.`,
            startHourIndex: hourBase,
            endHourIndex: Math.min(totalHours, hourBase + durationDays * 24),
          })
          break
        }
      }

      for (let h = 0; h < 24; h++) {
        const hourIndex = hourBase + h
        const rawDiurnalShape = baseShape[h] ?? 1

        // 1. DYNAMIC DEMAND
        const isWeekend = dowIdx === 5 || dowIdx === 6
        const weekendCompression = isWeekend ? 0.4 : 1.0
        const demandShape = 1.0 + ((rawDiurnalShape - 1.0) * weekendCompression)

        const variableLoadCapacity = maxPowerConsumption - constantBaseload
        const normalizedShape = (demandShape - 0.7) / 0.6
        const currentHourlyLoad = constantBaseload + variableLoadCapacity * Math.max(0, normalizedShape)

        // 2. PHYSICAL GENERATION
        const economicWindScale = consecutiveNegativeHours > 6 ? 0.35 : 1.0
        const windNoise = (uniform() - 0.5) * 0.05
        const omega = Math.max(0, Math.min(1, dailyWindCf + windNoise)) * economicWindScale

        let sigma = 0
        if (h >= 6 && h <= 20) {
          const solarShape = Math.max(0, Math.sin(Math.PI * (h - 6) / 14))
          sigma = solarShape * dailyInsolation
        }

        const Prenew = effectiveWindCapMW * omega + solarCapacityMW * sigma
        const totalGeneration = effectiveNuclearMW + Prenew

        // 3. STATEFUL BATTERY DISPATCH (Dynamic Peak Shaving Adjustment)
        let actualBatteryAction = 0
        const netPhysicalGap = currentHourlyLoad - totalGeneration

        if (netPhysicalGap < 0) {
          const surplus = Math.abs(netPhysicalGap)
          const availableRoomMWh = BESS_MAX_CAPACITY_MWH - bessSoCMWh
          const maxPowerChargeLimit = BESS_MAX_POWER_MW
          const maxCapacityChargeLimit = availableRoomMWh / BESS_CHARGE_EFFICIENCY
          
          const chargePowerGridSide = Math.min(surplus, maxPowerChargeLimit, maxCapacityChargeLimit)
          bessSoCMWh += chargePowerGridSide * BESS_CHARGE_EFFICIENCY
          actualBatteryAction = -chargePowerGridSide
        } else {
          // FIX: Batteries respond dynamically to load shapes to perform structural peak shaving
          if (demandShape > 1.02 || netPhysicalGap > (maxPowerConsumption * 0.1)) {
            const maxPowerDischargeLimit = BESS_MAX_POWER_MW
            const maxCapacityDischargeLimit = bessSoCMWh * BESS_DISCHARGE_EFFICIENCY
            
            const dischargePowerBatterySide = Math.min(netPhysicalGap, maxPowerDischargeLimit, maxCapacityDischargeLimit)
            bessSoCMWh -= (dischargePowerBatterySide / BESS_DISCHARGE_EFFICIENCY)
            actualBatteryAction = dischargePowerBatterySide
          }
        }

        // 3b. FLEXIBLE LOAD SECTOR COUPLING
        let residualGridLoad = netPhysicalGap - actualBatteryAction
        if (residualGridLoad < 0 && FLEXIBLE_LOAD_MW > 0) {
          const dynamicFlexLoadCap = consecutiveNegativeHours > 4 ? FLEXIBLE_LOAD_MW * 1.4 : FLEXIBLE_LOAD_MW
          const flexAbsorption = Math.min(Math.abs(residualGridLoad), dynamicFlexLoadCap)
          residualGridLoad += flexAbsorption
        }
        
        // 4. PRICE FORMATION
        const macroNoise = (ar1State / (residualSigma > 0 ? residualSigma : 1)) * effectiveMeanSpread * 0.5 * peakSpreadDampener
        let basePrice = muDayBase + macroNoise 
        let finalPrice = basePrice

        // A. SCARCITY REGIME (Fixed to eliminate artificial unconstrained daily spiking loops)
        if (residualGridLoad > 0) {
          if (inOversupplyEvent) {
            events.push({
              id: `oversupply-${++eventCounter}`,
              type: 'curtailment_event',
              severity: 'warning',
              title: 'BESS Saturation & Grid Curtailment',
              description: 'Renewable oversupply filled BESS capacity, forcing grid prices negative and triggering wind curtailment.',
              startHourIndex: oversupplyStartHour,
              endHourIndex: hourIndex,
            })
            inOversupplyEvent = false
          }

          // Safe normalized ratio based on total dynamic consumption capacity
          const scarcityRatio = residualGridLoad / Math.max(1000, maxPowerConsumption)
          let scarcityPremium = 0
          
          // 1. Calculate a dynamic cap modifier based on the actual forecast year parameters
          const volatilityMultiplier = params.spreadMultiplier ?? 1.0;

          // 2. Feed this directly into your premium and ceiling math
          if (scarcityRatio > 0.15) {
            // Volatility now expands or contracts the height of the peak directly
            scarcityPremium = 350 * Math.pow(scarcityRatio - 0.15, 2.2) * peakSpreadDampener * volatilityMultiplier;
            
            const dynamicCeilingThreshold = 40 * volatilityMultiplier;
            if (scarcityPremium > dynamicCeilingThreshold) {
              scarcityPremium = dynamicCeilingThreshold + (25 * volatilityMultiplier) * Math.log10(scarcityPremium - dynamicCeilingThreshold + 1);
            }
          } else {
            const profileGradient = (demandShape - 1.0) * 45 * peakSpreadDampener * volatilityMultiplier;
            basePrice = muDayBase + profileGradient + macroNoise;
          }         
          finalPrice = basePrice + scarcityPremium
          
        // B. OVERSUPPLY REGIME
        } else {
          const gridSurplus = Math.abs(residualGridLoad)

          if (gridSurplus > 0) {
            const surplusRatio = gridSurplus / Math.max(1000, maxPowerConsumption)
            let rawPrice = muDayBase - (surplusRatio * (muDayBase * 1.2) * peakSpreadDampener)

            const diurnalRelief = (demandShape - 1.0) * (muDayBase * 0.8) * peakSpreadDampener
            rawPrice += diurnalRelief
            rawPrice += macroNoise * 0.1

            const curtailmentFloor = -10.0
            
            if (rawPrice < curtailmentFloor) {
              const overshoot = Math.abs(rawPrice - curtailmentFloor)
              finalPrice = curtailmentFloor - (Math.sqrt(overshoot) * peakSpreadDampener)
            } else {
              finalPrice = rawPrice
            }

            finalPrice = Math.max(-50, finalPrice)

            if (!inOversupplyEvent) {
              inOversupplyEvent = true
              oversupplyStartHour = hourIndex
            }
          } else {
            finalPrice = Math.max(15.0, basePrice * 0.4)
            
            if (inOversupplyEvent) {
              events.push({
                id: `oversupply-${++eventCounter}`,
                type: 'curtailment_event',
                severity: 'warning',
                title: 'BESS Saturation & Grid Curtailment',
                description: 'Renewable oversupply filled BESS capacity, forcing grid prices negative and triggering wind curtailment.',
                startHourIndex: oversupplyStartHour,
                endHourIndex: hourIndex,
              })
              inOversupplyEvent = false
            }
          }
        }

        // 5. DUNKELFLAUTE OVERRIDE (Systemic events keep real extreme volatility spikes intact)
        if (isDunkelflauteDay) {
          const shockPremium = 130 + (Math.pow(demandShape, 2.0) * 80)
          finalPrice += shockPremium
          finalPrice = Math.max(140, finalPrice)
        }

        finalPrice = finalPrice * (1.0 + priceRandomizer)
        hourlyPrices[hourIndex] = Math.max(-300, Math.min(3000, finalPrice))

        if (finalPrice < 0) {
          consecutiveNegativeHours++
        } else {
          consecutiveNegativeHours = 0
        }
      }
    }
  }

  return {
    totalHours,
    hourlyPrices: Array.from(hourlyPrices),
    events,
  }
}