/**
 * AlertApp tests: availability screens, and navigation between the list and
 * the detail view.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert } from '../../src/types.js'
import { _resetAlertServiceSingleton } from '../../src/services/alert-service.js'
import { _resetAudioServiceSingleton } from '../../src/services/audio-service.js'
import { MIN_AUDIBLE_PRIORITY_KEY } from '../../src/services/audio-settings.js'
import { simulateUserGesture, stubAudioContext } from '../helpers/mock-audio.js'
import type { MockAudio } from '../helpers/mock-audio.js'
import { jsonResponse, statusReply, stubServer, textResponse } from '../helpers/mock-server.js'
import type { MockServer } from '../helpers/mock-server.js'

const alert: Alert = {
  id: 'alert-1',
  path: 'test.alert',
  $source: 'test',
  priority: 'emergency',
  state: 'unacknowledged',
  condition: true,
  latching: false,
  silenced: false,
  message: 'Bilge high',
  raisedAt: '2026-02-19T10:00:00.000Z',
  stateChangedAt: '2026-02-19T10:00:00.000Z',
  sourceOnline: true,
  lastSourceUpdate: '2026-02-19T10:00:00.000Z',
  stale: false
}

type Updatable = HTMLElement & { updateComplete: Promise<boolean> }

/** Sockets the service opened, newest last. */
let sockets: MockWebSocket[] = []

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = MockWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  constructor() {
    sockets.push(this)
  }
  send(): void {
    // outgoing frames are not inspected here
  }
  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }
  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

let audio: MockAudio
let server: MockServer
/** Answers the alert list; replace to delay or fail it. */
let listReply: () => Promise<Response>

beforeEach(async () => {
  localStorage.clear()
  sockets = []
  audio = stubAudioContext()
  listReply = () => Promise.resolve(jsonResponse(200, [alert]))
  server = stubServer((input: string) => {
    const { pathname } = new URL(input, 'http://my-server.local')
    if (pathname === '/signalk/v2/api/alerts') {
      return listReply()
    }
    if (pathname.endsWith('/acknowledge')) {
      // Anonymous reads allowed, writes refused.
      return Promise.resolve(jsonResponse(401, { error: 'Permission Denied' }))
    }
    return Promise.resolve(textResponse(404, 'Not Found'))
  })
  vi.stubGlobal('WebSocket', MockWebSocket)
  await import('../../src/main.js')
})

afterEach(() => {
  document.body.innerHTML = ''
  _resetAlertServiceSingleton()
  _resetAudioServiceSingleton()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  localStorage.clear()
})

/** Let fetches, events and renders settle; works under fake timers too. */
async function settle(el: Updatable): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await el.updateComplete
    if (vi.isFakeTimers()) {
      await vi.advanceTimersByTimeAsync(0)
    } else {
      await new Promise((r) => setTimeout(r, 0))
    }
  }
}

/** Advance fake time and let the app settle. */
async function advance(app: Updatable, ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle(app)
}

function heading(app: Element): HTMLElement | null {
  return app.shadowRoot?.querySelector<HTMLElement>('[aria-live="polite"] h2') ?? null
}

function liveRegionText(app: Element): string {
  const region = app.shadowRoot?.querySelector('[aria-live="polite"]')
  expect(region).not.toBeNull()
  return (region?.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function list(app: Element): Updatable | null {
  return app.shadowRoot?.querySelector<Updatable>('alert-list') ?? null
}

function listText(app: Element): string {
  return list(app)?.shadowRoot?.textContent ?? ''
}

/** Mount live with the alert sounding and its socket open. */
async function mountLive(): Promise<Updatable> {
  const app = await mountApp()
  simulateUserGesture()
  sockets[0].simulateOpen()
  await settle(app)
  expect(audio.playing()).toHaveLength(1)
  return app
}

async function mountApp(): Promise<Updatable> {
  const app = document.createElement('alert-app') as Updatable
  document.body.appendChild(app)
  await settle(app)
  return app
}

function child(app: Element, tag: string): Updatable {
  const el = app.shadowRoot?.querySelector(tag)
  expect(el).not.toBeNull()
  return el as Updatable
}

async function openDetail(app: Updatable): Promise<Updatable> {
  child(app, 'alert-list').dispatchEvent(
    new CustomEvent('alert-select', { detail: { id: alert.id }, bubbles: true, composed: true })
  )
  await settle(app)
  const detail = child(app, 'alert-detail')
  await settle(detail)
  return detail
}

function detailSilence(detail: Element): Element | null {
  return detail.shadowRoot?.querySelector('button[data-action="silence"]') ?? null
}

describe('AlertApp navigation', () => {
  it('is titled Alert Console', async () => {
    const app = await mountApp()
    expect(app.shadowRoot?.querySelector('h1')?.textContent.trim()).toBe('Alert Console')
  })

  it('gives the detail view the stored threshold', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'off')
    const app = await mountApp()

    const detail = await openDetail(app)

    expect((detail as Updatable & { minAudiblePriority: string }).minAudiblePriority).toBe('off')
    expect(detail.shadowRoot?.querySelector('.message')?.textContent).toContain('Bilge high')
    expect(detailSilence(detail)).toBeNull()
  })

  it('gives the detail view a threshold changed in the list', async () => {
    const app = await mountApp()
    const list = child(app, 'alert-list')
    const select = list.shadowRoot?.querySelector('select[data-setting="sound"]')
    expect(select).not.toBeNull()
    ;(select as HTMLSelectElement).value = 'off'
    select?.dispatchEvent(new Event('change'))
    await settle(list)

    const detail = await openDetail(app)

    expect(detailSilence(detail)).toBeNull()
  })

  it('offers Silence in the detail view at the default threshold', async () => {
    const app = await mountApp()

    const detail = await openDetail(app)

    expect(detailSilence(detail)).not.toBeNull()
  })
})

