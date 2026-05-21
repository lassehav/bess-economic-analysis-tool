import { useState, useMemo, useRef, useEffect } from 'react'
import { useForm, Controller } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { ZodError } from 'zod'
import type { Inputs } from '../../core/types/inputs'
import { inputsSchema } from '../../core/types/schemas'
import { computeCapex } from '../../core/economics/index'
import SliderInput from '../../ui/SliderInput'

// ─── Presets ──────────────────────────────────────────────────────────────────

const PRESET_LFP_4H: Inputs = {
  battery: {
    powerMW: 10,
    energyMWh: 40,
    roundTripEfficiency: 0.88,
    dod: 0.9,
    maxCyclesPerDay: 2,
    nominalCycleLifeEFC: 6000,
    calendarLifeYears: 20,
    cyclesPerDayPenaltyExponent: 1.5,
    endOfLifeSoH: 0.80,
  },
  costs: {
    batteryCapexPerKWh: 200,
    pcsCapexPerKW: 60,
    bopCapexPercentOfBatteryPcs: 5,
    developmentCapexPercent: 3,
    contingencyPercent: 5,
    pcsReplacementIntervalYears: 12,
    pcsReplacementCostPercentOfPcs: 50,
    fixedOmPerKWPerYear: 10,
    variableOmPerMWhThroughput: 0.5,
    insurancePercentOfCapexPerYear: 0.5,
    landLeasePerYear: 2000,
    gridFeePerMWhThroughput: 1,
    gridFeePerKWPerYear: 2,
    inflationPercentPerYear: 2,
    omEscalationPercentPerYear: 0,
  },
  finance: {
    projectLifeYears: 20,
    wacc: 6,
    taxRate: 20,
    depreciationYears: 15,
    residualValuePercentOfInitialCapex: 5,
  },
}

const PRESET_LFP_2H: Inputs = {
  ...PRESET_LFP_4H,
  battery: {
    ...PRESET_LFP_4H.battery,
    energyMWh: 20,
    maxCyclesPerDay: 3,
    nominalCycleLifeEFC: 8000,
  },
  costs: {
    ...PRESET_LFP_4H.costs,
    batteryCapexPerKWh: 180,
  },
}

const PRESET_NMC_1H: Inputs = {
  ...PRESET_LFP_4H,
  battery: {
    ...PRESET_LFP_4H.battery,
    energyMWh: 10,
    maxCyclesPerDay: 3,
    roundTripEfficiency: 0.88,
    nominalCycleLifeEFC: 4000,
    endOfLifeSoH: 0.75,
  },
  costs: {
    ...PRESET_LFP_4H.costs,
    batteryCapexPerKWh: 220,
  },
}

const PRESET_LFP_8H: Inputs = {
  ...PRESET_LFP_4H,
  battery: {
    ...PRESET_LFP_4H.battery,
    energyMWh: 80,
    maxCyclesPerDay: 1,
    nominalCycleLifeEFC: 5000,
  },
  costs: {
    ...PRESET_LFP_4H.costs,
    batteryCapexPerKWh: 160,
  },
}

const BUILTIN_PRESETS: Record<string, Inputs> = {
  'LFP 4h utility (default)': PRESET_LFP_4H,
  'LFP 2h fast-cycling': PRESET_LFP_2H,
  'NMC 1h peaking': PRESET_NMC_1H,
  'Long-duration LFP 8h': PRESET_LFP_8H,
}

const LS_KEY_PREFIX = 'bess-analyzer.parameters.'

function loadSavedNames(): string[] {
  const names: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(LS_KEY_PREFIX)) {
      names.push(key.slice(LS_KEY_PREFIX.length))
    }
  }
  return names
}

function savePreset(name: string, inputs: Inputs): void {
  localStorage.setItem(LS_KEY_PREFIX + name, JSON.stringify(inputs))
}

function loadPreset(name: string): Inputs | null {
  const raw = localStorage.getItem(LS_KEY_PREFIX + name)
  if (!raw) return null
  try {
    return inputsSchema.parse(JSON.parse(raw))
  } catch {
    return null
  }
}

// ─── Section wrapper ──────────────────────────────────────────────────────────

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className="rounded border border-gray-200">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-semibold hover:bg-gray-50"
      >
        <span>{title}</span>
        <span className="text-gray-400 text-base leading-none">{open ? '−' : '+'}</span>
      </button>
      {open && <div className="flex flex-col gap-3 px-3 pb-3">{children}</div>}
    </div>
  )
}

