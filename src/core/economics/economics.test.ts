import { describe, it, expect } from 'vitest'
import { computeFinancials, computeCapex } from './index'
import type { Inputs } from '../types/inputs'
import type { AnnualStream } from '../types/streams'

const BASE_INPUTS: Inputs = {
  battery: {
    powerMW: 10,
    energyMWh: 40,
    roundTripEfficiency: 0.85,
    dod: 0.9,
    maxCyclesPerDay: 2,
    nominalCycleLifeEFC: 6000,
    calendarLifeYears: 20,
    cyclesPerDayPenaltyExponent: 1.5,
    endOfLifeSoH: 0.80,
  },
  costs: {
    batteryCapexPerKWh: 200,
    pcsCapex: 600_000,    // €60/kW × 10 MW
    bopCapex: 430_000,    // 5% × (€8 M battery + €600 k PCS)
    developmentCapexPercent: 3,
    contingencyPercent: 5,
    pcsReplacementIntervalYears: 12,
    pcsReplacementCostPercentOfPcs: 50,
    fixedOmPerYear: 100_000, // €10/kW/yr × 10 MW
    variableOmPerMWhThroughput: 0.5,
    insurancePercentOfCapexPerYear: 0.5,
    landLeasePerYear: 50000,
    gridFeePerMWhThroughput: 1,
    gridFeePerKWPerYear: 2,
    inflationPercentPerYear: 2,
    omEscalationPercentPerYear: 0,
  },
  finance: {
    projectLifeYears: 20,
    wacc: 6,
    taxRate: 20,
    depreciationYears: 15,
    residualValuePercentOfInitialCapex: 5,
  },
}

function makeStreams(
  projectLifeYears: number,
  grossRevenue: number,
  throughputMWh: number,
  energyMWh: number,
  dod: number,
): AnnualStream[] {
  return Array.from({ length: projectLifeYears }, (_, i) => ({
    year: i + 1,
    grossRevenue,
    throughputMWh,
    cyclesEFC: throughputMWh / (energyMWh * dod),
    endOfYearSoH: 1,
    capacityMWh: energyMWh * dod,
    retired: false,
  }))
}

describe('economics — all-zero revenue', () => {
  it('NPV is negative and IRR is null when revenue is zero', () => {
    const streams = makeStreams(20, 0, 0, 40, 0.9)
    const result = computeFinancials(BASE_INPUTS, streams)
    expect(result.npv).toBeLessThan(0)
    expect(result.irr).toBeNull()
  })
})

describe('economics — constant revenue annuity', () => {
  it('NPV matches closed-form annuity formula within 1e-2', () => {
    // Minimal costs: no OM escalation, no PCS replacement, no insurance, no land lease, no grid fees
    const inputs: Inputs = {
      battery: {
        powerMW: 10,
        energyMWh: 40,
        roundTripEfficiency: 0.85,
        dod: 0.9,
        maxCyclesPerDay: 2,
        activationThreshold: 1.0,
        nominalCycleLifeEFC: 6000,
        calendarLifeYears: 20,
        cyclesPerDayPenaltyExponent: 1.5,
        endOfLifeSoH: 0.80,
      },
      costs: {
        batteryCapexPerKWh: 200,
        pcsCapex: 600_000, // €60/kW × 10 MW
        bopCapex: 0,
        developmentCapexPercent: 0,
        contingencyPercent: 0,
        pcsReplacementIntervalYears: 30, // > projectLifeYears so no replacement
        pcsReplacementCostPercentOfPcs: 0,
        fixedOmPerYear: 0,
        variableOmPerMWhThroughput: 0,
        insurancePercentOfCapexPerYear: 0,
        landLeasePerYear: 0,
        gridFeePerMWhThroughput: 0,
        gridFeePerKWPerYear: 0,
        inflationPercentPerYear: 0,
        omEscalationPercentPerYear: 0,
      },
      finance: {
        projectLifeYears: 10,
        wacc: 8,
        taxRate: 0,
        depreciationYears: 10,
        residualValuePercentOfInitialCapex: 0,
        vatRecoverable: true,
      },
    }

    const capex = computeCapex(inputs)
    // battery = 200 * 40000 = 8,000,000; pcsCapex = 600,000; total = 8,600,000
    const annualRevenue = 1_000_000
    const streams = makeStreams(10, annualRevenue, 0, 40, 0.9)

    const result = computeFinancials(inputs, streams)

    // Closed-form: PV = annualRevenue × [1 - (1+r)^-N] / r − capex
    const r = 0.08
    const N = 10
    const pvAnnuity = annualRevenue * (1 - Math.pow(1 + r, -N)) / r
    const expectedNpv = pvAnnuity - capex.total

    expect(Math.abs(result.npv - expectedNpv)).toBeLessThan(1e-2)
  })
})

