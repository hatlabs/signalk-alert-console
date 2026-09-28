/**
 * AlertService
 *
 * Fetches alerts from the REST API and subscribes to real-time updates
 * via the Signal K WebSocket delta stream.
 *
 * Dispatches 'change' events when the alert list is updated.
 */

import type { Alert, AlertFilter, AlertState, HistoryEntry, HistoryEventType } from '../types.js'
import { PRIORITY_ORDER } from '../styles/priority.js'

/**
 * Sort modes for the alert list.
 *
 * - 'standard': unacked first, then by priority, then most recent state
 *   change first within each group (IEC 62923-1 6.4.2.2)
 * - 'newest': Pure reverse-chronological (most recent first)
 */
export type SortBy = 'standard' | 'newest'

/** REST base of the Signal K core alerts API. */
const API_BASE = '/signalk/v2/api/alerts'

/** Shown for every 401: the read gate answers in plain text, so its body says nothing useful. */
export const NOT_PERMITTED_MESSAGE = 'Not permitted — sign in with a read/write account'
const UNREACHABLE_MESSAGE = 'Cannot reach the Signal K server'

/** A refused or failed request; status 0 means the server was not reached. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Fetch with `Accept: application/json`, which makes the server answer write
 * refusals with a JSON body. Rejects with an ApiError unless the response is ok.
 */
async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers }
    })
  } catch {
    throw new ApiError(0, UNREACHABLE_MESSAGE)
  }
  if (!response.ok) {
    throw await errorFrom(response)
  }
  return response
}

async function errorFrom(response: Response): Promise<ApiError> {
  if (response.status === 401) {
    return new ApiError(401, NOT_PERMITTED_MESSAGE)
  }
  const body = await readJson(response)
  const message =
    stringField(body, 'message') ??
    stringField(body, 'error') ??
    (response.statusText || `HTTP ${String(response.status)}`)
  return new ApiError(response.status, message)
}

/** The body as JSON, or undefined when it is missing or not JSON. */
async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text()) as unknown
  } catch {
    return undefined
  }
}

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const value = (body as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export class AlertService extends EventTarget {
  private alerts = new Map<string, Alert>()
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private intentionalDisconnect = false

  private static readonly MAX_RECONNECT_DELAY = 30000

  /**
   * Connect to the REST API and WebSocket.
   * Fetches current alerts, then opens a WebSocket subscription for live updates.
   */
  async connect(): Promise<void> {
    await this.fetchAlerts()
    this.intentionalDisconnect = false
    this.connectWebSocket()
    this.dispatchEvent(new Event('change'))
  }

  /** Fetch the full alert list from the REST API. */
  private async fetchAlerts(): Promise<void> {
    const response = await request(API_BASE)
    const alertList = (await response.json()) as Alert[]
    this.alerts.clear()
    for (const alert of alertList) {
      this.alerts.set(alert.id, alert)
    }
  }

  /** Close WebSocket and clear state. */
  disconnect(): void {
    this.intentionalDisconnect = true

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }

    this.alerts.clear()
  }

  /** Acknowledge an alert. State update arrives via WebSocket. */
  async acknowledgeAlert(id: string): Promise<void> {
    await request(`${API_BASE}/${id}/acknowledge`, { method: 'POST' })
  }

  /** Silence an alert. Duration is in seconds; omit for server default. */
  async silenceAlert(id: string, duration?: number): Promise<void> {
    const body: Record<string, unknown> = {}
    if (duration !== undefined) {
      body.duration = duration
    }
    await request(`${API_BASE}/${id}/silence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
  }

  /**
   * Dismiss an alert by clearing its triggering condition.
   *
   * Needed for one-shot sources that never retract their notification:
   * without it a caution alert stays in the list forever (see §2.1 — caution
   * clears on condition return, not on acknowledgement).
   */
  async dismissAlert(id: string): Promise<void> {
    await request(`${API_BASE}/${id}/condition`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    })
  }

  /**
   * Fetch alert history from the REST API.
   * Does not require WebSocket state — works as a standalone query.
   */
  static async fetchHistory(params: {
    from?: string
    to?: string
    alertId?: string
    eventType?: HistoryEventType[]
    limit?: number
    offset?: number
  }): Promise<{ entries: HistoryEntry[]; total: number }> {
    const query = new URLSearchParams()
    if (params.from) query.set('from', params.from)
    if (params.to) query.set('to', params.to)
    if (params.alertId) query.set('alertId', params.alertId)
    // The server rejects a comma-joined list; each type is its own parameter.
    for (const eventType of params.eventType ?? []) query.append('eventType', eventType)
    if (params.limit !== undefined) query.set('limit', String(params.limit))
    if (params.offset !== undefined) query.set('offset', String(params.offset))

    const url = `${API_BASE}/history${query.toString() ? `?${query.toString()}` : ''}`
    const response = await request(url)
    return response.json() as Promise<{ entries: HistoryEntry[]; total: number }>
  }

  /** Silence all unacknowledged alerts. */
  async silenceAll(): Promise<void> {
    await request(`${API_BASE}/silence-all`, { method: 'POST' })
  }

  /**
   * Get alerts, optionally filtered and sorted.
   *
   * @param filter - Optional filter criteria (state, priority, group)
   * @param sortBy - Sort order: 'standard' (IMO default) or 'newest' (reverse chronological)
   */
  getAlerts(filter?: AlertFilter, sortBy: SortBy = 'standard'): Alert[] {
    let result = Array.from(this.alerts.values())

    if (filter) {
      result = applyFilter(result, filter)
    }

    return applySort(result, sortBy)
  }

  private connectWebSocket(): void {
    const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${wsProtocol}//${location.host}/signalk/v1/stream?subscribe=none`

    this.ws = new WebSocket(wsUrl)

    this.ws.onopen = () => {
      this.reconnectDelay = 1000

      // Re-sync from REST API before subscribing to deltas — this
      // prevents deltas from arriving while the fetch is in flight
      // and then being wiped by alerts.clear() when the fetch resolves.
      this.fetchAlerts()
        .then(() => {
          this.dispatchEvent(new Event('change'))
        })
        .catch(() => {
          // Non-fatal; we still have the previous state + live updates
        })
        .finally(() => {
          this.ws?.send(
            JSON.stringify({
              context: 'vessels.self',
              subscribe: [{ path: 'alerts.*', minPeriod: 0 }]
            })
          )
        })
    }

    this.ws.onmessage = (ev: MessageEvent) => {
      this.handleDelta(ev)
    }

    this.ws.onclose = () => {
      this.ws = null
      this.scheduleReconnect()
    }
  }

  private handleDelta(ev: MessageEvent): void {
    let delta: {
      updates?: {
        values?: { path?: string; value?: unknown }[]
      }[]
    }

    try {
      delta = JSON.parse(String(ev.data)) as typeof delta
    } catch {
      return
    }

    let changed = false

    for (const update of delta.updates ?? []) {
      for (const pathValue of update.values ?? []) {
        if (!pathValue.path?.startsWith('alerts.')) {
          continue
        }

        const alert = pathValue.value as Alert | null | undefined
        if (alert === null || alert === undefined) {
          continue
        }

        if (alert.state === 'normal') {
          if (this.alerts.delete(alert.id)) {
            changed = true
          }
        } else {
          this.alerts.set(alert.id, alert)
          changed = true
        }
      }
    }

    if (changed) {
      this.dispatchEvent(new Event('change'))
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalDisconnect) {
      return
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connectWebSocket()
    }, this.reconnectDelay)

    this.reconnectDelay = Math.min(this.reconnectDelay * 2, AlertService.MAX_RECONNECT_DELAY)
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function applyFilter(alerts: Alert[], filter: AlertFilter): Alert[] {
  let result = alerts

  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state]
    result = result.filter((a) => states.includes(a.state))
  }

  if (filter.priority !== undefined) {
    const priorities = Array.isArray(filter.priority) ? filter.priority : [filter.priority]
    result = result.filter((a) => priorities.includes(a.priority))
  }

  if (filter.group !== undefined) {
    const needle = filter.group.toLowerCase()
    result = result.filter((a) => a.group?.toLowerCase().includes(needle))
  }

  if (filter.stale !== undefined) {
    result = result.filter((a) => a.stale === filter.stale)
  }

  return result
}

