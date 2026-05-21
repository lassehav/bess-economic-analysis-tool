export type HistoricalCalibration = {
  // [12 months][24 hours] additive normalized shape profile (mean = 1 per month)
  diurnalByMonth: number[][]
  // Month-of-year level multipliers relative to annual mean. Length 12.
  monthLevel: number[]
  // Day-of-week multipliers. Length 7 (0=Sun). Defaults to all-ones if flat.
  dayOfWeekLevel: number[]
  annualMeanPrice: number
  annualMeanSpread: number
  // AR(1) parameters in absolute €/MWh space (no log-space)
  residualAr1: number
  residualSigma: number
}

export type ScenarioYearParams = {
  yearIndex: number
  meanLevelMultiplier: number
  peakMultiplier: number
  troughMultiplier: number
  // gamma exponent for power-transform of diurnal shape
  peakDurationMultiplier: number
  activeStructuralMilestones: string[]
}

export type SimulationEventType = 'structural' | 'stochastic_outage' | 'fundamental_gap'
export type SimulationEventSeverity = 'info' | 'warning' | 'critical'

export type SimulationEvent = {
  id: string
  type: SimulationEventType
  severity: SimulationEventSeverity
  title: string
  description: string
  startHourIndex: number
  endHourIndex: number
  affectedAsset?: string
  metricDelta?: {
    capacityMW?: number
    priceImpactEur?: number
  }
}

export type MultiYearForecastOutput = {
  totalHours: number
  hourlyPrices: number[]
  events: SimulationEvent[]
}
