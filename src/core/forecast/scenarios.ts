import type { ScenarioProfile, YearCapacityParams } from './types'

function lerpInt(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

type CapacityEndpoints = Omit<YearCapacityParams, 'yearIndex' | 'priceRandomizer'>

function buildYears(start: CapacityEndpoints, end: CapacityEndpoints): YearCapacityParams[] {
  return Array.from({ length: 5 }, (_, i) => {
    const t = i / 4
    return {
      yearIndex: i,
      maxPowerConsumption: lerpInt(start.maxPowerConsumption, end.maxPowerConsumption, t),
      constantBaseload: lerpInt(start.constantBaseload, end.constantBaseload, t),
      nuclearCapacityMW: lerpInt(start.nuclearCapacityMW, end.nuclearCapacityMW, t),
      windCapacityMW: lerpInt(start.windCapacityMW, end.windCapacityMW, t),
      solarCapacityMW: lerpInt(start.solarCapacityMW, end.solarCapacityMW, t),
      priceRandomizer: 0,
    }
  })
}

export const PRESET_SCENARIOS: ScenarioProfile[] = [
  {
    id: 'preset_datacenter',
    name: 'High Datacenter Buildout',
    description:
      'Aggressive data center development outstrips zero-carbon supply deployment. Constant load suppresses negative price floors while structural supply deficits create severe peaks during low-wind freeze patterns.',
    isPreset: true,
    updatedAt: '2026-01-01T00:00:00Z',
    years: buildYears(
      { maxPowerConsumption: 14000, constantBaseload: 9500, nuclearCapacityMW: 4300, windCapacityMW: 7000, solarCapacityMW: 1000 },
      { maxPowerConsumption: 17500, constantBaseload: 13000, nuclearCapacityMW: 4300, windCapacityMW: 8500, solarCapacityMW: 1800 },
    ),
  },
  {
    id: 'preset_green',
    name: 'Balanced Green Transition',
    description:
      'Data center and green hydrogen buildouts advance in step with offshore wind and SMR deployments. High dispatchable capacity anchors baseline prices while wide peak-to-trough spreads create strong arbitrage conditions.',
    isPreset: true,
    updatedAt: '2026-01-01T00:00:00Z',
    years: buildYears(
      { maxPowerConsumption: 14000, constantBaseload: 9000, nuclearCapacityMW: 4300, windCapacityMW: 7000, solarCapacityMW: 1000 },
      { maxPowerConsumption: 19000, constantBaseload: 11500, nuclearCapacityMW: 4900, windCapacityMW: 14500, solarCapacityMW: 3500 },
    ),
  },
]

export function getDefaultProfile(): ScenarioProfile {
  return JSON.parse(JSON.stringify(PRESET_SCENARIOS[0]!)) as ScenarioProfile
}
