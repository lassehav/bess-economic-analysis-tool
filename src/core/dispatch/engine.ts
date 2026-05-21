import type { Inputs } from '../types/inputs'
import type { AnnualStream, DailyPriceParams } from '../types/streams'
import { makeInitialState, runDailyStep } from './dailyStep'
import { closeYear, resetYearAccumulator } from './yearClose'

export function runProjectSimulation(
  inputs: Inputs,
  days: DailyPriceParams[],
): { streams: AnnualStream[]; retiredAtYear: number | null; retiredAtDay: number | null } {
  const { projectLifeYears } = inputs.finance
  let state = makeInitialState()
  const streams: AnnualStream[] = []
  let retiredAtYear: number | null = null
  let retiredAtDay: number | null = null

  for (let i = 0; i < days.length; i++) {
    const day = days[i]!
    const prevRetired = state.retired
    state = runDailyStep(state, day, inputs)

    if (!prevRetired && state.retired && retiredAtDay === null) {
      retiredAtDay = i + 1
      retiredAtYear = Math.floor(i / 365) + 1
    }

    const isYearEnd = (i + 1) % 365 === 0
    if (isYearEnd) {
      const yearIndex = (i + 1) / 365
      streams.push(closeYear(state, yearIndex, inputs))
      state = resetYearAccumulator(state)
    }
  }

  const remainder = days.length % 365
  if (remainder !== 0) {
    const yearIndex = Math.floor(days.length / 365) + 1
    streams.push(closeYear(state, yearIndex, inputs))
    state = resetYearAccumulator(state)
  }

  while (streams.length < projectLifeYears) {
    const yearIndex = streams.length + 1
    streams.push({
      year: yearIndex,
      grossRevenue: 0,
      throughputMWh: 0,
      cyclesEFC: 0,
      endOfYearSoH: state.sohAtStartOfDay,
      capacityMWh: 0,
      retired: true,
    })
  }

  return { streams, retiredAtYear, retiredAtDay }
}
