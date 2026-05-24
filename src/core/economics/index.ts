import type { Inputs } from '../types/inputs'
import type { AnnualStream } from '../types/streams'

export type CapexBreakdown = {
  battery: number
  pcs: number
  bop: number
  development: number
  contingency: number
  total: number
}

export function computeCapex(inputs: Inputs): CapexBreakdown {
  const battery = inputs.costs.batteryCapexPerKWh * inputs.battery.energyMWh * 1000
  const pcs = inputs.costs.pcsCapexPerKW * inputs.battery.powerMW * 1000
  const bop = (battery + pcs) * inputs.costs.bopCapexPercentOfBatteryPcs / 100
  const development = (battery + pcs + bop) * inputs.costs.developmentCapexPercent / 100
  const contingency = (battery + pcs + bop + development) * inputs.costs.contingencyPercent / 100
  const total = battery + pcs + bop + development + contingency
  return { battery, pcs, bop, development, contingency, total }
}

export type AnnualOpex = {
  year: number
  fixedOM: number
  variableOM: number
  insurance: number
  landLease: number
  gridFees: number
  total: number
}

export function computeAnnualOpex(
  inputs: Inputs,
  capex: CapexBreakdown,
  stream: AnnualStream,
): AnnualOpex {
  const { year } = stream
  const inflFactor = Math.pow(1 + inputs.costs.inflationPercentPerYear / 100, year)
  const omFactor = inflFactor * Math.pow(1 + inputs.costs.omEscalationPercentPerYear / 100, year)

  const fixedOM =
    inputs.costs.fixedOmPerKWPerYear * inputs.battery.powerMW * 1000 * omFactor
  const variableOM =
    inputs.costs.variableOmPerMWhThroughput * stream.throughputMWh * omFactor
  const insurance =
    (inputs.costs.insurancePercentOfCapexPerYear / 100) * capex.total * inflFactor
  const landLease = inputs.costs.landLeasePerYear * inflFactor
  const gridFees =
    (inputs.costs.gridFeePerMWhThroughput * stream.throughputMWh +
      inputs.costs.gridFeePerKWPerYear * inputs.battery.powerMW * 1000) *
    inflFactor

  const total = fixedOM + variableOM + insurance + landLease + gridFees
  return { year, fixedOM, variableOM, insurance, landLease, gridFees, total }
}

export type AnnualPcsReplacement = {
  year: number
  pcsReplacementCost: number
}

export function computeAnnualPcsReplacement(
  inputs: Inputs,
  capex: CapexBreakdown,
  yearIndex: number,
): AnnualPcsReplacement {
  const { pcsReplacementIntervalYears, pcsReplacementCostPercentOfPcs, inflationPercentPerYear } =
    inputs.costs
  const { projectLifeYears } = inputs.finance

  let pcsReplacementCost = 0
  let repYear = pcsReplacementIntervalYears
  while (repYear <= projectLifeYears) {
    if (repYear === yearIndex) {
      const inflFactor = Math.pow(1 + inflationPercentPerYear / 100, yearIndex)
      pcsReplacementCost = capex.pcs * (pcsReplacementCostPercentOfPcs / 100) * inflFactor
      break
    }
    repYear += pcsReplacementIntervalYears
  }

  return { year: yearIndex, pcsReplacementCost }
}

export type CashflowRow = {
  year: number
  revenue: number
  // OPEX detail (positive amounts = cost)
  fixedOM: number
  variableOM: number
  insurance: number
  landLease: number
  gridFees: number
  opex: number
  pcsReplacement: number
  capex: number
  residualValue: number
  ebitda: number
  depreciation: number
  ebit: number
  nolCarryforward: number  // NOL balance remaining at end of year
  tax: number
  cashflow: number
  discountFactor: number
  discountedCashflow: number
  cumulativeDiscountedCashflow: number
}

