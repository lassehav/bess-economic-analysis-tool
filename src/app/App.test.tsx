import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import App from './App'

describe('App', () => {
  it('renders the BESS Analyzer header', () => {
    render(<App />)
    expect(screen.getByText('BESS Analyzer')).toBeInTheDocument()
  })

  it('renders all navigation tabs', () => {
    render(<App />)
    // 'Historical Data' appears in both the nav button and the active-tab panel,
    // so use getAllByText and assert at least one match exists.
    expect(screen.getAllByText('Historical Data').length).toBeGreaterThan(0)
    expect(screen.getByText('Parameters')).toBeInTheDocument()
    expect(screen.getByText('Results')).toBeInTheDocument()
  })
})
