export type AnnualStream = {
  year: number
  grossRevenue: number
  throughputMWh: number
  cyclesEFC: number
  endOfYearSoH: number
  capacityMWh: number
  retired: boolean
}

export type DailyPriceParams = {
  yearIndex: number
  dayOfYear: number
  startUtc: string
  hourlyPrices: number[]
  dayMeanPrice: number
}
