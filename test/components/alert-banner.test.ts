/**
 * AlertBanner Component Tests
 *
 * Tests the persistent banner that shows the highest-priority unacknowledged alert.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert } from '../../src/types.js'
import { _resetAlertServiceSingleton } from '../../src/services/alert-service.js'
import { ANY_SIGNAL, stubServer } from '../helpers/mock-server.js'

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

async function updateComplete(el: { updateComplete: Promise<boolean> }): Promise<void> {
  await el.updateComplete
}

function shadowQuery(el: Element, selector: string): Element | null {
  return el.shadowRoot?.querySelector(selector) ?? null
}

type BannerElement = HTMLElement & { updateComplete: Promise<boolean> }

let fetchMock: ReturnType<typeof vi.fn>

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlertBanner', () => {
  beforeEach(async () => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })
    stubServer(fetchMock)
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

    await import('../../src/components/alert-banner.js')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    _resetAlertServiceSingleton()
    vi.unstubAllGlobals()
  })

  async function createBanner(alerts: Alert[] = []): Promise<BannerElement> {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(alerts)
    })

    const el = document.createElement('alert-banner') as BannerElement
    document.body.appendChild(el)
    await updateComplete(el)
    // Allow service connect promise to resolve
    await new Promise((r) => setTimeout(r, 0))
    await updateComplete(el)
    return el
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  it('renders nothing when no unacknowledged alerts', async () => {
    const el = await createBanner([])
    expect(shadowQuery(el, '.banner')).toBeNull()
  })

  it('renders nothing when only acknowledged alerts exist', async () => {
    const el = await createBanner([makeAlert({ state: 'acknowledged' })])
    expect(shadowQuery(el, '.banner')).toBeNull()
  })

  it('renders banner when unacknowledged alert exists', async () => {
    const el = await createBanner([makeAlert({ state: 'unacknowledged' })])
    expect(shadowQuery(el, '.banner')).not.toBeNull()
  })

  it('hides when all alerts acknowledged', async () => {
    const alerts = [makeAlert({ state: 'acknowledged', priority: 'warning' })]
    const el = await createBanner(alerts)
    expect(shadowQuery(el, '.banner')).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  it('shows message of highest priority alert', async () => {
    const el = await createBanner([makeAlert({ message: 'Engine overheat' })])
    const message = shadowQuery(el, '.message')
    expect(message?.textContent).toContain('Engine overheat')
  })

  it('shows priority label and color', async () => {
    const el = await createBanner([makeAlert({ priority: 'alarm' })])
    const priority = shadowQuery(el, '.priority')
    expect(priority?.textContent).toContain('Alarm')
    const banner = shadowQuery(el, '.banner')
    const style = (banner as HTMLElement).style
    expect(style.getPropertyValue('--priority-color')).toBeTruthy()
  })

  it('has flashing class for unacknowledged state', async () => {
    const el = await createBanner([makeAlert({ state: 'unacknowledged' })])
    const banner = shadowQuery(el, '.banner')
    expect(banner?.classList.contains('flashing')).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Priority selection
  // -------------------------------------------------------------------------

  it('selects emergency over alarm', async () => {
    const el = await createBanner([
      makeAlert({ priority: 'alarm', message: 'Alarm msg' }),
      makeAlert({ priority: 'emergency', message: 'Emergency msg' })
    ])
    const message = shadowQuery(el, '.message')
    expect(message?.textContent).toContain('Emergency msg')
  })

  it('selects alarm over warning', async () => {
    const el = await createBanner([
      makeAlert({ priority: 'warning', message: 'Warning msg' }),
      makeAlert({ priority: 'alarm', message: 'Alarm msg' })
    ])
    const message = shadowQuery(el, '.message')
    expect(message?.textContent).toContain('Alarm msg')
  })

  it('selects the most recently changed alert when same priority', async () => {
    // IEC 62923-1 6.4.2.2: most recent state change on top
    const el = await createBanner([
      makeAlert({
        priority: 'alarm',
        message: 'Older change',
        stateChangedAt: '2026-01-01T00:00:00Z'
      }),
      makeAlert({
        priority: 'alarm',
        message: 'Newer change',
        stateChangedAt: '2026-01-02T00:00:00Z'
      })
    ])
    const message = shadowQuery(el, '.message')
    expect(message?.textContent).toContain('Newer change')
  })

  // -------------------------------------------------------------------------
  // Acknowledge button
  // -------------------------------------------------------------------------

  it('shows acknowledge button for non-caution alert', async () => {
    const el = await createBanner([makeAlert({ priority: 'warning', state: 'unacknowledged' })])
    const btn = shadowQuery(el, '[data-action="acknowledge"]')
    expect(btn).not.toBeNull()
  })

  it('shows acknowledge button for rtn-unacknowledged non-caution alert', async () => {
    const el = await createBanner([makeAlert({ priority: 'alarm', state: 'rtn-unacknowledged' })])
    const btn = shadowQuery(el, '[data-action="acknowledge"]')
    expect(btn).not.toBeNull()
  })

  it('shows acknowledge button for caution priority', async () => {
    const el = await createBanner([makeAlert({ priority: 'caution', state: 'unacknowledged' })])
    const btn = shadowQuery(el, '[data-action="acknowledge"]')
    expect(btn).not.toBeNull()
  })

  it('disables button after click', async () => {
    const el = await createBanner([
      makeAlert({ id: 'ack-1', priority: 'warning', state: 'unacknowledged' })
    ])

    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

    const btn = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
    btn.click()
    await updateComplete(el)

    const btnAfter = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
    expect(btnAfter.disabled).toBe(true)
  })

  it('calls service acknowledgeAlert on click', async () => {
    const el = await createBanner([
      makeAlert({ id: 'ack-2', priority: 'warning', state: 'unacknowledged' })
    ])

    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

    const btn = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
    btn.click()

    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/ack-2/acknowledge', {
      method: 'POST',
      signal: ANY_SIGNAL,
      headers: { Accept: 'application/json' }
    })
  })

  it('re-enables button when top alert changes via service event', async () => {
    const el = await createBanner([
      makeAlert({ id: 'ack-3', priority: 'warning', state: 'unacknowledged' })
    ])

    fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

    const btn = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
    btn.click()
    await updateComplete(el)
    expect((shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement).disabled).toBe(
      true
    )

    // Simulate a new top alert arriving: mock fetch to return different alert,
    // then re-connect the service (triggers fetch + change event on same element)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve([
          makeAlert({ id: 'ack-3-new', priority: 'alarm', state: 'unacknowledged' })
        ])
    })
    // Access the service via type escape to trigger a real data refresh
    const service = (el as unknown as { service: { connect(): Promise<void> } }).service
    await service.connect()
    await updateComplete(el)

    const btnAfter = shadowQuery(el, '[data-action="acknowledge"]') as HTMLButtonElement
    expect(btnAfter.disabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Expand / collapse
  // -------------------------------------------------------------------------

  it('details are hidden by default', async () => {
    const el = await createBanner([makeAlert({ group: 'engine' })])
    const details = shadowQuery(el, '.details')
    expect(details).toBeNull()
  })

  it('shows details after clicking expand', async () => {
    const el = await createBanner([makeAlert({ group: 'engine' })])
    const toggle = shadowQuery(el, '[data-action="toggle"]') as HTMLButtonElement
    toggle.click()
    await updateComplete(el)
    const details = shadowQuery(el, '.details')
    expect(details).not.toBeNull()
  })

  it('hides details after clicking collapse', async () => {
    const el = await createBanner([makeAlert({ group: 'engine' })])
    const toggle = shadowQuery(el, '[data-action="toggle"]') as HTMLButtonElement
    toggle.click()
    await updateComplete(el)
    // Click again to collapse
    const toggle2 = shadowQuery(el, '[data-action="toggle"]') as HTMLButtonElement
    toggle2.click()
    await updateComplete(el)
    const details = shadowQuery(el, '.details')
    expect(details).toBeNull()
  })

  it('shows group and stale in expanded view when present', async () => {
    const el = await createBanner([makeAlert({ group: 'navigation', stale: true })])
    const toggle = shadowQuery(el, '[data-action="toggle"]') as HTMLButtonElement
    toggle.click()
    await updateComplete(el)

    const group = shadowQuery(el, '.group')
    expect(group?.textContent).toContain('navigation')
    const stale = shadowQuery(el, '.stale')
    expect(stale).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // Service integration
  // -------------------------------------------------------------------------

  it('renders banner for rtn-unacknowledged alert', async () => {
    const el = await createBanner([makeAlert({ state: 'rtn-unacknowledged' })])
    expect(shadowQuery(el, '.banner')).not.toBeNull()
  })
})
