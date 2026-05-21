type SliderInputProps = {
  label: string
  value: number
  onChange: (value: number) => void
  min: number
  max: number
  step: number
  unit?: string
  readOnly?: boolean
}

export default function SliderInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  readOnly = false,
}: SliderInputProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-gray-700">
          {label}
          {unit && <span className="ml-1 text-gray-400">({unit})</span>}
        </label>
        <input
          type="number"
          value={value}
          min={min}
          max={max}
          step={step}
          readOnly={readOnly}
          onChange={(e) => {
            if (!readOnly) {
              const v = parseFloat(e.target.value)
              if (!isNaN(v)) onChange(Math.min(max, Math.max(min, v)))
            }
          }}
          className={[
            'w-20 rounded border border-gray-300 px-2 py-0.5 text-right text-xs',
            readOnly ? 'bg-gray-100 text-gray-500' : 'bg-white text-black',
          ].join(' ')}
        />
      </div>
      {!readOnly && (
        <input
          type="range"
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="h-1.5 w-full cursor-pointer accent-blue-600"
        />
      )}
    </div>
  )
}
