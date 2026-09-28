/**
 * AlertDetail Tests
 *
 * Tests for the expanded alert detail view showing full alert information,
 * history timeline, and action buttons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert, HistoryEntry } from '../../src/types.js'
import { _resetAlertServiceSingleton } from '../../src/services/alert-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    $source: 'engine-monitor',
    priority: 'alarm',
    state: 'unacknowledged',
    condition: true,
    latching: false,
    silenced: false,
    message: 'Engine coolant temperature high',
    group: 'engine',
    raisedAt: '2026-02-19T10:00:00.000Z',
    stateChangedAt: '2026-02-19T10:00:00.000Z',
    sourceOnline: true,
    lastSourceUpdate: '2026-02-19T10:05:00.000Z',
    stale: false,
    ...overrides
  }
}

function makeHistoryEntry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h-1',
    alertId: 'alert-1',
    eventType: 'raise',
    timestamp: '2026-02-19T10:00:00.000Z',
    ...overrides
  }
}

const fetchMock = vi.fn()

// Mock WebSocket to prevent connection attempts
class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  url: string
  constructor(url: string) {
    this.url = url
  }
  send(): void {}
  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('WebSocket', MockWebSocket)
})

afterEach(() => {
  _resetAlertServiceSingleton()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Create an alert-detail element.
 * The AlertService inside the component will fetch all alerts on connect,
 * and the component will find the matching alert by ID.
 * It also fetches history separately.
 */
async function createElement(alert: Alert, history: HistoryEntry[] = []) {
  // First fetch: AlertService.connect() fetches all alerts
  // Second fetch: fetchUiConfig() fetches UI config
  // Third fetch: history for this specific alert
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([alert])
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({})
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ entries: history, total: history.length })
    })

  const { AlertDetail } = await import('../../src/components/alert-detail.js')

  const el = new AlertDetail()
  el.alertId = alert.id
  document.body.appendChild(el)
  await el.updateComplete
  // Wait for async fetches to resolve
  await new Promise((r) => setTimeout(r, 0))
  await el.updateComplete
  // Extra tick for AlertService change event propagation
  await new Promise((r) => setTimeout(r, 0))
  await el.updateComplete
  return el
}

function shadowQuery(el: Element, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null
}

