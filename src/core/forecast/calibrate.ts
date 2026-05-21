import type { PriceSeries } from '../types/prices'
import type { HistoricalCalibration } from './types'

export function calibrateFromHistory(
  series: PriceSeries,
  windowStart?: string,
  windowEnd?: string,
): HistoricalCalibration {
  const seriesStartMs = new Date(series.startUtc).getTime()
  const startMs = windowStart
    ? new Date(windowStart + 'T00:00:00Z').getTime()
    : seriesStartMs
  const endMs = windowEnd
    ? new Date(windowEnd + 'T00:00:00Z').getTime()
    : new Date(series.endUtc).getTime()

  const mhSum = Array.from({ length: 12 }, () => new Float64Array(24))
  const mhCount = Array.from({ length: 12 }, () => new Int32Array(24))
  const mSum = new Float64Array(12)
  const mCount = new Int32Array(12)
  const wSum = new Float64Array(7)
  const wCount = new Int32Array(7)

  const dailySpreads: number[] = []
  const dailyMeans: Array<{ monthIdx: number; dowIdx: number; mean: number }> = []

  let totalPriceSum = 0
  let totalPriceCount = 0

  const msPerHour = 3_600_000
  const msPerDay = 86_400_000

  for (let dayMs = startMs; dayMs < endMs; dayMs += msPerDay) {
    if (dayMs < seriesStartMs) continue
    const idxStart = Math.round((dayMs - seriesStartMs) / msPerHour)
    const idxEnd = idxStart + 24
    if (idxEnd > series.prices.length) break
    if (idxStart < 0) continue

    const prices = series.prices.slice(idxStart, idxEnd)
    if (prices.length < 24) continue

    const dateObj = new Date(dayMs)
    const monthIdx = dateObj.getUTCMonth()
    const dowIdx = dateObj.getUTCDay()

    let daySum = 0
    let dayMin = Infinity
    let dayMax = -Infinity

    for (let h = 0; h < 24; h++) {
      const p = prices[h]!
      mhSum[monthIdx]![h] += p
      mhCount[monthIdx]![h]++
      daySum += p
      if (p < dayMin) dayMin = p
      if (p > dayMax) dayMax = p
    }

    const dayMean = daySum / 24
    mSum[monthIdx] += dayMean
    mCount[monthIdx]++
    wSum[dowIdx] += dayMean
    wCount[dowIdx]++
    dailySpreads.push(dayMax - dayMin)
    totalPriceSum += daySum
    totalPriceCount += 24
    dailyMeans.push({ monthIdx, dowIdx, mean: dayMean })
  }

  if (totalPriceCount === 0) {
    return {
      diurnalByMonth: Array.from({ length: 12 }, () => Array(24).fill(1) as number[]),
      monthLevel: Array(12).fill(1) as number[],
      dayOfWeekLevel: Array(7).fill(1) as number[],
      annualMeanPrice: 50,
      annualMeanSpread: 50,
      residualAr1: 0.5,
      residualSigma: 10,
    }
  }

  const annualMeanPrice = totalPriceSum / totalPriceCount
  const annualMeanSpread =
    dailySpreads.length > 0
      ? dailySpreads.reduce((s, v) => s + v, 0) / dailySpreads.length
      : 50

  // Diurnal shape: mean(price[m][h]) / mean(price[m]), normalized so sum=24
  const diurnalByMonth: number[][] = []
  for (let m = 0; m < 12; m++) {
    const monthMean = mCount[m]! > 0 ? mSum[m]! / mCount[m]! : annualMeanPrice
    const row: number[] = []
    for (let h = 0; h < 24; h++) {
      const v = mhCount[m]![h]! > 0 ? mhSum[m]![h]! / mhCount[m]![h]! : monthMean
      row.push(monthMean !== 0 ? v / monthMean : 1)
    }
    const rowSum = row.reduce((s, v) => s + v, 0)
    const scale = rowSum > 0 ? 24 / rowSum : 1
    diurnalByMonth.push(row.map((v) => v * scale))
  }

  const monthLevel: number[] = []
  for (let m = 0; m < 12; m++) {
    const mm = mCount[m]! > 0 ? mSum[m]! / mCount[m]! : annualMeanPrice
    monthLevel.push(annualMeanPrice !== 0 ? mm / annualMeanPrice : 1)
  }

  const dowMeans: number[] = []
  for (let w = 0; w < 7; w++) {
    dowMeans.push(wCount[w]! > 0 ? wSum[w]! / wCount[w]! : annualMeanPrice)
  }
  const dowOverallMean = dowMeans.reduce((s, v) => s + v, 0) / 7
  const dayOfWeekLevel = dowMeans.map((v) => (dowOverallMean !== 0 ? v / dowOverallMean : 1))

  // AR(1) on daily mean residuals in absolute €/MWh space
  const residuals: number[] = dailyMeans.map(({ monthIdx, dowIdx, mean }) => {
    const expected = annualMeanPrice * monthLevel[monthIdx]! * dayOfWeekLevel[dowIdx]!
    return mean - expected
  })

  let residualAr1 = 0.5
  let residualSigma = 10

  if (residuals.length >= 3) {
    let cov = 0
    let var0 = 0
    for (let i = 1; i < residuals.length; i++) {
      cov += residuals[i]! * residuals[i - 1]!
      var0 += residuals[i - 1]! ** 2
    }
    residualAr1 = Math.max(-0.95, Math.min(0.95, var0 > 0 ? cov / var0 : 0))
    const varTotal = residuals.reduce((s, v) => s + v ** 2, 0) / residuals.length
    const sigmaEst = Math.sqrt(Math.max(0, varTotal * (1 - residualAr1 ** 2)))
    residualSigma = sigmaEst > 0 ? sigmaEst : 10
  }

  return {
    diurnalByMonth,
    monthLevel,
    dayOfWeekLevel,
    annualMeanPrice,
    annualMeanSpread,
    residualAr1,
    residualSigma,
  }
}
