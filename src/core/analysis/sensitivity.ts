import type { SimulationRequest, SimulationOutcome } from './run'
import { runSingle } from './run'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SensitivityVariable = {
  key: string
  label: string
  basePath: string
  sweep:
    | { kind: 'multiplicative'; lowFactor: number; highFactor: number }
    | { kind: 'additive'; lowDelta: number; highDelta: number }
    | { kind: 'absolute'; low: number; high: number }
}

export type SensitivityRow = {
  variable: SensitivityVariable
  low: { value: number; outcome: SimulationOutcome }
  high: { value: number; outcome: SimulationOutcome }
  metricAtBase: number
  metricAtLow: number
  metricAtHigh: number
  range: number
}

export type SensitivityResult = {
  metric: 'npv' | 'irr' | 'lcos'
  base: SimulationOutcome
  rows: SensitivityRow[]
}

// ---------------------------------------------------------------------------
// Default variables
// ---------------------------------------------------------------------------

export const DEFAULT_SENSITIVITY_VARIABLES: SensitivityVariable[] = [
  {
    key: 'battery.powerMW',
    label: 'Power (MW)',
    basePath: 'battery.powerMW',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'battery.energyMWh',
    label: 'Energy (MWh)',
    basePath: 'battery.energyMWh',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'battery.roundTripEfficiency',
    label: 'Round-trip Efficiency',
    basePath: 'battery.roundTripEfficiency',
    sweep: { kind: 'multiplicative', lowFactor: 0.9, highFactor: 1.1 },
  },
  {
    key: 'battery.nominalCycleLifeEFC',
    label: 'Cycle Life (EFC)',
    basePath: 'battery.nominalCycleLifeEFC',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'battery.calendarLifeYears',
    label: 'Calendar Life (yr)',
    basePath: 'battery.calendarLifeYears',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'costs.batteryCapexPerKWh',
    label: 'Battery CAPEX (€/kWh)',
    basePath: 'costs.batteryCapexPerKWh',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'costs.pcsCapexPerKW',
    label: 'PCS CAPEX (€/kW)',
    basePath: 'costs.pcsCapexPerKW',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'costs.fixedOmPerKWPerYear',
    label: 'Fixed O&M (€/kW/yr)',
    basePath: 'costs.fixedOmPerKWPerYear',
    sweep: { kind: 'multiplicative', lowFactor: 0.5, highFactor: 1.5 },
  },
  {
    key: 'finance.wacc',
    label: 'WACC (%)',
    basePath: 'finance.wacc',
    sweep: { kind: 'additive', lowDelta: -2, highDelta: 2 },
  },
  {
    key: 'scenario.year1.meanLevelMultiplier',
    label: 'Price Level (mean mult.)',
    basePath: 'scenario.year1.meanLevelMultiplier',
    sweep: { kind: 'multiplicative', lowFactor: 0.8, highFactor: 1.2 },
  },
  {
    key: 'scenario.year1.spreadMultiplier',
    label: 'Price Spread (volatility)',
    basePath: 'scenario.year1.spreadMultiplier',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
]

// ---------------------------------------------------------------------------
// Dot-path helpers
// ---------------------------------------------------------------------------

function getNestedValue(obj: unknown, path: string): number {
  const parts = path.split('.')
  let cur: unknown = obj
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return 0
    cur = (cur as Record<string, unknown>)[p]
  }
  return typeof cur === 'number' ? cur : 0
}

function setNestedValue(obj: unknown, path: string, value: number): void {
  const parts = path.split('.')
  let cur: unknown = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!
    if (cur === null || typeof cur !== 'object') return
    cur = (cur as Record<string, unknown>)[p]
  }
  const last = parts[parts.length - 1]!
  if (cur !== null && typeof cur === 'object') {
    ;(cur as Record<string, unknown>)[last] = value
  }
}

// ---------------------------------------------------------------------------
// Path resolution: "scenario.year1.xxx" → scenario.years[0].xxx
// ---------------------------------------------------------------------------

function resolveScenarioPath(basePath: string): { isScenario: boolean; scenarioSubPath: string } {
  const match = basePath.match(/^scenario\.year(\d+)\.(.+)$/)
  if (match) {
    const yearIdx = parseInt(match[1]!, 10) - 1  // "year1" → index 0
    return { isScenario: true, scenarioSubPath: `years.${yearIdx}.${match[2]}` }
  }
  return { isScenario: false, scenarioSubPath: '' }
}

// ---------------------------------------------------------------------------
// Compute base value for a sweep variable
// ---------------------------------------------------------------------------

function getBaseValue(req: SimulationRequest, variable: SensitivityVariable): number {
  const { isScenario, scenarioSubPath } = resolveScenarioPath(variable.basePath)
  if (isScenario) {
    // For scenario multipliers, base is 1.0 (the identity multiplier)
    const existing = getNestedValue(req.scenario, scenarioSubPath)
    return existing !== 0 ? existing : 1.0
  }
  return getNestedValue(req.inputs, variable.basePath)
}

