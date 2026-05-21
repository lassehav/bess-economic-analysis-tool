export type Window = {
  chargeHourIndices: number[]
  dischargeHourIndices: number[]
  chargeStartUtc: string
  chargeEndUtc: string
  dischargeStartUtc: string
  dischargeEndUtc: string
  vwapCharge: number
  vwapDischarge: number
  effectiveMargin: number      // vwapDischarge × η_RTE − vwapCharge  (per MWh discharged)
  effectiveEnergyMWh: number   // powerMW × min(D, dischargeHourIndices.length)
  effectiveEFC: number         // effectiveEnergyMWh / (energyMWh × dod)
}

export type SocTracePoint = {
  hourIndex: number   // 0..H (H+1 points for H-hour day)
  socMWh: number
  socPct: number      // socMWh / energyMWh × 100
  mode: 'idle' | 'charging' | 'discharging'
}

export type DailyStats = {
  dateUtc: string          // "YYYY-MM-DD"
  hourlyPrices: number[]   // length 23, 24, or 25
  meanPrice: number
  minPrice: number
  maxPrice: number
  spread: number
  negativeHourCount: number
  windows: Window[]
  socTrace: SocTracePoint[]
  warnings: Array<
    | { kind: 'soc_exceeded_capacity'; hourIndex: number; socMWh: number }
    | { kind: 'soc_below_zero'; hourIndex: number; socMWh: number }
    | { kind: 'discharge_before_charge'; windowIndex: number }
    | { kind: 'block_overlap'; windowAIndex: number; windowBIndex: number }
  >
}

export type PeriodAggregateStats = {
  periodKey: string
  dayCount: number
  spread: { mean: number; std: number; p10: number; p50: number; p90: number; skewness: number }
  windowCount: { mean: number; mode: 0 | 1 | 2 | 3; histogram: Record<0 | 1 | 2 | 3, number> }
  secondaryRatio: { mean: number; std: number }
  tertiaryRatio: { mean: number; std: number }
  peakDurationHours: { mean: number; p10: number; p50: number; p90: number }
  meanLevel: number
  negativeHourShare: number
  effectiveMarginPerCycle: { mean: number; p10: number; p50: number; p90: number }
}
