import type { PriceSeries } from '../types/prices'
import type { DailyPriceParams } from '../types/streams'
import { getDayPrices } from '../types/prices'

export function buildHistoricalDays(
  series: PriceSeries,
  startUtc: string,
  yearCount: number,
  onCyclicWrap?: () => void,
): DailyPriceParams[] {
  const availableDays: Array<{ prices: number[]; dayStartUtc: string }> = []

  const seriesStartMs = new Date(series.startUtc).getTime()
  const seriesEndMs = new Date(series.endUtc).getTime()
  const msPerDay = 86_400_000

  for (let ms = seriesStartMs; ms < seriesEndMs; ms += msPerDay) {
    const dateStr = new Date(ms).toISOString().slice(0, 10)
    const result = getDayPrices(series, dateStr)
    if (result !== null) {
      availableDays.push(result)
    }
  }

  if (availableDays.length === 0) {
    return []
  }

  const startPrefix = startUtc.slice(0, 10)
  let startIndex = availableDays.findIndex(
    (d) => d.dayStartUtc.slice(0, 10) === startPrefix,
  )
  if (startIndex === -1) startIndex = 0

  const totalDays = yearCount * 365
  const result: DailyPriceParams[] = []
  let wrapFired = false

  for (let i = 0; i < totalDays; i++) {
    const rawIndex = startIndex + i
    const wrappedIndex = rawIndex % availableDays.length
    const isWrapped = rawIndex >= availableDays.length

    if (isWrapped && !wrapFired) {
      wrapFired = true
      onCyclicWrap?.()
    }

    const day = availableDays[wrappedIndex]!
    const yearIndex = Math.floor(i / 365) + 1
    const dayOfYear = (i % 365) + 1
    const prices = day.prices
    const dayMeanPrice =
      prices.length > 0
        ? prices.reduce((s, p) => s + p, 0) / prices.length
        : 0

    result.push({
      yearIndex,
      dayOfYear,
      startUtc: day.dayStartUtc,
      hourlyPrices: prices,
      dayMeanPrice,
    })
  }

  return result
}