/**
 * Unacknowledged states need operator attention and sort before acknowledged.
 * Lower number = higher display priority.
 */
/**
 * Sort weight per state. Lower = higher display priority.
 * Normal alerts are removed before sorting; the entry exists only to
 * satisfy the Record<AlertState, number> type constraint.
 */
const STATE_ORDER: Record<AlertState, number> = {
  normal: 2,
  unacknowledged: 0,
  'rtn-unacknowledged': 0,
  acknowledged: 1
}

function applySort(alerts: Alert[], sortBy: SortBy): Alert[] {
  return alerts.slice().sort((a, b) => {
    if (sortBy === 'newest') {
      return newestFirst(a.raisedAt, b.raisedAt)
    }
    // Default: state → priority → most recent state change first
    // (IEC 62923-1 6.4.2.2: active list ordered by time of last state change).
    const sDiff = STATE_ORDER[a.state] - STATE_ORDER[b.state]
    if (sDiff !== 0) return sDiff
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
    if (pDiff !== 0) return pDiff
    // Fall back to raisedAt when stateChangedAt is missing, mirroring the
    // store's state_changed_at ?? raised_at; new Date(undefined) is NaN and
    // would otherwise corrupt the ordering.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above
    return newestFirst(a.stateChangedAt ?? a.raisedAt, b.stateChangedAt ?? b.raisedAt)
  })
}

function newestFirst(a: string, b: string): number {
  return new Date(b).getTime() - new Date(a).getTime()
}

// ---------------------------------------------------------------------------
// Shared singleton with reference counting
// ---------------------------------------------------------------------------

let sharedInstance: AlertService | null = null
let refCount = 0

/**
 * Acquire the shared AlertService singleton.
 * First caller triggers connect(); subsequent callers reuse the connection.
 */
export function acquireAlertService(): AlertService {
  if (!sharedInstance) {
    sharedInstance = new AlertService()
    sharedInstance.connect().catch(() => {
      // Connection failure; the service will retry via WebSocket reconnect
    })
  }
  refCount++
  return sharedInstance
}

/**
 * Release the shared AlertService singleton.
 * When the last consumer releases, the connection is closed.
 */
export function releaseAlertService(): void {
  if (refCount <= 0) return
  if (--refCount <= 0) {
    sharedInstance?.disconnect()
    sharedInstance = null
    refCount = 0
  }
}

/** @internal Reset shared state. For testing only. */
export function _resetAlertServiceSingleton(): void {
  sharedInstance?.disconnect()
  sharedInstance = null
  refCount = 0
}
