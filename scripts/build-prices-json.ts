import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const ROOT = path.resolve(__dirname, '..')

// ─── CET/CEST helpers ────────────────────────────────────────────────────────

function lastSunday(year: number, month: number): number {
  // Returns the day-of-month of the last Sunday in the given month
  const d = new Date(Date.UTC(year, month + 1, 0)) // last day of month
  return d.getUTCDate() - d.getUTCDay()
}

function getCetOffset(date: Date): number {
  // Returns 1 for CET (winter) or 2 for CEST (summer)
  // European DST: last Sunday of March 01:00 UTC → CEST; last Sunday of October 01:00 UTC → CET
  const year = date.getUTCFullYear()
  const lastSundayMarch = lastSunday(year, 2)   // month index 2 = March
  const lastSundayOctober = lastSunday(year, 9) // month index 9 = October
  const springForward = Date.UTC(year, 2, lastSundayMarch, 1, 0, 0)
  const fallBack = Date.UTC(year, 9, lastSundayOctober, 1, 0, 0)
  if (date.getTime() >= springForward && date.getTime() < fallBack) return 2
  return 1
}

/** Parse "DD/MM/YYYY HH:MM:SS - DD/MM/YYYY HH:MM:SS" and return UTC ISO of start. */
function parseMtuStart(mtu: string): string {
  // Take the start part before " - "
  const startPart = mtu.split(' - ')[0]!.trim()
  // Format: DD/MM/YYYY HH:MM:SS
  const [datePart, timePart] = startPart.split(' ')
  if (!datePart || !timePart) throw new Error(`Cannot parse MTU: ${mtu}`)
  const [dd, mm, yyyy] = datePart.split('/')
  const [hh, min, ss] = timePart.split(':')
  if (!dd || !mm || !yyyy || !hh || !min || !ss) throw new Error(`Cannot parse MTU date: ${mtu}`)

  const day = parseInt(dd, 10)
  const month = parseInt(mm, 10) - 1 // 0-based
  const year = parseInt(yyyy, 10)
  const hour = parseInt(hh, 10)
  const minute = parseInt(min, 10)
  const second = parseInt(ss, 10)

  // The timestamp is in CET/CEST. We need to figure out which offset to use.
  // We estimate using a first-pass UTC assumption, then apply correct offset.
  // Trick: try UTC+2 first, compute the UTC time, check what offset that UTC time implies.
  // Actually: the local time is CET/CEST. We need to find UTC such that UTC + offset = local.
  // The offset at the local time depends on UTC, creating a chicken-and-egg.
  // For DST transition hours we must pick consistently:
  // Strategy: compute UTC from offset=2, check if that UTC gives offset=2; if not use offset=1.
  const localMs = Date.UTC(year, month, day, hour, minute, second)
  const utcMsGuess2 = localMs - 2 * 3600_000
  const guessDate2 = new Date(utcMsGuess2)
  const offset = getCetOffset(guessDate2)
  const utcMs = localMs - offset * 3600_000
  return new Date(utcMs).toISOString()
}

/** Detect interval in minutes from the MTU string. */
function detectIntervalMinutes(mtu: string): number {
  const parts = mtu.split(' - ')
  if (parts.length !== 2) return 60
  const start = new Date(parseMtuStart(parts[0]!.trim() + ' - ' + parts[1]!.trim())).getTime()
  // Actually parse both sides
  const startUtc = parseMtuStart(mtu)
  const endPart = parts[1]!.trim()
  // Parse end using same logic
  const [datePart, timePart] = endPart.split(' ')
  if (!datePart || !timePart) return 60
  const [dd, mm, yyyy] = datePart.split('/')
  const [hh, minStr, ss] = timePart.split(':')
  if (!dd || !mm || !yyyy || !hh || !minStr || !ss) return 60
  const day = parseInt(dd, 10)
  const month = parseInt(mm, 10) - 1
  const year = parseInt(yyyy, 10)
  const hour = parseInt(hh, 10)
  const minute = parseInt(minStr, 10)
  const second = parseInt(ss, 10)
  const localMs = Date.UTC(year, month, day, hour, minute, second)
  const utcMsGuess2 = localMs - 2 * 3600_000
  const guessDate2 = new Date(utcMsGuess2)
  const offset = getCetOffset(guessDate2)
  const endMs = localMs - offset * 3600_000
  const startMs = new Date(startUtc).getTime()
  const diffMs = endMs - startMs
  return Math.round(diffMs / 60_000)
}

// ─── CSV parsing ─────────────────────────────────────────────────────────────

type CsvRow = {
  'MTU (CET/CEST)': string
  'Day-ahead Price (EUR/MWh)': string
}

type HourlyEntry = { utcMs: number; price: number }

