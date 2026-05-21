import type { BatterySpec } from '../types/battery'
import type { DailyStats, PeriodAggregateStats, SocTracePoint, Window } from './types'
import { mean, percentile, skewness, sortedAsc, stddev } from './math'

// ─── UTC timestamp helper ─────────────────────────────────────────────────────

function hourIndexToUtc(dayStartUtc: string, hourIndex: number): string {
  const ms = new Date(dayStartUtc).getTime() + hourIndex * 3_600_000
  return new Date(ms).toISOString()
}

// ─── Weighted mean (VWAP) ─────────────────────────────────────────────────────

/** Weighted mean of dayPrices over indices in block.
 *  The last hour contributes with fractional weight (D - floor(D)) if D is non-integer.
 */
function vwap(dayPrices: number[], block: number[], D: number): number {
  if (block.length === 0) return 0
  const frac = D - Math.floor(D)
  let weightedSum = 0
  let totalWeight = 0
  for (let i = 0; i < block.length; i++) {
    const idx = block[i]!
    const price = dayPrices[idx] ?? 0
    const w = i === block.length - 1 && frac > 0 ? frac : 1
    weightedSum += price * w
    totalWeight += w
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

// ─── Generate all contiguous blocks of given length from available hours ──────

function contiguousBlocks(available: Set<number>, blockLen: number): number[][] {
  const sorted = Array.from(available).sort((a, b) => a - b)
  const blocks: number[][] = []
  for (let i = 0; i <= sorted.length - blockLen; i++) {
    // Check if sorted[i..i+blockLen-1] are consecutive
    let consecutive = true
    for (let j = 1; j < blockLen; j++) {
      if ((sorted[i + j] ?? -1) !== (sorted[i]! + j)) {
        consecutive = false
        break
      }
    }
    if (consecutive) {
      blocks.push(sorted.slice(i, i + blockLen))
    }
  }
  return blocks
}

// ─── extractDailyStats ────────────────────────────────────────────────────────

export function extractDailyStats(
  dayPrices: number[],
  dayStartUtc: string,
  battery: BatterySpec,
): DailyStats {
  const H = dayPrices.length
  const D = battery.energyMWh / battery.powerMW
  const blockLen = Math.ceil(D)
  const eta = battery.roundTripEfficiency

  // Basic stats
  const sumPrices = dayPrices.reduce((s, p) => s + p, 0)
  const dayMean = H > 0 ? sumPrices / H : 0
  const dayMin = H > 0 ? Math.min(...dayPrices) : 0
  const dayMax = H > 0 ? Math.max(...dayPrices) : 0
  const spread = dayMax - dayMin
  const negativeHourCount = dayPrices.filter((p) => p < 0).length

  const dateUtc = dayStartUtc.slice(0, 10) // "YYYY-MM-DD"

  // ── Window detection ────────────────────────────────────────────────────────
  const available = new Set<number>()
  for (let i = 0; i < H; i++) available.add(i)

  const windows: Window[] = []

  for (let w = 0; w < battery.maxCyclesPerDay; w++) {
    if (available.size < 2 * blockLen) break

    const chargeBlocks = contiguousBlocks(available, blockLen)
    const dischargeBlocks = contiguousBlocks(available, blockLen)

    let bestMargin = 0
    let bestCharge: number[] | null = null
    let bestDischarge: number[] | null = null

    for (const cBlock of chargeBlocks) {
      const cSet = new Set(cBlock)
      for (const dBlock of dischargeBlocks) {
        // Blocks must not overlap
        const overlaps = dBlock.some((h) => cSet.has(h))
        if (overlaps) continue

        const vwapC = vwap(dayPrices, cBlock, D)
        const vwapD = vwap(dayPrices, dBlock, D)
        const margin = vwapD * eta - vwapC

        if (margin > bestMargin) {
          bestMargin = margin
          bestCharge = cBlock
          bestDischarge = dBlock
        }
      }
    }

    if (bestCharge === null || bestDischarge === null) break

    const vwapC = vwap(dayPrices, bestCharge, D)
    const vwapD = vwap(dayPrices, bestDischarge, D)

    const effectiveEnergyMWh = battery.powerMW * Math.min(D, bestDischarge.length)
    const effectiveEFC = effectiveEnergyMWh / (battery.energyMWh * battery.dod)

    const chargeStart = Math.min(...bestCharge)
    const chargeEnd = Math.max(...bestCharge) + 1
    const dischargeStart = Math.min(...bestDischarge)
    const dischargeEnd = Math.max(...bestDischarge) + 1

    const win: Window = {
      chargeHourIndices: bestCharge,
      dischargeHourIndices: bestDischarge,
      chargeStartUtc: hourIndexToUtc(dayStartUtc, chargeStart),
      chargeEndUtc: hourIndexToUtc(dayStartUtc, chargeEnd),
      dischargeStartUtc: hourIndexToUtc(dayStartUtc, dischargeStart),
      dischargeEndUtc: hourIndexToUtc(dayStartUtc, dischargeEnd),
      vwapCharge: vwapC,
      vwapDischarge: vwapD,
      effectiveMargin: bestMargin,
      effectiveEnergyMWh,
      effectiveEFC,
    }
    windows.push(win)

    // Remove all hours from both blocks from available
    for (const h of bestCharge) available.delete(h)
    for (const h of bestDischarge) available.delete(h)
  }

  // ── SoC simulation ──────────────────────────────────────────────────────────
  const sqrtEta = Math.sqrt(eta)
  const hourMode = new Map<number, 'charging' | 'discharging'>()
  for (const win of windows) {
    for (const h of win.chargeHourIndices) hourMode.set(h, 'charging')
    for (const h of win.dischargeHourIndices) hourMode.set(h, 'discharging')
  }

  const initialSoc = battery.initialSocMWh ?? 0
  const socTrace: SocTracePoint[] = []
  let soc = initialSoc

  // First point (hour boundary 0)
  socTrace.push({
    hourIndex: 0,
    socMWh: soc,
    socPct: (soc / battery.energyMWh) * 100,
    mode: 'idle',
  })

  for (let h = 0; h < H; h++) {
    const mode = hourMode.get(h) ?? 'idle'
    if (mode === 'charging') {
      soc += battery.powerMW * sqrtEta
    } else if (mode === 'discharging') {
      soc -= battery.powerMW / sqrtEta
    }
    socTrace.push({
      hourIndex: h + 1,
      socMWh: soc,
      socPct: (soc / battery.energyMWh) * 100,
      mode,
    })
  }

  // ── Warnings ─────────────────────────────────────────────────────────────────
  type Warning = DailyStats['warnings'][number]
  const warnings: Warning[] = []
  const cap = battery.energyMWh * battery.dod

  for (const pt of socTrace) {
    if (pt.socMWh > battery.energyMWh + 1e-9) {
      warnings.push({ kind: 'soc_exceeded_capacity', hourIndex: pt.hourIndex, socMWh: pt.socMWh })
    }
    if (pt.socMWh < -1e-9) {
      warnings.push({ kind: 'soc_below_zero', hourIndex: pt.hourIndex, socMWh: pt.socMWh })
    }
    // Check against dod limit
    if (pt.socMWh > cap + 1e-9 && pt.socMWh <= battery.energyMWh + 1e-9) {
      // Within capacity but above dod cap — not a warning per spec
    }
  }

  // Check discharge_before_charge: for each window, if discharge block starts before charge block
  for (let wi = 0; wi < windows.length; wi++) {
    const win = windows[wi]!
    const minCharge = Math.min(...win.chargeHourIndices)
    const minDischarge = Math.min(...win.dischargeHourIndices)
    if (minDischarge < minCharge) {
      warnings.push({ kind: 'discharge_before_charge', windowIndex: wi })
    }
  }

  // Check block_overlap between windows
  for (let a = 0; a < windows.length; a++) {
    const winA = windows[a]!
    const aHours = new Set([...winA.chargeHourIndices, ...winA.dischargeHourIndices])
    for (let b = a + 1; b < windows.length; b++) {
      const winB = windows[b]!
      const hasOverlap = [
        ...winB.chargeHourIndices,
        ...winB.dischargeHourIndices,
      ].some((h) => aHours.has(h))
      if (hasOverlap) {
        warnings.push({ kind: 'block_overlap', windowAIndex: a, windowBIndex: b })
      }
    }
  }

  return {
    dateUtc,
    hourlyPrices: dayPrices,
    meanPrice: dayMean,
    minPrice: dayMin,
    maxPrice: dayMax,
    spread,
    negativeHourCount,
    windows,
    socTrace,
    warnings,
  }
}

// ─── aggregatePeriod ──────────────────────────────────────────────────────────

export function aggregatePeriod(daily: DailyStats[], periodKey: string): PeriodAggregateStats {
  const dayCount = daily.length

  // Spread stats
  const spreads = daily.map((d) => d.spread)
  const sortedSpreads = sortedAsc(spreads)

  // Window count stats
  const windowCounts = daily.map((d) => d.windows.length)
  const histogram: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
  for (const c of windowCounts) {
    const key = Math.min(c, 3) as 0 | 1 | 2 | 3
    histogram[key]++
  }

  // Mode = most common window count
  let modeCount: 0 | 1 | 2 | 3 = 0
  let modeFreq = -1
  for (const k of [0, 1, 2, 3] as const) {
    if (histogram[k] > modeFreq) {
      modeFreq = histogram[k]
      modeCount = k
    }
  }

  // Secondary ratio: days with ≥2 windows
  const secondaryRatios: number[] = []
  for (const d of daily) {
    if (d.windows.length >= 2) {
      const w0 = d.windows[0]!
      const w1 = d.windows[1]!
      if (w0.effectiveMargin !== 0) {
        secondaryRatios.push(w1.effectiveMargin / w0.effectiveMargin)
      }
    }
  }
  const secondaryRatio =
    secondaryRatios.length > 0
      ? { mean: mean(secondaryRatios), std: stddev(secondaryRatios) }
      : { mean: NaN, std: NaN }

  // Tertiary ratio: days with ≥3 windows
  const tertiaryRatios: number[] = []
  for (const d of daily) {
    if (d.windows.length >= 3) {
      const w0 = d.windows[0]!
      const w2 = d.windows[2]!
      if (w0.effectiveMargin !== 0) {
        tertiaryRatios.push(w2.effectiveMargin / w0.effectiveMargin)
      }
    }
  }
  const tertiaryRatio =
    tertiaryRatios.length > 0
      ? { mean: mean(tertiaryRatios), std: stddev(tertiaryRatios) }
      : { mean: NaN, std: NaN }

  // Peak duration: discharge hours of first window
  const peakDurations: number[] = []
  for (const d of daily) {
    if (d.windows.length >= 1) {
      peakDurations.push(d.windows[0]!.dischargeHourIndices.length)
    }
  }
  const sortedPeakDurations = sortedAsc(peakDurations)

  // Mean price level
  const allPrices: number[] = daily.flatMap((d) => d.hourlyPrices)
  const meanLevel = allPrices.length > 0 ? mean(allPrices) : NaN

  // Negative hour share
  const totalHours = allPrices.length
  const negativeHours = allPrices.filter((p) => p < 0).length
  const negativeHourShare = totalHours > 0 ? negativeHours / totalHours : 0

  // Effective margin per cycle (best window per day with ≥1 window)
  const margins: number[] = []
  for (const d of daily) {
    if (d.windows.length >= 1) {
      margins.push(d.windows[0]!.effectiveMargin)
    }
  }
  const sortedMargins = sortedAsc(margins)

  return {
    periodKey,
    dayCount,
    spread: {
      mean: mean(spreads),
      std: stddev(spreads),
      p10: percentile(sortedSpreads, 10),
      p50: percentile(sortedSpreads, 50),
      p90: percentile(sortedSpreads, 90),
      skewness: skewness(spreads),
    },
    windowCount: {
      mean: mean(windowCounts),
      mode: modeCount,
      histogram,
    },
    secondaryRatio,
    tertiaryRatio,
    peakDurationHours: {
      mean: peakDurations.length > 0 ? mean(peakDurations) : NaN,
      p10: percentile(sortedPeakDurations, 10),
      p50: percentile(sortedPeakDurations, 50),
      p90: percentile(sortedPeakDurations, 90),
    },
    meanLevel,
    negativeHourShare,
    effectiveMarginPerCycle: {
      mean: margins.length > 0 ? mean(margins) : NaN,
      p10: percentile(sortedMargins, 10),
      p50: percentile(sortedMargins, 50),
      p90: percentile(sortedMargins, 90),
    },
  }
}
