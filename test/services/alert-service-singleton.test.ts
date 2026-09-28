/**
 * Singleton acquire/release lifecycle tests for AlertService and AudioService.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  acquireAlertService,
  releaseAlertService,
  _resetAlertServiceSingleton
} from '../../src/services/alert-service.js'
import {
  acquireAudioService,
  releaseAudioService,
  _resetAudioServiceSingleton
} from '../../src/services/audio-service.js'

// Stub WebSocket and fetch so AlertService.connect() does not fail
class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  send(): void {}
  close(): void {
    this.readyState = MockWebSocket.CLOSED
  }
}

beforeEach(() => {
  vi.stubGlobal('WebSocket', MockWebSocket)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve([]) }))
})

afterEach(() => {
  _resetAlertServiceSingleton()
  _resetAudioServiceSingleton()
  vi.unstubAllGlobals()
})

describe('AlertService singleton', () => {
  it('returns the same instance on multiple acquires', () => {
    const a = acquireAlertService()
    const b = acquireAlertService()
    expect(a).toBe(b)
  })

  it('does not disconnect until the last consumer releases', () => {
    const service = acquireAlertService()
    const spy = vi.spyOn(service, 'disconnect')

    acquireAlertService()

    releaseAlertService()
    expect(spy).not.toHaveBeenCalled()

    releaseAlertService()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('creates a new instance after full release', () => {
    const first = acquireAlertService()
    releaseAlertService()

    const second = acquireAlertService()
    expect(second).not.toBe(first)
  })

  it('spurious release does not disconnect active consumers', () => {
    const service = acquireAlertService()
    const spy = vi.spyOn(service, 'disconnect')

    // Legitimate release
    releaseAlertService()
    expect(spy).toHaveBeenCalledOnce()

    // Spurious release -- should be a no-op
    releaseAlertService()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('spurious release without any acquire is a no-op', () => {
    releaseAlertService()
    releaseAlertService()

    const service = acquireAlertService()
    expect(service).toBeDefined()
  })
})

describe('AudioService singleton', () => {
  it('returns the same instance on multiple acquires', () => {
    const a = acquireAudioService()
    const b = acquireAudioService()
    expect(a).toBe(b)
  })

  it('does not dispose until the last consumer releases', () => {
    const service = acquireAudioService()
    const spy = vi.spyOn(service, 'dispose')

    acquireAudioService()

    releaseAudioService()
    expect(spy).not.toHaveBeenCalled()

    releaseAudioService()
    expect(spy).toHaveBeenCalledOnce()
  })

  it('creates a new instance after full release', () => {
    const first = acquireAudioService()
    releaseAudioService()

    const second = acquireAudioService()
    expect(second).not.toBe(first)
  })

  it('spurious release without any acquire is a no-op', () => {
    releaseAudioService()
    releaseAudioService()

    const service = acquireAudioService()
    expect(service).toBeDefined()
  })
})
