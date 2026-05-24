import { useState, useEffect } from 'react'
import HistoricalView from '../features/historical/HistoricalView'
import ParametersView from '../features/parameters/ParametersView'
import SimulationView from '../features/simulation/SimulationView'
import ScenariosView from '../features/scenarios/ScenariosView'
import SensitivityView from '../features/sensitivity/SensitivityView'
import MonteCarloView from '../features/montecarlo/MonteCarloView'
import ResultsView from '../features/results/ResultsView'
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
  const [mountedTabs, setMountedTabs] = useState<Set<TabId>>(new Set<TabId>(['historical']))
  const [forecastOutput, setForecastOutput] = useState<MultiYearForecastOutput | null>(null)
  const [darkMode, setDarkMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('bess-analyzer.theme') === 'dark'
    } catch { return false }
  })

  // Apply/remove the `dark` class on <html> whenever darkMode changes
  useEffect(() => {
    const root = document.documentElement
    if (darkMode) {
      root.classList.add('dark')
    } else {
      root.classList.remove('dark')
    }
    try {
      localStorage.setItem('bess-analyzer.theme', darkMode ? 'dark' : 'light')
    } catch { /* ignore */ }
  }, [darkMode])

  const currentIndex = TABS.findIndex((t) => t.id === activeTab)
  const nextTab = TABS[currentIndex + 1] ?? null

  function handleTabChange(tabId: TabId) {
    setActiveTab(tabId)
    setMountedTabs((prev) => new Set([...prev, tabId]))
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-900 text-black dark:text-gray-100 transition-colors">
      <header className="border-b border-black dark:border-gray-700 px-6 py-4 flex items-start justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">BESS Analyzer | Lasse Haverinen</h1>
          <p className="mt-0.5 text-sm text-gray-500 dark:text-gray-400">
            Battery Energy Storage — LCOS &amp; Economic Profitability
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDarkMode((v) => !v)}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          className="ml-4 mt-0.5 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-2.5 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors select-none"
          aria-label="Toggle dark mode"
        >
          {darkMode ? '☀ Light' : '☾ Dark'}
        </button>
      </header>

      <nav className="app-nav border-b border-black dark:border-gray-700 px-6 bg-white dark:bg-gray-900">
        <div className="flex gap-1 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={[
                'whitespace-nowrap px-4 py-3 text-sm font-medium transition-colors',
                activeTab === tab.id
                  ? 'border-b-2 border-blue-600 text-blue-600'
                  : 'text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white',
              ].join(' ')}
            >
              <span className="mr-1.5 font-normal opacity-50">{tab.step}.</span>
              {tab.label}
            </button>
          ))}
        </div>
      </nav>

      <main className="p-6 bg-white dark:bg-gray-900 min-h-screen">
        <div className="flex flex-col gap-6">
          {mountedTabs.has('historical') && (
            <div className={activeTab !== 'historical' ? 'hidden' : ''}>
              <HistoricalView />
            </div>
          )}
          {mountedTabs.has('parameters') && (
            <div className={activeTab !== 'parameters' ? 'hidden' : ''}>
              <ParametersView />
            </div>
          )}
          {mountedTabs.has('scenarios') && (
            <div className={activeTab !== 'scenarios' ? 'hidden' : ''}>
              <ScenariosView
                forecastOutput={forecastOutput}
                onForecastOutputChange={setForecastOutput}
                onNavigateToSimulation={() => handleTabChange('simulation')}
              />
            </div>
          )}
          {mountedTabs.has('simulation') && (
            <div className={activeTab !== 'simulation' ? 'hidden' : ''}>
              <SimulationView />
            </div>
          )}
          {mountedTabs.has('sensitivity') && (
            <div className={activeTab !== 'sensitivity' ? 'hidden' : ''}>
              <SensitivityView />
            </div>
          )}
          {mountedTabs.has('montecarlo') && (
            <div className={activeTab !== 'montecarlo' ? 'hidden' : ''}>
              <MonteCarloView />
            </div>
          )}
          {mountedTabs.has('results') && (
            <div className={activeTab !== 'results' ? 'hidden' : ''}>
              <ResultsView />
            </div>
          )}

          {nextTab && (
            <div className="border-t border-gray-200 dark:border-gray-700 pt-5">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-400 dark:text-gray-500">
                  Next: <span className="font-medium text-gray-600 dark:text-gray-300">Step {nextTab.step} — {nextTab.label}</span>
                  <span className="ml-2 text-gray-400 dark:text-gray-500">{nextTab.description}</span>
                </p>
                <button
                  onClick={() => handleTabChange(nextTab.id)}
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
