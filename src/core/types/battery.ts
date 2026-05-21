export type BatterySpec = {
  powerMW: number
  energyMWh: number
  roundTripEfficiency: number  // η_RTE, e.g. 0.85
  dod: number                  // usable fraction, e.g. 0.90
  maxCyclesPerDay: 1 | 2 | 3
  initialSocMWh?: number       // defaults to 0
}
