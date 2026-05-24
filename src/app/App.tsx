import { useState } from 'react'
import HistoricalView from '../features/historical/HistoricalView'
import ParametersView from '../features/parameters/ParametersView'
import SimulationView from '../features/simulation/SimulationView'
import ScenariosView from '../features/scenarios/ScenariosView'
import SensitivityView from '../features/sensitivity/SensitivityView'
import MonteCarloView from '../features/montecarlo/MonteCarloView'
import type { MultiYearForecastOutput } from '../core/forecast/types'

const TABS = [
  {
    id: 'historical',
    step: 1,
    label: 'Historical Data',
    description: 'Explore real Finnish spot prices and measure actual arbitrage opportunity.',
  },
  {
    id: 'parameters',
    step: 2,
    label: 'Parameters',
    description: 'Define your battery system, CAPEX, OPEX, and financing assumptions.',
  },
  {
    id: 'scenarios',
    step: 3,
    label: 'Scenarios',
    description: 'Build a market forecast — synthetic future prices driven by grid capacity evolution.',
  },
  {
    id: 'simulation',
    step: 4,
    label: 'Simulation',
    description: 'Run a deterministic projection on historical prices or your scenario forecast.',
  },
  {
    id: 'sensitivity',
    step: 5,
    label: 'Sensitivity',
    description: 'Identify which parameters drive NPV/IRR/LCOS the most.',
  },
  {
    id: 'montecarlo',
    step: 6,
    label: 'Monte Carlo',
    description: 'Quantify investment risk by sampling correlated uncertainties across thousands of trials.',
  },
  {
    id: 'results',
    step: 7,
    label: 'Results',
    description: 'Consolidated summary and export.',
  },
] as const

type TabId = (typeof TABS)[number]['id']

export default function App() {
  const [activeTab, setActiveTab] = useState<TabId>('historical')
  const [forecastOutput, setForecastOutput] = useState<MultiYearForecastOutput | null>(null)

  const currentIndex = TABS.findIndex((t) => t.id === activeTab)
  const nextTab = TABS[currentIndex + 1] ?? null

  return (
    <div className="min-h-screen bg-white text-black">
      <header className="border-b border-black px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight">BESS Analyzer | Lasse Haverinen</h1>
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
              <span className="mr-1.5 font-normal opacity-50">{tab.step}.</span>
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="p-6">
        <div className="flex flex-col gap-6">
          {activeTab === 'historical' ? (
            <HistoricalView />
          ) : activeTab === 'parameters' ? (
            <ParametersView />
          ) : activeTab === 'simulation' ? (
            <SimulationView />
          ) : activeTab === 'scenarios' ? (
            <ScenariosView
              forecastOutput={forecastOutput}
              onForecastOutputChange={setForecastOutput}
              onNavigateToSimulation={() => setActiveTab('simulation')}
            />
          ) : activeTab === 'sensitivity' ? (
            <SensitivityView />
          ) : activeTab === 'montecarlo' ? (
            <MonteCarloView />
          ) : (
            <div className="rounded-lg border border-gray-200 p-8 text-center text-gray-400">
              <p className="text-lg font-medium text-black">{TABS.find((t) => t.id === activeTab)?.label}</p>
              <p className="mt-2 text-sm">This section will be implemented in a later phase.</p>
            </div>
          )}

          {nextTab && nextTab.id !== 'results' && (
            <div className="border-t border-gray-200 pt-5">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-400">
                  Next: <span className="font-medium text-gray-600">Step {nextTab.step} — {nextTab.label}</span>
                  <span className="ml-2 text-gray-400">{nextTab.description}</span>
                </p>
                <button
                  onClick={() => setActiveTab(nextTab.id)}
                  className="flex items-center gap-2 rounded bg-blue-600 px-5 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Move to {nextTab.label}
                  <span aria-hidden>→</span>
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
