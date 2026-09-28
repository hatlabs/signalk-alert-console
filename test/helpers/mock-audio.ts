/**
 * Minimal Web Audio stand-in for component tests: records the oscillators
 * the audio service starts and stops, and models the browser's autoplay
 * block. happy-dom has no AudioContext.
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

interface StubOptions {
  /**
   * The state a new context starts in: 'running' for a page the browser lets
   * play, 'suspended' for one blocked until a gesture.
   */
  state?: 'running' | 'suspended'
}

/** True while a gesture is being dispatched, as the browser's user activation. */
let gestureActive = false

function audioParam() {
  return {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  }
}

class MockContext extends EventTarget {
  destination = {}
  currentTime = 0

  constructor(
    public state: AudioContextState,
    private readonly oscillators: MockOscillator[]
  ) {
    super()
  }

  createGain() {
    return { gain: audioParam(), connect: vi.fn(), disconnect: vi.fn() }
  }

  createOscillator() {
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
    this.oscillators.push(osc)
    return osc
  }

  /** Resolves either way, as browsers do; only a gesture lets it start. */
  resume(): Promise<void> {
    if (gestureActive && this.state === 'suspended') {
      this.state = 'running'
      this.dispatchEvent(new Event('statechange'))
    }
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

/** Stub the global AudioContext; call before the audio service is acquired. */
export function stubAudioContext({ state = 'running' }: StubOptions = {}): MockAudio {
  const oscillators: MockOscillator[] = []
  const ctx = new MockContext(state, oscillators)
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
  gestureActive = true
  try {
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  } finally {
    gestureActive = false
  }
}