export function buildCashflow(inputs: Inputs, streams: AnnualStream[]): CashflowRow[] {
  const capex = computeCapex(inputs)
  const { projectLifeYears, wacc, taxRate, depreciationYears, residualValuePercentOfInitialCapex } =
    inputs.finance
  const waccDecimal = wacc / 100

  const rows: CashflowRow[] = []
  let cumulativeDiscounted = 0
  let nolBalance = 0  // accumulated Net Operating Loss carryforward (DTA)

  // Year 0: construction
  const year0Cashflow = -capex.total
  cumulativeDiscounted += year0Cashflow
  rows.push({
    year: 0,
    revenue: 0,
    fixedOM: 0, variableOM: 0, insurance: 0, landLease: 0, gridFees: 0,
    opex: 0,
    pcsReplacement: 0,
    capex: -capex.total,
    residualValue: 0,
    ebitda: 0,
    depreciation: 0,
    ebit: 0,
    nolCarryforward: 0,
    tax: 0,
    cashflow: year0Cashflow,
    discountFactor: 1,
    discountedCashflow: year0Cashflow,
    cumulativeDiscountedCashflow: cumulativeDiscounted,
  })

  const annualDepreciation = capex.total / depreciationYears

  for (let y = 1; y <= projectLifeYears; y++) {
    const stream = streams.find((s) => s.year === y)
    const revenue = stream?.grossRevenue ?? 0
    const throughputMWh = stream?.throughputMWh ?? 0

    const streamForOpex: AnnualStream = stream ?? {
      year: y,
      grossRevenue: 0,
      throughputMWh: 0,
      cyclesEFC: 0,
      endOfYearSoH: 1,
      capacityMWh: inputs.battery.energyMWh * inputs.battery.dod,
      retired: false,
    }

    const opexResult = computeAnnualOpex(inputs, capex, { ...streamForOpex, throughputMWh })
    const pcsResult = computeAnnualPcsReplacement(inputs, capex, y)

    const isFinalYear = y === projectLifeYears
    const residualValueNominal = isFinalYear
      ? capex.total *
        (residualValuePercentOfInitialCapex / 100) *
        Math.pow(1 + inputs.costs.inflationPercentPerYear / 100, y)
      : 0

    const ebitda = revenue - opexResult.total - pcsResult.pcsReplacementCost
    const depreciationThisYear = y <= depreciationYears ? annualDepreciation : 0
    const ebit = ebitda - depreciationThisYear

    // NOL carryforward: losses accumulate into nolBalance and shield future taxable income
    let taxableEbit = ebit
    if (ebit < 0) {
      nolBalance += -ebit
      taxableEbit = 0
    } else if (nolBalance > 0) {
      const nolUsed = Math.min(ebit, nolBalance)
      nolBalance -= nolUsed
      taxableEbit = ebit - nolUsed
    }
    const tax = taxableEbit * (taxRate / 100)

    const cashflow =
      revenue -
      opexResult.total -
      pcsResult.pcsReplacementCost -
      tax +
      residualValueNominal

    const df = Math.pow(1 + waccDecimal, y)
    const discountedCashflow = cashflow / df
    cumulativeDiscounted += discountedCashflow

    rows.push({
      year: y,
      revenue,
      fixedOM: opexResult.fixedOM,
      variableOM: opexResult.variableOM,
      insurance: opexResult.insurance,
      landLease: opexResult.landLease,
      gridFees: opexResult.gridFees,
      opex: opexResult.total,
      pcsReplacement: pcsResult.pcsReplacementCost,
      capex: 0,
      residualValue: residualValueNominal,
      ebitda,
      depreciation: depreciationThisYear,
      ebit,
      nolCarryforward: nolBalance,
      tax,
      cashflow,
      discountFactor: 1 / df,
      discountedCashflow,
      cumulativeDiscountedCashflow: cumulativeDiscounted,
    })
  }

  return rows
}

export type FinancialResults = {
  capex: CapexBreakdown
  cashflow: CashflowRow[]
  totalRevenueNominal: number
  totalThroughputMWh: number
  npv: number
  irr: number | null
  simplePaybackYears: number | null
  discountedPaybackYears: number | null
  lcos: number
}