function shadowQueryAll(el: Element, selector: string): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? [])
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlertDetail', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  describe('rendering', () => {
    it('displays alert message', async () => {
      const el = await createElement(makeAlert())
      const message = shadowQuery(el, '.message')
      expect(message?.textContent).toContain('Engine coolant temperature high')
    })

    it('displays priority label', async () => {
      const el = await createElement(makeAlert({ priority: 'alarm' }))
      const priority = shadowQuery(el, '.priority')
      expect(priority?.textContent).toContain('Alarm')
    })

    it('displays state label', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged' }))
      const state = shadowQuery(el, '.state')
      expect(state?.textContent).toContain('Unacknowledged')
    })

    it('displays group', async () => {
      const el = await createElement(makeAlert({ group: 'engine' }))
      const group = shadowQuery(el, '.group')
      expect(group?.textContent).toContain('engine')
    })

    it('displays source ID', async () => {
      const el = await createElement(makeAlert({ $source: 'engine-monitor' }))
      const source = shadowQuery(el, '.source')
      expect(source?.textContent).toContain('engine-monitor')
    })

    it('displays raised timestamp', async () => {
      const el = await createElement(makeAlert())
      const detail = el.shadowRoot?.textContent
      expect(detail).toContain('2026')
    })

    it('displays stale indicator when stale', async () => {
      const el = await createElement(makeAlert({ stale: true }))
      const stale = shadowQuery(el, '.stale')
      expect(stale).not.toBeNull()
    })

    it('does not display stale indicator when not stale', async () => {
      const el = await createElement(makeAlert({ stale: false }))
      const stale = shadowQuery(el, '.stale')
      expect(stale).toBeNull()
    })

    it('displays silenced badge when silenced', async () => {
      const el = await createElement(makeAlert({ silenced: true }))
      const silenced = shadowQuery(el, '.silenced')
      expect(silenced).not.toBeNull()
    })

    it('displays data payload when present', async () => {
      const el = await createElement(makeAlert({ data: { temperature: 95.5, unit: 'celsius' } }))
      const data = shadowQuery(el, '.data')
      expect(data?.textContent).toContain('temperature')
      expect(data?.textContent).toContain('95.5')
    })

    it('hides data section when no data', async () => {
      const el = await createElement(makeAlert({ data: undefined }))
      const data = shadowQuery(el, '.data')
      expect(data).toBeNull()
    })

    it('applies priority color styling', async () => {
      const el = await createElement(makeAlert({ priority: 'emergency' }))
      const card = shadowQuery(el, '.detail-card')
      expect(card).not.toBeNull()
      const style = card?.getAttribute('style')
      expect(style).toContain('var(--priority-emergency-color)')
    })
  })

  describe('history timeline', () => {
    it('renders history entries', async () => {
      const history = [
        makeHistoryEntry({
          id: 'h-1',
          eventType: 'raise',
          timestamp: '2026-02-19T10:00:00.000Z'
        }),
        makeHistoryEntry({
          id: 'h-2',
          eventType: 'acknowledge',
          timestamp: '2026-02-19T10:05:00.000Z',
          userId: 'operator-1',
          previousState: 'unacknowledged',
          newState: 'acknowledged'
        })
      ]
      const el = await createElement(makeAlert(), history)
      const entries = shadowQueryAll(el, '.timeline-entry')
      expect(entries.length).toBe(2)
    })

    it('displays event type labels', async () => {
      const history = [
        makeHistoryEntry({ eventType: 'raise' }),
        makeHistoryEntry({ id: 'h-2', eventType: 'silence' }),
        makeHistoryEntry({ id: 'h-3', eventType: 'escalate' })
      ]
      const el = await createElement(makeAlert(), history)
      const labels = shadowQueryAll(el, '.event-type')
      const labelTexts = labels.map((l) => l.textContent?.trim())
      expect(labelTexts).toContain('Raised')
      expect(labelTexts).toContain('Silenced')
      expect(labelTexts).toContain('Escalated')
    })

    it('displays user info for acknowledge events', async () => {
      const history = [
        makeHistoryEntry({
          eventType: 'acknowledge',
          userId: 'operator-1'
        })
      ]
      const el = await createElement(makeAlert(), history)
      const text = el.shadowRoot?.textContent
      expect(text).toContain('operator-1')
    })

    it('displays escalation priority change', async () => {
      const history = [
        makeHistoryEntry({
          eventType: 'escalate',
          previousPriority: 'warning',
          newPriority: 'alarm'
        })
      ]
      const el = await createElement(makeAlert(), history)
      const text = el.shadowRoot?.textContent
      expect(text).toContain('Warning')
      expect(text).toContain('Alarm')
    })

    it('shows empty state when no history', async () => {
      const el = await createElement(makeAlert(), [])
      const empty = shadowQuery(el, '.timeline-empty')
      expect(empty).not.toBeNull()
    })

    it('shows error state when history fetch fails', async () => {
      fetchMock.mockReset()
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([makeAlert()])
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 503,
          statusText: 'Unavailable'
        })

      const { AlertDetail } = await import('../../src/components/alert-detail.js')
      const el = new AlertDetail()
      el.alertId = 'alert-1'
      document.body.appendChild(el)
      await el.updateComplete
      await new Promise((r) => setTimeout(r, 0))
      await el.updateComplete
      await new Promise((r) => setTimeout(r, 0))
      await el.updateComplete

      const error = shadowQuery(el, '.timeline-error')
      expect(error).not.toBeNull()
      expect(error?.textContent).toContain('Failed to load history')
    })

    it('uses role="list" and role="listitem" for accessibility', async () => {
      const history = [makeHistoryEntry()]
      const el = await createElement(makeAlert(), history)
      const list = shadowQuery(el, '.timeline[role="list"]')
      expect(list).not.toBeNull()
      const items = shadowQueryAll(el, '.timeline-entry[role="listitem"]')
      expect(items.length).toBe(1)
    })
  })

  describe('action buttons', () => {
    it('shows acknowledge button for unacknowledged alerts', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', priority: 'alarm' }))
      const ackBtn = shadowQuery(el, 'button[data-action="acknowledge"]')
      expect(ackBtn).not.toBeNull()
    })

    it('hides acknowledge button for acknowledged alerts', async () => {
      const el = await createElement(makeAlert({ state: 'acknowledged' }))
      const ackBtn = shadowQuery(el, 'button[data-action="acknowledge"]')
      expect(ackBtn).toBeNull()
    })

    it('shows silence button for unsilenced, unacknowledged alerts', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', silenced: false }))
      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]')
      expect(silenceBtn).not.toBeNull()
    })

    it('hides silence button for silenced alerts', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', silenced: true }))
      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]')
      expect(silenceBtn).toBeNull()
    })

    it('sends acknowledge API call on click', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', priority: 'alarm' }))

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      const ackBtn = shadowQuery(el, 'button[data-action="acknowledge"]') as HTMLButtonElement
      ackBtn.click()

      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
      expect(lastCall[0]).toContain('/alerts/alert-1/acknowledge')
      expect(lastCall[1]).toEqual({ method: 'POST' })
    })

    it('sends silence API call on click', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', silenced: false }))

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]') as HTMLButtonElement
      silenceBtn.click()

      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
      expect(lastCall[0]).toContain('/alerts/alert-1/silence')
    })

    it('disables buttons during action (actionInFlight)', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', priority: 'alarm' }))

      fetchMock.mockReturnValueOnce(new Promise(() => {}))

      const ackBtn = shadowQuery(el, 'button[data-action="acknowledge"]') as HTMLButtonElement
      ackBtn.click()
      await el.updateComplete

      const ackBtnAfter = shadowQuery(el, 'button[data-action="acknowledge"]') as HTMLButtonElement
      expect(ackBtnAfter.disabled).toBe(true)
    })

    it('shows acknowledge button for caution priority', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', priority: 'caution' }))
      const ackBtn = shadowQuery(el, 'button[data-action="acknowledge"]')
      expect(ackBtn).not.toBeNull()
    })

    it('shows dismiss button for acknowledged caution alerts', async () => {
      const el = await createElement(makeAlert({ state: 'acknowledged', priority: 'caution' }))
      const dismissBtn = shadowQuery(el, 'button[data-action="dismiss"]')
      expect(dismissBtn).not.toBeNull()
    })

    it('shows dismiss button for unacknowledged caution alerts', async () => {
      const el = await createElement(makeAlert({ state: 'unacknowledged', priority: 'caution' }))
      const dismissBtn = shadowQuery(el, 'button[data-action="dismiss"]')
      expect(dismissBtn).not.toBeNull()
    })

    // A cleared caution reaches the detail view via reconstructAlertFromHistory,
    // which hardcodes state 'normal' — dismissing it would PUT a 404.
    it('hides dismiss button for cleared caution alerts', async () => {
      const el = await createElement(makeAlert({ state: 'normal', priority: 'caution' }))
      const dismissBtn = shadowQuery(el, 'button[data-action="dismiss"]')
      expect(dismissBtn).toBeNull()
    })

    it('hides dismiss button for ack-required priorities', async () => {
      const el = await createElement(makeAlert({ state: 'acknowledged', priority: 'alarm' }))
      const dismissBtn = shadowQuery(el, 'button[data-action="dismiss"]')
      expect(dismissBtn).toBeNull()
    })

    it('sends dismiss API call on click', async () => {
      const el = await createElement(makeAlert({ state: 'acknowledged', priority: 'caution' }))

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      const dismissBtn = shadowQuery(el, 'button[data-action="dismiss"]') as HTMLButtonElement
      dismissBtn.click()

      const lastCall = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
      expect(lastCall[0]).toContain('/alerts/alert-1/condition')
      expect(lastCall[1]).toEqual({
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      })
    })

    it('renders silence button before acknowledge button in DOM order', async () => {
      const el = await createElement(
        makeAlert({ state: 'unacknowledged', priority: 'alarm', silenced: false })
      )
      const buttons = shadowQueryAll(el, 'button[data-action]')
      const actions = buttons.map((b) => b.getAttribute('data-action'))
      const silenceIdx = actions.indexOf('silence')
      const ackIdx = actions.indexOf('acknowledge')
      expect(silenceIdx).toBeGreaterThanOrEqual(0)
      expect(ackIdx).toBeGreaterThanOrEqual(0)
      expect(silenceIdx).toBeLessThan(ackIdx)
    })

    it('hides silence button when alert priority is below minAudiblePriority', async () => {
      const el = await createElement(
        makeAlert({ state: 'unacknowledged', priority: 'caution', silenced: false })
      )
      ;(el as unknown as { minAudiblePriority: string }).minAudiblePriority = 'warning'
      await el.updateComplete
      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]')
      expect(silenceBtn).toBeNull()
    })

    it('hides silence button when minAudiblePriority is off', async () => {
      const el = await createElement(
        makeAlert({ state: 'unacknowledged', priority: 'emergency', silenced: false })
      )
      ;(el as unknown as { minAudiblePriority: string }).minAudiblePriority = 'off'
      await el.updateComplete
      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]')
      expect(silenceBtn).toBeNull()
    })

    it('shows silence button when alert priority meets minAudiblePriority', async () => {
      const el = await createElement(
        makeAlert({ state: 'unacknowledged', priority: 'alarm', silenced: false })
      )
      ;(el as unknown as { minAudiblePriority: string }).minAudiblePriority = 'warning'
      await el.updateComplete
      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]')
      expect(silenceBtn).not.toBeNull()
    })

    it('has aria-labels on action buttons', async () => {
      const el = await createElement(
        makeAlert({ state: 'unacknowledged', priority: 'alarm', silenced: false })
      )
      const ackBtn = shadowQuery(el, 'button[data-action="acknowledge"]')
      expect(ackBtn?.getAttribute('aria-label')).toContain('Engine coolant temperature high')
      const silenceBtn = shadowQuery(el, 'button[data-action="silence"]')
      expect(silenceBtn?.getAttribute('aria-label')).toContain('Engine coolant temperature high')
    })
  })

  describe('close/navigation', () => {
    it('dispatches alert-detail-close event when close button clicked', async () => {
      const el = await createElement(makeAlert())
      const spy = vi.fn()
      el.addEventListener('alert-detail-close', spy)

      const closeBtn = shadowQuery(el, 'button[data-action="close"]') as HTMLButtonElement
      closeBtn.click()

      expect(spy).toHaveBeenCalledOnce()
    })
  })

  describe('error handling', () => {
    it('shows error when alert not found in service', async () => {
      fetchMock.mockReset()
      fetchMock
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([])
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: 'Not Found'
        })

      const { AlertDetail } = await import('../../src/components/alert-detail.js')
      const el = new AlertDetail()
      el.alertId = 'nonexistent'
      document.body.appendChild(el)
      await el.updateComplete
      await new Promise((r) => setTimeout(r, 0))
      await el.updateComplete
      await new Promise((r) => setTimeout(r, 0))
      await el.updateComplete

      const error = shadowQuery(el, '.error')
      expect(error).not.toBeNull()
      expect(error?.textContent).toContain('Alert not found')
    })
  })
})