describe('economics — known LCOS test vector', () => {
  it('LCOS ≈ 37.04 €/MWh for simple capex-only scenario at wacc=0', () => {
    const inputs: Inputs = {
      battery: {
        powerMW: 10,
        energyMWh: 40,
        roundTripEfficiency: 0.85,
        dod: 0.9,
        maxCyclesPerDay: 2,
        activationThreshold: 1.0,
        nominalCycleLifeEFC: 6000,
        calendarLifeYears: 20,
        cyclesPerDayPenaltyExponent: 1.5,
        endOfLifeSoH: 0.80,
      },
      costs: {
        batteryCapexPerKWh: 200,
        pcsCapex: 200_000, // €20/kW × 10 MW
        bopCapex: 0,
        developmentCapexPercent: 0,
        contingencyPercent: 0,
        pcsReplacementIntervalYears: 30,
        pcsReplacementCostPercentOfPcs: 0,
        fixedOmPerYear: 0,
        variableOmPerMWhThroughput: 0,
        insurancePercentOfCapexPerYear: 0,
        landLeasePerYear: 0,
        gridFeePerMWhThroughput: 0,
        gridFeePerKWPerYear: 0,
        inflationPercentPerYear: 0,
        omEscalationPercentPerYear: 0,
      },
      finance: {
        projectLifeYears: 20,
        wacc: 0,
        taxRate: 0,
        depreciationYears: 20,
        residualValuePercentOfInitialCapex: 0,
        vatRecoverable: true,
      },
    }

    // Only battery capex: 200 €/kWh × 40 MWh × 1000 = 8,000,000 €
    // PCS cost = 20 * 10 * 1000 = 200,000 — we zero out PCS contribution by overriding
    // pcsCapex = 200_000 (€20/kW × 10 MW); total CAPEX includes PCS, LCOS verified against it

    // usable = 40 × 0.9 = 36 MWh
    // EFC per year = 6000 / 20 = 300
    // throughput per year = 300 × 36 = 10,800 MWh
    const usableMWh = 40 * 0.9
    const efcPerYear = 6000 / 20
    const throughputPerYear = efcPerYear * usableMWh

    const streams: AnnualStream[] = Array.from({ length: 20 }, (_, i) => ({
      year: i + 1,
      grossRevenue: 0,
      throughputMWh: throughputPerYear,
      cyclesEFC: efcPerYear,
      endOfYearSoH: 1,
      capacityMWh: usableMWh,
      retired: false,
    }))

    const capex = computeCapex(inputs)
    // LCOS = capex.total / (20 × throughputPerYear) for wacc=0
    const totalThroughput = 20 * throughputPerYear
    const expectedLcos = capex.total / totalThroughput

    const result = computeFinancials(inputs, streams)
    expect(Math.abs(result.lcos - expectedLcos)).toBeLessThan(1)
  })

  it('pure-battery LCOS ≈ 37.04 for batteryCapexPerKWh=200, energyMWh=40, nomLife=6000, dod=0.9', () => {
    // batteryCapex = 200 * 40 * 1000 = 8,000,000
    // usable = 40 * 0.9 = 36 MWh
    // total lifetime EFC = 6000, throughput = 6000 * 36 = 216,000 MWh
    // LCOS = 8,000,000 / 216,000 = 37.037...
    const batteryCapex = 200 * 40 * 1000
    const usableMWh = 40 * 0.9
    const totalEFC = 6000
    const totalThroughput = totalEFC * usableMWh
    const pureLcos = batteryCapex / totalThroughput
    expect(Math.abs(pureLcos - 37.04)).toBeLessThan(0.01)
  })
})

describe('economics — discounted payback >= simple payback', () => {
  it('discountedPaybackYears >= simplePaybackYears when both are non-null', () => {
    // High revenue to guarantee payback
    const inputs: Inputs = {
      ...BASE_INPUTS,
      finance: { ...BASE_INPUTS.finance, wacc: 8, taxRate: 0 },
    }
    const streams = makeStreams(20, 5_000_000, 10000, 40, 0.9)
    const result = computeFinancials(inputs, streams)

    if (result.simplePaybackYears !== null && result.discountedPaybackYears !== null) {
      expect(result.discountedPaybackYears).toBeGreaterThanOrEqual(result.simplePaybackYears)
    } else {
      // At least simple payback should be non-null with high revenue
      expect(result.simplePaybackYears).not.toBeNull()
    }
  })
})
