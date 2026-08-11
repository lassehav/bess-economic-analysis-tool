import type { BatteryInputs } from '../types/inputs'

// Degradation: separate calendar and cycle mechanisms, added — the NREL/Sandia
// semi-empirical form. Each is non-linear in its own driver:
//
//   SoH(t,N) = 1 − F·s·(t/T_cal)^p − F·(1−s)·(N/N_nom)^q,   F = 1 − endOfLifeSoH
//
// Calendar fade with p < 1 follows diffusion-limited SEI growth: fast early loss that
// then flattens, which is what real packs show and what a linear ramp misses.
// Cycle fade is driven by cumulative EFC — energy through the cell is what counts,
// regardless of how many windows a given day was split into.
//
// Calibration: the two shares are anchored to the rated duty — a pack that delivers
// N_nom EFC over T_cal years lands exactly on endOfLifeSoH. Splitting one budget
// (rather than giving each mechanism a full budget) is what stops the additive form
// from double-counting: a datasheet cycle life is itself measured over calendar time,
// so its fade already contains both. Consequences: cycling harder than rated retires
// the pack early, while an idle pack outlives T_cal, since the calendar term alone
// only ever reaches s·F.
//
// These three are deliberately fixed rather than exposed as inputs — they set the
// *shape* of the curve, which is a modelling assumption, not a project variable.
// The user-facing levers on battery life stay cycle life, calendar life and EoL SoH.

/** s — share of the fade budget carried by the calendar term at rated duty. */
export const CALENDAR_FADE_SHARE = 0.4

/**
 * p — 1.0 would be a straight line; 0.5 is textbook √t SEI growth. 0.7 sits between:
 * still clearly front-loaded, but pure √t spends 22% of a 20-year calendar budget in
 * year 1 alone, which puts first-year loss above what vendor LFP curves show (2–3%).
 * At 0.7 the default preset loses ~2.4 pp in year 1 at 2 cycles/day. The exponent
 * mostly redistributes *when* fade lands — retirement year is fairly insensitive to it.
 */
export const CALENDAR_FADE_EXPONENT = 0.7

/** q — 1.0 makes cycle fade proportional to cumulative throughput. */
export const CYCLE_FADE_EXPONENT = 1.0

/**
 * State of health after `ageYears` of life having delivered `cumulativeEFC`
 * equivalent full cycles. Clamped to [0, 1].
 */
export function computeSoH(
  ageYears: number,
  cumulativeEFC: number,
  battery: BatteryInputs,
): number {
  const fadeBudget = 1 - battery.endOfLifeSoH

  const calFade =
    battery.calendarLifeYears > 0
      ? fadeBudget *
        CALENDAR_FADE_SHARE *
        Math.pow(ageYears / battery.calendarLifeYears, CALENDAR_FADE_EXPONENT)
      : 0

  const cycFade =
    battery.nominalCycleLifeEFC > 0
      ? fadeBudget *
        (1 - CALENDAR_FADE_SHARE) *
        Math.pow(cumulativeEFC / battery.nominalCycleLifeEFC, CYCLE_FADE_EXPONENT)
      : 0

  return Math.max(0, 1 - calFade - cycFade)
}
