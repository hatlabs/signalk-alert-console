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
import {
  hangingReply,
  jsonResponse,
  statusReply,
  stubServer,
  textResponse
} from '../helpers/mock-server.js'
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
  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
  }
}

let audio: MockAudio
let server: MockServer
/** Answers the alert list; replace to delay or fail it. */
let listReply: () => Promise<Response>
/** Answers acknowledge, silence and silence-all; replace to fail them. */
let writeReply: (input: string, init?: RequestInit) => Promise<Response>

beforeEach(async () => {
  localStorage.clear()
  sockets = []
  audio = stubAudioContext()
  listReply = () => Promise.resolve(jsonResponse(200, [alert]))
  // Anonymous reads allowed, writes refused.
  writeReply = () => Promise.resolve(jsonResponse(401, { error: 'Permission Denied' }))
  server = stubServer((input: string, init?: RequestInit) => {
    const { pathname } = new URL(input, 'http://my-server.local')
    if (pathname === '/signalk/v2/api/alerts') {
      return listReply()
    }
    if (/\/(acknowledge|silence|silence-all)$/.test(pathname)) {
      return writeReply(input, init)
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

  it('offers Silence in the detail view with sound off on this display', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'off')
    const app = await mountApp()

    const detail = await openDetail(app)

    expect(detail.shadowRoot?.querySelector('.message')?.textContent).toContain('Bilge high')
    expect(detailSilence(detail)).not.toBeNull()
  })

  it('offers Silence in the detail view at the default threshold', async () => {
    const app = await mountApp()

    const detail = await openDetail(app)

    expect(detailSilence(detail)).not.toBeNull()
  })
})

describe('AlertApp detail overlay', () => {
  const second: Alert = { ...alert, id: 'alert-2', priority: 'alarm', message: 'Engine hot' }

  function cards(app: Element): Updatable[] {
    return Array.from(list(app)?.shadowRoot?.querySelectorAll<Updatable>('alert-card') ?? [])
  }

  function cardFor(app: Element, id: string): Updatable {
    const found = cards(app).find((c) => (c as Updatable & { alert: Alert }).alert.id === id)
    if (!found) throw new Error(`no card for ${id}`)
    return found
  }

  function selectable(card: Element): HTMLElement {
    const el = card.shadowRoot?.querySelector<HTMLElement>('.content')
    if (!el) throw new Error('card has no selectable area')
    return el
  }

  async function openFromCard(app: Updatable, id: string): Promise<Updatable> {
    const target = selectable(cardFor(app, id))
    target.focus()
    target.click()
    await settle(app)
    const detail = child(app, 'alert-detail')
    await settle(detail)
    return detail
  }

  async function pressBackdrop(app: Updatable, detail: Element): Promise<void> {
    const dialog = detail.shadowRoot?.querySelector('dialog')
    expect(dialog).not.toBeNull()
    dialog?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    dialog?.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }))
    await settle(app)
  }

  /** The element focused inside the card's shadow root, if focus is in that card. */
  function focusedIn(card: Element): Element | null {
    return card.shadowRoot?.activeElement ?? null
  }

  beforeEach(() => {
    listReply = () => Promise.resolve(jsonResponse(200, [alert, second]))
  })

  it('keeps the list mounted and visible behind the open detail', async () => {
    const app = await mountLive()

    await openFromCard(app, second.id)

    const shown = list(app)
    expect(shown).not.toBeNull()
    expect(shown?.getAttribute('style') ?? '').not.toContain('display')
    expect(cards(app)).toHaveLength(2)
  })

  it('closes on a press on the backdrop and returns focus to the card', async () => {
    const app = await mountLive()
    const detail = await openFromCard(app, second.id)

    await pressBackdrop(app, detail)

    expect(app.shadowRoot?.querySelector('alert-detail')).toBeNull()
    expect(focusedIn(cardFor(app, second.id))).toBe(selectable(cardFor(app, second.id)))
  })

  it('closes on Escape and returns focus to the card', async () => {
    const app = await mountLive()
    const detail = await openFromCard(app, second.id)

    detail.shadowRoot
      ?.querySelector('button[data-action="close"]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true })
      )
    await settle(app)

    expect(app.shadowRoot?.querySelector('alert-detail')).toBeNull()
    expect(focusedIn(cardFor(app, second.id))).toBe(selectable(cardFor(app, second.id)))
  })

  it('stays open on a press on its own action buttons', async () => {
    const app = await mountLive()
    const detail = await openFromCard(app, second.id)
    const silence = detailSilence(detail)
    expect(silence).not.toBeNull()

    silence?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }))
    ;(silence as HTMLButtonElement).click()
    await settle(app)

    expect(app.shadowRoot?.querySelector('alert-detail')).not.toBeNull()
  })

  it('returns focus to the same alert card after the list reorders', async () => {
    const app = await mountLive()
    const detail = await openFromCard(app, second.id)

    // The alert above clears, so the second alert's card moves up a place.
    sockets[0].simulateMessage({
      updates: [{ values: [{ path: 'alerts.alert-1', value: { ...alert, state: 'normal' } }] }]
    })
    await settle(app)
    await pressBackdrop(app, detail)

    expect(cards(app)).toHaveLength(1)
    expect(focusedIn(cardFor(app, second.id))).toBe(selectable(cardFor(app, second.id)))
  })

  it('opens the detail from a card with the keyboard', async () => {
    const app = await mountLive()
    const target = selectable(cardFor(app, second.id))
    expect(target.getAttribute('tabindex')).toBe('0')
    expect(target.getAttribute('role')).toBe('button')

    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await settle(app)

    expect(child(app, 'alert-detail').getAttribute('alert-id')).toBe(second.id)
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
    expect(link?.getAttribute('href')).toBe('/signalk/v1/auth/oidc/login?redirect=%2F')
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

    it('reaches session-expired from a liveness 401 while live: list and tone stay', async () => {
      vi.useFakeTimers()
      const app = await mountLive()
      server.status.mockImplementation(statusReply(401))

      await advance(app, 30000)
      await advance(app, 1000)

      expect(liveRegionText(app)).toContain('Session expired — sign in')
      expect(list(app)?.shadowRoot?.querySelectorAll('alert-card')).toHaveLength(1)
      expect(audio.playing()).toHaveLength(1)
    })

    it('treats a probe 404 as connection lost: strip, list and tone stay', async () => {
      vi.useFakeTimers()
      const app = await mountLive()
      server.status.mockImplementation(statusReply(404))

      sockets[0].simulateClose()
      await advance(app, 1000)

      expect(liveRegionText(app)).toContain('Connection lost — showing last known alerts')
      expect(heading(app)).toBeNull()
      expect(list(app)?.shadowRoot?.querySelectorAll('alert-card')).toHaveLength(1)
      expect(audio.playing()).toHaveLength(1)
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
      'Not permitted — sign in with a read/write account'
    )
  })
})

