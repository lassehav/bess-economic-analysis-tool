import { runMonteCarlo } from './montecarlo'
import type { MCRequest, MCResult } from './montecarlo'

export type WorkerProgressMessage = { type: 'progress'; completed: number; total: number }
export type WorkerResultMessage = { type: 'result'; result: MCResult }
export type WorkerErrorMessage = { type: 'error'; error: string }

self.onmessage = (e: MessageEvent<MCRequest>) => {
  const req = e.data
  try {
    const result = runMonteCarlo(req, (completed, total) => {
      self.postMessage({ type: 'progress', completed, total } satisfies WorkerProgressMessage)
    })
    self.postMessage({ type: 'result', result } satisfies WorkerResultMessage)
  } catch (err) {
    self.postMessage({ type: 'error', error: String(err) } satisfies WorkerErrorMessage)
  }
}
