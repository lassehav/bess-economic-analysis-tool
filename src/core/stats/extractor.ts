import type { BatterySpec } from '../types/battery'
import type { DailyStats, SocTracePoint, Window } from './types'

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