import type { PriceSeries } from '../types/prices'
import type { MultiYearForecastOutput } from './types'
import { calibrateFromHistory } from './calibrate'
import { getScenario } from './scenarios'
import { generateForecast } from './generator'

export * from './types'
export * from './scenarios'
export { calibrateFromHistory } from './calibrate'
export { generateForecast } from './generator'

export function runForecast(
  series: PriceSeries,
  scenarioId: string,
  yearCount: number,
  seed = 42,
): MultiYearForecastOutput {
  const calibration = calibrateFromHistory(series)
  const scenario = getScenario(scenarioId)
  const yearParams = Array.from({ length: yearCount }, (_, i) => scenario.getYearParams(i + 1))
  return generateForecast(calibration, yearParams, seed)
}

export type { HistoricalCalibration } from './types'
