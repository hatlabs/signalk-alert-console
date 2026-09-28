/**
 * AudioService
 *
 * Synthesizes alert tones using the Web Audio API with IEC 60601-1-8
 * inspired pulsed patterns. Each priority level has a distinct pulse
 * pattern that conveys urgency through pulse count, timing, and frequency:
 * - Emergency: 5-pulse rapid burst at 880 Hz
 * - Alarm: 3-pulse triplet at 660 Hz
 * - Warning: 2-pulse double chime at 440 Hz
 * - Caution: no audible indicator
 *
 * Pulses are created by gain envelope ramping (oscillator runs continuously).
 *
 * Handles browser autoplay policy by deferring AudioContext creation
 * until the first user gesture on the document.
 */

import type { Alert, AlertPriority } from '../types.js'
import { PRIORITY_ORDER } from '../styles/priority.js'

type MinAudiblePriority = 'off' | AlertPriority

interface AudioServiceOptions {
  minAudiblePriority?: MinAudiblePriority
}

interface TonePattern {
  frequency: number
  pulseCount: number
  pulseDurationMs: number
  pulseGapMs: number
  interBurstMs: number
  riseMs: number
  fallMs: number
}

const TONE_PATTERNS: Partial<Record<AlertPriority, TonePattern>> = {
  emergency: {
    frequency: 880,
    pulseCount: 5,
    pulseDurationMs: 100,
    pulseGapMs: 100,
    interBurstMs: 500,
    riseMs: 20,
    fallMs: 20
  },
  alarm: {
    frequency: 660,
    pulseCount: 3,
    pulseDurationMs: 150,
    pulseGapMs: 150,
    interBurstMs: 1200,
    riseMs: 20,
    fallMs: 20
  },
  warning: {
    frequency: 440,
    pulseCount: 2,
    pulseDurationMs: 200,
    pulseGapMs: 200,
    interBurstMs: 2500,
    riseMs: 20,
    fallMs: 20
  }
}

const DEFAULT_GAIN = 0.15

// Persists across singleton lifecycles so a user gesture is not lost on
// dispose + re-acquire.
let userHasInteracted = false

export class AudioService {
  private minAudiblePriority: MinAudiblePriority
  private audioCtx: AudioContext | null = null
  private currentOscillator: OscillatorNode | null = null
  private currentGain: GainNode | null = null
  private currentPriority: AlertPriority | null = null
  private burstTimer: ReturnType<typeof setTimeout> | null = null
  private lastAlerts: Alert[] = []
  private gestureHandler: (() => void) | null = null

  constructor(options?: AudioServiceOptions) {
    this.minAudiblePriority = options?.minAudiblePriority ?? 'warning'
    this.listenForUserGesture()
  }

  isEnabled(): boolean {
    return this.minAudiblePriority !== 'off'
  }

  setMinAudiblePriority(priority: MinAudiblePriority): void {
    this.minAudiblePriority = priority
    if (priority === 'off') {
      this.stopTone()
    } else {
      this.evaluate(this.lastAlerts)
    }
  }

  /**
   * Evaluate the current alert set and play the appropriate tone.
   * Called whenever alerts change.
   */
  update(alerts: Alert[]): void {
    this.lastAlerts = alerts
    this.evaluate(alerts)
  }

