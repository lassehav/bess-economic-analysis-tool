const TABS = [
  { id: 'historical', label: 'Historical Data' },
  { id: 'parameters', label: 'Parameters' },
  { id: 'simulation', label: 'Simulation' },
  { id: 'scenarios', label: 'Scenarios' },
  { id: 'sensitivity', label: 'Sensitivity' },
  { id: 'montecarlo', label: 'Monte Carlo' },
  { id: 'results', label: 'Results' },
] as const

type TabId = (typeof TABS)[number]['id']

import { useState } from 'react'

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('historical')

  return (
    <div className="min-h-screen bg-white text-black">
      <header className="border-b border-black px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">BESS Analyzer</h1>
        <p className="mt-0.5 text-sm text-gray-500">
          Battery Energy Storage — LCOS &amp; Economic Profitability
        </p>
      </header>

      <nav className="border-b border-black px-6">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={[
                'whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-b-2 border-blue-600 text-blue-600'
                  : 'text-gray-500 hover:text-black',
              ].join(' ')}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="p-6">
        <div className="rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          <p className="text-lg font-medium text-black">{TABS.find((t) => t.id === activeTab)?.label}</p>
          <p className="mt-2 text-sm">This section will be implemented in a later phase.</p>
        </div>
      </main>
    </div>
  )
}
