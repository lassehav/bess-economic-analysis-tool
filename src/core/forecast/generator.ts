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
  const totalHours = totalYears * 365 * 24
  const hourlyPrices = new Float64Array(totalHours)
  const events: SimulationEvent[] = []

  let ar1State = 0
  let eventCounter = 0

  let persistentWindState = 0.4 
  let inDunkelflaute = false
  let dunkelflauteStartHour = 0
  let inOversupplyEvent = false
  let oversupplyStartHour = 0

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
    
    const yearHourBase = y * 365 * 24

    // Battery Parameters (1000 MWh capacity, 250 MW max charge/discharge rate)
    const BESS_MAX_CAPACITY_MWH = 1000
    const BESS_MAX_POWER_MW = 250
    let bessSoCMWh = 0 // Track State of Charge continuously across the year

    for (let d = 0; d < 365; d++) {
      const dayOfYear = d + 1
      const monthIdx = dayOfYearToMonthIdx(dayOfYear)
      const dowIdx = ((y * 365 + d) % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6
      const hourBase = yearHourBase + d * 24

      ar1State = residualAr1 * ar1State + residualSigma * normal()

      persistentWindState = 0.85 * persistentWindState + 0.15 * uniform()
      const dailyWindCf = 0.05 + persistentWindState * 0.90

      const dailyInsolation = isSummerMonth(monthIdx)
        ? 0.4 + uniform() * 0.6
        : 0.1 + uniform() * 0.4

      const baseShape = diurnalByMonth[monthIdx] ?? diurnalByMonth[0]!
      const mLevel = monthLevel[monthIdx] ?? 1
      const wLevel = dayOfWeekLevel[dowIdx] ?? 1
      const muDayBase = annualMeanPrice * mLevel * wLevel

      for (let h = 0; h < 24; h++) {
        const hourIndex = hourBase + h
        const diurnalShape = baseShape[h] ?? 1

        // 1. DYNAMIC DEMAND CALCULATION
        // The load fluctuates with the time of day, but can never drop below the datacenter baseload.
        // diurnalShape typically ranges from ~0.7 (night) to ~1.3 (evening peak).
        const variableLoadCapacity = maxPowerConsumption - constantBaseload
        const normalizedShape = (diurnalShape - 0.7) / 0.6 // Rough normalization [0 to 1]
        let currentHourlyLoad = constantBaseload + (variableLoadCapacity * Math.max(0, normalizedShape))
        
        // 2. PHYSICAL GENERATION
        const windNoise = (uniform() - 0.5) * 0.05
        const omega = Math.max(0, Math.min(1, dailyWindCf + windNoise))

        let sigma = 0
        if (h >= 6 && h <= 20) {
          const solarShape = Math.max(0, Math.sin(Math.PI * (h - 6) / 14))
          sigma = solarShape * dailyInsolation
        }

        const Prenew = windCapacityMW * omega + solarCapacityMW * sigma
        const totalGeneration = nuclearCapacityMW + Prenew
        
        // 3. BATTERY DISPATCH LOGIC (Stateful)
        let actualBatteryAction = 0 // Positive = discharging to grid, Negative = charging
        let netPhysicalGap = currentHourlyLoad - totalGeneration

        if (netPhysicalGap < 0) {
          // Oversupply: We have excess power. Try to charge battery.
          const surplus = Math.abs(netPhysicalGap)
          const availableRoomMWh = BESS_MAX_CAPACITY_MWH - bessSoCMWh
          const chargeAmount = Math.min(surplus, BESS_MAX_POWER_MW, availableRoomMWh)
          
          bessSoCMWh += chargeAmount
          actualBatteryAction = -chargeAmount
        } else {
          // Shortage: Demand exceeds base generation. Try to discharge battery to capture peak prices.
          // Only discharge if demand is high enough to warrant it (e.g., peak hours)
          if (diurnalShape > 1.1) {
            const availableEnergyMWh = bessSoCMWh
            const dischargeAmount = Math.min(netPhysicalGap, BESS_MAX_POWER_MW, availableEnergyMWh)
            
            bessSoCMWh -= dischargeAmount
            actualBatteryAction = dischargeAmount
          }
        }

        // The final unserved load or unabsorbed surplus
        const residualGridLoad = netPhysicalGap - actualBatteryAction

        // 4. PRICE FORMATION based on Residual Load
        const macroNoise = (ar1State / (residualSigma > 0 ? residualSigma : 1)) * annualMeanSpread * 0.5
        let basePrice = muDayBase * diurnalShape + macroNoise

        let finalPrice = basePrice
        
        // A. SCARCITY REGIME (High Residual Load)
        if (residualGridLoad > 0) {
          // As the grid relies on expensive gas/coal to fill the gap, price rises exponentially
          const scarcityRatio = residualGridLoad / maxPowerConsumption
          const scarcityPremium = 200 * Math.pow(scarcityRatio, 1.5)
          finalPrice = basePrice + scarcityPremium

          if (residualGridLoad > (maxPowerConsumption * 0.25) && (omega + sigma) < 0.10) {
             if (!inDunkelflaute) {
               inDunkelflaute = true
               dunkelflauteStartHour = hourIndex
             }
          } else if (inDunkelflaute) {
             events.push({
               id: `dunkelflaute-${++eventCounter}`,
               type: 'dunkelflaute_shock',
               severity: 'critical',
               title: 'Windless Winter Freeze',
               description: `High residual load unmitigated by renewables. Prices spiked rapidly.`,
               startHourIndex: dunkelflauteStartHour,
               endHourIndex: hourIndex,
               metricDelta: { priceImpactEur: finalPrice },
             })
             inDunkelflaute = false
          }
        } 
        // B. OVERSUPPLY REGIME (Negative Residual Load)
        else {
          const gridSurplus = Math.abs(residualGridLoad)
          
          if (gridSurplus > 0) {
            // The battery is full (or maxed out on power) and there is STILL excess energy.
            // Price crashes into negatives based on the severity of the unabsorbed surplus.
            const surplusRatio = gridSurplus / maxPowerConsumption
            finalPrice = -80 * surplusRatio

            // Curtailment Floor: Wind operators shut down at -€15 to -€20.
            const curtailmentFloor = -18.0
            if (finalPrice < curtailmentFloor) {
               finalPrice = curtailmentFloor + (finalPrice - curtailmentFloor) * 0.05
            }

            if (!inOversupplyEvent) {
              inOversupplyEvent = true
              oversupplyStartHour = hourIndex
            }
          } else {
             // Balanced by battery. Price is soft/near zero.
             finalPrice = Math.max(5.0, basePrice * 0.2)
             if (inOversupplyEvent) {
               events.push({
                 id: `oversupply-${++eventCounter}`,
                 type: 'curtailment_event',
                 severity: 'warning',
                 title: 'BESS Saturation & Grid Curtailment',
                 description: `Renewable oversupply filled BESS capacity, forcing grid prices negative and triggering wind curtailment.`,
                 startHourIndex: oversupplyStartHour,
                 endHourIndex: hourIndex,
               })
               inOversupplyEvent = false
             }
          }
        }

        // Apply randomizer and boundaries
        finalPrice = finalPrice * (1.0 + priceRandomizer)
        hourlyPrices[hourIndex] = Math.max(-500, Math.min(4000, finalPrice))
      }
    }
  }

  return {
    totalHours,
    hourlyPrices: Array.from(hourlyPrices),
    events,
  }
}