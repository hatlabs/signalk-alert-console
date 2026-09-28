/**
 * AlertService Tests
 *
 * Tests for the UI data layer that fetches alerts from the REST API
 * and subscribes to real-time updates via Signal K WebSocket.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AlertService } from '../../src/services/alert-service.js'
import type { Alert, AlertState } from '../../src/types.js'

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

/** Captured WebSocket instances for test control. */
let wsInstances: MockWebSocket[] = []

class MockWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly CONNECTING = 0
  readonly OPEN = 1
  readonly CLOSING = 2
  readonly CLOSED = 3

  readyState = MockWebSocket.CONNECTING
  onopen: ((ev: Event) => void) | null = null
  onmessage: ((ev: MessageEvent) => void) | null = null
  onclose: ((ev: CloseEvent) => void) | null = null
  onerror: ((ev: Event) => void) | null = null
  sent: string[] = []
  url: string

  constructor(url: string) {
    this.url = url
    wsInstances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }

  // Test helpers
  simulateOpen(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.(new Event('open'))
  }

  simulateMessage(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(data) }))
  }

  simulateClose(): void {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.(new CloseEvent('close'))
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlertService', () => {
  let service: AlertService
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    wsInstances = []
    vi.stubGlobal('WebSocket', MockWebSocket)

    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // Default: return empty alerts array
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })

    service = new AlertService()
  })

  afterEach(() => {
    service.disconnect()
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // Initial fetch
  // -------------------------------------------------------------------------

  describe('connect()', () => {
    it('fetches alerts from REST API on connect', async () => {
      const alerts = [makeAlert({ message: 'Engine hot' }), makeAlert({ message: 'Low fuel' })]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      await service.connect()

      expect(fetchMock).toHaveBeenCalledWith('/plugins/signalk-alert-manager/alerts')
      expect(service.getAlerts()).toHaveLength(2)
    })

    it('dispatches change event after initial fetch', async () => {
      const alerts = [makeAlert()]
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })

      const onChange = vi.fn()
      service.addEventListener('change', onChange)

      await service.connect()

      expect(onChange).toHaveBeenCalled()
    })

    it('opens WebSocket connection after initial fetch', async () => {
      await service.connect()

      expect(wsInstances).toHaveLength(1)
      expect(wsInstances[0].url).toContain('/signalk/v1/stream')
    })

    it('subscribes to alerts.* on WebSocket open', async () => {
      await service.connect()

      const ws = wsInstances[0]
      ws.simulateOpen()
      // Subscription is sent after the re-sync fetch settles
      await new Promise((r) => setTimeout(r, 0))

      expect(ws.sent).toHaveLength(1)
      const subscription = JSON.parse(ws.sent[0]) as {
        context: string
        subscribe: { path: string }[]
      }
      expect(subscription.context).toBe('vessels.self')
      expect(subscription.subscribe).toContainEqual(expect.objectContaining({ path: 'alerts.*' }))
    })

    it('handles fetch failure gracefully', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'))

      await expect(service.connect()).rejects.toThrow('Network error')
      expect(service.getAlerts()).toHaveLength(0)
    })

    it('handles non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable'
      })

      await expect(service.connect()).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // WebSocket real-time updates
  // -------------------------------------------------------------------------

  describe('WebSocket updates', () => {
    let existingAlert: Alert

    beforeEach(async () => {
      existingAlert = makeAlert({ id: 'alert-1', message: 'Existing', priority: 'warning' })
      const alertResponse = {
        ok: true,
        json: () => Promise.resolve([existingAlert])
      }
      // First call: initial connect; second call: re-sync on WebSocket open
      fetchMock.mockResolvedValueOnce(alertResponse).mockResolvedValueOnce(alertResponse)

      await service.connect()
      wsInstances[0].simulateOpen()
      // Let the re-fetch promise in onopen settle
      await new Promise((r) => setTimeout(r, 0))
    })

    it('adds new alert from delta', () => {
      const newAlert = makeAlert({
        id: 'alert-2',
        path: 'engine.overheating',
        message: 'New alert'
      })

      const onChange = vi.fn()
      service.addEventListener('change', onChange)

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.engine.overheating', value: newAlert }]
          }
        ]
      })

      expect(service.getAlerts()).toHaveLength(2)
      expect(onChange).toHaveBeenCalled()
    })

    it('updates existing alert from delta', () => {
      const updated = { ...existingAlert, state: 'acknowledged' as AlertState }

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.electrical.battery.low', value: updated }]
          }
        ]
      })

      const alerts = service.getAlerts()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].state).toBe('acknowledged')
    })

    it('removes alert when delta has state normal (cleared)', () => {
      const cleared = {
        ...existingAlert,
        state: 'normal' as AlertState,
        condition: false
      }

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'alert-manager' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.electrical.battery.low', value: cleared }]
          }
        ]
      })

      expect(service.getAlerts()).toHaveLength(0)
    })

    it('ignores deltas for non-alert paths', () => {
      const onChange = vi.fn()
      service.addEventListener('change', onChange)

      wsInstances[0].simulateMessage({
        context: 'vessels.self',
        updates: [
          {
            source: { label: 'something' },
            timestamp: new Date().toISOString(),
            values: [{ path: 'navigation.position', value: { latitude: 60, longitude: 25 } }]
          }
        ]
      })

      expect(service.getAlerts()).toHaveLength(1)
      expect(onChange).not.toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // Filtering
  // -------------------------------------------------------------------------

  describe('getAlerts() filtering', () => {
    const alerts = [
      makeAlert({
        id: '1',
        priority: 'emergency',
        state: 'unacknowledged',
        group: 'engine'
      }),
      makeAlert({ id: '2', priority: 'alarm', state: 'acknowledged', group: 'engine' }),
      makeAlert({
        id: '3',
        priority: 'warning',
        state: 'unacknowledged',
        group: 'navigation'
      }),
      makeAlert({ id: '4', priority: 'caution', state: 'acknowledged', group: 'navigation' })
    ]

    beforeEach(async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(alerts)
      })
      await service.connect()
    })

    it('returns all alerts when no filter', () => {
      expect(service.getAlerts()).toHaveLength(4)
    })

    it('filters by single state', () => {
      const result = service.getAlerts({ state: 'unacknowledged' })
      expect(result).toHaveLength(2)
      expect(result.every((a) => a.state === 'unacknowledged')).toBe(true)
    })

    it('filters by multiple states', () => {
      const result = service.getAlerts({ state: ['unacknowledged', 'acknowledged'] })
      expect(result).toHaveLength(4)
    })

    it('filters by single priority', () => {
      const result = service.getAlerts({ priority: 'emergency' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('1')
    })

    it('filters by multiple priorities', () => {
      const result = service.getAlerts({ priority: ['emergency', 'alarm'] })
      expect(result).toHaveLength(2)
    })

    it('filters by group (exact match)', () => {
      const result = service.getAlerts({ group: 'engine' })
      expect(result).toHaveLength(2)
      expect(result.every((a) => a.group === 'engine')).toBe(true)
    })

    it('filters by group substring (case-insensitive)', () => {
      const result = service.getAlerts({ group: 'eng' })
      expect(result).toHaveLength(2)
      expect(result.every((a) => a.group === 'engine')).toBe(true)
    })

    it('filters by group case-insensitively', () => {
      const result = service.getAlerts({ group: 'ENGINE' })
      expect(result).toHaveLength(2)
    })

    it('combines filters (AND logic)', () => {
      const result = service.getAlerts({ state: 'unacknowledged', group: 'engine' })
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('1')
    })
  })

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------

  describe('getAlerts() sorting', () => {
    const now = Date.now()

    // Default: state → priority → most recent state change first (IEC 62923-1 6.4.2.2)
    describe('standard sort (default)', () => {
      const alerts = [
        makeAlert({
          id: 'acked-warn',
          priority: 'warning',
          state: 'acknowledged',
          raisedAt: new Date(now - 1000).toISOString()
        }),
        makeAlert({
          id: 'unacked-caution',
          priority: 'caution',
          state: 'unacknowledged',
          raisedAt: new Date(now - 2000).toISOString()
        }),
        makeAlert({
          id: 'unacked-emergency',
          priority: 'emergency',
          state: 'unacknowledged',
          raisedAt: new Date(now - 3000).toISOString()
        }),
        makeAlert({
          id: 'rtn-unacked',
          priority: 'alarm',
          state: 'rtn-unacknowledged',
          raisedAt: new Date(now - 4000).toISOString()
        }),
        makeAlert({
          id: 'acked-emergency',
          priority: 'emergency',
          state: 'acknowledged',
          raisedAt: new Date(now - 5000).toISOString()
        })
      ]

      beforeEach(async () => {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(alerts)
        })
        await service.connect()
      })

      it('places unacknowledged alerts before acknowledged', () => {
        const result = service.getAlerts()
        const ackedIdx = result.findIndex((a) => a.state === 'acknowledged')
        const lastUnackedIdx = result.findLastIndex(
          (a) => a.state === 'unacknowledged' || a.state === 'rtn-unacknowledged'
        )
        expect(lastUnackedIdx).toBeLessThan(ackedIdx)
      })

      it('treats rtn-unacknowledged the same as unacknowledged', () => {
        const result = service.getAlerts()
        const rtnIdx = result.findIndex((a) => a.id === 'rtn-unacked')
        const firstAckedIdx = result.findIndex((a) => a.state === 'acknowledged')
        expect(rtnIdx).toBeLessThan(firstAckedIdx)
      })

      it('sorts by priority within each state group', () => {
        const result = service.getAlerts()
        // Unacked group: emergency, alarm (rtn), caution
        const unackedGroup = result.filter(
          (a) => a.state === 'unacknowledged' || a.state === 'rtn-unacknowledged'
        )
        expect(unackedGroup.map((a) => a.priority)).toEqual(['emergency', 'alarm', 'caution'])
      })

      it('orders by most recent state change first within a state+priority group', () => {
        // IEC 62923-1 6.4.2.2: ties broken by time of last state change, newest on top
        const twoAlarms = [
          makeAlert({
            id: 'older-change',
            priority: 'alarm',
            state: 'unacknowledged',
            stateChangedAt: new Date(now - 5000).toISOString()
          }),
          makeAlert({
            id: 'newer-change',
            priority: 'alarm',
            state: 'unacknowledged',
            stateChangedAt: new Date(now - 1000).toISOString()
          })
        ]
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(twoAlarms)
        })

        const service2 = new AlertService()
        return service2.connect().then(() => {
          const result = service2.getAlerts()
          expect(result.map((a) => a.id)).toEqual(['newer-change', 'older-change'])
          service2.disconnect()
        })
      })

      it('places a freshly-escalated alarm above an older alarm of the same priority', () => {
        // Escalation bumps stateChangedAt (IEC 62923-1 6.4.2.2), so a
        // warning that just escalated to alarm rises above an older alarm.
        const twoAlarms = [
          makeAlert({
            id: 'long-standing-alarm',
            priority: 'alarm',
            state: 'unacknowledged',
            raisedAt: new Date(now - 60000).toISOString(),
            stateChangedAt: new Date(now - 60000).toISOString()
          }),
          makeAlert({
            id: 'just-escalated',
            priority: 'alarm',
            state: 'unacknowledged',
            raisedAt: new Date(now - 30000).toISOString(),
            stateChangedAt: new Date(now - 1000).toISOString()
          })
        ]
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(twoAlarms)
        })

        const service2 = new AlertService()
        return service2.connect().then(() => {
          const result = service2.getAlerts()
          expect(result.map((a) => a.id)).toEqual(['just-escalated', 'long-standing-alarm'])
          service2.disconnect()
        })
      })

      it('does not reorder the list when an alert is silenced', () => {
        // Silence is not a state change, so stateChangedAt — and thus list
        // position — is unaffected (IEC 62923-1 6.4.2.2).
        const twoAlarms = [
          makeAlert({
            id: 'recent-change',
            priority: 'alarm',
            state: 'unacknowledged',
            stateChangedAt: new Date(now - 1000).toISOString()
          }),
          makeAlert({
            id: 'older-but-silenced',
            priority: 'alarm',
            state: 'unacknowledged',
            stateChangedAt: new Date(now - 5000).toISOString(),
            silenced: true
          })
        ]
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(twoAlarms)
        })

        const service2 = new AlertService()
        return service2.connect().then(() => {
          const result = service2.getAlerts()
          expect(result.map((a) => a.id)).toEqual(['recent-change', 'older-but-silenced'])
          service2.disconnect()
        })
      })

      it('falls back to raisedAt when stateChangedAt is missing (no NaN)', () => {
        // An alert lacking stateChangedAt must not poison the sort with NaN;
        // it falls back to raisedAt, mirroring the store's
        // state_changed_at ?? raised_at.
        const withoutStateChange = makeAlert({
          id: 'no-state-change',
          priority: 'alarm',
          state: 'unacknowledged',
          raisedAt: new Date(now - 1000).toISOString()
        })
        delete (withoutStateChange as Partial<Alert>).stateChangedAt

        const olderAlarm = makeAlert({
          id: 'older-alarm',
          priority: 'alarm',
          state: 'unacknowledged',
          raisedAt: new Date(now - 5000).toISOString(),
          stateChangedAt: new Date(now - 5000).toISOString()
        })

        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve([olderAlarm, withoutStateChange])
        })

        const service2 = new AlertService()
        return service2.connect().then(() => {
          const result = service2.getAlerts()
          expect(result.map((a) => a.id)).toEqual(['no-state-change', 'older-alarm'])
          service2.disconnect()
        })
      })

      it('produces full IMO-compliant ordering', () => {
        const result = service.getAlerts()
        expect(result.map((a) => a.id)).toEqual([
          'unacked-emergency', // unacked, highest priority
          'rtn-unacked', // unacked (rtn), alarm
          'unacked-caution', // unacked, lowest priority
          'acked-emergency', // acked, highest priority
          'acked-warn' // acked, lower priority
        ])
      })
    })

    describe('newest sort', () => {
      const alerts = [
        makeAlert({ id: 'old', raisedAt: new Date(now - 3000).toISOString() }),
        makeAlert({ id: 'new', raisedAt: new Date(now - 1000).toISOString() }),
        makeAlert({ id: 'mid', raisedAt: new Date(now - 2000).toISOString() })
      ]

      beforeEach(async () => {
        fetchMock.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(alerts)
        })
        await service.connect()
      })

      it('sorts newest first regardless of state or priority', () => {
        const result = service.getAlerts(undefined, 'newest')
        expect(result.map((a) => a.id)).toEqual(['new', 'mid', 'old'])
      })
    })
  })

  // -------------------------------------------------------------------------
  // Disconnect
  // -------------------------------------------------------------------------

  describe('disconnect()', () => {
    it('closes WebSocket connection', async () => {
      await service.connect()
      const ws = wsInstances[0]
      ws.simulateOpen()

      service.disconnect()

      expect(ws.readyState).toBe(MockWebSocket.CLOSED)
    })

    it('clears alerts', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([makeAlert()])
      })
      await service.connect()

      expect(service.getAlerts()).toHaveLength(1)

      service.disconnect()

      expect(service.getAlerts()).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // Mutation methods
  // -------------------------------------------------------------------------

  describe('acknowledgeAlert()', () => {
    it('sends POST to correct endpoint', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      await service.acknowledgeAlert('alert-42')

      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/alert-42/acknowledge',
        { method: 'POST' }
      )
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })

      await expect(service.acknowledgeAlert('bad-id')).rejects.toThrow()
    })
  })

  describe('silenceAlert()', () => {
    it('sends POST with default duration (no body)', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      await service.silenceAlert('alert-42')

      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/alert-42/silence',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }
      )
    })

    it('sends POST with custom duration in body', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      await service.silenceAlert('alert-42', 120)

      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/alert-42/silence',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: 120 })
        }
      )
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })

      await expect(service.silenceAlert('alert-42')).rejects.toThrow()
    })
  })

  describe('dismissAlert()', () => {
    it('sends PUT to the condition endpoint with active false', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      await service.dismissAlert('alert-42')

      expect(fetchMock).toHaveBeenCalledWith(
        '/plugins/signalk-alert-manager/alerts/alert-42/condition',
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ active: false })
        }
      )
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' })

      await expect(service.dismissAlert('bad-id')).rejects.toThrow()
    })
  })

  describe('silenceAll()', () => {
    it('sends POST to silence-all endpoint', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      await service.silenceAll()

      expect(fetchMock).toHaveBeenCalledWith('/plugins/signalk-alert-manager/alerts/silence-all', {
        method: 'POST'
      })
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' })

      await expect(service.silenceAll()).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Reconnection
  // -------------------------------------------------------------------------

  describe('WebSocket reconnection', () => {
    it('attempts reconnect after unexpected close', async () => {
      vi.useFakeTimers()

      await service.connect()
      const ws1 = wsInstances[0]
      ws1.simulateOpen()

      // Simulate unexpected close
      ws1.simulateClose()

      // Advance past reconnect delay
      vi.advanceTimersByTime(1500)

      expect(wsInstances).toHaveLength(2)

      vi.useRealTimers()
    })

    it('does not reconnect after explicit disconnect', async () => {
      vi.useFakeTimers()

      await service.connect()
      wsInstances[0].simulateOpen()

      service.disconnect()

      vi.advanceTimersByTime(5000)

      // Only the original WebSocket, no reconnect attempts
      expect(wsInstances).toHaveLength(1)

      vi.useRealTimers()
    })
  })
})
