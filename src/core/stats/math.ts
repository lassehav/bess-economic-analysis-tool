/** Sort array ascending (returns a new array). */
export function sortedAsc(arr: number[]): number[] {
  return [...arr].sort((a, b) => a - b)
}

/** Linear-interpolation percentile on a sorted array. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]!
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  const frac = idx - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}

/** Population mean. */
export function mean(arr: number[]): number {
  if (arr.length === 0) return NaN
  return arr.reduce((s, x) => s + x, 0) / arr.length
}

/** Population standard deviation. */
export function stddev(arr: number[]): number {
  if (arr.length === 0) return NaN
  const m = mean(arr)
  const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length
  return Math.sqrt(variance)
}

/** Bias-corrected skewness: n/((n-1)(n-2)) × Σ((x-μ)/σ)^3 */
export function skewness(arr: number[]): number {
  const n = arr.length
  if (n < 3) return NaN
  const m = mean(arr)
  const s = stddev(arr)
  if (s === 0) return 0
  const sumCubed = arr.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0)
  return (n / ((n - 1) * (n - 2))) * sumCubed
}
