import { makePrng, makeNormalPrng } from '../forecast/prng'
import type { SimulationRequest, SimulationOutcome } from './run'
import { runSingle } from './run'

// ---------------------------------------------------------------------------
// Distribution types
// ---------------------------------------------------------------------------

export type MCDistribution =
  | { kind: 'fixed'; value: number }
  | { kind: 'uniform'; low: number; high: number }
  | { kind: 'triangular'; low: number; mode: number; high: number }
  | { kind: 'normal'; mean: number; stddev: number; clipLow?: number; clipHigh?: number }
  | { kind: 'lognormal'; meanLog: number; sigmaLog: number; clipLow?: number; clipHigh?: number }
  | { kind: 'discrete'; values: number[]; weights: number[] }

export type MCVariableConfig = {
  key: string
  label: string
  distribution: MCDistribution
}

export type MCCorrelation = {
  varA: string
  varB: string
  rho: number
}

export type MCRequest = {
  base: SimulationRequest
  variables: MCVariableConfig[]
  correlations: MCCorrelation[]
  trials: number
  rngSeed: number
}

export type MCResult = {
  outcomes: SimulationOutcome[]
  sampledInputs: Array<Record<string, number>>
  summary: {
    npv: { mean: number; std: number; p10: number; p50: number; p90: number; min: number; max: number }
    irr: { p10: number | null; p50: number | null; p90: number | null; pPositive: number }
    lcos: { mean: number; p10: number; p50: number; p90: number }
    pNpvPositive: number
    pRetiresEarly: number
  }
  convergence: { trialsTo90PctStable: number | null }
}

// ---------------------------------------------------------------------------
// Normal inverse CDF (Peter Acklam's rational approximation)
// ---------------------------------------------------------------------------

function normalInverseCDF(p: number): number {
  // Clamp to avoid infinities
  const pClamped = Math.max(1e-10, Math.min(1 - 1e-10, p))

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]

  const pLow = 0.02425
  const pHigh = 1 - pLow

  let q: number
  let r: number

  if (pClamped < pLow) {
    q = Math.sqrt(-2 * Math.log(pClamped))
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
           ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  } else if (pClamped <= pHigh) {
    q = pClamped - 0.5
    r = q * q
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q /
           (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  } else {
    q = Math.sqrt(-2 * Math.log(1 - pClamped))
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
             ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  }
}

// Standard normal CDF (approximation)
function normalCDF(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2))
}

function erf(x: number): number {
  // Abramowitz & Stegun approximation
  const sign = x >= 0 ? 1 : -1
  x = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * x)
  const y = 1 - (0.254829592 * t - 0.284496736 * t * t + 1.421413741 * t * t * t
             - 1.453152027 * t * t * t * t + 1.061405429 * t * t * t * t * t) * Math.exp(-x * x)
  return sign * y
}

// ---------------------------------------------------------------------------
// Distribution sampler (takes uniform [0,1] and normal N(0,1) sources)
// ---------------------------------------------------------------------------

export function sampleDistribution(
  dist: MCDistribution,
  uniform: () => number,
  _normal: () => number,
): number {
  switch (dist.kind) {
    case 'fixed':
      return dist.value

    case 'uniform':
      return dist.low + uniform() * (dist.high - dist.low)

    case 'triangular': {
      const u = uniform()
      const { low, mode, high } = dist
      const fc = (mode - low) / (high - low)
      let x: number
      if (u < fc) {
        x = low + Math.sqrt(u * (high - low) * (mode - low))
      } else {
        x = high - Math.sqrt((1 - u) * (high - low) * (high - mode))
      }
      return x
    }

    case 'normal': {
      // Use inverse CDF approach with the passed uniform
      const u = uniform()
      const z = normalInverseCDF(u)
      const raw = dist.mean + dist.stddev * z
      let result = raw
      if (dist.clipLow !== undefined) result = Math.max(dist.clipLow, result)
      if (dist.clipHigh !== undefined) result = Math.min(dist.clipHigh, result)
      return result
    }

    case 'lognormal': {
      const u = uniform()
      const z = normalInverseCDF(u)
      const raw = Math.exp(dist.meanLog + dist.sigmaLog * z)
      let result = raw
      if (dist.clipLow !== undefined) result = Math.max(dist.clipLow, result)
      if (dist.clipHigh !== undefined) result = Math.min(dist.clipHigh, result)
      return result
    }

    case 'discrete': {
      const { values, weights } = dist
      const totalWeight = weights.reduce((s, w) => s + w, 0)
      const u = uniform() * totalWeight
      let cumulative = 0
      for (let i = 0; i < values.length; i++) {
        cumulative += weights[i]!
        if (u <= cumulative) return values[i]!
      }
      return values[values.length - 1]!
    }
  }
}