function computeIrr(cashflows: number[], initialGuess: number): number | null {
  // Check for sign change
  const hasPositive = cashflows.some((c) => c > 0)
  const hasNegative = cashflows.some((c) => c < 0)
  if (!hasPositive || !hasNegative) return null

  let r = initialGuess
  const MAX_ITER = 50
  const TOL = 1e-7

  for (let i = 0; i < MAX_ITER; i++) {
    let npv = 0
    let dnpv = 0
    for (let t = 0; t < cashflows.length; t++) {
      const cf = cashflows[t] ?? 0
      const denom = Math.pow(1 + r, t)
      npv += cf / denom
      if (t > 0) {
        dnpv -= (t * cf) / Math.pow(1 + r, t + 1)
      }
    }
    if (Math.abs(dnpv) < 1e-10) return null
    const rNew = r - npv / dnpv
    if (Math.abs(rNew - r) < TOL) return rNew
    r = rNew
  }

  return null
}

function computeSimplePayback(cashflows: number[]): number | null {
  let cumulative = 0
  for (let t = 0; t < cashflows.length; t++) {
    const cf = cashflows[t] ?? 0
    const prevCumulative = cumulative
    cumulative += cf
    if (cumulative >= 0 && t > 0) {
      // Linear interpolation
      const fraction = -prevCumulative / cf
      return (t - 1) + fraction
    }
  }
  return null
}

export function computeFinancials(inputs: Inputs, streams: AnnualStream[]): FinancialResults {
  const capex = computeCapex(inputs)
  const cashflow = buildCashflow(inputs, streams)

  const operatingRows = cashflow.filter((r) => r.year > 0)
  const totalRevenueNominal = operatingRows.reduce((s, r) => s + r.revenue, 0)
  const totalThroughputMWh = streams.reduce((s, st) => s + st.throughputMWh, 0)

  const npv = cashflow[cashflow.length - 1]?.cumulativeDiscountedCashflow ?? 0

  const rawCashflows = cashflow.map((r) => r.cashflow)
  const irr = computeIrr(rawCashflows, inputs.finance.wacc / 100)

  // Simple payback on cumulative undiscounted cashflows
  const undiscountedCumulative: number[] = []
  let cumUndiscounted = 0
  for (const row of cashflow) {
    cumUndiscounted += row.cashflow
    undiscountedCumulative.push(cumUndiscounted)
  }

  let simplePaybackYears: number | null = null
  for (let t = 1; t < undiscountedCumulative.length; t++) {
    const prev = undiscountedCumulative[t - 1] ?? 0
    const curr = undiscountedCumulative[t] ?? 0
    if (prev < 0 && curr >= 0) {
      const cf = cashflow[t]?.cashflow ?? 0
      const fraction = cf !== 0 ? -prev / cf : 0
      simplePaybackYears = (t - 1) + fraction
      break
    }
  }

  let discountedPaybackYears: number | null = null
  for (let t = 1; t < cashflow.length; t++) {
    const prev = cashflow[t - 1]?.cumulativeDiscountedCashflow ?? 0
    const curr = cashflow[t]?.cumulativeDiscountedCashflow ?? 0
    if (prev < 0 && curr >= 0) {
      const dcf = cashflow[t]?.discountedCashflow ?? 0
      const fraction = dcf !== 0 ? -prev / dcf : 0
      discountedPaybackYears = (t - 1) + fraction
      break
    }
  }

  // LCOS: NPV_costs / NPV_energy
  const waccDecimal = inputs.finance.wacc / 100
  const { projectLifeYears } = inputs.finance

  let npvCosts = capex.total // year 0 cost, discounted at factor 1
  let npvEnergy = 0

  for (let y = 1; y <= projectLifeYears; y++) {
    const row = cashflow.find((r) => r.year === y)
    if (!row) continue
    const discountFactor = Math.pow(1 + waccDecimal, y)

    const isFinalYear = y === projectLifeYears
    const costY = row.opex + row.pcsReplacement - (isFinalYear ? row.residualValue : 0)
    npvCosts += costY / discountFactor

    const stream = streams.find((s) => s.year === y)
    const throughput = stream?.throughputMWh ?? 0
    npvEnergy += throughput / discountFactor
  }

  const lcos = npvEnergy > 0 ? npvCosts / npvEnergy : 0

  return {
    capex,
    cashflow,
    totalRevenueNominal,
    totalThroughputMWh,
    npv,
    irr,
    simplePaybackYears,
    discountedPaybackYears,
    lcos,
  }
}