function parseCsvFile(filePath: string): HourlyEntry[] {
  const content = fs.readFileSync(filePath, 'utf-8')
  const result = Papa.parse<CsvRow>(content, { header: true, skipEmptyLines: true })

  if (result.errors.length > 0) {
    console.warn(`Warnings parsing ${path.basename(filePath)}:`, result.errors.slice(0, 3))
  }

  const rawEntries: HourlyEntry[] = []

  for (const row of result.data) {
    const mtu = row['MTU (CET/CEST)']?.trim()
    const priceStr = row['Day-ahead Price (EUR/MWh)']?.trim()
    if (!mtu || !priceStr) continue
    const price = parseFloat(priceStr)
    if (isNaN(price)) continue
    const utcIso = parseMtuStart(mtu)
    rawEntries.push({ utcMs: new Date(utcIso).getTime(), price })
  }

  if (rawEntries.length === 0) return []

  // Detect resolution from first row
  const firstRow = result.data[0]
  const firstMtu = firstRow?.['MTU (CET/CEST)']?.trim()
  const intervalMin = firstMtu ? detectIntervalMinutes(firstMtu) : 60

  console.log(
    `  ${path.basename(filePath)}: ${rawEntries.length} rows, resolution=${intervalMin} min`,
  )

  if (intervalMin === 60) {
    // Already hourly
    return rawEntries
  }

  // Downsample 15-min → hourly: group by UTC hour bucket, average prices
  const buckets = new Map<number, number[]>()
  for (const entry of rawEntries) {
    const hourBucket = Math.floor(entry.utcMs / 3_600_000) * 3_600_000
    const arr = buckets.get(hourBucket)
    if (arr) {
      arr.push(entry.price)
    } else {
      buckets.set(hourBucket, [entry.price])
    }
  }

  const hourly: HourlyEntry[] = []
  for (const [utcMs, prices] of buckets) {
    const sum = prices.reduce((a, b) => a + b, 0)
    hourly.push({ utcMs, price: sum / prices.length })
  }
  return hourly
}

// ─── Output schema ────────────────────────────────────────────────────────────

type Gap = { startUtc: string; endUtc: string; reason: string }

type PriceSeries = {
  source: 'ENTSO-E FI day-ahead'
  generatedAt: string
  startUtc: string
  endUtc: string
  resolutionMinutes: 60
  prices: number[]
  gaps: Gap[]
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const CSV_FILES = [
  'GUI_ENERGY_PRICES_202312312300-202412312300.csv',
  'GUI_ENERGY_PRICES_202412312300-202512312300.csv',
  'GUI_ENERGY_PRICES_202512312300-202612312300.csv',
]

console.log('Building fi-prices.json from ENTSO-E CSV files...')

const allEntries: HourlyEntry[] = []

for (const file of CSV_FILES) {
  const filePath = path.join(ROOT, file)
  if (!fs.existsSync(filePath)) {
    console.warn(`  File not found: ${file}`)
    continue
  }
  const entries = parseCsvFile(filePath)
  allEntries.push(...entries)
}

// Sort by UTC timestamp
allEntries.sort((a, b) => a.utcMs - b.utcMs)

// Deduplicate (keep first occurrence per hour bucket)
const deduped: HourlyEntry[] = []
let prevMs = -Infinity
for (const entry of allEntries) {
  if (entry.utcMs !== prevMs) {
    deduped.push(entry)
    prevMs = entry.utcMs
  }
}

// Detect gaps (where consecutive entries are more than 1 hour apart)
const HOUR_MS = 3_600_000
const gaps: Gap[] = []

for (let i = 1; i < deduped.length; i++) {
  const prev = deduped[i - 1]!
  const curr = deduped[i]!
  const diff = curr.utcMs - prev.utcMs
  if (diff > HOUR_MS) {
    gaps.push({
      startUtc: new Date(prev.utcMs + HOUR_MS).toISOString(),
      endUtc: new Date(curr.utcMs).toISOString(),
      reason: 'missing data',
    })
    console.warn(
      `  GAP detected: ${new Date(prev.utcMs + HOUR_MS).toISOString()} → ${new Date(curr.utcMs).toISOString()} (${diff / HOUR_MS - 1} missing hours)`,
    )
  }
}

if (deduped.length === 0) {
  console.error('No price data found!')
  process.exit(1)
}

const firstEntry = deduped[0]!
const lastEntry = deduped[deduped.length - 1]!

const series: PriceSeries = {
  source: 'ENTSO-E FI day-ahead',
  generatedAt: new Date().toISOString(),
  startUtc: new Date(firstEntry.utcMs).toISOString(),
  endUtc: new Date(lastEntry.utcMs + HOUR_MS).toISOString(),
  resolutionMinutes: 60,
  prices: deduped.map((e) => e.price),
  gaps,
}

const outDir = path.join(ROOT, 'public', 'data')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'fi-prices.json')
fs.writeFileSync(outPath, JSON.stringify(series), 'utf-8')

console.log('\nDone!')
console.log(`  Entries: ${series.prices.length}`)
console.log(`  Range:   ${series.startUtc} → ${series.endUtc}`)
console.log(`  Gaps:    ${gaps.length}`)
console.log(`  Output:  ${outPath}`)
