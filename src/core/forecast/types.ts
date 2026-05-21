export type HistoricalCalibration = {
  diurnalByMonth: number[][]  // [12][24] normalized shape (mean=1 per month)
  monthLevel: number[]         // [12] relative to annual mean
  dayOfWeekLevel: number[]     // [7] 0=Sun
  annualMeanPrice: number
  annualMeanSpread: number
  residualAr1: number
  residualSigma: number
}

export type YearCapacityParams = {
  yearIndex: number             // 0-based
  maxPowerConsumption: number   // MW peak system load
  constantBaseload: number      // MW inelastic + "cheap eaters"
  solarCapacityMW: number
  windCapacityMW: number
  nuclearCapacityMW: number
  priceRandomizer: number       // [-0.20, +0.20]
}

export type ScenarioProfile = {
  id: string
  name: string
  description: string
  isPreset: boolean
  updatedAt: string  // ISO timestamp
  years: YearCapacityParams[]
}

export type SimulationEventType = 'structural_shift' | 'stochastic_outage' | 'dunkelflaute_shock'
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