  dispose(): void {
    this.removeGestureListener()
    this.stopTone()
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {
        // Context may already be closed by the browser
      })
    }
  }

  /**
   * Listen for a user gesture to unlock the AudioContext.
   * Browsers block audio playback until the user interacts with the page.
   */
  private listenForUserGesture(): void {
    if (typeof document === 'undefined') return
    if (userHasInteracted) return

    this.gestureHandler = () => {
      userHasInteracted = true
      this.removeGestureListener()
      // Re-evaluate: if alerts were waiting for audio, start playing now
      this.evaluate(this.lastAlerts)
    }

    for (const event of ['click', 'touchstart', 'keydown'] as const) {
      document.addEventListener(event, this.gestureHandler, { once: true, capture: true })
    }
  }

  private removeGestureListener(): void {
    if (!this.gestureHandler || typeof document === 'undefined') return

    for (const event of ['click', 'touchstart', 'keydown'] as const) {
      document.removeEventListener(event, this.gestureHandler, { capture: true })
    }
    this.gestureHandler = null
  }

  private evaluate(alerts: Alert[]): void {
    if (this.minAudiblePriority === 'off') {
      return
    }

    // Find the highest-priority unacknowledged, unsilenced alert
    const audibleAlert = this.findHighestAudibleAlert(alerts)

    if (!audibleAlert) {
      this.stopTone()
      return
    }

    const pattern = TONE_PATTERNS[audibleAlert.priority]
    if (!pattern) {
      // Caution — no audible
      this.stopTone()
      return
    }

    // Can't play until user has interacted with the page
    if (!userHasInteracted) {
      return
    }

    // If already playing the same priority, don't restart
    if (this.currentPriority === audibleAlert.priority && this.currentOscillator) {
      return
    }

    // Stop any existing tone and start the new one
    this.stopTone()
    this.playTone(audibleAlert.priority, pattern)
  }

  private findHighestAudibleAlert(alerts: Alert[]): Alert | null {
    if (this.minAudiblePriority === 'off') return null

    const threshold = PRIORITY_ORDER[this.minAudiblePriority]
    let best: Alert | null = null
    for (const alert of alerts) {
      const isUnacked = alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
      if (!isUnacked || alert.silenced) {
        continue
      }
      // Only consider alerts at or above the minimum audible priority
      if (PRIORITY_ORDER[alert.priority] > threshold) {
        continue
      }
      if (!best || PRIORITY_ORDER[alert.priority] < PRIORITY_ORDER[best.priority]) {
        best = alert
      }
    }
    return best
  }

  private ensureContext(): AudioContext {
    if (!this.audioCtx || this.audioCtx.state === 'closed') {
      this.audioCtx = new AudioContext()
    }
    return this.audioCtx
  }

  private playTone(priority: AlertPriority, pattern: TonePattern): void {
    const ctx = this.ensureContext()

    // Resume if suspended — the context is created after user gesture,
    // so resume() should succeed immediately.
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // If resume fails, we can't play audio. The next evaluate()
        // will try again.
      })
    }

    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, ctx.currentTime)
    gain.connect(ctx.destination)

    const osc = ctx.createOscillator()
    osc.type = 'square'
    osc.frequency.value = pattern.frequency
    osc.connect(gain)
    osc.start()

    this.currentOscillator = osc
    this.currentGain = gain
    this.currentPriority = priority

    this.scheduleBurst(pattern)
  }

  /** Schedule one burst of pulses, then repeat after the inter-burst gap. */
  private scheduleBurst(pattern: TonePattern): void {
    if (!this.currentGain || !this.audioCtx) return

    const ctx = this.audioCtx
    const gainParam = this.currentGain.gain
    // Clear stale automation events to prevent unbounded memory growth
    gainParam.cancelScheduledValues(ctx.currentTime)
    const riseS = pattern.riseMs / 1000
    const fallS = pattern.fallMs / 1000
    const pulseS = pattern.pulseDurationMs / 1000
    const gapS = pattern.pulseGapMs / 1000

    let t = ctx.currentTime

    for (let i = 0; i < pattern.pulseCount; i++) {
      // Rise
      gainParam.setValueAtTime(0, t)
      gainParam.linearRampToValueAtTime(DEFAULT_GAIN, t + riseS)
      // Hold at peak until fall starts
      t += pulseS - fallS
      // Fall
      gainParam.setValueAtTime(DEFAULT_GAIN, t)
      gainParam.linearRampToValueAtTime(0, t + fallS)
      t += fallS
      // Gap between pulses (except after last pulse)
      if (i < pattern.pulseCount - 1) {
        t += gapS
      }
    }

    // Total burst duration from start to end of last pulse
    const burstDurationMs =
      pattern.pulseCount * pattern.pulseDurationMs + (pattern.pulseCount - 1) * pattern.pulseGapMs

    // Schedule next burst after inter-burst interval
    this.burstTimer = setTimeout(() => {
      this.scheduleBurst(pattern)
    }, burstDurationMs + pattern.interBurstMs)
  }

  private stopTone(): void {
    if (this.burstTimer !== null) {
      clearTimeout(this.burstTimer)
      this.burstTimer = null
    }

    if (this.currentOscillator) {
      try {
        this.currentOscillator.stop()
      } catch {
        // Already stopped
      }
      this.currentOscillator.disconnect()
      this.currentOscillator = null
    }

    if (this.currentGain) {
      this.currentGain.disconnect()
      this.currentGain = null
    }

    this.currentPriority = null
  }
}

// ---------------------------------------------------------------------------
// Shared singleton with reference counting
// ---------------------------------------------------------------------------

let sharedInstance: AudioService | null = null
let refCount = 0

/** Acquire the shared AudioService singleton. */
export function acquireAudioService(): AudioService {
  if (!sharedInstance) {
    sharedInstance = new AudioService()
  }
  refCount++
  return sharedInstance
}

/** Release the shared AudioService singleton. */
export function releaseAudioService(): void {
  if (refCount <= 0) return
  if (--refCount <= 0) {
    sharedInstance?.dispose()
    sharedInstance = null
    refCount = 0
  }
}

/** @internal Reset shared state. For testing only. */
export function _resetAudioServiceSingleton(): void {
  sharedInstance?.dispose()
  sharedInstance = null
  refCount = 0
  userHasInteracted = false
}
