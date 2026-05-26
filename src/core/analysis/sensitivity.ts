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
  isPositiveCorrelation: boolean // Added directionality signature
}

export type SensitivityResult = {
  metric: 'npv' | 'irr' | 'lcos'
  base: SimulationOutcome
  rows: SensitivityRow[]
}

// ---------------------------------------------------------------------------
// Default variables (Updated to execute global multi-year adjustments)
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
    key: 'costs.pcsCapex',
    label: 'PCS CAPEX (€)',
    basePath: 'costs.pcsCapex',
    sweep: { kind: 'multiplicative', lowFactor: 0.7, highFactor: 1.3 },
  },
  {
    key: 'costs.fixedOmPerYear',
    label: 'Fixed O&M (€/yr)',
    basePath: 'costs.fixedOmPerYear',
    sweep: { kind: 'multiplicative', lowFactor: 0.5, highFactor: 1.5 },
  },
  {
    key: 'finance.wacc',
    label: 'WACC (%)',
    basePath: 'finance.wacc',
    sweep: { kind: 'additive', lowDelta: -2, highDelta: 2 },
  },
  {
    key: 'scenario.allYears.meanLevelMultiplier',
    label: 'Price Level (Global Mean)',
    basePath: 'scenario.allYears.meanLevelMultiplier',
    sweep: { kind: 'multiplicative', lowFactor: 0.8, highFactor: 1.2 },
  },
  {
    key: 'scenario.allYears.spreadMultiplier',
    label: 'Price Spread (Global Volatility)',
    basePath: 'scenario.allYears.spreadMultiplier',
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
    const next = (cur as Record<string, unknown>)[p]
    // Performance: Create shallow field step copies only when mutation is necessary
    const clonedNext = Array.isArray(next) ? [...next] : typeof next === 'object' && next !== null ? { ...next } : {}
    ;(cur as Record<string, unknown>)[p] = clonedNext
    cur = clonedNext
  }
  const last = parts[parts.length - 1]!
  if (cur !== null && typeof cur === 'object') {
    ;(cur as Record<string, unknown>)[last] = value
  }
}

// ---------------------------------------------------------------------------
// Path resolution supporting explicit target indices and universal wildcards
// ---------------------------------------------------------------------------

type PathResolution = { isScenario: boolean; isWildcard: boolean; subPaths: string[] }

function resolveScenarioPath(basePath: string): PathResolution {
  const wildcardMatch = basePath.match(/^scenario\.allYears\.(.+)$/)
  if (wildcardMatch) {
    return { isScenario: true, isWildcard: true, subPaths: [wildcardMatch[1]!] }
  }

  const explicitMatch = basePath.match(/^scenario\.year(\d+)\.(.+)$/)
  if (explicitMatch) {
    const yearIdx = parseInt(explicitMatch[1]!, 10) - 1
    return { isScenario: true, isWildcard: false, subPaths: [`years.${yearIdx}.${explicitMatch[2]}`] }
  }

  return { isScenario: false, isWildcard: false, subPaths: [] }
}

// ---------------------------------------------------------------------------
// Compute base value for a sweep variable
// ---------------------------------------------------------------------------

function getBaseValue(req: SimulationRequest, variable: SensitivityVariable): number {
  const res = resolveScenarioPath(variable.basePath)
  if (res.isScenario) {
    if (res.isWildcard) {
      // Return parameters extracted from structural index zero as base comparison representation
      const target = req.scenario?.years?.[0]
      if (!target) return 1.0
      const val = target[res.subPaths[0] as keyof typeof target]
      return typeof val === 'number' ? val : 1.0
    }
    const existing = getNestedValue(req.scenario, res.subPaths[0]!)
    return existing !== 0 ? existing : 1.0
  }
  return getNestedValue(req.inputs, variable.basePath)
}

// ---------------------------------------------------------------------------
// Optimized Apply Value (Eliminated slow JSON string parsing)
// ---------------------------------------------------------------------------

function applyValue(
  req: SimulationRequest,
  variable: SensitivityVariable,
  value: number,
): SimulationRequest {
  const res = resolveScenarioPath(variable.basePath)

  if (res.isScenario) {
    // Shallow copy root layout structure safely
    const clonedScenario = { ...req.scenario, years: req.scenario.years.map(y => ({ ...y })) }
    
    if (res.isWildcard) {
      const fieldKey = res.subPaths[0]!
      for (const year of clonedScenario.years) {
        (year as Record<string, unknown>)[fieldKey] = value
      }
    } else {
      setNestedValue(clonedScenario, res.subPaths[0]!, value)
    }
    return { ...req, scenario: clonedScenario }
  }

  // Shallow copy core parameters reference fields without touching deep profile data logs
  const clonedInputs = { ...req.inputs, battery: { ...req.inputs.battery }, costs: { ...req.inputs.costs }, finance: { ...req.inputs.finance } }
  setNestedValue(clonedInputs, variable.basePath, value)
  
  return { ...req, inputs: clonedInputs }
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
  return { lowValue: sweep.low, highValue: sweep.high }
}

export function extractMetric(outcome: SimulationOutcome, metric: 'npv' | 'irr' | 'lcos'): number {
  switch (metric) {
    case 'npv':
      // NPV is a perfectly linear real number. Return exactly as-is.
      return outcome.npv;

    case 'lcos':
      // Protect against dividing by zero or negative throughput scenarios.
      // If LCOS is missing, zero, or negative, return a clean infinity flag or 0 to protect the UI scale.
      if (outcome.lcos === null || outcome.lcos <= 0 || isNaN(outcome.lcos)) {
        return 0; 
      }
      return outcome.lcos;

    case 'irr':
      // Catch instances where the IRR solver diverged or failed to converge cleanly
      if (outcome.irr === null || isNaN(outcome.irr)) {
        return -100.0; // Enforce the true corporate financial floor (Lose 100% of capital)
      }
      
      const irrPercentage = outcome.irr * 100;
      
      // Stop unconstrained mathematical polynomial roots from exploding your UI scales
      if (irrPercentage < -100.0) return -100.0;
      if (irrPercentage > 1000.0) return 1000.0; // Prevent upward solver runaway loops
      
      return irrPercentage;

    default:
      void (metric as never)
      return 0;
  }
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
    // Positive correlation means increasing the parameter improves the financial returns metric
    const isPositiveCorrelation = metricAtHigh >= metricAtLow

    return {
      variable,
      low: { value: lowValue, outcome: lowOutcome },
      high: { value: highValue, outcome: highOutcome },
      metricAtBase,
      metricAtLow,
      metricAtHigh,
      range,
      isPositiveCorrelation,
    }
  })

  rows.sort((a, b) => b.range - a.range)

  return { metric, base, rows }
}

// ---------------------------------------------------------------------------
// Activation threshold sweep
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

    const clonedInputs = { ...req.inputs, battery: { ...req.inputs.battery, activationThreshold: threshold } }
    const swept = { ...req, inputs: clonedInputs }
    outcomes.push(runSingle(swept))
  }

  return { values, outcomes }
}

// ---------------------------------------------------------------------------
// Variable drill-down sweep
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