describe('AlertApp sound threshold', () => {
  function makeAlert(overrides: Partial<Alert>): Alert {
    return { ...alert, id: crypto.randomUUID(), ...overrides }
  }

  /** Mount live, with its socket open, listing the given alerts. */
  async function mountWith(alerts: Alert[]): Promise<Updatable> {
    listReply = () => Promise.resolve(jsonResponse(200, alerts))
    const app = await mountApp()
    simulateUserGesture()
    sockets[0].simulateOpen()
    await settle(app)
    return app
  }

  function soundSelect(app: Element): HTMLSelectElement {
    const select = list(app)?.shadowRoot?.querySelector('select[data-setting="sound"]')
    expect(select).not.toBeNull()
    return select as HTMLSelectElement
  }

  async function chooseSound(app: Updatable, value: string): Promise<void> {
    const select = soundSelect(app)
    select.value = value
    select.dispatchEvent(new Event('change'))
    await settle(app)
    const shown = list(app)
    if (shown) await settle(shown)
  }

  function silenceButtons(app: Element): Element[] {
    return Array.from(list(app)?.shadowRoot?.querySelectorAll('alert-card') ?? []).flatMap((card) =>
      Array.from(card.shadowRoot?.querySelectorAll('button[data-action="silence"]') ?? [])
    )
  }

  function soundOffIndicator(app: Element): Element | null {
    return list(app)?.shadowRoot?.querySelector('.sound-off') ?? null
  }

  it('starts at warning when nothing is stored, and a new alarm sounds', async () => {
    const app = await mountWith([makeAlert({ priority: 'alarm' })])

    const select = soundSelect(app)
    expect(select.value).toBe('warning')
    expect(select.selectedOptions[0].text.trim()).toBe('Warning and above')
    expect(audio.playing()).toHaveLength(1)
    expect(soundOffIndicator(app)).toBeNull()
  })

  it('turning sound off stores it and stops the tone; Silence stays', async () => {
    const app = await mountWith([makeAlert({ priority: 'alarm' })])
    expect(audio.playing()).toHaveLength(1)

    await chooseSound(app, 'off')

    expect(localStorage.getItem(MIN_AUDIBLE_PRIORITY_KEY)).toBe('off')
    expect(soundSelect(app).value).toBe('off')
    expect(audio.playing()).toHaveLength(0)
    // Silence is server-wide: the alert may be sounding on another display.
    expect(silenceButtons(app)).toHaveLength(1)
    expect(soundOffIndicator(app)?.textContent).toContain('Sound off')
  })

  it('starts at a stored alarm threshold, so a warning stays silent', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'alarm')

    const app = await mountWith([makeAlert({ priority: 'warning' })])

    expect(soundSelect(app).value).toBe('alarm')
    expect(audio.oscillators).toHaveLength(0)
  })

  it('offers Silence on a warning at emergency only, never on a caution', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'emergency')

    const app = await mountWith([
      makeAlert({ priority: 'warning' }),
      makeAlert({ priority: 'caution' })
    ])

    expect(silenceButtons(app)).toHaveLength(1)
  })

  it('shows the Sound off indicator when off is stored', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'off')

    const app = await mountWith([makeAlert({ priority: 'emergency' })])

    expect(soundSelect(app).value).toBe('off')
    expect(soundOffIndicator(app)?.textContent).toContain('Sound off')
    expect(audio.oscillators).toHaveLength(0)
  })

  it('treats a garbage stored value as warning', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'very-loud')

    const app = await mountWith([makeAlert({ priority: 'warning' })])

    expect(soundSelect(app).value).toBe('warning')
    expect(audio.playing()).toHaveLength(1)
  })

  it('treats a stored caution as warning: caution stays silent, warning sounds', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'caution')

    const app = await mountWith([
      makeAlert({ priority: 'caution' }),
      makeAlert({ priority: 'warning' })
    ])

    expect(soundSelect(app).value).toBe('warning')
    expect(audio.playing()).toHaveLength(1)
    expect(audio.playing()[0].frequency.value).toBe(440)
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

    const app = await mountWith([makeAlert({ priority: 'warning' })])
    expect(soundSelect(app).value).toBe('warning')
    expect(audio.playing()).toHaveLength(1)

    await chooseSound(app, 'off')

    expect(soundSelect(app).value).toBe('off')
    expect(audio.playing()).toHaveLength(0)
    expect(soundOffIndicator(app)).not.toBeNull()
  })

  it('lowering the threshold starts the tone of an alert now above it', async () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'alarm')
    const app = await mountWith([makeAlert({ priority: 'warning' })])
    expect(audio.oscillators).toHaveLength(0)

    await chooseSound(app, 'warning')

    expect(audio.playing()).toHaveLength(1)
  })
})

