/**
 * AlertService
 *
 * Probes the core alerts API, fetches alerts from it and subscribes to
 * real-time updates via the Signal K WebSocket delta stream.
 *
 * Dispatches 'change' events when the alert list is updated and
 * 'availability' events when the connection state changes.
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

/** A server that accepts a request but never answers counts as unreachable after this. */
const REQUEST_TIMEOUT_MS = 10000

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
 * refusals with a JSON body. Rejects with an ApiError unless the response is ok;
 * a request that times out is status 0, like one that never reached the server.
 */
async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...init.headers },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
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

/**
 * Where the console stands with the server:
 * - probing: first contact, nothing known yet
 * - live: list fetched, socket open or opening
 * - reconnecting: the socket closed after live; the last list is kept
 * - session-expired: after live, reads are now refused; the last list is kept
 * - no-api: the server has no alerts API
 * - sign-in: the server refuses anonymous reads
 * - unreachable: no answer, or an answer other than 2xx, 401 or 404
 */
export type Availability =
  'probing' | 'live' | 'reconnecting' | 'session-expired' | 'no-api' | 'sign-in' | 'unreachable'

/** Where to sign in when the server does not advertise an OIDC login. */
export const DEFAULT_SIGN_IN_URL = '/admin/#/login'

type ProbeOutcome = 'ok' | 'no-api' | 'sign-in' | 'unreachable'

const INITIAL_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30000

export class AlertService extends EventTarget {
  private alerts = new Map<string, Alert>()
  private ws: WebSocket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = INITIAL_RETRY_DELAY_MS
  private probeInFlight = false
  /** Bumped by disconnect(); async work begun in an earlier session is dropped. */
  private session = 0
  private currentAvailability: Availability = 'probing'
  private currentSignInUrl = DEFAULT_SIGN_IN_URL

  get availability(): Availability {
    return this.currentAvailability
  }

  /** Sign-in target: the server's OIDC login when enabled, else the admin UI's login. */
  get signInUrl(): string {
    return this.currentSignInUrl
  }

  /** The list is on screen: live, or its last known state while the connection recovers. */
  private get holdsList(): boolean {
    return (
      this.currentAvailability === 'live' ||
      this.currentAvailability === 'reconnecting' ||
      this.currentAvailability === 'session-expired'
    )
  }

  /**
   * Probe the API, then fetch the list and open the WebSocket. Never rejects:
   * the outcome is the availability, and failures retry on their own.
   */
  async connect(): Promise<void> {
    this.setAvailability('probing')
    await this.probe()
  }

  /** Probe now rather than at the next retry, e.g. when the tab regains focus. */
  retryNow(): void {
    if (this.currentAvailability === 'live' || this.currentAvailability === 'probing') return
    if (this.probeInFlight || this.ws !== null) return
    this.clearRetryTimer()
    void this.probe()
  }

  /** Close WebSocket and clear state. */
  disconnect(): void {
    this.session++
    this.clearRetryTimer()

    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }

