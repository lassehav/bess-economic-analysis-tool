import type { PriceSeries } from '../types/prices'
import type { MultiYearForecastOutput, ScenarioProfile } from './types'
import { calibrateFromHistory } from './calibrate'
import { generateForecast } from './generator'

export * from './types'
export * from './scenarios'
export { calibrateFromHistory } from './calibrate'
export { generateForecast } from './generator'

export function runForecast(
  series: PriceSeries,
  profile: ScenarioProfile,
  seed = 42,
): MultiYearForecastOutput {
  const calibration = calibrateFromHistory(series)
  return generateForecast(calibration, profile, seed)
}

export type { HistoricalCalibration } from './types'