describe('AlertApp availability', () => {
  it('shows "Connecting to Signal K…", never "No alerts", before the first list fetch', async () => {
    let resolveList!: (response: Response) => void
    listReply = () =>
      new Promise<Response>((resolve) => {
        resolveList = resolve
      })

    const app = await mountApp()

    expect(heading(app)?.textContent).toContain('Connecting to Signal K…')
    expect(list(app)).toBeNull()
    expect(app.shadowRoot?.textContent).not.toContain('No alerts')

    resolveList(jsonResponse(200, []))
    await settle(app)

    expect(heading(app)).toBeNull()
    const shown = list(app)
    expect(shown).not.toBeNull()
    if (shown) await settle(shown)
    expect(listText(app)).toContain('No alerts')
  })

  it('renders the list and opens the socket on a 200', async () => {
    const app = await mountApp()

    expect(list(app)).not.toBeNull()
    expect(sockets).toHaveLength(1)
    expect(liveRegionText(app)).toBe('')
  })

  it('shows the no-API screen on a 404, with no socket and no audio', async () => {
    server.status.mockImplementation(statusReply(404))

    const app = await mountApp()
    simulateUserGesture()

    expect(heading(app)?.textContent).toContain('Alerts API not available')
    expect(list(app)).toBeNull()
    expect(sockets).toHaveLength(0)
    expect(audio.oscillators).toHaveLength(0)
  })

  it('shows the sign-in screen on a 401, linking to the admin login', async () => {
    server.status.mockImplementation(statusReply(401))

    const app = await mountApp()

    expect(heading(app)?.textContent).toContain('Sign in')
    const link = app.shadowRoot?.querySelector('[aria-live="polite"] a')
    expect(link?.getAttribute('href')).toBe('/admin/#/login')
    expect(list(app)).toBeNull()
    expect(sockets).toHaveLength(0)
  })

  it('links the sign-in screen to the OIDC login when OIDC is enabled', async () => {
    server.status.mockImplementation(statusReply(401))
    server.loginStatus.mockResolvedValue(
      jsonResponse(200, { oidcEnabled: true, oidcLoginUrl: '/signalk/v1/auth/oidc/login' })
    )

    const app = await mountApp()

    const link = app.shadowRoot?.querySelector('[aria-live="polite"] a')
    expect(link?.getAttribute('href')).toBe('/signalk/v1/auth/oidc/login')
  })

  it('shows the sign-in screen for a plain-text "bad auth token" 401', async () => {
    server.status.mockResolvedValue(textResponse(401, 'bad auth token'))

    const app = await mountApp()

    expect(heading(app)?.textContent).toContain('Sign in')
  })

  it('shows Unreachable on a 502 and retries on the backoff until live', async () => {
    vi.useFakeTimers()
    server.status.mockImplementation(statusReply(502))

    const app = await mountApp()
    expect(heading(app)?.textContent).toContain('Cannot reach the Signal K server — retrying')
    expect(list(app)).toBeNull()

    await advance(app, 1000)
    expect(server.status).toHaveBeenCalledTimes(2)

    server.status.mockImplementation(statusReply(200))
    await advance(app, 2000)

    expect(heading(app)).toBeNull()
    expect(list(app)).not.toBeNull()
  })

  it('shows Unreachable when the probe fetch rejects, and recovers', async () => {
    vi.useFakeTimers()
    server.status.mockRejectedValue(new TypeError('Failed to fetch'))

    const app = await mountApp()
    expect(heading(app)?.textContent).toContain('Cannot reach the Signal K server')

    server.status.mockImplementation(statusReply(200))
    await advance(app, 1000)

    expect(list(app)).not.toBeNull()
  })

  it('re-probes the no-API screen on the timer and reaches the list', async () => {
    vi.useFakeTimers()
    server.status.mockImplementation(statusReply(404))
    const app = await mountApp()
    expect(list(app)).toBeNull()

    server.status.mockImplementation(statusReply(200))
    await advance(app, 1000)

    expect(list(app)).not.toBeNull()
  })

  it('re-probes the sign-in screen when the window regains focus', async () => {
    server.status.mockImplementation(statusReply(401))
    const app = await mountApp()
    expect(list(app)).toBeNull()
    server.status.mockImplementation(statusReply(200))

    window.dispatchEvent(new Event('focus'))
    await settle(app)

    expect(heading(app)).toBeNull()
    expect(list(app)).not.toBeNull()
  })

  it('re-probes the no-API screen when the tab becomes visible', async () => {
    server.status.mockImplementation(statusReply(404))
    const app = await mountApp()
    expect(list(app)).toBeNull()
    server.status.mockImplementation(statusReply(200))

    document.dispatchEvent(new Event('visibilitychange'))
    await settle(app)

    expect(list(app)).not.toBeNull()
  })

  it('renders state screens in a polite live region and focuses their heading', async () => {
    server.status.mockImplementation(statusReply(404))

    const app = await mountApp()

    const h = heading(app)
    expect(h).not.toBeNull()
    expect(app.shadowRoot?.activeElement).toBe(h)
  })

  describe('after live, when the socket closes', () => {
    it('shows the "Connection lost" strip over the last known list', async () => {
      vi.useFakeTimers()
      const app = await mountLive()

      sockets[0].simulateClose()
      await settle(app)

      expect(liveRegionText(app)).toContain('Connection lost — showing last known alerts')
      expect(list(app)).not.toBeNull()
      expect(app.shadowRoot?.querySelector('.views.stale')).not.toBeNull()
      expect(audio.playing()).toHaveLength(1)
    })

    it('keeps the list and the tone under a session-expired strip on a probe 401', async () => {
      vi.useFakeTimers()
      const app = await mountLive()
      server.status.mockImplementation(statusReply(401))

      sockets[0].simulateClose()
      await advance(app, 1000)
      // The handshake keeps failing: each attempt probes again.
      await advance(app, 2000)

      const text = liveRegionText(app)
      expect(text).toContain('Session expired — sign in')
      const link = app.shadowRoot?.querySelector('[aria-live="polite"] a')
      expect(link?.getAttribute('href')).toBe('/admin/#/login')
      expect(list(app)).not.toBeNull()
      expect(listText(app)).not.toContain('No alerts')
      expect(app.shadowRoot?.querySelector('.views.stale')).not.toBeNull()
      expect(audio.playing()).toHaveLength(1)
    })

    it('shows the no-API screen and stops the tone on a probe 404', async () => {
      vi.useFakeTimers()
      const app = await mountLive()
      server.status.mockImplementation(statusReply(404))

      sockets[0].simulateClose()
      await advance(app, 1000)

      expect(heading(app)?.textContent).toContain('Alerts API not available')
      expect(list(app)).toBeNull()
      expect(audio.playing()).toHaveLength(0)
    })

    it('drops the strip once a new socket opens', async () => {
      vi.useFakeTimers()
      const app = await mountLive()

      sockets[0].simulateClose()
      await advance(app, 1000)
      sockets[1].simulateOpen()
      await settle(app)

      expect(liveRegionText(app)).toBe('')
      expect(app.shadowRoot?.querySelector('.views.stale')).toBeNull()
    })
  })

  it('stays live when a write is refused, showing the refusal on the card', async () => {
    const app = await mountLive()
    const shown = list(app)
    const card = shown?.shadowRoot?.querySelector<Updatable>('alert-card')
    const ack = card?.shadowRoot?.querySelector<HTMLButtonElement>(
      'button[data-action="acknowledge"]'
    )
    expect(ack).toBeDefined()

    ack?.click()
    await settle(app)
    if (shown) await settle(shown)
    if (card) await settle(card)

    expect(liveRegionText(app)).toBe('')
    expect(app.shadowRoot?.querySelector('.views.stale')).toBeNull()
    expect(card?.shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
      'Not permitted'
    )
  })
})
