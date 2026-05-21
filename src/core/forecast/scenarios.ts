import type { ScenarioProfile, YearCapacityParams } from './types'

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t))
}

function buildYears(
  startValues: Omit<YearCapacityParams, 'yearIndex'>,
  endValues: Omit<YearCapacityParams, 'yearIndex'>,
  count: number,
): YearCapacityParams[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count > 1 ? i / (count - 1) : 0
    return {
      yearIndex: i,
      maxPowerConsumption: Math.round(lerp(startValues.maxPowerConsumption, endValues.maxPowerConsumption, t)),
      constantBaseload: Math.round(lerp(startValues.constantBaseload, endValues.constantBaseload, t)),
      solarCapacityMW: Math.round(lerp(startValues.solarCapacityMW, endValues.solarCapacityMW, t)),
      windCapacityMW: Math.round(lerp(startValues.windCapacityMW, endValues.windCapacityMW, t)),
      nuclearCapacityMW: Math.round(lerp(startValues.nuclearCapacityMW, endValues.nuclearCapacityMW, t)),
      priceRandomizer: lerp(startValues.priceRandomizer, endValues.priceRandomizer, t),
    }
  })
}

export const PRESET_SCENARIOS: ScenarioProfile[] = [
  {
    id: 'preset_datacenter',
    name: 'High Datacenter Buildout',
    description:
      'Demand-driven tightening from large-scale data center buildout and district heating electrification. Constant industrial baseload absorbs overnight surplus, suppressing negative price blocks and lifting mean prices.',
    isPreset: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    years: buildYears(
      {
        maxPowerConsumption: 14000,
        constantBaseload: 9500,
        solarCapacityMW: 1000,
        windCapacityMW: 7000,
        nuclearCapacityMW: 4300,
        priceRandomizer: 0,
      },
      {
        maxPowerConsumption: 17500,
        constantBaseload: 13000,
        solarCapacityMW: 1800,
        windCapacityMW: 8500,
        nuclearCapacityMW: 4300,
        priceRandomizer: 0,
      },
      5,
    ),
  },
  {
    id: 'preset_green',
    name: 'Balanced Green Transition',
    description:
      'Aggressive Nordic wind and solar expansion alongside moderate demand growth. High-generation windows become more frequent, driving down mean prices and amplifying negative price events during calm demand hours.',
    isPreset: true,
    updatedAt: '2026-01-01T00:00:00.000Z',
    years: buildYears(
      {
        maxPowerConsumption: 14000,
        constantBaseload: 9000,
        solarCapacityMW: 1000,
        windCapacityMW: 7000,
        nuclearCapacityMW: 4300,
        priceRandomizer: 0,
      },
      {
        maxPowerConsumption: 19000,
        constantBaseload: 11500,
        solarCapacityMW: 3500,
        windCapacityMW: 14500,
        nuclearCapacityMW: 4900,
        priceRandomizer: 0,
      },
      5,
    ),
  },
]

export function getDefaultProfile(): ScenarioProfile {
  const preset = PRESET_SCENARIOS[0]!
  return {
    ...preset,
    years: preset.years.map((y) => ({ ...y })),
  }
}
