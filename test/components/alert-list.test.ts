/**
 * AlertList and AlertCard Component Tests
 *
 * Tests component rendering with happy-dom environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert } from '../../src/types.js'
import { _resetAlertServiceSingleton } from '../../src/services/alert-service.js'
import { _resetAudioServiceSingleton } from '../../src/services/audio-service.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: crypto.randomUUID(),
    $source: 'test',
    priority: 'warning',
    state: 'unacknowledged',
    condition: true,
    latching: false,
    silenced: false,
    message: 'Test alert',
    raisedAt: new Date().toISOString(),
    stateChangedAt: new Date().toISOString(),
    sourceOnline: true,
    lastSourceUpdate: new Date().toISOString(),
    stale: false,
    ...overrides
  }
}

/** Wait for Lit to finish rendering. */
async function updateComplete(el: { updateComplete: Promise<boolean> }): Promise<void> {
  await el.updateComplete
}

/** Query inside shadow DOM. */
function shadowQuery(el: Element, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null
}

function shadowQueryAll(el: Element, selector: string): Element[] {
  return Array.from(el.shadowRoot?.querySelectorAll(selector) ?? [])
}

// ---------------------------------------------------------------------------
// AlertCard
// ---------------------------------------------------------------------------

describe('AlertCard', () => {
  beforeEach(async () => {
    await import('../../src/components/alert-card.js')
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('renders alert message', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ message: 'Engine coolant high' })
    document.body.appendChild(el)
    await updateComplete(el)

    const message = shadowQuery(el, '.message')
    expect(message?.textContent).toContain('Engine coolant high')
  })

  it('shows priority label', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ priority: 'alarm' })
    document.body.appendChild(el)
    await updateComplete(el)

    const priority = shadowQuery(el, '.priority')
    expect(priority?.textContent).toContain('Alarm')
  })

  it('shows state badge', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ state: 'acknowledged' })
    document.body.appendChild(el)
    await updateComplete(el)

    const state = shadowQuery(el, '.state')
    expect(state?.textContent).toContain('Acknowledged')
  })

  it('shows group when present', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ group: 'engine' })
    document.body.appendChild(el)
    await updateComplete(el)

    const group = shadowQuery(el, '.group')
    expect(group?.textContent).toContain('engine')
  })

  it('does not show group when absent', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ group: undefined })
    document.body.appendChild(el)
    await updateComplete(el)

    const group = shadowQuery(el, '.group')
    expect(group).toBeNull()
  })

  it('applies priority color via CSS custom property', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ priority: 'emergency' })
    document.body.appendChild(el)
    await updateComplete(el)

    const card = shadowQuery(el, '.card')
    expect(card).not.toBeNull()
    // The component should set --priority-color CSS variable
    const style = (card as HTMLElement)?.style
    expect(style.getPropertyValue('--priority-color')).toBeTruthy()
  })

  it('shows stale indicator when alert is stale', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ stale: true })
    document.body.appendChild(el)
    await updateComplete(el)

    const stale = shadowQuery(el, '.stale')
    expect(stale).not.toBeNull()
  })

  it('has flashing class for unacknowledged state', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ state: 'unacknowledged' })
    document.body.appendChild(el)
    await updateComplete(el)

    const card = shadowQuery(el, '.card')
    expect(card?.classList.contains('flashing')).toBe(true)
  })

  it('does not flash for acknowledged state', async () => {
    const el = document.createElement('alert-card') as HTMLElement & {
      alert: Alert
      updateComplete: Promise<boolean>
    }
    el.alert = makeAlert({ state: 'acknowledged' })
    document.body.appendChild(el)
    await updateComplete(el)

    const card = shadowQuery(el, '.card')
    expect(card?.classList.contains('flashing')).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Action buttons
  // -------------------------------------------------------------------------

  describe('action buttons', () => {
    async function createCard(overrides: Partial<Alert> = {}) {
      const el = document.createElement('alert-card') as HTMLElement & {
        alert: Alert
        updateComplete: Promise<boolean>
      }
      el.alert = makeAlert(overrides)
      document.body.appendChild(el)
      await updateComplete(el)
      return el
    }

    it('shows acknowledge button for unacknowledged non-caution alert', async () => {
      const el = await createCard({ state: 'unacknowledged', priority: 'warning' })
      const btn = shadowQuery(el, '[data-action="acknowledge"]')
      expect(btn).not.toBeNull()
    })

    it('shows acknowledge button for rtn-unacknowledged alert', async () => {
      const el = await createCard({ state: 'rtn-unacknowledged', priority: 'alarm' })
      const btn = shadowQuery(el, '[data-action="acknowledge"]')
      expect(btn).not.toBeNull()
    })

    it('shows acknowledge button for caution priority', async () => {
      const el = await createCard({ state: 'unacknowledged', priority: 'caution' })
      const btn = shadowQuery(el, '[data-action="acknowledge"]')
      expect(btn).not.toBeNull()
    })

    it('does not show acknowledge button for acknowledged alert', async () => {
      const el = await createCard({ state: 'acknowledged', priority: 'warning' })
      const btn = shadowQuery(el, '[data-action="acknowledge"]')
      expect(btn).toBeNull()
    })

    it('shows silence button for unacknowledged unsilenced alert', async () => {
      const el = await createCard({ state: 'unacknowledged', silenced: false })
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).not.toBeNull()
    })

    it('does not show silence button when already silenced', async () => {
      const el = await createCard({ state: 'unacknowledged', silenced: true })
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).toBeNull()
    })

    it('does not show silence button for acknowledged alert', async () => {
      const el = await createCard({ state: 'acknowledged', silenced: false })
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).toBeNull()
    })

    it('hides silence button when alert priority is below minAudiblePriority', async () => {
      const el = document.createElement('alert-card') as HTMLElement & {
        alert: Alert
        minAudiblePriority: string
        updateComplete: Promise<boolean>
      }
      el.alert = makeAlert({ state: 'unacknowledged', priority: 'caution', silenced: false })
      el.minAudiblePriority = 'warning'
      document.body.appendChild(el)
      await updateComplete(el)
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).toBeNull()
    })

    it('shows silence button when alert priority meets minAudiblePriority', async () => {
      const el = document.createElement('alert-card') as HTMLElement & {
        alert: Alert
        minAudiblePriority: string
        updateComplete: Promise<boolean>
      }
      el.alert = makeAlert({ state: 'unacknowledged', priority: 'warning', silenced: false })
      el.minAudiblePriority = 'warning'
      document.body.appendChild(el)
      await updateComplete(el)
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).not.toBeNull()
    })

    it('shows silence button when minAudiblePriority is not set', async () => {
      const el = await createCard({ state: 'unacknowledged', priority: 'caution', silenced: false })
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).not.toBeNull()
    })

    it('hides silence button when minAudiblePriority is off', async () => {
      const el = document.createElement('alert-card') as HTMLElement & {
        alert: Alert
        minAudiblePriority: string
        updateComplete: Promise<boolean>
      }
      el.alert = makeAlert({ state: 'unacknowledged', priority: 'emergency', silenced: false })
      el.minAudiblePriority = 'off'
      document.body.appendChild(el)
      await updateComplete(el)
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).toBeNull()
    })

    it('shows silenced badge when alert is silenced', async () => {
      const el = await createCard({ state: 'unacknowledged', silenced: true })
      const badge = shadowQuery(el, '.silenced')
      expect(badge).not.toBeNull()
    })

    it('does not show silenced badge when not silenced', async () => {
      const el = await createCard({ state: 'unacknowledged', silenced: false })
      const badge = shadowQuery(el, '.silenced')
      expect(badge).toBeNull()
    })

    it('renders silence button before acknowledge button in DOM order', async () => {
      const el = await createCard({ state: 'unacknowledged', priority: 'warning', silenced: false })
      const buttons = shadowQueryAll(el, 'button[data-action]')
      const actions = buttons.map((b) => b.getAttribute('data-action'))
      const silenceIdx = actions.indexOf('silence')
      const ackIdx = actions.indexOf('acknowledge')
      expect(silenceIdx).toBeGreaterThanOrEqual(0)
      expect(ackIdx).toBeGreaterThanOrEqual(0)
      expect(silenceIdx).toBeLessThan(ackIdx)
    })

    it('does not show actions area for acknowledged alerts', async () => {
      const el = await createCard({ state: 'acknowledged', priority: 'warning' })
      const actions = shadowQuery(el, '.actions')
      expect(actions).toBeNull()
    })

    it('shows actions area for acknowledged caution alerts', async () => {
      const el = await createCard({ state: 'acknowledged', priority: 'caution' })
      const actions = shadowQuery(el, '.actions')
      expect(actions).not.toBeNull()
    })

    it('dispatches alert-acknowledge event on acknowledge click', async () => {
      const el = await createCard({
        id: 'test-123',
        state: 'unacknowledged',
        priority: 'warning'
      })
      const handler = vi.fn()
      el.addEventListener('alert-acknowledge', handler)

      const btn = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
      btn.click()

      expect(handler).toHaveBeenCalledTimes(1)
      expect((handler.mock.calls[0][0] as CustomEvent).detail.id).toBe('test-123')
    })

    it('dispatches alert-silence event on silence click', async () => {
      const el = await createCard({
        id: 'test-456',
        state: 'unacknowledged',
        silenced: false
      })
      const handler = vi.fn()
      el.addEventListener('alert-silence', handler)

      const btn = shadowQuery(el, '[data-action="silence"]') as HTMLButtonElement
      btn.click()

      expect(handler).toHaveBeenCalledTimes(1)
      expect((handler.mock.calls[0][0] as CustomEvent).detail.id).toBe('test-456')
    })

    it('shows dismiss button for acknowledged caution alert', async () => {
      const el = await createCard({ state: 'acknowledged', priority: 'caution' })
      const btn = shadowQuery(el, '[data-action="dismiss"]')
      expect(btn).not.toBeNull()
    })

    it('shows dismiss button for unacknowledged caution alert', async () => {
      const el = await createCard({ state: 'unacknowledged', priority: 'caution' })
      const btn = shadowQuery(el, '[data-action="dismiss"]')
      expect(btn).not.toBeNull()
    })

    it('does not show dismiss button for ack-required priorities', async () => {
      const el = await createCard({ state: 'acknowledged', priority: 'warning' })
      const btn = shadowQuery(el, '[data-action="dismiss"]')
      expect(btn).toBeNull()
    })

    it('dispatches alert-dismiss event on dismiss click', async () => {
      const el = await createCard({
        id: 'test-dismiss',
        state: 'acknowledged',
        priority: 'caution'
      })
      const handler = vi.fn()
      el.addEventListener('alert-dismiss', handler)

      const btn = shadowQuery(el, '[data-action="dismiss"]') as HTMLButtonElement
      btn.click()

      expect(handler).toHaveBeenCalledTimes(1)
      expect((handler.mock.calls[0][0] as CustomEvent).detail.id).toBe('test-dismiss')
    })

    it('disables buttons after click (actionInFlight)', async () => {
      const el = await createCard({
        id: 'test-789',
        state: 'unacknowledged',
        priority: 'warning',
        silenced: false
      })

      const ackBtn = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
      ackBtn.click()
      await updateComplete(el)

      const ackBtnAfter = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
      const silBtnAfter = shadowQuery(el, '[data-action="silence"]') as HTMLButtonElement
      expect(ackBtnAfter?.disabled).toBe(true)
      expect(silBtnAfter?.disabled).toBe(true)
    })

    it('resets actionInFlight when alert property changes', async () => {
      const el = (await createCard({
        id: 'test-reset',
        state: 'unacknowledged',
        priority: 'warning',
        silenced: false
      })) as HTMLElement & { alert: Alert; updateComplete: Promise<boolean> }

      const ackBtn = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
      ackBtn.click()
      await updateComplete(el)

      // Simulate new alert data arriving via WebSocket
      el.alert = makeAlert({
        id: 'test-reset',
        state: 'unacknowledged',
        priority: 'warning',
        silenced: false
      })
      await updateComplete(el)

      const ackBtnAfter = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
      expect(ackBtnAfter?.disabled).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// AlertList
// ---------------------------------------------------------------------------

describe('AlertList', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    // Mock fetch and WebSocket since AlertList connects to AlertService
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen: (() => void) | null = null
        onmessage: (() => void) | null = null
        onclose: (() => void) | null = null
        onerror: (() => void) | null = null
        close(): void {
          /* noop */
        }
        send(): void {
          /* noop */
        }
      }
    )

    await import('../../src/components/alert-card.js')
    await import('../../src/components/alert-list.js')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    _resetAlertServiceSingleton()
    _resetAudioServiceSingleton()
    vi.unstubAllGlobals()
  })

  it('renders empty state when no alerts', async () => {
    const el = document.createElement('alert-list') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    document.body.appendChild(el)
    await updateComplete(el)
    // Allow the service connect promise to resolve
    await new Promise((r) => setTimeout(r, 0))
    await updateComplete(el)

    const empty = shadowQuery(el, '.empty')
    expect(empty).not.toBeNull()
    expect(empty?.textContent).toContain('No alerts')
  })

  it('renders alert cards for each alert', async () => {
    const alerts = [
      makeAlert({ id: '1', message: 'Alert one' }),
      makeAlert({ id: '2', message: 'Alert two' }),
      makeAlert({ id: '3', message: 'Alert three' })
    ]
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(alerts)
    })

    const el = document.createElement('alert-list') as HTMLElement & {
      updateComplete: Promise<boolean>
    }
    document.body.appendChild(el)
    await updateComplete(el)
    await new Promise((r) => setTimeout(r, 0))
    await updateComplete(el)

    const cards = shadowQueryAll(el, 'alert-card')
    expect(cards).toHaveLength(3)
  })

  describe('group separator', () => {
    it('shows separator between unacknowledged and acknowledged alerts', async () => {
      const alerts = [
        makeAlert({ id: '1', state: 'unacknowledged' }),
        makeAlert({ id: '2', state: 'acknowledged' })
      ]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const separator = shadowQuery(el, '.group-separator')
      expect(separator).not.toBeNull()
    })

    it('shows separator between rtn-unacknowledged and acknowledged alerts', async () => {
      const alerts = [
        makeAlert({ id: '1', state: 'rtn-unacknowledged' }),
        makeAlert({ id: '2', state: 'acknowledged' })
      ]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const separator = shadowQuery(el, '.group-separator')
      expect(separator).not.toBeNull()
    })

    it('does not show separator when only unacknowledged alerts', async () => {
      const alerts = [
        makeAlert({ id: '1', state: 'unacknowledged' }),
        makeAlert({ id: '2', state: 'unacknowledged' })
      ]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const separator = shadowQuery(el, '.group-separator')
      expect(separator).toBeNull()
    })

    it('does not show separator when only acknowledged alerts', async () => {
      const alerts = [
        makeAlert({ id: '1', state: 'acknowledged' }),
        makeAlert({ id: '2', state: 'acknowledged' })
      ]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const separator = shadowQuery(el, '.group-separator')
      expect(separator).toBeNull()
    })
  })

  describe('global silence button', () => {
    it('renders silence-all button', async () => {
      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="silence-all"]')
      expect(btn).not.toBeNull()
    })

    it('disables silence-all when no unsilenced unacknowledged alerts', async () => {
      // Default fetch returns empty array
      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="silence-all"]') as HTMLButtonElement
      expect(btn?.disabled).toBe(true)
    })

    it('enables silence-all when unsilenced unacknowledged alerts exist', async () => {
      const alerts = [makeAlert({ state: 'unacknowledged', silenced: false })]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="silence-all"]') as HTMLButtonElement
      expect(btn?.disabled).toBe(false)
    })

    it('disables silence-all when all unacknowledged alerts are already silenced', async () => {
      const alerts = [
        makeAlert({ id: 'acked', state: 'acknowledged', silenced: false }),
        makeAlert({ id: 'unacked', state: 'unacknowledged', silenced: true })
      ]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="silence-all"]') as HTMLButtonElement
      expect(btn?.disabled).toBe(true)
    })
  })

  describe('simulation button', () => {
    it('does not render simulate button by default', async () => {
      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="simulate"]')
      expect(btn).toBeNull()
    })

    it('renders simulate button when simulationEnabled is true', async () => {
      const el = document.createElement('alert-list') as HTMLElement & {
        simulationEnabled: boolean
        updateComplete: Promise<boolean>
      }
      el.simulationEnabled = true
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="simulate"]')
      expect(btn).not.toBeNull()
      expect(btn?.textContent).toContain('Simulate')
    })

    it('toggles button text and class on click', async () => {
      const el = document.createElement('alert-list') as HTMLElement & {
        simulationEnabled: boolean
        updateComplete: Promise<boolean>
      }
      el.simulationEnabled = true
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      const btn = shadowQuery(el, '[data-action="simulate"]') as HTMLButtonElement
      expect(btn.classList.contains('sim-active')).toBe(false)

      btn.click()
      await updateComplete(el)

      const btnAfter = shadowQuery(el, '[data-action="simulate"]') as HTMLButtonElement
      expect(btnAfter.textContent).toContain('Stop Sim')
      expect(btnAfter.classList.contains('sim-active')).toBe(true)

      btnAfter.click()
      await updateComplete(el)

      const btnFinal = shadowQuery(el, '[data-action="simulate"]') as HTMLButtonElement
      expect(btnFinal.textContent).toContain('Simulate')
      expect(btnFinal.classList.contains('sim-active')).toBe(false)
    })
  })

  describe('event handling', () => {
    it('calls service acknowledgeAlert on alert-acknowledge event', async () => {
      const alerts = [makeAlert({ id: 'evt-1', state: 'unacknowledged', priority: 'warning' })]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      // Mock the fetch for the acknowledge call
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      // Dispatch a bubbling event from the card
      const card = shadowQuery(el, 'alert-card')!
      card.dispatchEvent(
        new CustomEvent('alert-acknowledge', {
          detail: { id: 'evt-1' },
          bubbles: true,
          composed: true
        })
      )

      // The service should have called the acknowledge endpoint
      await new Promise((r) => setTimeout(r, 0))
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/evt-1/acknowledge',
        { method: 'POST' }
      )
    })

    it('calls service silenceAlert on alert-silence event', async () => {
      const alerts = [makeAlert({ id: 'evt-2', state: 'unacknowledged', silenced: false })]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      const card = shadowQuery(el, 'alert-card')!
      card.dispatchEvent(
        new CustomEvent('alert-silence', {
          detail: { id: 'evt-2' },
          bubbles: true,
          composed: true
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/evt-2/silence',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      )
    })

    it('calls service dismissAlert on alert-dismiss event', async () => {
      const alerts = [makeAlert({ id: 'evt-3', state: 'acknowledged', priority: 'caution' })]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)

      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      const card = shadowQuery(el, 'alert-card')!
      card.dispatchEvent(
        new CustomEvent('alert-dismiss', {
          detail: { id: 'evt-3' },
          bubbles: true,
          composed: true
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/evt-3/condition',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: false })
        }
      )
    })
  })
})
