/**
 * Audio settings tests: the per-browser minimum audible priority.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  MIN_AUDIBLE_PRIORITY_KEY,
  loadMinAudiblePriority,
  saveMinAudiblePriority
} from '../../src/services/audio-settings.js'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
  vi.restoreAllMocks()
})

function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException('denied', 'SecurityError')
  }
  return {
    length: 0,
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail
  }
}

describe('audio settings', () => {
  it('uses a fixed storage key', () => {
    expect(MIN_AUDIBLE_PRIORITY_KEY).toBe('signalk-alert-console.minAudiblePriority')
  })

  it('defaults to warning when nothing is stored', () => {
    expect(loadMinAudiblePriority()).toBe('warning')
  })

  it.each(['off', 'emergency', 'alarm', 'warning'] as const)('round-trips %s', (value) => {
    saveMinAudiblePriority(value)
    expect(localStorage.getItem(MIN_AUDIBLE_PRIORITY_KEY)).toBe(value)
    expect(loadMinAudiblePriority()).toBe(value)
  })

  it.each(['loud', '', 'Warning', 'normal', 'toString'])('treats stored %j as warning', (value) => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, value)
    expect(loadMinAudiblePriority()).toBe('warning')
  })

  it('treats a stored caution as warning, since caution never sounds', () => {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, 'caution')
    expect(loadMinAudiblePriority()).toBe('warning')
  })

  it('falls back to warning when storage methods throw', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(loadMinAudiblePriority()).toBe('warning')
  })

  it('swallows errors when saving to storage that throws', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => {
      saveMinAudiblePriority('off')
    }).not.toThrow()
  })

  it('falls back to warning when the storage accessor itself throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      }
    })
    try {
      expect(loadMinAudiblePriority()).toBe('warning')
      expect(() => {
        saveMinAudiblePriority('alarm')
      }).not.toThrow()
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    }
  })
})
