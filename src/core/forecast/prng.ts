// Mulberry32 — fast, seedable, good statistical properties
export function makePrng(seed: number): () => number {
  let s = seed >>> 0
  return function (): number {
    s += 0x6d2b79f5
    let z = s
    z = Math.imul(z ^ (z >>> 15), z | 1)
    z ^= z + Math.imul(z ^ (z >>> 7), z | 61)
    return ((z ^ (z >>> 14)) >>> 0) / 0x100000000
  }
}

// Box-Muller transform producing standard-normal samples from a uniform [0,1) source
export function makeNormalPrng(uniform: () => number): () => number {
  let spare: number | null = null
  return function (): number {
    if (spare !== null) {
      const v = spare
      spare = null
      return v
    }
    let u: number, v: number, s: number
    do {
      u = uniform() * 2 - 1
      v = uniform() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const mul = Math.sqrt((-2 * Math.log(s)) / s)
    spare = v * mul
    return u * mul
  }
}
