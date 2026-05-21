export type PriceSeries = {
  source: 'ENTSO-E FI day-ahead'
  generatedAt: string
  startUtc: string
  endUtc: string
  resolutionMinutes: 60
  prices: number[]
  gaps: Array<{ startUtc: string; endUtc: string; reason: string }>
}

/** Given the PriceSeries, return the hourly prices for one UTC date "YYYY-MM-DD". */
export function getDayPrices(
  series: PriceSeries,
  dateUtc: string,
): { prices: number[]; dayStartUtc: string } | null {
  const seriesStartMs = new Date(series.startUtc).getTime()
  // dayStart in UTC
  const dayStartMs = new Date(dateUtc + 'T00:00:00.000Z').getTime()

  const startIdx = Math.round((dayStartMs - seriesStartMs) / 3_600_000)
  if (startIdx < 0 || startIdx >= series.prices.length) return null

  // Collect prices for the day: stop when we reach next calendar day UTC midnight
  // A UTC day always starts at 00:00 UTC and ends before the next 00:00 UTC
  // But our prices are in UTC, so one calendar UTC day = exactly 24 hours
  const hoursInDay = 24
  const endIdx = Math.min(startIdx + hoursInDay, series.prices.length)
  const prices = series.prices.slice(startIdx, endIdx)
  if (prices.length === 0) return null

  return { prices, dayStartUtc: new Date(dayStartMs).toISOString() }
}
