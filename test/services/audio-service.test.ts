/**
 * AudioService Tests
 *
 * Tests for browser audio playback of alert notifications.
 * Uses Web Audio API synthesis with pulsed tone patterns per priority level.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Alert, AlertPriority } from '../../src/types.js'
import { _resetAudioServiceSingleton } from '../../src/services/audio-service.js'

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

/** Simulate a user gesture to unlock AudioContext. */
function simulateUserGesture(): void {
  document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// ---------------------------------------------------------------------------
// Mock Web Audio API
// ---------------------------------------------------------------------------

class MockOscillatorNode {
  type = 'sine'
  frequency = { value: 0 }
  started = false
  stopped = false
  connectedTo: MockGainNode | null = null

  connect(destination: MockGainNode): void {
    this.connectedTo = destination
  }

  start(): void {
    this.started = true
  }

  stop(): void {
    this.stopped = true
  }

  disconnect(): void {
    this.connectedTo = null
  }
}

class MockGainNode {
  gain = {
    value: 0,
    setValueAtTime: vi.fn(),
    linearRampToValueAtTime: vi.fn(),
    cancelScheduledValues: vi.fn()
  }
  connectedTo: unknown = null

  connect(destination: unknown): void {
    this.connectedTo = destination
  }

  disconnect(): void {
    this.connectedTo = null
  }
}

class MockAudioContext {
  state = 'running' as AudioContextState
  destination = {}
  currentTime = 0

  oscillators: MockOscillatorNode[] = []
  gainNodes: MockGainNode[] = []

  createOscillator(): MockOscillatorNode {
    const osc = new MockOscillatorNode()
    this.oscillators.push(osc)
    return osc
  }

  createGain(): MockGainNode {
    const gain = new MockGainNode()
    this.gainNodes.push(gain)
    return gain
  }

  resume(): Promise<void> {
    this.state = 'running'
    return Promise.resolve()
  }

  close(): Promise<void> {
    this.state = 'closed'
    return Promise.resolve()
  }
}

let mockAudioContext: MockAudioContext

beforeEach(() => {
  mockAudioContext = new MockAudioContext()
  vi.stubGlobal(
    'AudioContext',
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- constructor hands back the shared mock
    class {
      constructor() {
        return mockAudioContext
      }
    }
  )
})

afterEach(() => {
  _resetAudioServiceSingleton()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Lazy import after mocks are set up
// ---------------------------------------------------------------------------

async function importAudioService() {
  // Dynamic import so mocks are in place first
  const mod = await import('../../src/services/audio-service.js')
  return mod.AudioService
}

/** Create a service and simulate a user gesture so audio is unlocked. */
async function createUnlockedService(options?: {
  minAudiblePriority?: 'off' | 'emergency' | 'alarm' | 'warning'
}) {
  const AudioService = await importAudioService()
  const service = new AudioService(options)
  simulateUserGesture()
  return service
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AudioService', () => {
  describe('construction', () => {
    it('defaults to warning as minimum audible priority', async () => {
      const service = await createUnlockedService()
      expect(service.isEnabled()).toBe(true)
      service.dispose()
    })

    it('can be constructed with audio disabled via off', async () => {
      const service = await createUnlockedService({ minAudiblePriority: 'off' })
      expect(service.isEnabled()).toBe(false)
      service.dispose()
    })

    it('can be constructed with emergency-only audio', async () => {
      const service = await createUnlockedService({ minAudiblePriority: 'emergency' })
      expect(service.isEnabled()).toBe(true)
      service.dispose()
    })
  })

  describe('user gesture gating', () => {
    it('does not play audio before user gesture', async () => {
      const AudioService = await importAudioService()
      const service = new AudioService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      // No oscillator created — waiting for user gesture
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })

    it('starts playing after user gesture when alerts are waiting', async () => {
      const AudioService = await importAudioService()
      const service = new AudioService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      // User interacts with the page
      simulateUserGesture()

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      expect(mockAudioContext.oscillators[0].started).toBe(true)

      service.dispose()
    })

    it('plays immediately if user has already interacted', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('enable/disable', () => {
    it('setMinAudiblePriority(off) stops any playing tone', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.setMinAudiblePriority('off')
      expect(service.isEnabled()).toBe(false)
      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })

    it('setMinAudiblePriority(warning) re-evaluates alerts and plays if needed', async () => {
      const service = await createUnlockedService({ minAudiblePriority: 'off' })

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.setMinAudiblePriority('warning')
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('minAudiblePriority filtering', () => {
    it('emergency-only suppresses alarm and warning tones', async () => {
      const service = await createUnlockedService({ minAudiblePriority: 'emergency' })

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.update([
        makeAlert({ priority: 'emergency', state: 'unacknowledged', silenced: false })
      ])
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })

    it('alarm threshold suppresses warning but allows alarm and emergency', async () => {
      const service = await createUnlockedService({ minAudiblePriority: 'alarm' })

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })

    it('off suppresses all audio', async () => {
      const service = await createUnlockedService({ minAudiblePriority: 'off' })

      service.update([
        makeAlert({ priority: 'emergency', state: 'unacknowledged', silenced: false })
      ])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })
  })

  describe('priority tones', () => {
    it('plays pulsed tone for emergency at 880 Hz', async () => {
      const service = await createUnlockedService()

      service.update([
        makeAlert({ priority: 'emergency', state: 'unacknowledged', silenced: false })
      ])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)
      expect(osc.frequency.value).toBe(880)

      service.dispose()
    })

    it('plays pulsed tone for alarm at 660 Hz', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)
      expect(osc.frequency.value).toBe(660)

      service.dispose()
    })

    it('plays pulsed tone for warning at 440 Hz', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)
      expect(osc.frequency.value).toBe(440)

      service.dispose()
    })

    it('does not play audio for caution', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'caution', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })

    it('uses different frequencies for different priorities', async () => {
      const AudioService = await importAudioService()
      const frequencies: Record<string, number> = {}

      for (const priority of ['emergency', 'alarm', 'warning'] as AlertPriority[]) {
        mockAudioContext = new MockAudioContext()
        const svc = new AudioService()
        simulateUserGesture()
        svc.update([makeAlert({ priority, state: 'unacknowledged', silenced: false })])

        if (mockAudioContext.oscillators.length > 0) {
          frequencies[priority] = mockAudioContext.oscillators[0].frequency.value
        }
        svc.dispose()
      }

      expect(frequencies.emergency).toBeGreaterThan(frequencies.alarm)
      expect(frequencies.alarm).toBeGreaterThan(frequencies.warning)
    })
  })

  describe('pulse envelope', () => {
    it('starts gain at zero and schedules rise/fall ramps', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      expect(mockAudioContext.gainNodes.length).toBeGreaterThan(0)
      const gainNode = mockAudioContext.gainNodes[0]

      // Gain initialized to 0 via setValueAtTime
      expect(gainNode.gain.setValueAtTime).toHaveBeenCalled()
      // Rise and fall ramps scheduled
      expect(gainNode.gain.linearRampToValueAtTime).toHaveBeenCalled()

      // Should have multiple setValueAtTime/linearRamp pairs for pulse envelope
      // Alarm has 3 pulses: each pulse has setValueAtTime(0) + ramp up + setValueAtTime(peak) + ramp down
      // Plus the initial setValueAtTime(0) in playTone
      const setValueCalls = gainNode.gain.setValueAtTime.mock.calls.length
      const rampCalls = gainNode.gain.linearRampToValueAtTime.mock.calls.length
      expect(setValueCalls).toBeGreaterThanOrEqual(7) // 1 init + 3 pulses * 2
      expect(rampCalls).toBeGreaterThanOrEqual(6) // 3 pulses * 2 (rise + fall)

      service.dispose()
    })

    it('schedules repeating bursts via timer', async () => {
      vi.useFakeTimers()
      const AudioService = await importAudioService()
      const service = new AudioService()
      simulateUserGesture()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])

      const gainNode = mockAudioContext.gainNodes[0]
      const initialRampCount = gainNode.gain.linearRampToValueAtTime.mock.calls.length

      // Advance past burst duration + inter-burst interval to trigger next burst
      // Warning: 2 pulses * 200ms + 1 gap * 200ms + 2500ms inter-burst = 3100ms
      vi.advanceTimersByTime(3200)

      // More ramp calls should have been scheduled for the next burst
      expect(gainNode.gain.linearRampToValueAtTime.mock.calls.length).toBeGreaterThan(
        initialRampCount
      )

      vi.useRealTimers()
      service.dispose()
    })

    it('clears stale automation events before each burst', async () => {
      vi.useFakeTimers()
      const AudioService = await importAudioService()
      const service = new AudioService()
      simulateUserGesture()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])

      const gainNode = mockAudioContext.gainNodes[0]

      // First burst calls cancelScheduledValues
      expect(gainNode.gain.cancelScheduledValues).toHaveBeenCalledTimes(1)

      // Advance to trigger second burst
      vi.advanceTimersByTime(3200)
      expect(gainNode.gain.cancelScheduledValues).toHaveBeenCalledTimes(2)

      vi.useRealTimers()
      service.dispose()
    })

    it('stopTone clears burst scheduling', async () => {
      vi.useFakeTimers()
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      const gainNode = mockAudioContext.gainNodes[0]

      // Stop the tone (e.g., by clearing alerts)
      service.update([])

      const rampCountAfterStop = gainNode.gain.linearRampToValueAtTime.mock.calls.length

      // Advance well past any burst interval — no new ramps should be scheduled
      vi.advanceTimersByTime(5000)

      expect(gainNode.gain.linearRampToValueAtTime.mock.calls.length).toBe(rampCountAfterStop)

      vi.useRealTimers()
      service.dispose()
    })
  })

  describe('silence state', () => {
    it('does not play for silenced alerts', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: true })])

      expect(mockAudioContext.oscillators.length).toBe(0)

      service.dispose()
    })

    it('stops playing when alert becomes silenced', async () => {
      const service = await createUnlockedService()

      const alert = makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })
      service.update([alert])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)
      const osc = mockAudioContext.oscillators[0]
      expect(osc.started).toBe(true)

      service.update([{ ...alert, silenced: true }])

      expect(osc.stopped).toBe(true)

      service.dispose()
    })

    it('resumes audio when silence expires (alert becomes unsilenced)', async () => {
      const service = await createUnlockedService()

      const alert = makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: true })
      service.update([alert])
      expect(mockAudioContext.oscillators.length).toBe(0)

      service.update([{ ...alert, silenced: false }])
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('alert state changes', () => {
    it('stops playing when alert is acknowledged', async () => {
      const service = await createUnlockedService()

      const alert = makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })
      service.update([alert])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.update([{ ...alert, state: 'acknowledged' }])

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })

    it('stops playing when alert is removed (cleared)', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.update([])

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })

    it('plays for rtn-unacknowledged alerts', async () => {
      const service = await createUnlockedService()

      service.update([
        makeAlert({ priority: 'alarm', state: 'rtn-unacknowledged', silenced: false })
      ])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })
  })

  describe('highest priority selection', () => {
    it('plays tone for highest unsilenced priority', async () => {
      const service = await createUnlockedService()

      service.update([
        makeAlert({
          id: 'e1',
          priority: 'emergency',
          state: 'unacknowledged',
          silenced: true
        }),
        makeAlert({
          id: 'a1',
          priority: 'alarm',
          state: 'unacknowledged',
          silenced: false
        })
      ])

      expect(mockAudioContext.oscillators.length).toBeGreaterThan(0)

      service.dispose()
    })

    it('upgrades tone when higher-priority alert arrives', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])
      const warningFreq = mockAudioContext.oscillators[0]?.frequency.value ?? 0

      service.update([
        makeAlert({ id: 'w1', priority: 'warning', state: 'unacknowledged', silenced: false }),
        makeAlert({ id: 'a1', priority: 'alarm', state: 'unacknowledged', silenced: false })
      ])

      const latestOsc = mockAudioContext.oscillators[mockAudioContext.oscillators.length - 1]
      expect(latestOsc.frequency.value).toBeGreaterThan(warningFreq)

      service.dispose()
    })
  })

  describe('dispose', () => {
    it('stops all audio and closes context', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      service.dispose()

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }
      expect(mockAudioContext.state).toBe('closed')
    })

    it('is idempotent', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      service.dispose()
      // Should not throw
      service.dispose()

      expect(mockAudioContext.state).toBe('closed')
    })

    it('handles AudioContext.close() rejection gracefully', async () => {
      mockAudioContext.close = () => Promise.reject(new Error('already closed'))
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])

      // Should not throw
      expect(() => {
        service.dispose()
      }).not.toThrow()
    })
  })

  describe('concurrent updates', () => {
    it('handles rapid priority changes without orphaned oscillators', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'warning', state: 'unacknowledged', silenced: false })])
      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      service.update([
        makeAlert({ priority: 'emergency', state: 'unacknowledged', silenced: false })
      ])

      // All previous oscillators should be stopped
      for (let i = 0; i < mockAudioContext.oscillators.length - 1; i++) {
        expect(mockAudioContext.oscillators[i].stopped).toBe(true)
      }
      // Only the last one should be active
      const last = mockAudioContext.oscillators[mockAudioContext.oscillators.length - 1]
      expect(last.started).toBe(true)
      expect(last.stopped).toBe(false)
      expect(last.frequency.value).toBe(880)

      service.dispose()
    })

    it('handles rapid update then clear without leftover audio', async () => {
      const service = await createUnlockedService()

      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      service.update([makeAlert({ priority: 'alarm', state: 'unacknowledged', silenced: false })])
      service.update([])

      for (const osc of mockAudioContext.oscillators) {
        expect(osc.stopped).toBe(true)
      }

      service.dispose()
    })
  })
})
