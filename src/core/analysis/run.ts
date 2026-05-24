import type { Inputs } from '../types/inputs'
import type { ScenarioProfile, HistoricalCalibration } from '../forecast/types'
import type { DailyPriceParams } from '../types/streams'
import { generateForecast } from '../forecast/index'
import { runProjectSimulation } from '../dispatch/engine'
import { computeFinancials } from '../economics/index'

export type SimulationRequest = {
  inputs: Inputs
  scenario: ScenarioProfile
  calibration: HistoricalCalibration
  rngSeed: number
}

export type SimulationOutcome = {
  npv: number
  irr: number | null
  lcos: number
  simplePaybackYears: number | null
  discountedPaybackYears: number | null
  totalRevenueNominal: number
  endOfYearSoH_atYear20: number
  retiredAtYear: number | null
}

function hourlyToDailyParams(prices: number[], projectLifeYears: number): DailyPriceParams[] {
  const days: DailyPriceParams[] = []
  if (prices.length === 0) return days
  const totalDays = projectLifeYears * 365
  for (let d = 0; d < totalDays; d++) {
    // Cycle the price series when the scenario is shorter than the project life.
    // Prices are generated in whole-year blocks (8 760 h/yr) so the modulo
    // always lands on a clean day boundary, repeating the last scenario year
    // onwards — equivalent to "steady-state market" assumption.
    const startH = (d * 24) % prices.length
    const endH = startH + 24
    const slice = endH <= prices.length
      ? prices.slice(startH, endH)
      : [...prices.slice(startH), ...prices.slice(0, endH - prices.length)]
    const mean = slice.reduce((a, b) => a + b, 0) / 24
    days.push({
      yearIndex: Math.floor(d / 365),
      dayOfYear: (d % 365) + 1,
      startUtc: `2026-01-01T00:00:00Z`,
      hourlyPrices: slice,
      dayMeanPrice: mean,
    })
  }
  return days
}

export function runSingle(req: SimulationRequest): SimulationOutcome {
  const forecast = generateForecast(req.calibration, req.scenario, req.rngSeed)
  const days = hourlyToDailyParams(forecast.hourlyPrices, req.inputs.finance.projectLifeYears)
  const sim = runProjectSimulation(req.inputs, days)
  const fin = computeFinancials(req.inputs, sim.streams)
  const lastStream = sim.streams[sim.streams.length - 1]
  return {
    npv: fin.npv,
    irr: fin.irr,
    lcos: fin.lcos,
    simplePaybackYears: fin.simplePaybackYears,
    discountedPaybackYears: fin.discountedPaybackYears,
    totalRevenueNominal: fin.totalRevenueNominal,
    endOfYearSoH_atYear20: lastStream?.endOfYearSoH ?? 0,
    retiredAtYear: sim.retiredAtYear,
  }
}
