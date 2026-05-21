import type { ScenarioYearParams } from './types'

export type ScenarioDefinition = {
  id: string
  name: string
  description: string
  getYearParams: (yearIndex: number) => ScenarioYearParams
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t))
}

export const MILESTONE_LABELS: Record<string, string> = {
  dc_load_ramp: 'Data Center Load Ramp',
  wind_fleet_expansion: 'Wind Fleet Expansion',
}

export const MILESTONE_DESCRIPTIONS: Record<string, string> = {
  dc_load_ramp:
    'Large-scale data center and district heating boiler capacity comes online. Constant industrial baseload absorbs overnight surplus, suppressing negative price blocks.',
  wind_fleet_expansion:
    'Finnish and Baltic wind fleet reaches critical mass. High-generation windows become more frequent, driving down mean prices and amplifying negative price events during calm demand hours.',
}

export const SCENARIOS: ScenarioDefinition[] = [
  {
    id: 'status_quo',
    name: 'Status Quo',
    description:
      'Baseline historical replication. All structural multipliers hold at 1.0 with standard drift. Represents continuation of current market dynamics without major structural change.',
    getYearParams(yearIndex) {
      return {
        yearIndex,
        meanLevelMultiplier: 1.0,
        peakMultiplier: 1.0,
        troughMultiplier: 1.0,
        peakDurationMultiplier: 1.0,
        activeStructuralMilestones: [],
      }
    },
  },
  {
    id: 'data_center_boom',
    name: 'Data Center Boom',
    description:
      'Demand-driven tightening from large-scale data center buildout and district heating electrification. Mean prices rise and overnight troughs are suppressed as constant industrial load absorbs surplus generation.',
    getYearParams(yearIndex) {
      const t = Math.min(yearIndex / 8, 1)
      return {
        yearIndex,
        meanLevelMultiplier: lerp(1.0, 1.15, t),
        peakMultiplier: lerp(1.0, 1.30, t),
        troughMultiplier: lerp(1.0, 0.65, t),
        peakDurationMultiplier: lerp(1.0, 1.12, t),
        activeStructuralMilestones: yearIndex >= 3 ? ['dc_load_ramp'] : [],
      }
    },
  },
  {
    id: 'renewable_surge',
    name: 'Renewable Surge',
    description:
      'Aggressive Nordic wind and solar expansion drives mean prices lower while amplifying negative price events during high-generation blocks. BESS arbitrage opportunity intensifies.',
    getYearParams(yearIndex) {
      const t = Math.min(yearIndex / 10, 1)
      return {
        yearIndex,
        meanLevelMultiplier: lerp(1.0, 0.85, t),
        peakMultiplier: lerp(1.0, 1.05, t),
        troughMultiplier: lerp(1.0, 1.70, t),
        peakDurationMultiplier: lerp(1.0, 0.88, t),
        activeStructuralMilestones: yearIndex >= 5 ? ['wind_fleet_expansion'] : [],
      }
    },
  },
]

export function getScenario(id: string): ScenarioDefinition {
  return SCENARIOS.find((s) => s.id === id) ?? SCENARIOS[0]!
}
