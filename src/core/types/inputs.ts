export type BatteryInputs = {
  powerMW: number
  energyMWh: number
  roundTripEfficiency: number
  dod: number
  maxCyclesPerDay: 1 | 2 | 3
  nominalCycleLifeEFC: number
  calendarLifeYears: number
  cyclesPerDayPenaltyExponent: number
  endOfLifeSoH: number
  activationThreshold?: number | undefined  // multiplier on MDC threshold; default 1.0; >1 = more conservative
}

// All costs and prices are expressed in real terms (constant money of the price-calibration
// base year). There is deliberately no inflation parameter: general inflation cancels between
// escalation and discounting, so it is omitted and the discount rate is a REAL rate.
// `omEscalationPercentPerYear` is therefore a real escalation — O&M and grid tariffs rising
// faster than CPI — not an inflation proxy.
export type CostInputs = {
  batteryCapexPerKWh: number
  pcsCapex: number           // absolute €
  bopCapex: number           // absolute €
  developmentCapexPercent: number
  contingencyPercent: number
  pcsReplacementIntervalYears: number
  pcsReplacementCostPercentOfPcs: number
  fixedOmPerYear: number     // absolute €/yr
  variableOmPerMWhThroughput: number
  insurancePercentOfCapexPerYear: number
  landLeasePerYear: number
  gridFeePerMWhThroughput: number
  gridFeePerKWPerYear: number
  omEscalationPercentPerYear: number  // REAL escalation above inflation
}

export type FinanceInputs = {
  projectLifeYears: number
  wacc: number               // REAL discount rate (nominal WACC less expected inflation)
  taxRate: number
  depreciationYears: number
  residualValuePercentOfInitialCapex: number
}

export type Inputs = {
  battery: BatteryInputs
  costs: CostInputs
  finance: FinanceInputs
}