// ---------------------------------------------------------------------------
// Cholesky decomposition (lower triangular, in-place on rows of L)
// ---------------------------------------------------------------------------

function cholesky(matrix: number[][]): number[][] {
  const n = matrix.length
  const L: number[][] = Array.from({ length: n }, () => new Array(n).fill(0) as number[])

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = matrix[i]![j]!
      for (let k = 0; k < j; k++) {
        sum -= L[i]![k]! * L[j]![k]!
      }
      if (i === j) {
        L[i]![j] = Math.sqrt(Math.max(0, sum))  // clamp small negatives
      } else {
        L[i]![j] = L[j]![j]! > 1e-12 ? sum / L[j]![j]! : 0
      }
    }
  }
  return L
}

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
}

// ---------------------------------------------------------------------------
// Apply a sampled variable set to a cloned request
// ---------------------------------------------------------------------------

function applyMCSample(
  base: SimulationRequest,
  variables: MCVariableConfig[],
  sample: number[],
): SimulationRequest {
  const clonedInputs = JSON.parse(JSON.stringify(base.inputs)) as typeof base.inputs
  const clonedScenario = JSON.parse(JSON.stringify(base.scenario)) as typeof base.scenario

  for (let i = 0; i < variables.length; i++) {
    const v = variables[i]!
    const value = sample[i]!

    // Resolve scenario.yearN.xxx paths
    const match = v.key.match(/^scenario\.year(\d+)\.(.+)$/)
    if (match) {
      const yearIdx = parseInt(match[1]!, 10) - 1
      const field = match[2]!
      const year = clonedScenario.years[yearIdx]
      if (year) {
        ;(year as Record<string, unknown>)[field] = value
      }
    } else {
      // Navigate inputs dot-path
      const parts = v.key.split('.')
      let cur: unknown = clonedInputs
      for (let k = 0; k < parts.length - 1; k++) {
        if (cur !== null && typeof cur === 'object') {
          cur = (cur as Record<string, unknown>)[parts[k]!]
        }
      }
      const last = parts[parts.length - 1]!
      if (cur !== null && typeof cur === 'object') {
        ;(cur as Record<string, unknown>)[last] = value
      }
    }
  }

  // Use a deterministic seed derived from the base seed + trial index (passed via rngSeed)
  return { ...base, inputs: clonedInputs, scenario: clonedScenario }
}

// ---------------------------------------------------------------------------
// Convergence check: find trial index where running mean of NPV stabilises
// ---------------------------------------------------------------------------

