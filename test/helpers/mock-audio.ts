/**
 * Minimal Web Audio stand-in for component tests: records the oscillators
 * the audio service starts and stops. happy-dom has no AudioContext.
 */

import { vi } from 'vitest'

export interface MockOscillator {
  frequency: { value: number }
  started: boolean
  stopped: boolean
}

export interface MockAudio {
  oscillators: MockOscillator[]
  /** Oscillators started and not yet stopped. */
  playing(): MockOscillator[]
}

function audioParam() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  }
}

/** Stub the global AudioContext; call before the audio service is acquired. */
export function stubAudioContext(): MockAudio {
  const oscillators: MockOscillator[] = []
  const ctx = {
    state: 'running',
    destination: {},
    currentTime: 0,
    createGain: () => ({ gain: audioParam(), connect: vi.fn(), disconnect: vi.fn() }),
    createOscillator: () => {
      const osc = {
        type: 'sine',
        frequency: { value: 0 },
        started: false,
        stopped: false,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start() {
          osc.started = true
        },
        stop() {
          osc.stopped = true
        }
      }
      oscillators.push(osc)
      return osc
    },
    resume: () => Promise.resolve(),
    close: () => Promise.resolve()
  }
  vi.stubGlobal(
    'AudioContext',
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- constructor hands back the shared mock
    class {
      constructor() {
        return ctx
      }
    }
  )
  return {
    oscillators,
    playing: () => oscillators.filter((o) => o.started && !o.stopped)
  }
}

/** A document-level gesture, which unlocks audio playback. */
export function simulateUserGesture(): void {
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}
