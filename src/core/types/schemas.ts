import { z } from 'zod'
import type { Inputs } from './inputs'

export const batteryInputsSchema = z.object({
  powerMW: z.number().positive(),
  energyMWh: z.number().positive(),
  roundTripEfficiency: z.number().gt(0).lte(1),
  dod: z.number().gte(0.5).lte(1.0),
  maxCyclesPerDay: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  nominalCycleLifeEFC: z.number().gte(500).lte(20000),
  calendarLifeYears: z.number().gte(1).lte(30),
  cyclesPerDayPenaltyExponent: z.number().gte(0.5).lte(3.0),
  endOfLifeSoH: z.number().gt(0).lt(1),
  activationThreshold: z.number().gte(0.5).lte(3.0).optional(),
})

export const costInputsSchema = z.object({
  batteryCapexPerKWh: z.number().gte(50).lte(1000),
  pcsCapexPerKW: z.number().gte(20).lte(300),
  bopCapexPercentOfBatteryPcs: z.number().gte(0).lte(100),
  developmentCapexPercent: z.number().gte(0).lte(100),
  contingencyPercent: z.number().gte(0).lte(100),
  pcsReplacementIntervalYears: z.number().gte(5).lte(30),
  pcsReplacementCostPercentOfPcs: z.number().gte(0).lte(100),
  fixedOmPerKWPerYear: z.number().gte(0),
  variableOmPerMWhThroughput: z.number().gte(0),
  insurancePercentOfCapexPerYear: z.number().gte(0).lte(100),
  landLeasePerYear: z.number().gte(0),
  gridFeePerMWhThroughput: z.number().gte(0),
  gridFeePerKWPerYear: z.number().gte(0),
  inflationPercentPerYear: z.number().gte(0).lte(100),
  omEscalationPercentPerYear: z.number().gte(0).lte(100),
})

export const financeInputsSchema = z.object({
  projectLifeYears: z.number().gte(5).lte(40),
  wacc: z.number().gte(0).lte(30),
  taxRate: z.number().gte(0).lte(60),
  depreciationYears: z.number().gte(1).lte(40),
  residualValuePercentOfInitialCapex: z.number().gte(0).lte(100),
})

export const inputsSchema = z.object({
  battery: batteryInputsSchema,
  costs: costInputsSchema,
  finance: financeInputsSchema,
})

export function parseInputs(raw: unknown): Inputs {
  return inputsSchema.parse(raw) as Inputs
}