function findConvergence(npvValues: number[]): number | null {
  if (npvValues.length < 600) return null
  const finalMean = npvValues.reduce((s, v) => s + v, 0) / npvValues.length
  const threshold = Math.abs(finalMean) * 0.02 + 1  // 2% of final mean, min €1
  const lookAhead = 500

  let runningSum = 0
  for (let t = 0; t < npvValues.length; t++) {
    runningSum += npvValues[t]!
    if (t + lookAhead < npvValues.length) {
      let stable = true
      let futureSum = runningSum
      for (let k = t + 1; k <= t + lookAhead; k++) {
        futureSum += npvValues[k]!
        const futureMean = futureSum / (k + 1)
        if (Math.abs(futureMean - finalMean) > threshold) {
          stable = false
          break
        }
      }
      if (stable) return t + 1
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Main Monte Carlo runner
// ---------------------------------------------------------------------------

export function runMonteCarlo(
  req: MCRequest,
  onProgress?: (completed: number, total: number) => void,
): MCResult {
  const { base, variables, correlations, trials, rngSeed } = req
  const n = variables.length

  const uniform = makePrng(rngSeed)
  const _normal = makeNormalPrng(uniform)

  // Build correlation matrix and Cholesky factor if correlations are specified
  let choleskyL: number[][] | null = null
  if (correlations.length > 0 && n > 0) {
    const R: number[][] = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)),
    )
    for (const corr of correlations) {
      const idxA = variables.findIndex((v) => v.key === corr.varA)
      const idxB = variables.findIndex((v) => v.key === corr.varB)
      if (idxA >= 0 && idxB >= 0) {
        R[idxA]![idxB] = corr.rho
        R[idxB]![idxA] = corr.rho
      }
    }
    choleskyL = cholesky(R)
  }

  const outcomes: SimulationOutcome[] = []
  const sampledInputs: Array<Record<string, number>> = []

  for (let t = 0; t < trials; t++) {
    // Generate uniform samples (possibly correlated via NORTA)
    let uniforms: number[]

    if (choleskyL !== null && n > 0) {
      // Generate n independent standard normals
      const Z: number[] = Array.from({ length: n }, () => _normal())
      // Correlate: X = L · Z
      const X: number[] = Array.from({ length: n }, (_, i) => {
        let s = 0
        for (let j = 0; j <= i; j++) {
          s += choleskyL![i]![j]! * Z[j]!
        }
        return s
      })
      // Transform to uniform via normal CDF (NORTA)
      uniforms = X.map((x) => normalCDF(x))
    } else {
      uniforms = Array.from({ length: n }, () => uniform())
    }

    // Sample each distribution at its quantile
    const sample: number[] = variables.map((v, i) => {
      // Create a uniform source that returns the pre-computed quantile
      const u = uniforms[i]!
      const uniformSource = (() => {
        let used = false
        return () => {
          if (!used) { used = true; return u }
          return uniform()  // fallback for distributions needing more randoms
        }
      })()
      return sampleDistribution(v.distribution, uniformSource, _normal)
    })

    const sampledRecord: Record<string, number> = {}
    variables.forEach((v, i) => { sampledRecord[v.key] = sample[i]! })
    sampledInputs.push(sampledRecord)

    // Use a trial-specific seed offset for the price forecast randomness
    const trialReq = applyMCSample({ ...base, rngSeed: base.rngSeed + t + 1 }, variables, sample)
    outcomes.push(runSingle(trialReq))

    // Progress callback every 100 trials
    if (onProgress && (t + 1) % 100 === 0) {
      onProgress(t + 1, trials)
    }
  }

  // Final progress notification
  if (onProgress && trials % 100 !== 0) {
    onProgress(trials, trials)
  }

  // ---------------------------------------------------------------------------
  // Summary statistics
  // ---------------------------------------------------------------------------

  const npvValues = outcomes.map((o) => o.npv)
  const irrValues = outcomes.map((o) => o.irr)
  const lcosValues = outcomes.map((o) => o.lcos)

  const npvSorted = [...npvValues].sort((a, b) => a - b)
  const lcosSorted = [...lcosValues].sort((a, b) => a - b)

  const npvMean = npvValues.reduce((s, v) => s + v, 0) / trials
  const npvVariance = npvValues.reduce((s, v) => s + (v - npvMean) ** 2, 0) / trials
  const npvStd = Math.sqrt(npvVariance)

  const irrNonNull = irrValues.filter((v): v is number => v !== null).sort((a, b) => a - b)
  const irrP10 = irrNonNull.length > 0 ? percentile(irrNonNull, 0.1) * 100 : null
  const irrP50 = irrNonNull.length > 0 ? percentile(irrNonNull, 0.5) * 100 : null
  const irrP90 = irrNonNull.length > 0 ? percentile(irrNonNull, 0.9) * 100 : null
  const pPositive = irrNonNull.filter((v) => v > 0).length / trials

  const pNpvPositive = npvValues.filter((v) => v > 0).length / trials
  const pRetiresEarly = outcomes.filter((o) => o.retiredAtYear !== null).length / trials

  const convergence = findConvergence(npvValues)

  return {
    outcomes,
    sampledInputs,
    summary: {
      npv: {
        mean: npvMean,
        std: npvStd,
        p10: percentile(npvSorted, 0.1),
        p50: percentile(npvSorted, 0.5),
        p90: percentile(npvSorted, 0.9),
        min: npvSorted[0] ?? 0,
        max: npvSorted[npvSorted.length - 1] ?? 0,
      },
      irr: { p10: irrP10, p50: irrP50, p90: irrP90, pPositive },
      lcos: {
        mean: lcosValues.reduce((s, v) => s + v, 0) / trials,
        p10: percentile(lcosSorted, 0.1),
        p50: percentile(lcosSorted, 0.5),
        p90: percentile(lcosSorted, 0.9),
      },
      pNpvPositive,
      pRetiresEarly,
    },
    convergence: { trialsTo90PctStable: convergence },
  }
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function DEFAULT_MC_VARIABLES(base: SimulationRequest): MCVariableConfig[] {
  const b = base.inputs
  return [
    {
      key: 'costs.batteryCapexPerKWh',
      label: 'Battery CAPEX',
      distribution: {
        kind: 'normal',
        mean: b.costs.batteryCapexPerKWh,
        stddev: b.costs.batteryCapexPerKWh * 0.15,
        clipLow: b.costs.batteryCapexPerKWh * 0.5,
      },
    },
    {
      key: 'costs.pcsCapexPerKW',
      label: 'PCS CAPEX',
      distribution: {
        kind: 'normal',
        mean: b.costs.pcsCapexPerKW,
        stddev: b.costs.pcsCapexPerKW * 0.10,
      },
    },
    {
      key: 'battery.nominalCycleLifeEFC',
      label: 'Cycle Life EFC',
      distribution: {
        kind: 'triangular',
        low: b.battery.nominalCycleLifeEFC * 0.7,
        mode: b.battery.nominalCycleLifeEFC,
        high: b.battery.nominalCycleLifeEFC * 1.3,
      },
    },
    {
      key: 'battery.calendarLifeYears',
      label: 'Calendar Life',
      distribution: {
        kind: 'triangular',
        low: b.battery.calendarLifeYears * 0.8,
        mode: b.battery.calendarLifeYears,
        high: b.battery.calendarLifeYears * 1.2,
      },
    },
    {
      key: 'battery.roundTripEfficiency',
      label: 'Round-trip Efficiency',
      distribution: {
        kind: 'normal',
        mean: b.battery.roundTripEfficiency,
        stddev: 0.02,
        clipLow: 0.7,
        clipHigh: 0.95,
      },
    },
    {
      key: 'finance.wacc',
      label: 'WACC',
      distribution: {
        kind: 'normal',
        mean: b.finance.wacc,
        stddev: 1.0,
        clipLow: 2,
        clipHigh: 12,
      },
    },
    {
      key: 'scenario.year1.meanLevelMultiplier',
      label: 'Price Level Mult.',
      distribution: { kind: 'lognormal', meanLog: 0, sigmaLog: 0.15 },
    },
    {
      key: 'scenario.year1.spreadMultiplier',
      label: 'Price Spread Mult.',
      distribution: { kind: 'lognormal', meanLog: 0, sigmaLog: 0.20 },
    },
  ]
}

export const DEFAULT_MC_CORRELATIONS: MCCorrelation[] = [
  { varA: 'costs.batteryCapexPerKWh', varB: 'costs.pcsCapexPerKW', rho: 0.5 },
  { varA: 'scenario.year1.meanLevelMultiplier', varB: 'scenario.year1.spreadMultiplier', rho: 0.3 },
]

// ---------------------------------------------------------------------------
// Histogram helper (exported for UI use)
// ---------------------------------------------------------------------------

export function histogram(values: number[], bins = 30): { x: number[]; counts: number[] } {
  if (values.length === 0) return { x: [], counts: [] }
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return { x: [min], counts: [values.length] }

  const binWidth = (max - min) / bins
  const counts = new Array(bins).fill(0) as number[]
  const x: number[] = Array.from({ length: bins }, (_, i) => min + (i + 0.5) * binWidth)

  for (const v of values) {
    const idx = Math.min(Math.floor((v - min) / binWidth), bins - 1)
    counts[idx]!++
  }

  return { x, counts }
}

// Re-export extractMetric so UI can use it
export { extractMetric } from './sensitivity'