    this.alerts.clear()
  }

  /**
   * Ask the status endpoint whether the API exists and is readable. A refused
   * WebSocket handshake never reaches onopen, so every attempt starts here.
   */
  private async probe(): Promise<void> {
    const session = this.session
    this.probeInFlight = true
    let outcome = await probeStatus()
    let alertList: Alert[] | null = null
    if (outcome === 'ok' && !this.holdsList) {
      try {
        alertList = await fetchAlertList()
      } catch (error) {
        outcome = outcomeOf(error)
      }
    }
    const signInUrl = outcome === 'sign-in' ? await fetchSignInUrl() : this.currentSignInUrl
    this.probeInFlight = false
    if (session !== this.session) return

    this.currentSignInUrl = signInUrl
    switch (outcome) {
      case 'ok':
        if (alertList) {
          this.replaceAlerts(alertList)
          this.goLive()
        }
        this.connectWebSocket()
        return
      case 'no-api':
        this.alerts.clear()
        this.setAvailability('no-api')
        this.dispatchEvent(new Event('change'))
        break
      case 'sign-in':
        this.setAvailability(this.holdsList ? 'session-expired' : 'sign-in')
        break
      case 'unreachable':
        // A list on screen stays there while the server is away.
        if (!this.holdsList) this.setAvailability('unreachable')
        break
    }
    this.scheduleRetry()
  }

  private goLive(): void {
    this.retryDelay = INITIAL_RETRY_DELAY_MS
    this.setAvailability('live')
    this.dispatchEvent(new Event('change'))
  }

  private setAvailability(availability: Availability): void {
    if (availability === this.currentAvailability) return
    this.currentAvailability = availability
    this.dispatchEvent(new Event('availability'))
  }

  private replaceAlerts(alertList: Alert[]): void {
    this.alerts.clear()
    for (const alert of alertList) {
      this.alerts.set(alert.id, alert)
    }
  }

  /**
   * Run a write. A 401 refreshes the sign-in target before the ApiError
   * reaches the caller, so the refusal can link to it.
   */
  private async write(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string }
  ): Promise<void> {
    try {
      await request(url, init)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.currentSignInUrl = await fetchSignInUrl()
      }
      throw error
    }
  }

  /** Acknowledge an alert. State update arrives via WebSocket. */
  async acknowledgeAlert(id: string): Promise<void> {
    await this.write(`${API_BASE}/${id}/acknowledge`, { method: 'POST' })
  }

  /** Silence an alert. Duration is in seconds; omit for server default. */
  async silenceAlert(id: string, duration?: number): Promise<void> {
    const body: Record<string, unknown> = {}
    if (duration !== undefined) {
      body.duration = duration
    }
    await this.write(`${API_BASE}/${id}/silence`, {
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
    await this.write(`${API_BASE}/${id}/condition`, {
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
    await this.write(`${API_BASE}/silence-all`, { method: 'POST' })
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

    const socket = new WebSocket(wsUrl)
    this.ws = socket

    socket.onopen = () => {
      void this.onSocketOpen(socket)
    }

    socket.onmessage = (ev: MessageEvent) => {
      this.handleDelta(ev)
    }

    socket.onclose = () => {
      if (socket !== this.ws) return
      this.ws = null
      if (this.currentAvailability === 'live') this.setAvailability('reconnecting')
      this.scheduleRetry()
    }
  }

  /**
   * Re-sync from REST before subscribing to deltas, so that deltas arriving
   * while the fetch is in flight are not wiped when it resolves.
   */
  private async onSocketOpen(socket: WebSocket): Promise<void> {
    let alertList: Alert[]
    try {
      alertList = await fetchAlertList()
    } catch {
      // Start over; the probe on the next attempt says what is wrong.
      if (socket === this.ws) socket.close()
      return
    }
    // By now this socket may have closed and a newer one be connecting.
    if (socket !== this.ws || socket.readyState !== WebSocket.OPEN) return
    this.replaceAlerts(alertList)
    this.goLive()
    socket.send(
      JSON.stringify({
        context: 'vessels.self',
        subscribe: [{ path: 'alerts.*', minPeriod: 0 }]
      })
    )
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

  /** Probe again on the 1 s to 30 s backoff. */
  private scheduleRetry(): void {
    this.clearRetryTimer()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      void this.probe()
    }, this.retryDelay)
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY_MS)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Fetch the full alert list from the REST API. */
async function fetchAlertList(): Promise<Alert[]> {
  const response = await request(API_BASE)
  return (await response.json()) as Alert[]
}

async function probeStatus(): Promise<ProbeOutcome> {
  try {
    // The body's store.degraded flag is not shown.
    await request(`${API_BASE}/status`)
    return 'ok'
  } catch (error) {
    return outcomeOf(error)
  }
}

function outcomeOf(error: unknown): ProbeOutcome {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'sign-in'
    if (error.status === 404) return 'no-api'
  }
  return 'unreachable'
}

/** The server's OIDC login when it advertises one, else the admin UI's login. */
async function fetchSignInUrl(): Promise<string> {
  try {
    const response = await request('/skServer/loginStatus')
    const body = (await response.json()) as unknown
    if (typeof body === 'object' && body !== null) {
      const { oidcEnabled, oidcLoginUrl } = body as Record<string, unknown>
      if (oidcEnabled === true && typeof oidcLoginUrl === 'string' && isHttpUrl(oidcLoginUrl)) {
        return oidcLoginUrl
      }
    }
  } catch {
    // The admin login is always there.
  }
  return DEFAULT_SIGN_IN_URL
}

function isHttpUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url, 'http://relative.invalid')
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

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
    void sharedInstance.connect()
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
