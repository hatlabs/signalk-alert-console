import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { SimulationService, pickWeighted } from '../../src/services/simulation-service.js'
import type { Alert } from '../../src/types.js'

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: crypto.randomUUID(),
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

describe('SimulationService', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('starts and stops correctly', () => {
    const sim = new SimulationService(() => [])
    expect(sim.running).toBe(false)

    sim.start()
    expect(sim.running).toBe(true)

    sim.stop()
    expect(sim.running).toBe(false)
  })

  it('does not create duplicate intervals on repeated start', () => {
    const sim = new SimulationService(() => [])
    sim.start()
    sim.start()
    expect(sim.running).toBe(true)

    // Verify only one interval fires per tick
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.advanceTimersByTime(2000)
    // With no alerts, it always raises — so exactly one fetch call
    expect(fetchMock).toHaveBeenCalledTimes(1)

    sim.stop()
  })

  it('always raises an alert when no alerts exist', () => {
    const sim = new SimulationService(() => [])
    sim.start()

    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    vi.advanceTimersByTime(2000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toBe('/plugins/signalk-alert-manager/alerts')
    expect(opts.method).toBe('POST')

    const body = JSON.parse(opts.body)
    expect(typeof body.priority).toBe('string')
    expect(['emergency', 'alarm', 'warning', 'caution']).toContain(body.priority)
    expect(body.message).toMatch(/^SIM: /)
    expect(body.$source).toMatch(/^simulation-\d+$/)

    sim.stop()
  })

  it('raises with probability when alerts exist', () => {
    const alerts = [makeAlert()]
    const sim = new SimulationService(() => alerts)
    sim.start()

    // 0.05 < 0.114 → raise triggered. Then raiseRandomAlert calls random
    // for scenario index, pickWeighted, and latching check.
    // Finally the clear loop calls random: 0.005 < 0.017 → clear unacked.
    let callIdx = 0
    const values = [
      0.05, // raise check → yes
      0.5, // scenario index
      0.5, // pickWeighted
      0.5, // latching check
      0.005 // clear check for the one unacked alert → yes (< 0.017)
    ]
    vi.spyOn(Math, 'random').mockImplementation(() => values[callIdx++] ?? 0.5)
    vi.advanceTimersByTime(2000)

    // One raise + one clear = 2 fetch calls
    expect(fetchMock).toHaveBeenCalledTimes(2)
    sim.stop()
  })

  it('does not raise when random exceeds threshold and alerts exist', () => {
    const alerts = [makeAlert({ state: 'acknowledged' })]
    const sim = new SimulationService(() => alerts)
    sim.start()

    // 0.5 > 0.114 → no raise, 0.5 > 0.133 → no clear acked
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    vi.advanceTimersByTime(2000)

    expect(fetchMock).not.toHaveBeenCalled()
    sim.stop()
  })

  it('clears acknowledged alerts at higher probability than unacknowledged', () => {
    const acked = makeAlert({ id: 'acked-1', state: 'acknowledged' })
    const unacked = makeAlert({ id: 'unacked-1', state: 'unacknowledged' })
    const sim = new SimulationService(() => [acked, unacked])
    sim.start()

    // 0.05 is between the two clear thresholds (0.017 < 0.05 < 0.133),
    // so only the acked alert gets cleared.
    let callCount = 0
    vi.spyOn(Math, 'random').mockImplementation(() => {
      callCount++
      if (callCount === 1) return 0.5 // raise check → no (> 0.114)
      if (callCount === 2) return 0.05 // acked clear → yes (< 0.133)
      if (callCount === 3) return 0.05 // unacked clear → no (> 0.017)
      return 0.5
    })

    vi.advanceTimersByTime(2000)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0]
    expect(url).toContain('acked-1')

    sim.stop()
  })

  it('uses unique $source for each raised alert', () => {
    const sim = new SimulationService(() => [])
    sim.start()

    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    vi.advanceTimersByTime(2000)
    vi.advanceTimersByTime(2000)

    expect(fetchMock).toHaveBeenCalledTimes(2)

    const body1 = JSON.parse(fetchMock.mock.calls[0][1].body)
    const body2 = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(body1.$source).not.toBe(body2.$source)
    expect(body1.$source).toMatch(/^simulation-\d+$/)

    sim.stop()
  })
})

describe('pickWeighted', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('picks first item when random is below first weight', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const items = [
      { value: 'a', weight: 0.05 },
      { value: 'b', weight: 0.95 }
    ]
    const result = pickWeighted(items)
    expect(result.value).toBe('a')
  })

  it('picks second item when random exceeds first weight', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.06)
    const items = [
      { value: 'a', weight: 0.05 },
      { value: 'b', weight: 0.95 }
    ]
    const result = pickWeighted(items)
    expect(result.value).toBe('b')
  })

  it('returns last item as fallback for edge case', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.9999999)
    const items = [
      { value: 'a', weight: 0.5 },
      { value: 'b', weight: 0.5 }
    ]
    const result = pickWeighted(items)
    expect(result.value).toBe('b')
  })

  it('handles boundary between weights correctly', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.049)
    const items = [
      { value: 'emergency', weight: 0.05 },
      { value: 'alarm', weight: 0.15 },
      { value: 'warning', weight: 0.4 },
      { value: 'caution', weight: 0.4 }
    ]
    const result = pickWeighted(items)
    expect(result.value).toBe('emergency')
  })
})