// ─── Field helpers ────────────────────────────────────────────────────────────

function NumericField({
  label,
  unit,
  error,
  children,
}: {
  label: string
  unit?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="text-xs font-medium text-gray-700">
        {label}
        {unit && <span className="ml-1 text-gray-400">({unit})</span>}
      </label>
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  )
}

const inputCls =
  'w-full rounded border border-gray-300 px-2 py-1 text-sm focus:border-blue-600 focus:outline-none'

// ─── Derived values panel ─────────────────────────────────────────────────────

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-block cursor-default">
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-gray-200 text-xs font-bold text-gray-600 select-none">
        i
      </span>
      <span className="absolute left-5 top-0 z-10 hidden w-72 rounded border border-gray-200 bg-white px-2.5 py-2 text-xs text-gray-600 shadow-md group-hover:block">
        {text}
      </span>
    </span>
  )
}

function DerivedPanel({ inputs }: { inputs: Inputs }) {
  const derived = useMemo(() => {
    const { battery, costs, finance } = inputs
    const capex = computeCapex(inputs)
    const nameplateKWh = battery.energyMWh * 1000
    const capexPerKWh = nameplateKWh > 0 ? capex.total / nameplateKWh : 0
    const duration = battery.powerMW > 0 ? battery.energyMWh / battery.powerMW : 0
    const totalLifetimeThroughput = battery.energyMWh * battery.dod * battery.nominalCycleLifeEFC
    const pureMdc = totalLifetimeThroughput > 0 ? capex.total / totalLifetimeThroughput : 0

    // SoH(t) at 1 cpd:
    // degradation formula: fraction_cycle = EFC_at_t / nomLife, fraction_cal = t / calLife
    // with penalty for cpd=1: penalty = 1^exponent = 1
    // SoH(t) = max(0, 1 - (1-eol) * (fraction_cycle + fraction_cal))
    // Using additive model: SoH(t) = 1 - (1-eol) * (EFC_at_t/nomLife + t/calLife)
    const eol = battery.endOfLifeSoH
    const sohAt = (t: number): number => {
      const efcAtT = 365 * t
      const fracCycle = efcAtT / battery.nominalCycleLifeEFC
      const fracCal = t / battery.calendarLifeYears
      return Math.max(0, 1 - (1 - eol) * (fracCycle + fracCal))
    }

    const eolCapacity = battery.energyMWh * battery.dod * eol

    // Suppress unused finance warning — finance is part of inputs used for capex
    void finance
    void costs

    return {
      capexTotal: capex.total,
      capexPerKWh,
      duration,
      pureMdc,
      soh5: sohAt(5),
      soh10: sohAt(10),
      soh15: sohAt(15),
      soh20: sohAt(20),
      eolCapacity,
    }
  }, [inputs])

  const fmt0 = (v: number) => v.toLocaleString('fi-FI', { maximumFractionDigits: 0 })
  const fmt2 = (v: number) => v.toFixed(2)
  const fmt1 = (v: number) => v.toFixed(1)

  return (
    <div className="flex flex-col gap-3 rounded border border-gray-200 p-3">
      <h3 className="text-sm font-semibold">Derived Values</h3>

      <div className="flex flex-col gap-1.5 text-xs">
        <div className="flex justify-between border-b border-gray-100 pb-1">
          <span className="text-gray-500">Total CAPEX</span>
          <span className="font-medium">{fmt0(derived.capexTotal)} €</span>
        </div>
        <div className="flex justify-between border-b border-gray-100 pb-1">
          <span className="text-gray-500">CAPEX / kWh nameplate</span>
          <span className="font-medium">{fmt2(derived.capexPerKWh)} €/kWh</span>
        </div>
        <div className="flex justify-between border-b border-gray-100 pb-1">
          <span className="text-gray-500">Duration D = E/P</span>
          <span className="font-medium">{fmt2(derived.duration)} h</span>
        </div>
        <div className="flex justify-between border-b border-gray-100 pb-1">
          <span className="flex items-center text-gray-500">
            Pure-capital MDC
            <InfoTooltip
              text={
                'Pure-capital MDC (Marginal Degradation Cost):\n\nMDC = Total CAPEX ÷ (Energy × DoD × Cycle Life EFC)\n\nSpread over total lifetime throughput (MWh). Constant over time — reflects only capital cost per MWh dispatched; O&M and replacement costs are excluded.'
              }
            />
          </span>
          <span className="font-medium">{fmt2(derived.pureMdc)} €/MWh</span>
        </div>

        <div className="mt-1 text-gray-500 font-medium">SoH at 1 cpd</div>
        {([5, 10, 15, 20] as const).map((yr) => {
          const soh = yr === 5 ? derived.soh5 : yr === 10 ? derived.soh10 : yr === 15 ? derived.soh15 : derived.soh20
          return (
            <div key={yr} className="flex justify-between border-b border-gray-100 pb-1">
              <span className="text-gray-500">Year {yr}</span>
              <span className="font-medium">{(soh * 100).toFixed(1)} %</span>
            </div>
          )
        })}

        <div className="flex justify-between border-b border-gray-100 pb-1">
          <span className="text-gray-500">Capacity at EoL</span>
          <span className="font-medium">{fmt1(derived.eolCapacity)} MWh</span>
        </div>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function loadStoredInputs(): Inputs {
  try {
    const raw = JSON.parse(localStorage.getItem('bess-analyzer.inputs') ?? 'null')
    const parsed = inputsSchema.safeParse(raw)
    if (parsed.success) return parsed.data
  } catch { /* ignore */ }
  return PRESET_LFP_4H
}

export default function ParametersView() {
  const [savedNames, setSavedNames] = useState<string[]>(loadSavedNames)
  const importRef = useRef<HTMLInputElement>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const [initialValues] = useState<Inputs>(loadStoredInputs)

  const {
    control,
    watch,
    reset,
    getValues,
    formState: { errors },
  } = useForm<Inputs>({
    resolver: zodResolver(inputsSchema),
    defaultValues: initialValues,
    mode: 'onChange',
  })

  const liveValues = watch()
  // watch() returns DeepPartial on first render before all fields are registered;
  // fall back to initialValues so DerivedPanel never receives an incomplete object.
  const safeInputs = useMemo<Inputs>(() => {
    const parsed = inputsSchema.safeParse(liveValues)
    return parsed.success ? parsed.data : initialValues
  }, [liveValues, initialValues])

  useEffect(() => {
    localStorage.setItem('bess-analyzer.inputs', JSON.stringify(safeInputs))
  }, [safeInputs])

  // Preset dropdown includes built-in + saved
  const allPresetNames = [
    ...Object.keys(BUILTIN_PRESETS),
    ...savedNames.filter((n) => !(n in BUILTIN_PRESETS)),
  ]

  function handlePresetLoad(name: string) {
    if (name in BUILTIN_PRESETS) {
      const data = BUILTIN_PRESETS[name]!
      reset(data)
      localStorage.setItem('bess-analyzer.inputs', JSON.stringify(data))
      return
    }
    const loaded = loadPreset(name)
    if (loaded) {
      reset(loaded)
      localStorage.setItem('bess-analyzer.inputs', JSON.stringify(loaded))
    }
  }

  function handleSaveCurrent() {
    const name = window.prompt('Save preset as:')
    if (!name) return
    const data = getValues()
    savePreset(name, data)
    localStorage.setItem('bess-analyzer.inputs', JSON.stringify(data))
    setSavedNames(loadSavedNames())
  }

  function handleExportJson() {
    const data = JSON.stringify(getValues(), null, 2)
    const blob = new Blob([data], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'bess-parameters.json'
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleImportJson(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      try {
        const raw = JSON.parse(ev.target?.result as string)
        const parsed = inputsSchema.parse(raw)
        reset(parsed)
        setImportError(null)
      } catch (err) {
        if (err instanceof ZodError) {
          setImportError(err.errors.map((e) => e.message).join('; '))
        } else {
          setImportError('Invalid JSON file')
        }
      }
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const batteryErrors = errors.battery ?? {}
  const costsErrors = errors.costs ?? {}
  const financeErrors = errors.finance ?? {}

  return (
    <div className="flex flex-col gap-4">
      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-gray-200 pb-3">
        <select
          onChange={(e) => handlePresetLoad(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
          defaultValue=""
        >
          <option value="" disabled>
            Load preset...
          </option>
          {allPresetNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        <button
          type="button"
          onClick={handleSaveCurrent}
          className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
        >
          Save current
        </button>

        <button
          type="button"
          onClick={handleExportJson}
          className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
        >
          Export JSON
        </button>

        <button
          type="button"
          onClick={() => importRef.current?.click()}
          className="rounded border border-gray-300 px-3 py-1 text-sm hover:bg-gray-50"
        >
          Import JSON
        </button>
        <input
          ref={importRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={handleImportJson}
        />

        {importError && (
          <span className="text-xs text-red-600">{importError}</span>
        )}
      </div>

      {/* Two-column layout */}
      <div className="flex gap-6">
        {/* Left: form sections */}
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {/* 1. Battery sizing & operation */}
          <Section title="1. Battery sizing & operation">
            <Controller
              name="battery.powerMW"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="Power"
                  unit="MW"
                  value={field.value}
                  onChange={field.onChange}
                  min={1}
                  max={200}
                  step={1}
                />
              )}
            />
            {batteryErrors.powerMW && (
              <p className="text-xs text-red-600">{batteryErrors.powerMW.message}</p>
            )}

            <Controller
              name="battery.energyMWh"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="Energy"
                  unit="MWh"
                  value={field.value}
                  onChange={field.onChange}
                  min={1}
                  max={1000}
                  step={1}
                />
              )}
            />
            {batteryErrors.energyMWh && (
              <p className="text-xs text-red-600">{batteryErrors.energyMWh.message}</p>
            )}

            <Controller
              name="battery.roundTripEfficiency"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="Round-trip efficiency"
                  unit="η AC-AC"
                  value={field.value}
                  onChange={field.onChange}
                  min={0.80}
                  max={0.95}
                  step={0.01}
                />
              )}
            />
            {batteryErrors.roundTripEfficiency && (
              <p className="text-xs text-red-600">{batteryErrors.roundTripEfficiency.message}</p>
            )}

            <Controller
              name="battery.dod"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="Depth of discharge"
                  unit="DoD"
                  value={field.value}
                  onChange={field.onChange}
                  min={0.5}
                  max={1.0}
                  step={0.01}
                />
              )}
            />
            {batteryErrors.dod && (
              <p className="text-xs text-red-600">{batteryErrors.dod.message}</p>
            )}

            <Controller
              name="battery.maxCyclesPerDay"
              control={control}
              render={({ field }) => (
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-700">
                    Max cycles / day
                  </label>
                  <div className="flex gap-2">
                    {([1, 2, 3] as const).map((n) => (
                      <button
                        key={n}
                        type="button"
                        onClick={() => field.onChange(n)}
                        className={[
                          'flex-1 rounded border py-1 text-sm font-medium',
                          field.value === n
                            ? 'border-blue-600 bg-blue-50 text-blue-600'
                            : 'border-gray-300 text-gray-600 hover:border-gray-400',
                        ].join(' ')}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            />

          </Section>

          {/* 2. Battery degradation */}
          <Section title="2. Battery degradation">
            <Controller
              name="battery.nominalCycleLifeEFC"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="Nominal cycle life"
                  unit="EFC"
                  value={field.value}
                  onChange={field.onChange}
                  min={500}
                  max={12000}
                  step={100}
                />
              )}
            />
            {batteryErrors.nominalCycleLifeEFC && (
              <p className="text-xs text-red-600">{batteryErrors.nominalCycleLifeEFC.message}</p>
            )}

            <Controller
              name="battery.calendarLifeYears"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Calendar life"
                  unit="years"
                  error={batteryErrors.calendarLifeYears?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={1}
                    max={30}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="battery.cyclesPerDayPenaltyExponent"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Cycles/day penalty exponent"
                  error={batteryErrors.cyclesPerDayPenaltyExponent?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0.5}
                    max={3.0}
                    step={0.1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="battery.endOfLifeSoH"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="End-of-life SoH"
                  error={batteryErrors.endOfLifeSoH?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0.01}
                    max={0.99}
                    step={0.01}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />
          </Section>

          {/* 3. CAPEX */}
          <Section title="3. CAPEX">
            <Controller
              name="costs.batteryCapexPerKWh"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="Battery CAPEX"
                  unit="€/kWh"
                  value={field.value}
                  onChange={field.onChange}
                  min={50}
                  max={500}
                  step={5}
                />
              )}
            />
            {costsErrors.batteryCapexPerKWh && (
              <p className="text-xs text-red-600">{costsErrors.batteryCapexPerKWh.message}</p>
            )}

            <Controller
              name="costs.pcsCapexPerKW"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="PCS CAPEX"
                  unit="€/kW"
                  error={costsErrors.pcsCapexPerKW?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={20}
                    max={300}
                    step={5}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.bopCapexPercentOfBatteryPcs"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="BoP CAPEX"
                  unit="% of battery+PCS"
                  error={costsErrors.bopCapexPercentOfBatteryPcs?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={0.5}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.developmentCapexPercent"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Development CAPEX"
                  unit="%"
                  error={costsErrors.developmentCapexPercent?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={0.5}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.contingencyPercent"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Contingency"
                  unit="%"
                  error={costsErrors.contingencyPercent?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={0.5}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />
          </Section>

          {/* 4. PCS replacement */}
          <Section title="4. PCS replacement">
            <Controller
              name="costs.pcsReplacementIntervalYears"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Replacement interval"
                  unit="years"
                  error={costsErrors.pcsReplacementIntervalYears?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={5}
                    max={30}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.pcsReplacementCostPercentOfPcs"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Replacement cost"
                  unit="% of PCS CAPEX"
                  error={costsErrors.pcsReplacementCostPercentOfPcs?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />
          </Section>

          {/* 5. OPEX */}
          <Section title="5. OPEX">
            <Controller
              name="costs.fixedOmPerKWPerYear"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Fixed O&M"
                  unit="€/kW/year"
                  error={costsErrors.fixedOmPerKWPerYear?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    step={0.5}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.variableOmPerMWhThroughput"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Variable O&M"
                  unit="€/MWh throughput"
                  error={costsErrors.variableOmPerMWhThroughput?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    step={0.1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.insurancePercentOfCapexPerYear"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Insurance"
                  unit="% of CAPEX/year"
                  error={costsErrors.insurancePercentOfCapexPerYear?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={0.1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.landLeasePerYear"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Land lease"
                  unit="€/year"
                  error={costsErrors.landLeasePerYear?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    step={1000}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.gridFeePerMWhThroughput"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Grid fee"
                  unit="€/MWh throughput"
                  error={costsErrors.gridFeePerMWhThroughput?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    step={0.1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.gridFeePerKWPerYear"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Grid fee"
                  unit="€/kW/year"
                  error={costsErrors.gridFeePerKWPerYear?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    step={0.5}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.inflationPercentPerYear"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Inflation"
                  unit="%/year"
                  error={costsErrors.inflationPercentPerYear?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={0.1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="costs.omEscalationPercentPerYear"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="O&M escalation (above inflation)"
                  unit="%/year"
                  error={costsErrors.omEscalationPercentPerYear?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={0.1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />
          </Section>

          {/* 6. Finance */}
          <Section title="6. Finance">
            <Controller
              name="finance.projectLifeYears"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Project life"
                  unit="years"
                  error={financeErrors.projectLifeYears?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={5}
                    max={40}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="finance.wacc"
              control={control}
              render={({ field }) => (
                <SliderInput
                  label="WACC"
                  unit="%"
                  value={field.value}
                  onChange={field.onChange}
                  min={0}
                  max={20}
                  step={0.5}
                />
              )}
            />
            {financeErrors.wacc && (
              <p className="text-xs text-red-600">{financeErrors.wacc.message}</p>
            )}

            <Controller
              name="finance.taxRate"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Tax rate"
                  unit="%"
                  error={financeErrors.taxRate?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={60}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="finance.depreciationYears"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Depreciation period"
                  unit="years"
                  error={financeErrors.depreciationYears?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={1}
                    max={40}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

            <Controller
              name="finance.residualValuePercentOfInitialCapex"
              control={control}
              render={({ field }) => (
                <NumericField
                  label="Residual value"
                  unit="% of initial CAPEX"
                  error={financeErrors.residualValuePercentOfInitialCapex?.message}
                >
                  <input
                    type="number"
                    value={field.value}
                    onChange={(e) => field.onChange(parseFloat(e.target.value))}
                    min={0}
                    max={100}
                    step={1}
                    className={inputCls}
                  />
                </NumericField>
              )}
            />

          </Section>
        </div>

        {/* Right: derived values */}
        <div className="w-64 shrink-0">
          <DerivedPanel inputs={safeInputs} />
        </div>
      </div>
    </div>
  )
}
