import type { Inputs } from '../types/inputs'
import type { AnnualStream } from '../types/streams'
import type { EngineState } from './dailyStep'

export function closeYear(
  state: EngineState,
  yearIndex: number,
  inputs: Inputs,
): AnnualStream {
  const acc = state.yearAccumulator
  const samples = acc.sohSamples
  const avgSoH =
    samples.length > 0
      ? samples.reduce((s, v) => s + v, 0) / samples.length
      : state.sohAtStartOfDay

  return {
    year: yearIndex,
    grossRevenue: acc.revenue,
    throughputMWh: acc.throughputMWh,
    cyclesEFC: acc.cyclesEFC,
    endOfYearSoH: state.sohAtStartOfDay,
    capacityMWh: inputs.battery.energyMWh * avgSoH * inputs.battery.dod,
    retired: state.retired,
  }
}

export function resetYearAccumulator(state: EngineState): EngineState {
  return {
    ...state,
    yearAccumulator: {
      revenue: 0,
      throughputMWh: 0,
      cyclesEFC: 0,
      sohSamples: [],
      dayCount: 0,
    },
  }
}
