import type { BatterySpec } from '../types/battery'
import type { DailyStats, PeriodAggregateStats, SocTracePoint, Window } from './types'

function hourIndexToUtc(dayStartUtc: string, hourIndex: number): string {
  const ms = new Date(dayStartUtc).getTime() + hourIndex * 3_600_000
  return new Date(ms).toISOString()
}

export function extractDailyStats(
  dayPrices: number[],
  dayStartUtc: string,
  battery: BatterySpec,
  marginalDegradationCost = 0,
): DailyStats {
  const H = dayPrices.length
  const eta = battery.roundTripEfficiency
  const sqrtEta = Math.sqrt(eta)
  const usableMaxMWh = battery.energyMWh * battery.dod

  // Basic descriptive metrics
  const sumPrices = dayPrices.reduce((s, p) => s + p, 0)
  const dayMean = H > 0 ? sumPrices / H : 0
  const dayMin = H > 0 ? Math.min(...dayPrices) : 0
  const dayMax = H > 0 ? Math.max(...dayPrices) : 0
  const spread = dayMax - dayMin
  const negativeHourCount = dayPrices.filter((p) => p < 0).length
  const dateUtc = dayStartUtc.slice(0, 10)

  // ── 1. GENERATE ALL POSSIBLE PARTIAL OPPORTUNITIES ───────────────────────
  type Opportunity = { c: number; d: number; margin: number }
  const opportunities: Opportunity[] = []

  // Generate every forward-looking chronological pair (Charge completes before Discharge)
  for (let c = 0; c < H; c++) {
    for (let d = c + 1; d < H; d++) {
      // Margin of buying 1 MW from grid, and selling whatever survives round-trip efficiency
      const margin = (dayPrices[d]! * eta) - dayPrices[c]! - marginalDegradationCost
      if (margin > 0) {
        opportunities.push({ c, d, margin })
      }
    }
  }

  // Sort strictly by highest profit margin
  opportunities.sort((a, b) => b.margin - a.margin)

  // ── 2. FRACTIONAL STATE DISPATCH ENGINE ──────────────────────────────────
  // Trackers to ensure we do not violate hardware physics during fractional allocation
  const availChargePower = Array(H).fill(battery.powerMW)
  const availDischargePower = Array(H).fill(battery.powerMW)
  
  // Track SoC at the END of each hour
  const internalSoc = Array(H).fill(battery.initialSocMWh ?? 0)
  
  // Convert cycles limit to a strict daily energy throughput limit
  let availThroughputMWh = battery.maxCyclesPerDay * usableMaxMWh

  // Keep a record of the actual dispatched Grid MW
  const gridChargeMW = Array(H).fill(0)
  const gridDischargeMW = Array(H).fill(0)

  for (const opp of opportunities) {
    if (availThroughputMWh <= 0) break

    const { c, d } = opp

    // Calculate maximum grid charge power we can allocate to this pair:
    // Constraint A: Inverter capacity limits at the charge & discharge hour
    let p_alloc = Math.min(availChargePower[c], availDischargePower[d] / eta)

    // Constraint B: Maximum allowed remaining daily throughput
    p_alloc = Math.min(p_alloc, availThroughputMWh / sqrtEta)

    // Constraint C: Physical battery capacity in the time between Charge and Discharge
    // Adding charge at hour 'c' raises the internal SoC for all hours until it is discharged at 'd'
    for (let t = c; t < d; t++) {
      const space = usableMaxMWh - internalSoc[t]
      p_alloc = Math.min(p_alloc, space / sqrtEta)
    }

    // If there's still room to execute a partial cycle, lock it in!
    if (p_alloc > 1e-6) {
      availChargePower[c] -= p_alloc
      availDischargePower[d] -= p_alloc * eta
      availThroughputMWh -= p_alloc * sqrtEta

      gridChargeMW[c] += p_alloc
      gridDischargeMW[d] += p_alloc * eta

      // Elevate the simulated SoC for the duration the energy sits in the battery
      for (let t = c; t < d; t++) {
        internalSoc[t] += p_alloc * sqrtEta
      }
    }
  }

  // ── 3. RECONSTRUCT UI WINDOWS FROM FRACTIONAL LOGIC ──────────────────────
  const finalWindows: Window[] = []
  let activeWindow: {
    cHours: number[],
    dHours: number[],
    cEnergy: number, // Grid MW
    dEnergy: number, // Grid MW
    cCost: number,
    dRev: number
  } | null = null

  for (let h = 0; h < H; h++) {
    const isCharging = gridChargeMW[h] > 1e-6
    const isDischarging = gridDischargeMW[h] > 1e-6

    if (isCharging) {
      // If we see a new charge but already have a discharge sequence, wrap up the old window
      if (activeWindow && activeWindow.dHours.length > 0) {
        pushWindow(activeWindow)
        activeWindow = null
      }
      if (!activeWindow) {
        activeWindow = { cHours: [], dHours: [], cEnergy: 0, dEnergy: 0, cCost: 0, dRev: 0 }
      }
      activeWindow.cHours.push(h)
      activeWindow.cEnergy += gridChargeMW[h]
      activeWindow.cCost += gridChargeMW[h] * dayPrices[h]!
    }

    if (isDischarging) {
      if (!activeWindow) {
        activeWindow = { cHours: [], dHours: [], cEnergy: 0, dEnergy: 0, cCost: 0, dRev: 0 }
      }
      activeWindow.dHours.push(h)
      activeWindow.dEnergy += gridDischargeMW[h]
      activeWindow.dRev += gridDischargeMW[h] * dayPrices[h]!
    }
  }

  if (activeWindow && (activeWindow.cHours.length > 0 || activeWindow.dHours.length > 0)) {
    pushWindow(activeWindow)
  }

  function pushWindow(win: typeof activeWindow) {
    if (!win) return
    const vwapCharge = win.cEnergy > 0 ? win.cCost / win.cEnergy : 0
    const vwapDischarge = win.dEnergy > 0 ? win.dRev / win.dEnergy : 0
    
    // Internal energy is Grid Charge * sqrtEta
    const internalEnergy = win.cEnergy * sqrtEta

    finalWindows.push({
      chargeHourIndices: win.cHours,
      dischargeHourIndices: win.dHours,
      chargeStartUtc: win.cHours.length ? hourIndexToUtc(dayStartUtc, win.cHours[0]!) : '',
      chargeEndUtc: win.cHours.length ? hourIndexToUtc(dayStartUtc, win.cHours[win.cHours.length - 1]! + 1) : '',
      dischargeStartUtc: win.dHours.length ? hourIndexToUtc(dayStartUtc, win.dHours[0]!) : '',
      dischargeEndUtc: win.dHours.length ? hourIndexToUtc(dayStartUtc, win.dHours[win.dHours.length - 1]! + 1) : '',
      vwapCharge,
      vwapDischarge,
      effectiveMargin: (vwapDischarge * eta) - vwapCharge,
      effectiveEnergyMWh: internalEnergy,
      effectiveEFC: internalEnergy / usableMaxMWh,
    })
  }

  // ── 3b. ENFORCE maxCyclesPerDay WINDOW LIMIT ──────────────────────────────
  // The fractional dispatch engine may produce more distinct charge→discharge
  // groups than maxCyclesPerDay because the throughput budget (in MWh) allows
  // many small independent pairs that reconstruct into N > maxCyclesPerDay
  // windows.  Prune to the top N most profitable and zero out their dispatch
  // allocations so the SoC trace reflects only the kept cycles.
  if (finalWindows.length > battery.maxCyclesPerDay) {
    const ranked = finalWindows
      .map((w) => ({ w, profit: w.effectiveMargin * w.effectiveEnergyMWh }))
      .sort((a, b) => b.profit - a.profit)

    for (const { w } of ranked.slice(battery.maxCyclesPerDay)) {
      for (const h of w.chargeHourIndices) gridChargeMW[h] = 0
      for (const h of w.dischargeHourIndices) gridDischargeMW[h] = 0
    }

    finalWindows.length = 0
    for (const { w } of ranked.slice(0, battery.maxCyclesPerDay)) {
      finalWindows.push(w)
    }
    finalWindows.sort(
      (a, b) =>
        (a.chargeHourIndices[0] ?? a.dischargeHourIndices[0] ?? 0) -
        (b.chargeHourIndices[0] ?? b.dischargeHourIndices[0] ?? 0),
    )
  }

  // ── 4. CHRONOLOGICAL TRACE FOR THE CHARTS ────────────────────────────────
  const socTrace: SocTracePoint[] = []
  let traceSoc = battery.initialSocMWh ?? 0

  socTrace.push({
    hourIndex: 0,
    socMWh: traceSoc,
    socPct: battery.energyMWh > 0 ? (traceSoc / battery.energyMWh) * 100 : 0,
    mode: 'idle',
  })

  for (let h = 0; h < H; h++) {
    const chargeGrid = gridChargeMW[h]
    const dischargeGrid = gridDischargeMW[h]
    
    let mode: 'idle' | 'charging' | 'discharging' = 'idle'
    if (chargeGrid > 1e-6) mode = 'charging'
    else if (dischargeGrid > 1e-6) mode = 'discharging'

    traceSoc = traceSoc + (chargeGrid * sqrtEta) - (dischargeGrid / sqrtEta)

    socTrace.push({
      hourIndex: h + 1,
      socMWh: traceSoc,
      socPct: battery.energyMWh > 0 ? (traceSoc / battery.energyMWh) * 100 : 0,
      mode,
    })
  }

  // ── 5. RUNTIME VALIDATION ────────────────────────────────────────────────
  const warnings: DailyStats['warnings'] = []
  for (const pt of socTrace) {
    if (pt.socMWh > usableMaxMWh + 1e-6) {
      warnings.push({ kind: 'soc_exceeded_capacity', hourIndex: pt.hourIndex, socMWh: pt.socMWh })
    }
    if (pt.socMWh < -1e-6) {
      warnings.push({ kind: 'soc_below_zero', hourIndex: pt.hourIndex, socMWh: pt.socMWh })
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
    windows: finalWindows,
    socTrace,
    warnings,
  }
}

export function aggregatePeriod(daily: DailyStats[], periodKey: string): PeriodAggregateStats {
  const n = daily.length

  function avg(arr: number[]): number {
    return arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : 0
  }
  function stdDev(arr: number[], m: number): number {
    if (arr.length < 2) return 0
    return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1))
  }
  function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    const idx = (p / 100) * (sorted.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return lo === hi ? (sorted[lo] ?? 0) : (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (idx - lo)
  }
  function skew(arr: number[], m: number, s: number): number {
    if (arr.length < 3 || s === 0) return 0
    const k = arr.length
    return (k / ((k - 1) * (k - 2))) * arr.reduce((acc, v) => acc + ((v - m) / s) ** 3, 0)
  }

  // Spread
  const spreads = daily.map((d) => d.spread).sort((a, b) => a - b)
  const spreadMean = avg(spreads)
  const spreadStd = stdDev(spreads, spreadMean)

  // Window counts
  const wcounts = daily.map((d) => d.windows.length)
  const histogram: Record<0 | 1 | 2 | 3, number> = { 0: 0, 1: 0, 2: 0, 3: 0 }
  for (const wc of wcounts) histogram[Math.min(wc, 3) as 0 | 1 | 2 | 3]++
  let modeKey: 0 | 1 | 2 | 3 = 0
  let modeMax = -1
  for (const [k, count] of Object.entries(histogram) as [string, number][]) {
    if (count > modeMax) { modeMax = count; modeKey = Number(k) as 0 | 1 | 2 | 3 }
  }

  // Secondary / tertiary margin ratios (relative to primary cycle)
  const secondaryRatios: number[] = []
  const tertiaryRatios: number[] = []
  for (const d of daily) {
    const [w0, w1, w2] = d.windows
    if (w0 && w1 && w0.effectiveMargin > 0) secondaryRatios.push(w1.effectiveMargin / w0.effectiveMargin)
    if (w0 && w2 && w0.effectiveMargin > 0) tertiaryRatios.push(w2.effectiveMargin / w0.effectiveMargin)
  }
  const secMean = avg(secondaryRatios)
  const terMean = avg(tertiaryRatios)

  // Peak (discharge) duration
  const durations: number[] = daily.flatMap((d) => d.windows.map((w) => w.dischargeHourIndices.length))
  const durationsSorted = durations.slice().sort((a, b) => a - b)

  // Price level and negative-hour share
  let totalHours = 0, totalPriceSum = 0, totalNegHours = 0
  for (const d of daily) {
    totalHours += d.hourlyPrices.length
    totalPriceSum += d.hourlyPrices.reduce((s, p) => s + p, 0)
    totalNegHours += d.negativeHourCount
  }

  // Effective margin per cycle
  const margins: number[] = daily.flatMap((d) => d.windows.map((w) => w.effectiveMargin))
  const marginsSorted = margins.slice().sort((a, b) => a - b)
  const marginMean = avg(margins)

  return {
    periodKey,
    dayCount: n,
    spread: {
      mean: spreadMean,
      std: spreadStd,
      p10: pct(spreads, 10),
      p50: pct(spreads, 50),
      p90: pct(spreads, 90),
      skewness: skew(spreads, spreadMean, spreadStd),
    },
    windowCount: { mean: avg(wcounts), mode: modeKey, histogram },
    secondaryRatio: { mean: secMean, std: stdDev(secondaryRatios, secMean) },
    tertiaryRatio: { mean: terMean, std: stdDev(tertiaryRatios, terMean) },
    peakDurationHours: {
      mean: avg(durations),
      p10: pct(durationsSorted, 10),
      p50: pct(durationsSorted, 50),
      p90: pct(durationsSorted, 90),
    },
    meanLevel: totalHours > 0 ? totalPriceSum / totalHours : 0,
    negativeHourShare: totalHours > 0 ? totalNegHours / totalHours : 0,
    effectiveMarginPerCycle: {
      mean: marginMean,
      p10: pct(marginsSorted, 10),
      p50: pct(marginsSorted, 50),
      p90: pct(marginsSorted, 90),
    },
  }
}