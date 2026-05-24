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

export type CostInputs = {
  batteryCapexPerKWh: number
  pcsCapexPerKW: number
  bopCapexPercentOfBatteryPcs: number
  developmentCapexPercent: number
  contingencyPercent: number
  pcsReplacementIntervalYears: number
  pcsReplacementCostPercentOfPcs: number
  fixedOmPerKWPerYear: number
  variableOmPerMWhThroughput: number
  insurancePercentOfCapexPerYear: number
  landLeasePerYear: number
  gridFeePerMWhThroughput: number
  gridFeePerKWPerYear: number
  inflationPercentPerYear: number
  omEscalationPercentPerYear: number
}

export type FinanceInputs = {
  projectLifeYears: number
  wacc: number
  taxRate: number
  depreciationYears: number
  residualValuePercentOfInitialCapex: number
}

export type Inputs = {
  battery: BatteryInputs
  costs: CostInputs
  finance: FinanceInputs
}
