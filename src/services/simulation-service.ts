/**
 * SimulationService — generates random alerts for UI development and demos.
 *
 * Entirely client-side: calls the existing REST API to raise alerts and
 * clear conditions. Start/stop via the toggle in the AlertList toolbar.
 */

import type { Alert, AlertPriority } from '../types.js'

const API_BASE = '/plugins/signalk-alert-manager'
const TICK_MS = 2000

const RAISE_PROBABILITY = 0.114
const CLEAR_ACKED_PROBABILITY = 0.133
const CLEAR_UNACKED_PROBABILITY = 0.017

const PRIORITY_WEIGHTS: Array<{ priority: AlertPriority; weight: number }> = [
  { priority: 'emergency', weight: 0.05 },
  { priority: 'alarm', weight: 0.15 },
  { priority: 'warning', weight: 0.4 },
  { priority: 'caution', weight: 0.4 }
]

const SCENARIOS: Array<{ message: string; group: string }> = [
  { message: 'Engine coolant temperature high', group: 'engine' },
  { message: 'Low oil pressure', group: 'engine' },
  { message: 'Battery voltage below threshold', group: 'electrical' },
  { message: 'Bilge water level high', group: 'safety' },
  { message: 'GPS signal lost', group: 'navigation' },
  { message: 'AIS target CPA alarm', group: 'navigation' },
  { message: 'Anchor drag detected', group: 'navigation' },
  { message: 'Depth below minimum', group: 'navigation' },
  { message: 'Fuel level low', group: 'engine' },
  { message: 'Rudder angle sensor fault', group: 'steering' }
]

export class SimulationService {
  private intervalId: ReturnType<typeof setInterval> | null = null
  private counter = 0
  private getAlerts: () => Alert[]

  constructor(getAlerts: () => Alert[]) {
    this.getAlerts = getAlerts
  }

  get running(): boolean {
    return this.intervalId !== null
  }

  start(): void {
    if (this.intervalId !== null) return
    this.intervalId = setInterval(() => this.tick(), TICK_MS)
  }

  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }

  /** Single simulation tick — fire-and-forget, no awaiting. */
  private tick(): void {
    const alerts = this.getAlerts()

    // Always raise if there are no alerts, otherwise use probability
    if (alerts.length === 0 || Math.random() < RAISE_PROBABILITY) {
      this.raiseRandomAlert()
    }

    for (const alert of alerts) {
      const threshold =
        alert.state === 'acknowledged' ? CLEAR_ACKED_PROBABILITY : CLEAR_UNACKED_PROBABILITY
      if (Math.random() < threshold) {
        this.clearAlert(alert.id)
      }
    }
  }

  private raiseRandomAlert(): void {
    const scenario = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)]
    const { priority } = pickWeighted(PRIORITY_WEIGHTS)
    const latching = Math.random() < 0.3
    const $source = `simulation-${String(++this.counter)}`
    const path = `${scenario.group}.sim-${String(this.counter)}`

    fetch(`${API_BASE}/alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path,
        $source,
        priority,
        message: `SIM: ${scenario.message}`,
        group: scenario.group,
        latching
      })
    }).catch(() => {
      // Fire-and-forget
    })
  }

  private clearAlert(id: string): void {
    fetch(`${API_BASE}/alerts/${id}/condition`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    }).catch(() => {
      // Fire-and-forget
    })
  }
}

/** Pick a value from a weighted distribution. Exported for testing. */
export function pickWeighted<T>(items: Array<{ weight: number } & T>): T {
  const r = Math.random()
  let cumulative = 0
  for (const item of items) {
    cumulative += item.weight
    if (r < cumulative) return item
  }
  return items[items.length - 1]
}