describe('AlertApp acting during an outage', () => {
  const LOCAL_ONLY = 'On this display only — not confirmed by the server'
  const unreachable = () => Promise.reject(new TypeError('Failed to fetch'))

  function card(app: Element): Updatable {
    const el = list(app)?.shadowRoot?.querySelector('alert-card')
    expect(el).not.toBeNull()
    return el as Updatable
  }

  async function press(app: Updatable, host: Updatable, action: string): Promise<void> {
    const btn = host.shadowRoot?.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)
    expect(btn).not.toBeNull()
    btn?.click()
    await settle(app)
    const shown = list(app)
    if (shown) await settle(shown)
    await settle(host)
  }

  function marker(host: Element): string | null {
    const text = host.shadowRoot?.querySelector('.local-only')?.textContent
    return text === undefined ? null : text.replace(/\s+/g, ' ').trim()
  }

  /** Live, then the connection drops while the alarm sounds. */
  async function mountThenLost(): Promise<Updatable> {
    vi.useFakeTimers()
    const app = await mountLive()
    sockets[0].simulateClose()
    await settle(app)
    writeReply = unreachable
    return app
  }

  it('acknowledges on this display only: tone stops, card marked', async () => {
    const app = await mountThenLost()

    await press(app, card(app), 'acknowledge')

    expect(audio.playing()).toHaveLength(0)
    expect(marker(card(app))).toBe(LOCAL_ONLY)
    expect(card(app).shadowRoot?.querySelector('[role="alert"]')).toBeNull()
  })

  it('silences on this display only: tone stops, card marked', async () => {
    const app = await mountThenLost()

    await press(app, card(app), 'silence')

    expect(audio.playing()).toHaveLength(0)
    expect(marker(card(app))).toBe(LOCAL_ONLY)
  })

  it('silences all on this display only: tone stops, card marked', async () => {
    const app = await mountThenLost()
    const shown = list(app)
    expect(shown).not.toBeNull()

    if (shown) await press(app, shown, 'silence-all')

    expect(audio.playing()).toHaveLength(0)
    expect(marker(card(app))).toBe(LOCAL_ONLY)
    expect(shown?.shadowRoot?.querySelector('.toolbar [role="alert"]')).toBeNull()
  })

  it('drops the local acknowledgement on reconnect: marker gone, tone resumes', async () => {
    const app = await mountThenLost()
    await press(app, card(app), 'acknowledge')
    expect(audio.playing()).toHaveLength(0)

    await advance(app, 1000)
    sockets[1].simulateOpen()
    await settle(app)
    await settle(card(app))

    expect(marker(card(app))).toBeNull()
    expect(audio.playing()).toHaveLength(1)
  })

  it('marks the detail view too', async () => {
    const app = await mountThenLost()
    const detail = await openDetail(app)

    await press(app, detail, 'acknowledge')

    expect(marker(detail)).toBe(LOCAL_ONLY)
    expect(audio.playing()).toHaveLength(0)
  })

  function cardError(app: Element): string | undefined {
    return card(app).shadowRoot?.querySelector('[role="alert"]')?.textContent.trim()
  }

  it('refuses a live 500 inline when the server still answers: no marker, tone continues', async () => {
    vi.useFakeTimers()
    const app = await mountLive()
    writeReply = () => Promise.resolve(jsonResponse(500, { message: 'Store write failed' }))

    await press(app, card(app), 'acknowledge')

    expect(cardError(app)).toBe('Store write failed')
    expect(marker(card(app))).toBeNull()
    expect(audio.playing()).toHaveLength(1)
    expect(liveRegionText(app)).toBe('')
  })

  it('refuses a live 404 inline when the server still answers', async () => {
    vi.useFakeTimers()
    const app = await mountLive()
    writeReply = () => Promise.resolve(textResponse(404, 'Not Found', 'Not Found'))

    await press(app, card(app), 'acknowledge')

    expect(cardError(app)).toBe('This alert is no longer active')
    expect(marker(card(app))).toBeNull()
    expect(audio.playing()).toHaveLength(1)
  })

  it('acts locally when a live write times out and the status probe fails', async () => {
    vi.useFakeTimers()
    const app = await mountLive()
    writeReply = hangingReply
    server.status.mockImplementation(statusReply(502))

    await press(app, card(app), 'acknowledge')
    await advance(app, 10000)
    await settle(card(app))

    expect(liveRegionText(app)).toContain('Connection lost — showing last known alerts')
    expect(marker(card(app))).toBe(LOCAL_ONLY)
    expect(card(app).shadowRoot?.querySelector('[role="alert"]')).toBeNull()
    expect(audio.playing()).toHaveLength(0)
  })

  it('acts at once while reconnecting, sending nothing; a repeat changes nothing', async () => {
    const app = await mountThenLost()
    const write = vi.fn(hangingReply)
    writeReply = write

    await press(app, card(app), 'acknowledge')

    expect(audio.playing()).toHaveLength(0)
    expect(write).not.toHaveBeenCalled()

    card(app).dispatchEvent(
      new CustomEvent('alert-acknowledge', {
        detail: { id: alert.id },
        bubbles: true,
        composed: true
      })
    )
    await settle(app)
    await settle(card(app))

    expect(write).not.toHaveBeenCalled()
    expect(marker(card(app))).toBe(LOCAL_ONLY)
    expect(card(app).shadowRoot?.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a live 401 a refusal, with no local effect', async () => {
    const app = await mountLive()

    await press(app, card(app), 'acknowledge')

    expect(card(app).shadowRoot?.querySelector('[role="alert"]')?.textContent).toContain(
      'Not permitted — sign in with a read/write account'
    )
    expect(marker(card(app))).toBeNull()
    expect(audio.playing()).toHaveLength(1)
  })
})