// ---------------------------------------------------------------------------
// Apply a swept value to a cloned request
// ---------------------------------------------------------------------------

function applyValue(
  req: SimulationRequest,
  variable: SensitivityVariable,
  value: number,
): SimulationRequest {
  const clonedInputs = JSON.parse(JSON.stringify(req.inputs)) as typeof req.inputs
  const clonedScenario = JSON.parse(JSON.stringify(req.scenario)) as typeof req.scenario

  const { isScenario, scenarioSubPath } = resolveScenarioPath(variable.basePath)

  if (isScenario) {
    setNestedValue(clonedScenario, scenarioSubPath, value)
  } else {
    setNestedValue(clonedInputs, variable.basePath, value)
  }

  return { ...req, inputs: clonedInputs, scenario: clonedScenario }
}

// ---------------------------------------------------------------------------
// Compute swept low/high values from base
// ---------------------------------------------------------------------------

function computeSweepValues(
  baseValue: number,
  sweep: SensitivityVariable['sweep'],
): { lowValue: number; highValue: number } {
  if (sweep.kind === 'multiplicative') {
    return {
      lowValue: baseValue * sweep.lowFactor,
      highValue: baseValue * sweep.highFactor,
    }
  }
  if (sweep.kind === 'additive') {
    return {
      lowValue: baseValue + sweep.lowDelta,
      highValue: baseValue + sweep.highDelta,
    }
  }
  // absolute
  return { lowValue: sweep.low, highValue: sweep.high }
}

// ---------------------------------------------------------------------------
// Extract metric from outcome
// ---------------------------------------------------------------------------

export function extractMetric(outcome: SimulationOutcome, metric: 'npv' | 'irr' | 'lcos'): number {
  if (metric === 'npv') return outcome.npv
  if (metric === 'lcos') return outcome.lcos
  // IRR: null → 0
  return outcome.irr !== null ? outcome.irr * 100 : 0
}

// ---------------------------------------------------------------------------
// Main sensitivity runner
// ---------------------------------------------------------------------------

export function runSensitivity(
  req: SimulationRequest,
  variables: SensitivityVariable[],
  metric: 'npv' | 'irr' | 'lcos',
): SensitivityResult {
  const base = runSingle(req)
  const metricAtBase = extractMetric(base, metric)

  const rows: SensitivityRow[] = variables.map((variable) => {
    const baseValue = getBaseValue(req, variable)
    const { lowValue, highValue } = computeSweepValues(baseValue, variable.sweep)

    const lowReq = applyValue(req, variable, lowValue)
    const highReq = applyValue(req, variable, highValue)

    const lowOutcome = runSingle(lowReq)
    const highOutcome = runSingle(highReq)

    const metricAtLow = extractMetric(lowOutcome, metric)
    const metricAtHigh = extractMetric(highOutcome, metric)
    const range = Math.abs(metricAtHigh - metricAtLow)

    return {
      variable,
      low: { value: lowValue, outcome: lowOutcome },
      high: { value: highValue, outcome: highOutcome },
      metricAtBase,
      metricAtLow,
      metricAtHigh,
      range,
    }
  })

  // Sort by range descending
  rows.sort((a, b) => b.range - a.range)

  return { metric, base, rows }
}

// ---------------------------------------------------------------------------
// Activation threshold sweep (separate from tornado)
// ---------------------------------------------------------------------------

export function runActivationSweep(
  req: SimulationRequest,
  _metric: 'npv' | 'irr' | 'lcos',
  points = 11,
): { values: number[]; outcomes: SimulationOutcome[] } {
  const low = 0.6
  const high = 2.0
  const values: number[] = []
  const outcomes: SimulationOutcome[] = []

  for (let i = 0; i < points; i++) {
    const t = points > 1 ? i / (points - 1) : 0
    const threshold = low + t * (high - low)
    values.push(threshold)

    const clonedInputs = JSON.parse(JSON.stringify(req.inputs)) as typeof req.inputs
    clonedInputs.battery.activationThreshold = threshold
    const swept = { ...req, inputs: clonedInputs }
    outcomes.push(runSingle(swept))
  }

  return { values, outcomes }
}

// ---------------------------------------------------------------------------
// Variable drill-down sweep (11 evenly-spaced points between low and high)
// ---------------------------------------------------------------------------

export function runVariableSweep(
  req: SimulationRequest,
  variable: SensitivityVariable,
  _metric: 'npv' | 'irr' | 'lcos',
  points = 11,
): { values: number[]; outcomes: SimulationOutcome[] } {
  const baseValue = getBaseValue(req, variable)
  const { lowValue, highValue } = computeSweepValues(baseValue, variable.sweep)

  const values: number[] = []
  const outcomes: SimulationOutcome[] = []

  for (let i = 0; i < points; i++) {
    const t = points > 1 ? i / (points - 1) : 0
    const v = lowValue + t * (highValue - lowValue)
    values.push(v)
    outcomes.push(runSingle(applyValue(req, variable, v)))
  }

  return { values, outcomes }
}
