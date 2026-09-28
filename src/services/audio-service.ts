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
 * Browsers block audio until the page has had a user gesture. The context is
 * created at load and resumed if it starts suspended; a page the browser lets
 * play (prior engagement, a kiosk autoplay flag) sounds at once. Otherwise a
 * document gesture listener resumes it. isSoundBlocked() lets the UI say
 * when an alert should sound but cannot, and 'change' fires whenever that may
 * have changed.
 */

import type { Alert, AlertPriority } from '../types.js'
import { DEFAULT_MIN_AUDIBLE_PRIORITY, PRIORITY_ORDER } from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'

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

const GESTURE_EVENTS = ['click', 'touchstart', 'keydown'] as const

export class AudioService extends EventTarget {
  private minAudiblePriority: MinAudiblePriority
  private audioCtx: AudioContext | null = null
  private currentOscillator: OscillatorNode | null = null
  private currentGain: GainNode | null = null
  private currentPriority: AlertPriority | null = null
  private burstTimer: ReturnType<typeof setTimeout> | null = null
  private lastAlerts: Alert[] = []
  private gestureHandler: (() => void) | null = null
  private disposed = false

  constructor(options?: AudioServiceOptions) {
    super()
    this.minAudiblePriority = options?.minAudiblePriority ?? DEFAULT_MIN_AUDIBLE_PRIORITY
    this.unlockAtLoad()
  }

  /** Whether the browser lets this page play sound now. */
  isUnlocked(): boolean {
    return this.audioCtx?.state === 'running'
  }

  /** Whether a tone should be sounding now but the browser has not let the page play. */
  isSoundBlocked(): boolean {
    return !this.isUnlocked() && this.toneToSound() !== null
  }

  isEnabled(): boolean {
    return this.minAudiblePriority !== 'off'
  }

  setMinAudiblePriority(priority: MinAudiblePriority): void {
    this.minAudiblePriority = priority
    this.evaluate()
    this.notify()
  }

  /**
   * Evaluate the current alert set and play the appropriate tone.
   * Called whenever alerts change.
   */
  update(alerts: Alert[]): void {
    this.lastAlerts = alerts
    this.evaluate()
    this.notify()
  }

  dispose(): void {
    this.disposed = true
    this.removeGestureListener()
    this.audioCtx?.removeEventListener('statechange', this.onStateChange)
    this.stopTone()
    if (this.audioCtx && this.audioCtx.state !== 'closed') {
      this.audioCtx.close().catch(() => {
        // Context may already be closed by the browser
      })
    }
  }

  private notify(): void {
    this.dispatchEvent(new Event('change'))
  }

  private unlockAtLoad(): void {
    // No Web Audio at all: stay locked and silent rather than fail the page.
    if (typeof AudioContext === 'undefined') return
    const ctx = new AudioContext()
    this.audioCtx = ctx
    ctx.addEventListener('statechange', this.onStateChange)
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {
        // Still blocked; the gesture listener resumes it later.
      })
    }
    this.onStateChange()
  }

  /** The context can also be suspended later by the browser, so this runs on every change. */
  private onStateChange = (): void => {
    if (this.disposed) return
    if (this.isUnlocked()) {
      this.removeGestureListener()
      this.evaluate()
    } else {
      this.listenForUserGesture()
    }
    this.notify()
  }

  /** Browsers let a suspended context start only from within a user gesture. */
  private listenForUserGesture(): void {
    if (this.gestureHandler || typeof document === 'undefined') return

    this.gestureHandler = () => {
      this.audioCtx?.resume().catch(() => {
        // Refused; the listener stays for the next gesture.
      })
    }

    for (const event of GESTURE_EVENTS) {
      document.addEventListener(event, this.gestureHandler, { capture: true })
    }
  }

  private removeGestureListener(): void {
    if (!this.gestureHandler || typeof document === 'undefined') return

    for (const event of GESTURE_EVENTS) {
      document.removeEventListener(event, this.gestureHandler, { capture: true })
    }
    this.gestureHandler = null
  }

  private evaluate(): void {
    const tone = this.toneToSound()
    if (!tone) {
      this.stopTone()
      return
    }

    // The browser has not let the page play yet
    if (!this.isUnlocked()) {
      return
    }

    // If already playing the same priority, don't restart
    if (this.currentPriority === tone.priority && this.currentOscillator) {
      return
    }

    this.stopTone()
    this.playTone(tone.priority, tone.pattern)
  }

  /** The tone this display should sound now: the highest audible alert's, if it has one. */
  private toneToSound(): { priority: AlertPriority; pattern: TonePattern } | null {
    const alert = this.findHighestAudibleAlert(this.lastAlerts)
    if (!alert) return null
    // Caution has no tone
    const pattern = TONE_PATTERNS[alert.priority]
    return pattern ? { priority: alert.priority, pattern } : null
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

  /** Called only while the context runs, so it exists. */
  private playTone(priority: AlertPriority, pattern: TonePattern): void {
    const ctx = this.audioCtx
    if (!ctx) return

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
  sharedInstance ??= new AudioService()
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
}
