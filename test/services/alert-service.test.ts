/**
 * AlertService Tests
 *
 * Tests for the UI data layer that fetches alerts from the REST API
 * and subscribes to real-time updates via Signal K WebSocket.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { AlertService } from '../../src/services/alert-service.js'
import type { Alert, AlertState } from '../../src/types.js'
import {
  ANY_SIGNAL,
  hangingReply,
  jsonResponse,
  statusReply,
  stubServer,
  textResponse
} from '../helpers/mock-server.js'
import type { MockServer } from '../helpers/mock-server.js'

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
    // A real socket throws when it is not open.
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new DOMException('Still in CONNECTING state', 'InvalidStateError')
    }
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
  let server: MockServer

  beforeEach(() => {
    wsInstances = []
    vi.stubGlobal('WebSocket', MockWebSocket)

    fetchMock = vi.fn()
    server = stubServer(fetchMock)

    // Default: return empty alerts array
    fetchMock.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([])
    })

    service = new AlertService()
  })

  afterEach(() => {
    service.disconnect()
    vi.useRealTimers()
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

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts', {
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
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

    it('reports a rejected list fetch as unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'))

      await service.connect()

      expect(service.availability).toBe('unreachable')
      expect(service.getAlerts()).toHaveLength(0)
      expect(wsInstances).toHaveLength(0)
    })

    it('reports a failed list fetch as unreachable', async () => {
      fetchMock.mockResolvedValueOnce(textResponse(503, 'down', 'Service Unavailable'))

      await service.connect()

      expect(service.availability).toBe('unreachable')
      expect(wsInstances).toHaveLength(0)
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
            $source: 'alertsApi',
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
            $source: 'alertsApi',
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.test.alert', value: updated }]
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
            $source: 'alertsApi',
            timestamp: new Date().toISOString(),
            values: [{ path: 'alerts.test.alert', value: cleared }]
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

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/alert-42/acknowledge', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
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

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/alert-42/silence', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: '{}'
      })
    })

    it('sends POST with custom duration in body', async () => {
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) })

      await service.silenceAlert('alert-42', 120)

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/alert-42/silence', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration: 120 })
      })
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

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/alert-42/condition', {
        method: 'PUT',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false })
      })
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

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/silence-all', {
        method: 'POST',
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Unavailable' })

      await expect(service.silenceAll()).rejects.toThrow()
    })
  })

  describe('refused and failed requests', () => {
    it('reports a JSON 401 by its status, not its body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'Permission Denied' }))

      await expect(service.acknowledgeAlert('a')).rejects.toMatchObject({
        name: 'ApiError',
        status: 401,
        message: 'Unauthorized'
      })
    })

    it('parses a plain-text 401 body without a JSON error', async () => {
      fetchMock.mockResolvedValueOnce(textResponse(401, 'bad auth token'))

      await expect(service.silenceAll()).rejects.toMatchObject({
        status: 401,
        message: 'Unauthorized'
      })
    })

    it("shows core's message from a FAILED body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(409, { state: 'FAILED', statusCode: 409, message: 'Alert is not active' })
      )

      await expect(service.silenceAlert('a')).rejects.toMatchObject({
        status: 409,
        message: 'Alert is not active'
      })
    })

    it('falls back to a JSON error field', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(403, { error: 'Forbidden here' }))

      await expect(service.dismissAlert('a')).rejects.toMatchObject({
        status: 403,
        message: 'Forbidden here'
      })
    })

    it('falls back to the status text for a non-JSON body', async () => {
      fetchMock.mockResolvedValueOnce(textResponse(502, '<html>bad gateway</html>', 'Bad Gateway'))

      await expect(service.acknowledgeAlert('a')).rejects.toMatchObject({
        status: 502,
        message: 'Bad Gateway'
      })
    })

    it('works on a browser without AbortSignal.timeout', async () => {
      const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
      Object.defineProperty(AbortSignal, 'timeout', { value: undefined, configurable: true })
      try {
        await service.connect()
      } finally {
        if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout)
      }

      expect(service.availability).toBe('live')
    })

    it('reports a rejected fetch as unreachable', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))

      await expect(service.acknowledgeAlert('a')).rejects.toMatchObject({
        status: 0,
        message: 'Cannot reach the Signal K server'
      })
    })

    it('asks for JSON when fetching history', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { entries: [], total: 0 }))

      await AlertService.fetchHistory({})

      expect(fetchMock).toHaveBeenCalledWith('/signalk/v2/api/alerts/history', {
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
    })
  })

  describe('fetchHistory()', () => {
    function requestedUrl(): URL {
      const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string]
      return new URL(url, 'http://my-server.local')
    }

    it('sends each event type as its own eventType parameter with paging', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ entries: [], total: 0 })
      })

      await AlertService.fetchHistory({
        eventType: ['raise', 'clear', 'acknowledge'],
        limit: 50,
        offset: 100
      })

      const url = requestedUrl()
      expect(url.pathname).toBe('/signalk/v2/api/alerts/history')
      expect(url.searchParams.getAll('eventType')).toEqual(['raise', 'clear', 'acknowledge'])
      expect(url.searchParams.get('limit')).toBe('50')
      expect(url.searchParams.get('offset')).toBe('100')
    })

    it('filters by alertId', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ entries: [], total: 0 })
      })

      await AlertService.fetchHistory({ alertId: 'alert-42' })

      const url = requestedUrl()
      expect(url.pathname).toBe('/signalk/v2/api/alerts/history')
      expect(url.searchParams.get('alertId')).toBe('alert-42')
      expect(url.searchParams.has('eventType')).toBe(false)
    })

    it('returns entries and total', async () => {
      const page = { entries: [], total: 7 }
      fetchMock.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(page) })

      await expect(AlertService.fetchHistory({})).resolves.toEqual(page)
    })

    it('throws on non-ok response', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request' })

      await expect(AlertService.fetchHistory({})).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // Availability
  // -------------------------------------------------------------------------

  describe('availability', () => {
    function listReply(alerts: Alert[] = []) {
      return () => Promise.resolve(jsonResponse(200, alerts))
    }

    it('is probing until the probe and the first list fetch answer', async () => {
      const connecting = service.connect()

      expect(service.availability).toBe('probing')
      await connecting
      expect(service.availability).toBe('live')
    })

    it('probes the status endpoint, asking for JSON', async () => {
      await service.connect()

      expect(server.status).toHaveBeenCalledWith('/signalk/v2/api/alerts/status', {
        signal: ANY_SIGNAL,
        headers: { Accept: 'application/json' }
      })
    })

    it('goes live on a 2xx: list fetched, socket opened', async () => {
      fetchMock.mockImplementation(listReply([makeAlert()]))

      await service.connect()

      expect(service.availability).toBe('live')
      expect(service.getAlerts()).toHaveLength(1)
      expect(wsInstances).toHaveLength(1)
    })

    it('shows no API on a 404: no list fetch, no socket', async () => {
      server.status.mockImplementation(statusReply(404))

      await service.connect()

      expect(service.availability).toBe('no-api')
      expect(fetchMock).not.toHaveBeenCalled()
      expect(wsInstances).toHaveLength(0)
    })

    it('asks to sign in on a plain-text 401, targeting the admin login', async () => {
      server.status.mockResolvedValue(textResponse(401, 'bad auth token'))

      await service.connect()

      expect(service.availability).toBe('sign-in')
      expect(service.signInUrl).toBe('/admin/#/login')
      expect(wsInstances).toHaveLength(0)
    })

    describe('with OIDC enabled', () => {
      const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM

      beforeEach(() => {
        happyDOM.setURL('http://my-server.local/signalk-alert-console/?tab=history#top')
        server.status.mockImplementation(statusReply(401))
      })

      afterEach(() => {
        happyDOM.setURL('http://localhost:3000/')
      })

      function oidcLogin(oidcLoginUrl: string): void {
        server.loginStatus.mockResolvedValue(jsonResponse(200, { oidcEnabled: true, oidcLoginUrl }))
      }

      it('targets the OIDC login, redirecting back to this page', async () => {
        oidcLogin('/signalk/v1/auth/oidc/login')

        await service.connect()

        const target = new URL(service.signInUrl, location.origin)
        expect(service.signInUrl.startsWith('/signalk/v1/auth/oidc/login?')).toBe(true)
        expect(target.searchParams.get('redirect')).toBe('/signalk-alert-console/?tab=history#top')
      })

      it('keeps the query parameters the login URL already has', async () => {
        oidcLogin('/signalk/v1/auth/oidc/login?provider=main')

        await service.connect()

        const target = new URL(service.signInUrl, location.origin)
        expect(target.searchParams.get('provider')).toBe('main')
        expect(target.searchParams.get('redirect')).toBe('/signalk-alert-console/?tab=history#top')
      })

      it('keeps an absolute login URL absolute', async () => {
        oidcLogin('https://sso.my-server.local/login')

        await service.connect()

        const target = new URL(service.signInUrl)
        expect(target.origin).toBe('https://sso.my-server.local')
        expect(target.searchParams.get('redirect')).toBe('/signalk-alert-console/?tab=history#top')
      })

      it('falls back to the admin login for a data: URL', async () => {
        oidcLogin('data:text/html,<p>hi</p>')

        await service.connect()

        expect(service.signInUrl).toBe('/admin/#/login')
      })
    })

    it('falls back to the admin login when the login status fails', async () => {
      server.status.mockImplementation(statusReply(401))
      server.loginStatus.mockRejectedValue(new TypeError('Failed to fetch'))

      await service.connect()

      expect(service.availability).toBe('sign-in')
      expect(service.signInUrl).toBe('/admin/#/login')
    })

    it('ignores an OIDC login URL that is not http(s)', async () => {
      server.status.mockImplementation(statusReply(401))
      server.loginStatus.mockResolvedValue(
        jsonResponse(200, { oidcEnabled: true, oidcLoginUrl: 'javascript:alert(1)' })
      )

      await service.connect()

      expect(service.signInUrl).toBe('/admin/#/login')
    })

    it('treats a 502 as unreachable, not as a missing API', async () => {
      server.status.mockImplementation(statusReply(502))

      await service.connect()

      expect(service.availability).toBe('unreachable')
    })

    it('retries an unreachable probe on the 1s to 30s backoff until live', async () => {
      vi.useFakeTimers()
      server.status.mockRejectedValue(new TypeError('Failed to fetch'))
      fetchMock.mockImplementation(listReply([makeAlert()]))

      await service.connect()
      expect(service.availability).toBe('unreachable')
      expect(server.status).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(999)
      expect(server.status).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.status).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(2000)
      expect(server.status).toHaveBeenCalledTimes(3)
      expect(service.availability).toBe('unreachable')

      server.status.mockImplementation(statusReply(200))
      await vi.advanceTimersByTimeAsync(4000)

      expect(service.availability).toBe('live')
      expect(service.getAlerts()).toHaveLength(1)
      expect(wsInstances).toHaveLength(1)
    })

    it('gives up on a status probe that never answers and retries', async () => {
      vi.useFakeTimers()
      server.status.mockImplementation(hangingReply)

      void service.connect()
      await vi.advanceTimersByTimeAsync(10000)
      expect(service.availability).toBe('unreachable')

      server.status.mockImplementation(statusReply(200))
      await vi.advanceTimersByTimeAsync(1000)
      expect(server.status).toHaveBeenCalledTimes(2)
      expect(service.availability).toBe('live')
    })

    it('caps the retry delay at 30 seconds', async () => {
      vi.useFakeTimers()
      server.status.mockImplementation(statusReply(503))

      await service.connect()
      // 1 + 2 + 4 + 8 + 16 seconds reach the cap; later retries are 30 s apart.
      await vi.advanceTimersByTimeAsync(31000)
      const before = server.status.mock.calls.length
      await vi.advanceTimersByTimeAsync(29999)
      expect(server.status).toHaveBeenCalledTimes(before)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.status).toHaveBeenCalledTimes(before + 1)
      await vi.advanceTimersByTimeAsync(30000)
      expect(server.status).toHaveBeenCalledTimes(before + 2)
    })

    it('re-probes a missing API on the timer and goes live', async () => {
      vi.useFakeTimers()
      server.status.mockImplementation(statusReply(404))
      await service.connect()

      server.status.mockImplementation(statusReply(200))
      await vi.advanceTimersByTimeAsync(1000)

      expect(service.availability).toBe('live')
      expect(wsInstances).toHaveLength(1)
    })

    it('re-probes at once on retryNow() from sign-in and goes live', async () => {
      vi.useFakeTimers()
      server.status.mockImplementation(statusReply(401))
      await service.connect()
      server.status.mockImplementation(statusReply(200))

      service.retryNow()
      await vi.advanceTimersByTimeAsync(0)

      expect(service.availability).toBe('live')
      // The pending timer was replaced, not left to probe again before the
      // first liveness probe.
      const calls = server.status.mock.calls.length
      await vi.advanceTimersByTimeAsync(29999)
      expect(server.status).toHaveBeenCalledTimes(calls)
    })

    it('ignores retryNow() while live', async () => {
      await service.connect()

      service.retryNow()

      expect(server.status).toHaveBeenCalledTimes(1)
    })

    it('dispatches an availability event on each change', async () => {
      const seen: string[] = []
      service.addEventListener('availability', () => seen.push(service.availability))

      await service.connect()

      expect(seen).toEqual(['live'])
    })

    describe('after live, when the socket closes', () => {
      async function liveThenClosed(alerts: Alert[]): Promise<void> {
        vi.useFakeTimers()
        fetchMock.mockImplementation(listReply(alerts))
        await service.connect()
        wsInstances[0].simulateOpen()
        await vi.advanceTimersByTimeAsync(0)
        wsInstances[0].simulateClose()
      }

      it('is reconnecting and keeps the last list', async () => {
        await liveThenClosed([makeAlert()])

        expect(service.availability).toBe('reconnecting')
        expect(service.getAlerts()).toHaveLength(1)
      })

      it('stays reconnecting while the probe fails', async () => {
        await liveThenClosed([makeAlert()])
        server.status.mockImplementation(statusReply(502))

        await vi.advanceTimersByTimeAsync(1000)

        expect(server.status).toHaveBeenCalledTimes(2)
        expect(service.availability).toBe('reconnecting')
        expect(wsInstances).toHaveLength(1)
      })

      it('probes before each new socket and goes live once it opens', async () => {
        await liveThenClosed([makeAlert()])

        await vi.advanceTimersByTimeAsync(1000)
        expect(server.status).toHaveBeenCalledTimes(2)
        expect(wsInstances).toHaveLength(2)
        expect(service.availability).toBe('reconnecting')

        wsInstances[1].simulateOpen()
        await vi.advanceTimersByTimeAsync(0)
        expect(service.availability).toBe('live')
      })

      it('keeps reconnecting when handshakes keep failing', async () => {
        await liveThenClosed([makeAlert()])

        await vi.advanceTimersByTimeAsync(1000)
        wsInstances[1].simulateClose()
        await vi.advanceTimersByTimeAsync(2000)

        expect(server.status).toHaveBeenCalledTimes(3)
        expect(wsInstances).toHaveLength(3)
        expect(service.availability).toBe('reconnecting')
      })

      it('is session-expired on a probe 401, keeping the last list', async () => {
        await liveThenClosed([makeAlert()])
        server.status.mockImplementation(statusReply(401))

        await vi.advanceTimersByTimeAsync(1000)

        expect(service.availability).toBe('session-expired')
        expect(service.getAlerts()).toHaveLength(1)
        expect(service.signInUrl).toBe('/admin/#/login')
      })

      it('goes from session-expired to live once the probe answers 2xx', async () => {
        await liveThenClosed([makeAlert()])
        server.status.mockImplementation(statusReply(401))
        await vi.advanceTimersByTimeAsync(1000)

        server.status.mockImplementation(statusReply(200))
        await vi.advanceTimersByTimeAsync(2000)
        wsInstances[wsInstances.length - 1].simulateOpen()
        await vi.advanceTimersByTimeAsync(0)

        expect(service.availability).toBe('live')
      })

      it('treats a probe 404 as connection lost, keeping the list and retrying', async () => {
        await liveThenClosed([makeAlert()])
        server.status.mockImplementation(statusReply(404))

        await vi.advanceTimersByTimeAsync(1000)
        expect(service.availability).toBe('reconnecting')
        expect(service.getAlerts()).toHaveLength(1)

        server.status.mockImplementation(statusReply(200))
        await vi.advanceTimersByTimeAsync(2000)
        expect(wsInstances).toHaveLength(2)
      })
    })
  })

  describe('liveness while live', () => {
    async function liveAndOpen(): Promise<void> {
      vi.useFakeTimers()
      fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, [makeAlert()])))
      await service.connect()
      wsInstances[0].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
    }

    it('probes the status every 30 s and stays live on a 2xx', async () => {
      await liveAndOpen()

      await vi.advanceTimersByTimeAsync(29999)
      expect(server.status).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.status).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(30000)
      expect(server.status).toHaveBeenCalledTimes(3)

      expect(service.availability).toBe('live')
      expect(wsInstances[0].readyState).toBe(MockWebSocket.OPEN)
    })

    it('closes the socket and reconnects when the probe fails', async () => {
      await liveAndOpen()
      server.status.mockImplementation(statusReply(502))

      await vi.advanceTimersByTimeAsync(30000)

      expect(wsInstances[0].readyState).toBe(MockWebSocket.CLOSED)
      expect(service.availability).toBe('reconnecting')
      expect(service.getAlerts()).toHaveLength(1)
    })

    it('closes the socket when the probe never answers', async () => {
      await liveAndOpen()
      server.status.mockImplementation(hangingReply)

      await vi.advanceTimersByTimeAsync(39999)
      expect(service.availability).toBe('live')
      await vi.advanceTimersByTimeAsync(1)

      expect(wsInstances[0].readyState).toBe(MockWebSocket.CLOSED)
      expect(service.availability).toBe('reconnecting')
    })

    it('reconnects at once when a dead socket is slow to report its close', async () => {
      await liveAndOpen()
      const dead = wsInstances[0]
      // A browser waits for the closing handshake before firing onclose.
      dead.close = () => {
        dead.readyState = MockWebSocket.CLOSING
      }
      server.status.mockImplementation(statusReply(502))

      await vi.advanceTimersByTimeAsync(30000)

      expect(service.availability).toBe('reconnecting')
      server.status.mockImplementation(statusReply(200))
      await vi.advanceTimersByTimeAsync(1000)
      expect(wsInstances).toHaveLength(2)
    })

    it('does not probe for liveness while reconnecting', async () => {
      await liveAndOpen()
      wsInstances[0].simulateClose()
      const probes = server.status.mock.calls.length

      // The retry at 1 s opens a socket that stays connecting.
      await vi.advanceTimersByTimeAsync(30000)

      expect(service.availability).toBe('reconnecting')
      expect(wsInstances[1].readyState).toBe(MockWebSocket.CONNECTING)
      expect(server.status).toHaveBeenCalledTimes(probes + 1)
    })

    it('stops probing on disconnect', async () => {
      await liveAndOpen()

      service.disconnect()

      expect(vi.getTimerCount()).toBe(0)
    })
  })

  describe('acting during an outage', () => {
    const unacked = makeAlert({ id: 'u1', priority: 'alarm' })
    const caution = makeAlert({ id: 'c1', priority: 'caution' })
    const acked = makeAlert({ id: 'k1', state: 'acknowledged' })

    /** Live with the socket open, listing the alerts; writes answer via `write`. */
    async function live(
      write: (url: string, init?: RequestInit) => Promise<unknown>,
      alerts: Alert[] = [unacked, caution, acked]
    ): Promise<void> {
      vi.useFakeTimers()
      fetchMock.mockImplementation((url: string, init?: RequestInit) =>
        url === '/signalk/v2/api/alerts'
          ? Promise.resolve(jsonResponse(200, alerts))
          : write(url, init)
      )
      await service.connect()
      wsInstances[0].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
    }

    const unreachable = () => Promise.reject(new TypeError('Failed to fetch'))
    const answering = (status: number) => () =>
      Promise.resolve(textResponse(status, status === 401 ? 'Unauthorized' : 'Error'))

    function alertById(id: string): Alert | undefined {
      return service.getAlerts().find((a) => a.id === id)
    }

    it('acknowledges on this display only when the server cannot be reached', async () => {
      await live(unreachable)
      wsInstances[0].simulateClose()
      let changes = 0
      service.addEventListener('change', () => changes++)

      await service.acknowledgeAlert('u1')

      expect(alertById('u1')?.state).toBe('acknowledged')
      expect(service.isLocalOnly('u1')).toBe(true)
      expect(service.isLocalOnly('c1')).toBe(false)
      expect(changes).toBe(1)
    })

    it('silences on this display only when the server cannot be reached', async () => {
      await live(unreachable)
      wsInstances[0].simulateClose()

      await service.silenceAlert('u1')

      expect(alertById('u1')?.silenced).toBe(true)
      expect(alertById('u1')?.state).toBe('unacknowledged')
      expect(service.isLocalOnly('u1')).toBe(true)
    })

    describe('while live, a write that fails without a refusal', () => {
      it('acts locally when it times out and the status probe fails', async () => {
        await live(hangingReply)
        server.status.mockImplementation(statusReply(502))
        const acking = service.acknowledgeAlert('u1')

        await vi.advanceTimersByTimeAsync(10000)
        await acking

        expect(service.isLocalOnly('u1')).toBe(true)
        expect(service.availability).toBe('reconnecting')
        expect(wsInstances[0].readyState).toBe(MockWebSocket.CLOSED)
      })

      it.each([404, 500, 502, 503])(
        'acts locally on a %i when the status probe fails',
        async (status) => {
          await live(answering(status))
          server.status.mockImplementation(statusReply(502))

          await service.silenceAlert('u1')

          expect(alertById('u1')?.silenced).toBe(true)
          expect(service.isLocalOnly('u1')).toBe(true)
          expect(service.availability).toBe('reconnecting')
        }
      )

      it.each([500, 503])(
        "refuses a %i with core's message when the server still answers",
        async (status) => {
          await live(() => Promise.resolve(jsonResponse(status, { message: 'Store write failed' })))
          const probes = server.status.mock.calls.length

          await expect(service.acknowledgeAlert('u1')).rejects.toMatchObject({
            status,
            message: 'Store write failed'
          })

          expect(server.status).toHaveBeenCalledTimes(probes + 1)
          expect(alertById('u1')?.state).toBe('unacknowledged')
          expect(service.isLocalOnly('u1')).toBe(false)
          expect(service.availability).toBe('live')
          expect(wsInstances[0].readyState).toBe(MockWebSocket.OPEN)
        }
      )

      it('refuses a timed-out write when the server still answers', async () => {
        await live(hangingReply)
        const acking = service.acknowledgeAlert('u1')
        const outcome = expect(acking).rejects.toMatchObject({ status: 0 })

        await vi.advanceTimersByTimeAsync(10000)
        await outcome

        expect(service.isLocalOnly('u1')).toBe(false)
        expect(service.availability).toBe('live')
      })

      it("refuses a 404 with core's message when the server still answers", async () => {
        await live(() =>
          Promise.resolve(jsonResponse(404, { message: 'Alert u1 not found' }, 'Not Found'))
        )

        await expect(service.acknowledgeAlert('u1')).rejects.toMatchObject({
          status: 404,
          message: 'Alert u1 not found'
        })

        expect(service.isLocalOnly('u1')).toBe(false)
      })

      it('says a bare 404 means the alert is no longer active', async () => {
        await live(() => Promise.resolve(textResponse(404, 'Not Found', 'Not Found')))

        await expect(service.silenceAlert('u1')).rejects.toMatchObject({
          status: 404,
          message: 'This alert is no longer active'
        })
      })
    })

    describe('while the connection is known to be down', () => {
      function writes(): unknown[][] {
        return fetchMock.mock.calls.filter(([url]) => String(url) !== '/signalk/v2/api/alerts')
      }

      it('acknowledges locally at once while reconnecting, sending nothing', async () => {
        await live(hangingReply)
        wsInstances[0].simulateClose()

        await service.acknowledgeAlert('u1')

        expect(alertById('u1')?.state).toBe('acknowledged')
        expect(service.isLocalOnly('u1')).toBe(true)
        expect(writes()).toHaveLength(0)
      })

      it('silences and silences all locally at once while reconnecting, sending nothing', async () => {
        await live(hangingReply, [unacked, makeAlert({ id: 'u2', priority: 'alarm' })])
        wsInstances[0].simulateClose()

        await service.silenceAlert('u1')
        await service.silenceAll()

        expect(alertById('u1')?.silenced).toBe(true)
        expect(alertById('u2')?.silenced).toBe(true)
        expect(writes()).toHaveLength(0)
      })

      it('acts locally at once while the session has expired, sending nothing', async () => {
        await live(answering(401))
        server.status.mockImplementation(statusReply(401))
        wsInstances[0].simulateClose()
        await vi.advanceTimersByTimeAsync(1000)
        expect(service.availability).toBe('session-expired')

        await service.acknowledgeAlert('u1')

        expect(service.isLocalOnly('u1')).toBe(true)
        expect(writes()).toHaveLength(0)
      })

      it('resolves a repeated action that is already applied, changing nothing', async () => {
        await live(hangingReply)
        wsInstances[0].simulateClose()
        await service.acknowledgeAlert('u1')
        let changes = 0
        service.addEventListener('change', () => changes++)

        await service.acknowledgeAlert('u1')
        await service.silenceAlert('u1')

        expect(changes).toBe(0)
        expect(writes()).toHaveLength(0)
      })
    })

    it('refuses without a local effect on a 401 while live', async () => {
      await live(answering(401))

      await expect(service.acknowledgeAlert('u1')).rejects.toMatchObject({ status: 401 })

      expect(alertById('u1')?.state).toBe('unacknowledged')
      expect(service.isLocalOnly('u1')).toBe(false)
    })

    it('refuses without a local effect on a 409 while live', async () => {
      await live(answering(409))

      await expect(service.silenceAlert('u1')).rejects.toMatchObject({ status: 409 })

      expect(service.isLocalOnly('u1')).toBe(false)
    })

    it('silences all unacknowledged, unsilenced alerts locally', async () => {
      await live(unreachable)
      wsInstances[0].simulateClose()

      await service.silenceAll()

      expect(alertById('u1')?.silenced).toBe(true)
      expect(alertById('c1')?.silenced).toBe(true)
      expect(service.isLocalOnly('u1')).toBe(true)
      expect(service.isLocalOnly('c1')).toBe(true)
      expect(alertById('k1')?.silenced).toBe(false)
      expect(service.isLocalOnly('k1')).toBe(false)
    })

    it('lets the re-sync on reconnect replace the local override', async () => {
      await live(unreachable)
      wsInstances[0].simulateClose()
      await service.acknowledgeAlert('u1')

      await vi.advanceTimersByTimeAsync(1000)
      wsInstances[1].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)

      expect(service.availability).toBe('live')
      expect(alertById('u1')?.state).toBe('unacknowledged')
      expect(service.isLocalOnly('u1')).toBe(false)
    })

    it('does not queue or replay the write on reconnect', async () => {
      await live(unreachable)
      wsInstances[0].simulateClose()
      await service.acknowledgeAlert('u1')
      const writes = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/acknowledge'))

      await vi.advanceTimersByTimeAsync(1000)
      wsInstances[1].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)

      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/acknowledge'))
      ).toHaveLength(writes.length)
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

      // Advance past reconnect delay; the probe runs before the new socket
      await vi.advanceTimersByTimeAsync(1500)

      expect(wsInstances).toHaveLength(2)

      vi.useRealTimers()
    })

    it('opens no socket when disconnected while the first fetch is pending', async () => {
      vi.useFakeTimers()
      let resolveList!: (response: Response) => void
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveList = resolve
        })
      )

      const connecting = service.connect()
      service.disconnect()
      resolveList(new Response('[]', { status: 200 }))
      await connecting.catch(() => undefined)
      vi.advanceTimersByTime(60000)

      expect(wsInstances).toHaveLength(0)

      vi.useRealTimers()
    })

    it('closes the socket and retries when the re-sync on open never answers', async () => {
      vi.useFakeTimers()
      await service.connect()
      const ws1 = wsInstances[0]
      fetchMock.mockImplementationOnce(hangingReply)

      ws1.simulateOpen()
      await vi.advanceTimersByTimeAsync(10000)
      expect(ws1.readyState).toBe(MockWebSocket.CLOSED)
      expect(service.availability).toBe('reconnecting')

      await vi.advanceTimersByTimeAsync(1000)
      expect(wsInstances).toHaveLength(2)
    })

    it('subscribes only on the socket that opened, while it is open', async () => {
      vi.useFakeTimers()
      await service.connect()
      const ws1 = wsInstances[0]

      let resolveResync!: (response: Response) => void
      fetchMock.mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveResync = resolve
        })
      )
      ws1.simulateOpen()
      ws1.simulateClose()
      await vi.advanceTimersByTimeAsync(1500)
      const ws2 = wsInstances[wsInstances.length - 1]
      expect(ws2).not.toBe(ws1)
      expect(ws2.readyState).toBe(MockWebSocket.CONNECTING)
      const send2 = vi.spyOn(ws2, 'send')

      resolveResync(new Response('[]', { status: 200 }))
      await vi.advanceTimersByTimeAsync(0)

      expect(send2).not.toHaveBeenCalled()
      expect(ws1.sent).toHaveLength(0)

      vi.useRealTimers()
    })

    it('closes the socket and retries when the re-sync on open fails', async () => {
      vi.useFakeTimers()
      await service.connect()
      const ws1 = wsInstances[0]
      fetchMock.mockResolvedValueOnce(textResponse(502, 'Bad Gateway'))

      ws1.simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
      expect(ws1.readyState).toBe(MockWebSocket.CLOSED)
      expect(ws1.sent).toHaveLength(0)

      await vi.advanceTimersByTimeAsync(1000)
      expect(wsInstances).toHaveLength(2)
    })

    it('ignores retryNow() while a new socket is connecting', async () => {
      vi.useFakeTimers()
      await service.connect()
      wsInstances[0].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
      wsInstances[0].simulateClose()
      await vi.advanceTimersByTimeAsync(1000)
      expect(wsInstances[1].readyState).toBe(MockWebSocket.CONNECTING)
      const probes = server.status.mock.calls.length

      service.retryNow()
      await vi.advanceTimersByTimeAsync(0)

      expect(server.status).toHaveBeenCalledTimes(probes)
      expect(wsInstances).toHaveLength(2)
    })

    it('ignores retryNow() while a probe is in flight', async () => {
      vi.useFakeTimers()
      await service.connect()
      wsInstances[0].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
      server.status.mockImplementation(hangingReply)
      wsInstances[0].simulateClose()
      await vi.advanceTimersByTimeAsync(1000)
      const probes = server.status.mock.calls.length

      service.retryNow()
      service.retryNow()
      await vi.advanceTimersByTimeAsync(0)

      expect(server.status).toHaveBeenCalledTimes(probes)
    })

    it('resets the backoff to 1 s once live again', async () => {
      vi.useFakeTimers()
      server.status.mockImplementation(statusReply(503))
      await service.connect()
      // Failures at 0, 1, 3 and 7 s leave the next retry 8 s away.
      await vi.advanceTimersByTimeAsync(7000)
      server.status.mockImplementation(statusReply(200))
      await vi.advanceTimersByTimeAsync(8000)
      expect(service.availability).toBe('live')
      wsInstances[0].simulateOpen()
      await vi.advanceTimersByTimeAsync(0)
      const probes = server.status.mock.calls.length

      wsInstances[0].simulateClose()
      await vi.advanceTimersByTimeAsync(999)
      expect(server.status).toHaveBeenCalledTimes(probes)
      await vi.advanceTimersByTimeAsync(1)
      expect(server.status).toHaveBeenCalledTimes(probes + 1)
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
