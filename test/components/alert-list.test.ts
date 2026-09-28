/**
 * AlertList and AlertCard Component Tests
 *
 * Tests component rendering with happy-dom environment.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert } from '../../src/types.js'
import { _resetAlertServiceSingleton } from '../../src/services/alert-service.js'
import { _resetAudioServiceSingleton } from '../../src/services/audio-service.js'
import { MIN_AUDIBLE_PRIORITY_KEY } from '../../src/services/audio-settings.js'
import { stubAudioContext, simulateUserGesture } from '../helpers/mock-audio.js'
import type { MockAudio } from '../helpers/mock-audio.js'
import { ANY_SIGNAL, jsonResponse, stubServer, textResponse } from '../helpers/mock-server.js'
import type { MockServer } from '../helpers/mock-server.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: crypto.randomUUID(),
    path: 'test.alert',
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
    const style = (card as HTMLElement).style
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

    it('hides silence on a caution alert at the default warning threshold', async () => {
      const el = await createCard({ state: 'unacknowledged', priority: 'caution', silenced: false })
      const btn = shadowQuery(el, '[data-action="silence"]')
      expect(btn).toBeNull()
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
      expect((handler.mock.calls[0][0] as CustomEvent<{ id: string }>).detail.id).toBe('test-123')
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
      expect((handler.mock.calls[0][0] as CustomEvent<{ id: string }>).detail.id).toBe('test-456')
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
      expect((handler.mock.calls[0][0] as CustomEvent<{ id: string }>).detail.id).toBe(
        'test-dismiss'
      )
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
      expect(ackBtnAfter.disabled).toBe(true)
      expect(silBtnAfter.disabled).toBe(true)
    })

    it('resets actionInFlight when alert property changes', async () => {
      const el = await createCard({
        id: 'test-reset',
        state: 'unacknowledged',
        priority: 'warning',
        silenced: false
      })

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
      expect(ackBtnAfter.disabled).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// AlertList
// ---------------------------------------------------------------------------

describe('AlertList', () => {
  let fetchMock: ReturnType<typeof vi.fn>
  let server: MockServer

  beforeEach(async () => {
    // Mock fetch and WebSocket since AlertList connects to AlertService
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })
    server = stubServer(fetchMock)
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
      expect(btn.disabled).toBe(true)
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
      expect(btn.disabled).toBe(false)
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
      expect(btn.disabled).toBe(true)
    })
  })

  describe('toolbar and configuration', () => {
    async function mountList(alerts: Alert[] = []) {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(alerts) })
      const el = document.createElement('alert-list') as HTMLElement & {
        updateComplete: Promise<boolean>
      }
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)
      return el
    }

    it('has no Simulate control', async () => {
      const el = await mountList()

      expect(shadowQuery(el, '[data-action="simulate"]')).toBeNull()
      const toolbar = shadowQuery(el, '.toolbar')
      expect(toolbar?.textContent).not.toMatch(/simulat/i)
    })

    it('sends no request to a plugin endpoint', async () => {
      await mountList([makeAlert()])

      const urls = fetchMock.mock.calls.map(([input]) => String(input))
      expect(urls).toEqual(['/signalk/v2/api/alerts'])
    })

    it('hides Silence on a caution alert at the default threshold', async () => {
      const el = await mountList([
        makeAlert({ id: 'c1', priority: 'caution', state: 'unacknowledged', silenced: false })
      ])

      const card = shadowQuery(el, 'alert-card') as HTMLElement
      expect(card.shadowRoot?.querySelector('button[data-action="silence"]')).toBeNull()
    })

    it('silence-all calls the core endpoint', async () => {
      const el = await mountList([makeAlert({ state: 'unacknowledged', silenced: false })])
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      const btn = shadowQuery(el, '[data-action="silence-all"]') as HTMLButtonElement
      // Non-bubbling, so the audio service's document-level gesture listener
      // does not try to start a tone (happy-dom has no AudioContext).
      btn.dispatchEvent(new MouseEvent('click'))
      await new Promise((r) => setTimeout(r, 0))

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/silence-all', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
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
      const card = shadowQuery(el, 'alert-card') as HTMLElement
      card.dispatchEvent(
        new CustomEvent('alert-acknowledge', {
          detail: { id: 'evt-1' },
          bubbles: true,
          composed: true
        })
      )

      // The service should have called the acknowledge endpoint
      await new Promise((r) => setTimeout(r, 0))
      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/evt-1/acknowledge', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
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

      const card = shadowQuery(el, 'alert-card') as HTMLElement
      card.dispatchEvent(
        new CustomEvent('alert-silence', {
          detail: { id: 'evt-2' },
          bubbles: true,
          composed: true
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/evt-2/silence', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}'
      })
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

      const card = shadowQuery(el, 'alert-card') as HTMLElement
      card.dispatchEvent(
        new CustomEvent('alert-dismiss', {
          detail: { id: 'evt-3' },
          bubbles: true,
          composed: true
        })
      )

      await new Promise((r) => setTimeout(r, 0))
      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/evt-3/condition', {
        method: 'PUT',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      })
    })
  })

  describe('refused actions', () => {
    type ListElement = HTMLElement & { updateComplete: Promise<boolean> }
    type CardElement = HTMLElement & { updateComplete: Promise<boolean>; alert: Alert }

    /** Sockets the service opened, for pushing deltas. */
    let sockets: { onmessage: ((ev: MessageEvent) => void) | null }[] = []

    beforeEach(() => {
      sockets = []
      // A click is a user gesture, which starts the tone.
      stubAudioContext()
      vi.stubGlobal(
        'WebSocket',
        class {
          onopen: (() => void) | null = null
          onmessage: ((ev: MessageEvent) => void) | null = null
          onclose: (() => void) | null = null
          onerror: (() => void) | null = null
          constructor() {
            sockets.push(this)
          }
          close(): void {
            /* noop */
          }
          send(): void {
            /* noop */
          }
        }
      )
    })

    const first = makeAlert({ id: 'first', message: 'Bilge high', priority: 'alarm' })
    const second = makeAlert({ id: 'second', message: 'Engine hot', priority: 'alarm' })

    async function settle(el: ListElement): Promise<void> {
      for (let i = 0; i < 3; i++) {
        await el.updateComplete
        await new Promise((r) => setTimeout(r, 0))
        await Promise.all(
          (shadowQueryAll(el, 'alert-card') as CardElement[]).map((c) => c.updateComplete)
        )
      }
    }

    async function mountList(): Promise<ListElement> {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, [first, second]))
      const el = document.createElement('alert-list') as ListElement
      document.body.appendChild(el)
      await settle(el)
      return el
    }

    function card(el: Element, id: string): CardElement {
      const found = (shadowQueryAll(el, 'alert-card') as CardElement[]).find(
        (c) => c.alert.id === id
      )
      if (!found) throw new Error(`no card for ${id}`)
      return found
    }

    function button(cardEl: Element, action: string): HTMLButtonElement {
      const found = cardEl.shadowRoot?.querySelector(`button[data-action="${action}"]`)
      expect(found).not.toBeNull()
      return found as HTMLButtonElement
    }

    function cardError(cardEl: Element): Element | null {
      return cardEl.shadowRoot?.querySelector('[role="alert"]') ?? null
    }

    async function pushAlert(el: ListElement, alert: Alert): Promise<void> {
      sockets[0].onmessage?.(
        new MessageEvent('message', {
          data: JSON.stringify({
            updates: [{ values: [{ path: `alerts.${alert.path}`, value: alert }] }]
          })
        })
      )
      await settle(el)
    }

    it('re-enables a refused acknowledge at once and shows a sign-in link on that card only', async () => {
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))

      button(card(el, 'first'), 'acknowledge').click()
      await settle(el)

      const refused = card(el, 'first')
      expect(button(refused, 'acknowledge').disabled).toBe(false)
      const error = cardError(refused)
      expect(error?.textContent.replace(/\s+/g, ' ')).toContain(
        'Not permitted — sign in with a read/write account'
      )
      expect(error?.querySelector('a')?.getAttribute('href')).toBe('/admin/#/login')
      expect(cardError(card(el, 'second'))).toBeNull()
    })

    it('links a refusal to the OIDC login when OIDC is enabled', async () => {
      server.loginStatus.mockResolvedValue(
        jsonResponse(200, { oidcEnabled: true, oidcLoginUrl: '/signalk/v1/auth/oidc/login' })
      )
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))

      button(card(el, 'first'), 'acknowledge').click()
      await settle(el)

      const link = cardError(card(el, 'first'))?.querySelector('a')
      expect(link?.getAttribute('href')).toBe('/signalk/v1/auth/oidc/login?redirect=%2F')
    })

    it('clears the message on the next delta for that alert', async () => {
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))
      fetchMock.mockResolvedValueOnce(textResponse(401, 'Unauthorized'))
      button(card(el, 'first'), 'acknowledge').click()
      button(card(el, 'second'), 'acknowledge').click()
      await settle(el)
      expect(cardError(card(el, 'first'))).not.toBeNull()
      expect(cardError(card(el, 'second'))).not.toBeNull()

      await pushAlert(el, { ...first, silenced: true })

      expect(cardError(card(el, 'first'))).toBeNull()
      expect(cardError(card(el, 'second'))).not.toBeNull()
    })

    it('clears the message on the next attempt', async () => {
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))
      button(card(el, 'first'), 'acknowledge').click()
      await settle(el)
      expect(cardError(card(el, 'first'))).not.toBeNull()

      fetchMock.mockReturnValueOnce(
        new Promise(() => {
          // stays pending
        })
      )
      button(card(el, 'first'), 'acknowledge').click()
      await settle(el)

      expect(cardError(card(el, 'first'))).toBeNull()
      expect(button(card(el, 'first'), 'acknowledge').disabled).toBe(true)
    })

    it("shows core's message when silence is answered 409 FAILED", async () => {
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { state: 'FAILED', statusCode: 409, message: 'Alert already silenced' })
      )

      button(card(el, 'first'), 'silence').click()
      await settle(el)

      const error = cardError(card(el, 'first'))
      expect(error?.textContent).toContain('Alert already silenced')
      expect(error?.querySelector('a')).toBeNull()
    })

    it('shows a refused Silence All next to its button, which stays usable', async () => {
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))

      const silenceAll = shadowQuery(el, 'button[data-action="silence-all"]') as HTMLButtonElement
      silenceAll.click()
      await settle(el)

      const error = shadowQuery(el, '.toolbar-actions [role="alert"]')
      expect(error?.textContent.replace(/\s+/g, ' ')).toContain(
        'Not permitted — sign in with a read/write account'
      )
      expect(error?.querySelector('a')?.getAttribute('href')).toBe('/admin/#/login')
      expect(silenceAll.disabled).toBe(false)
      expect(cardError(card(el, 'first'))).toBeNull()
    })

    it('clears the Silence All error on the next attempt', async () => {
      const el = await mountList()
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))
      const silenceAll = shadowQuery(el, 'button[data-action="silence-all"]') as HTMLButtonElement
      silenceAll.click()
      await settle(el)

      fetchMock.mockResolvedValueOnce(jsonResponse(200, {}))
      silenceAll.click()
      await settle(el)

      expect(shadowQuery(el, '.toolbar-actions [role="alert"]')).toBeNull()
    })
  })

  describe('sound threshold', () => {
    let audio: MockAudio

    beforeEach(() => {
      localStorage.clear()
      audio = stubAudioContext()
    })

    afterEach(() => {
      vi.unstubAllGlobals()
      localStorage.clear()
    })

    type ListElement = HTMLElement & { updateComplete: Promise<boolean> }

    async function mountList(alerts: Alert[] = []): Promise<ListElement> {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(alerts) })
      const el = document.createElement('alert-list') as ListElement
      document.body.appendChild(el)
      await updateComplete(el)
      await new Promise((r) => setTimeout(r, 0))
      await updateComplete(el)
      simulateUserGesture()
      return el
    }

    function soundSelect(el: Element): HTMLSelectElement {
      const select = shadowQuery(el, 'select[data-setting="sound"]')
      expect(select).not.toBeNull()
      return select as HTMLSelectElement
    }

    async function chooseSound(el: ListElement, value: string): Promise<void> {
      const select = soundSelect(el)
      select.value = value
      select.dispatchEvent(new Event('change'))
      await updateComplete(el)
      const cards = shadowQueryAll(el, 'alert-card') as (Element & {
        updateComplete: Promise<boolean>
      })[]
      await Promise.all(cards.map((c) => c.updateComplete))
    }

    function silenceButtons(el: Element): Element[] {
      return shadowQueryAll(el, 'alert-card').flatMap((card) =>
        Array.from(card.shadowRoot?.querySelectorAll('button[data-action="silence"]') ?? [])
      )
    }

    function soundOffIndicator(el: Element): Element | null {
      return shadowQuery(el, '.sound-off')
    }

    it('labels the control "Sound:" with an accessible name', async () => {
      const el = await mountList()
      const select = soundSelect(el)

      expect(select.getAttribute('aria-label')).toBe('Minimum priority that sounds')
      const label = shadowQuery(el, `label[for="${select.id}"]`)
      expect(label?.textContent.trim()).toBe('Sound:')
    })

    it('offers every threshold from off to warning, and no caution', async () => {
      const el = await mountList()
      const options = Array.from(soundSelect(el).options).map((o) => [o.value, o.text.trim()])

      expect(options).toEqual([
        ['off', 'Off (no sound)'],
        ['emergency', 'Emergency only'],
        ['alarm', 'Alarm and above'],
        ['warning', 'Warning and above']
      ])
    })

    it('starts at warning when nothing is stored, and a new alarm sounds', async () => {
      const el = await mountList([makeAlert({ priority: 'alarm' })])

      const select = soundSelect(el)
      expect(select.value).toBe('warning')
      expect(select.selectedOptions[0].text.trim()).toBe('Warning and above')
      expect(audio.playing()).toHaveLength(1)
      expect(soundOffIndicator(el)).toBeNull()
    })

    it('turning sound off stores it, stops the tone and hides Silence', async () => {
      const el = await mountList([makeAlert({ priority: 'alarm' })])
      expect(audio.playing()).toHaveLength(1)
      expect(silenceButtons(el)).toHaveLength(1)

      await chooseSound(el, 'off')

      expect(localStorage.getItem(MIN_AUDIBLE_PRIORITY_KEY)).toBe('off')
      expect(audio.playing()).toHaveLength(0)
      expect(silenceButtons(el)).toHaveLength(0)
      expect(soundOffIndicator(el)?.textContent).toContain('Sound off')
    })

    it('starts at a stored alarm threshold, so a warning stays silent', async () => {
      localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'alarm')

      const el = await mountList([makeAlert({ priority: 'warning' })])

      expect(soundSelect(el).value).toBe('alarm')
      expect(audio.oscillators).toHaveLength(0)
      expect(silenceButtons(el)).toHaveLength(0)
    })

    it('shows the Sound off indicator when off is stored', async () => {
      localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'off')

      const el = await mountList([makeAlert({ priority: 'emergency' })])

      expect(soundSelect(el).value).toBe('off')
      expect(soundOffIndicator(el)?.textContent).toContain('Sound off')
      expect(audio.oscillators).toHaveLength(0)
    })

    it('treats a garbage stored value as warning', async () => {
      localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'very-loud')

      const el = await mountList([makeAlert({ priority: 'warning' })])

      expect(soundSelect(el).value).toBe('warning')
      expect(audio.playing()).toHaveLength(1)
    })

    it('works for the session at warning when storage throws', async () => {
      const fail = (): never => {
        throw new DOMException('denied', 'SecurityError')
      }
      vi.stubGlobal('localStorage', {
        length: 0,
        clear: fail,
        getItem: fail,
        key: fail,
        removeItem: fail,
        setItem: fail
      })

      const el = await mountList([makeAlert({ priority: 'warning' })])
      expect(soundSelect(el).value).toBe('warning')
      expect(audio.playing()).toHaveLength(1)

      await chooseSound(el, 'off')

      expect(soundSelect(el).value).toBe('off')
      expect(audio.playing()).toHaveLength(0)
      expect(soundOffIndicator(el)).not.toBeNull()
    })

    it('lowering the threshold starts the tone of an alert now above it', async () => {
      localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'alarm')
      const el = await mountList([makeAlert({ priority: 'warning' })])
      expect(audio.oscillators).toHaveLength(0)

      await chooseSound(el, 'warning')

      expect(audio.playing()).toHaveLength(1)
      expect(silenceButtons(el)).toHaveLength(1)
    })

    it('treats a stored caution as warning: caution stays silent, warning sounds', async () => {
      localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'caution')

      const el = await mountList([
        makeAlert({ priority: 'caution' }),
        makeAlert({ priority: 'warning' })
      ])

      expect(soundSelect(el).value).toBe('warning')
      expect(audio.playing()).toHaveLength(1)
      expect(audio.playing()[0].frequency.value).toBe(440)
      expect(silenceButtons(el)).toHaveLength(1)
    })
  })
})
