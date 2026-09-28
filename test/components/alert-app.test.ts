/**
 * AlertApp tests: navigation between the list and the detail view.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert } from '../../src/types.js'
import { _resetAlertServiceSingleton } from '../../src/services/alert-service.js'
import { _resetAudioServiceSingleton } from '../../src/services/audio-service.js'
import { MIN_AUDIBLE_PRIORITY_KEY } from '../../src/services/audio-settings.js'
import { stubAudioContext } from '../helpers/mock-audio.js'

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

beforeEach(async () => {
  localStorage.clear()
  stubAudioContext()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const { pathname } = new URL(input, 'http://my-server.local')
      if (pathname === '/signalk/v2/api/alerts') {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([alert]) })
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' })
    })
  )
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
  await import('../../src/main.js')
})

afterEach(() => {
  document.body.innerHTML = ''
  localStorage.clear()
  _resetAlertServiceSingleton()
  _resetAudioServiceSingleton()
  vi.unstubAllGlobals()
})

async function settle(el: Updatable): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete
    await new Promise((r) => setTimeout(r, 0))
  }
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

describe('AlertApp', () => {
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
