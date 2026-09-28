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

const UNREACHABLE_MESSAGE = 'Cannot reach the Signal K server'
const NOT_ACTIVE_MESSAGE = 'This alert is no longer active'

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
 * A 404 whose body carries no message gets `notFoundMessage` when given.
 */
async function request(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  notFoundMessage?: string
): Promise<Response> {
  // Not AbortSignal.timeout: Safari before 16 and Chrome before 103 lack it.
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  try {
    let response: Response
    try {
      response = await fetch(url, {
        ...init,
        headers: { Accept: 'application/json', ...init.headers },
        signal: controller.signal
      })
    } catch {
      throw new ApiError(0, UNREACHABLE_MESSAGE)
    }
    if (!response.ok) {
      throw await errorFrom(response, response.status === 404 ? notFoundMessage : undefined)
    }
    return response
  } finally {
    clearTimeout(timer)
  }
}

async function errorFrom(response: Response, fallback?: string): Promise<ApiError> {
  if (response.status === 401) {
    // The read gate answers in plain text, so the body says nothing useful;
    // the refusal is worded where it is rendered.
    return new ApiError(401, 'Unauthorized')
  }
  const body = await readJson(response)
  const message =
    stringField(body, 'message') ??
    stringField(body, 'error') ??
    fallback ??
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
 * - no-api: the server has no alerts API (a 404 on first contact; later, a 404
 *   is a lost connection)
 * - sign-in: the server refuses anonymous reads
 * - unreachable: no answer, or an answer other than 2xx, 401 or 404
 */
export type Availability =
  'probing' | 'live' | 'reconnecting' | 'session-expired' | 'no-api' | 'sign-in' | 'unreachable'

/** The list, live or its last known state while the connection recovers, is on screen. */
export function showsList(availability: Availability): boolean {
  return (
    availability === 'live' || availability === 'reconnecting' || availability === 'session-expired'
  )
}

/** Where to sign in when the server does not advertise an OIDC login. */
export const DEFAULT_SIGN_IN_URL = '/admin/#/login'

type ProbeOutcome = 'ok' | 'no-api' | 'sign-in' | 'unreachable'

const INITIAL_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 30000
/**
 * How often a live console asks the server whether it still answers. A socket
 * whose peer vanished without a reset never closes on its own.
 */
const LIVENESS_INTERVAL_MS = 30000

export class AlertService extends EventTarget {
  private alerts = new Map<string, Alert>()
  /**
   * Alerts acknowledged or silenced on this display only, because the server
   * could not be told. Server data for an alert replaces its override.
   */
  private localOnly = new Set<string>()
  private ws: WebSocket | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private livenessTimer: ReturnType<typeof setInterval> | null = null
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

  private get holdsList(): boolean {
    return showsList(this.currentAvailability)
  }

  /**
   * Probe the API, then fetch the list and open the WebSocket. Never rejects:
   * the outcome is the availability, and failures retry on their own.
   */
  async connect(): Promise<void> {
    this.setAvailability('probing')
    await this.probe()
  }

  /** Whether the alert's shown state is this display's alone, not confirmed by the server. */
  isLocalOnly(id: string): boolean {
    return this.localOnly.has(id)
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
    this.stopLiveness()

    if (this.ws) {
      this.ws.onclose = null
      this.ws.close()
      this.ws = null
    }

    this.clearAlerts()
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
    // Some reverse proxies answer 404 while the backend restarts, so only first
    // contact can tell that the API is missing.
    if (outcome === 'no-api' && this.holdsList) outcome = 'unreachable'

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
        this.clearAlerts()
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
    if (availability === 'live') {
      this.startLiveness()
    } else {
      this.stopLiveness()
    }
    this.dispatchEvent(new Event('availability'))
  }

  private startLiveness(): void {
    this.stopLiveness()
    this.livenessTimer = setInterval(() => {
      void this.checkLiveness()
    }, LIVENESS_INTERVAL_MS)
  }

  private stopLiveness(): void {
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer)
      this.livenessTimer = null
    }
  }

  /**
   * Whether the server still answers. Any answer but a 2xx, or none in time,
   * drops the socket so the console reconnects.
   */
  private async checkLiveness(): Promise<boolean> {
    const socket = this.ws
    if (socket === null) return false
    try {
      await request(`${API_BASE}/status`)
      return true
    } catch {
      this.dropSocket(socket)
      return false
    }
  }

  private clearAlerts(): void {
    this.alerts.clear()
    this.localOnly.clear()
  }

  private replaceAlerts(alertList: Alert[]): void {
    this.clearAlerts()
    for (const alert of alertList) {
      this.alerts.set(alert.id, alert)
    }
  }

  /**
   * Run a write, or apply its effect to the matching alerts on this display
   * only when the server cannot be told. Nothing is queued or replayed.
   *
   * While the connection is known to be down, the effect applies at once and
   * nothing is sent. While live, a failure that may be an outage is checked
   * with an immediate liveness probe: if the server still answers, the failure
   * is the server's and reaches the caller.
   */
  private async writeOrApplyLocally(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    matches: (alert: Alert) => boolean,
    effect: (alert: Alert) => Alert,
    notFoundMessage?: string
  ): Promise<void> {
    if (this.holdsList && this.currentAvailability !== 'live') {
      this.applyLocally(matches, effect)
      return
    }
    try {
      await this.write(url, init, notFoundMessage)
    } catch (error) {
      if (!mayBeOutage(error)) throw error
      if (this.currentAvailability === 'live' && (await this.checkLiveness())) throw error
      if (!this.holdsList) throw error
      this.applyLocally(matches, effect)
    }
  }

  /** An alert the effect already covers is left alone, so repeating an action changes nothing. */
  private applyLocally(matches: (alert: Alert) => boolean, effect: (alert: Alert) => Alert): void {
    const affected = [...this.alerts.values()].filter(matches)
    if (affected.length === 0) return
    for (const alert of affected) {
      this.alerts.set(alert.id, effect(alert))
      this.localOnly.add(alert.id)
    }
    this.dispatchEvent(new Event('change'))
  }

  /**
   * Run a write. A 401 refreshes the sign-in target before the ApiError
   * reaches the caller, so the refusal can link to it.
   */
  private async write(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
    notFoundMessage?: string
  ): Promise<void> {
    try {
      await request(url, init, notFoundMessage)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.currentSignInUrl = await fetchSignInUrl()
      }
      throw error
    }
  }

  /**
   * Acknowledge an alert. State update arrives via WebSocket; during an outage
   * the alert is acknowledged on this display only.
   */
  async acknowledgeAlert(id: string): Promise<void> {
    await this.writeOrApplyLocally(
      `${API_BASE}/${id}/acknowledge`,
      { method: 'POST' },
      (alert) => alert.id === id && isUnacknowledged(alert),
      (alert) => ({ ...alert, state: 'acknowledged' }),
      NOT_ACTIVE_MESSAGE
    )
  }

  /**
   * Silence an alert. Duration is in seconds; omit for server default. During
   * an outage the alert is silenced on this display only.
   */
  async silenceAlert(id: string, duration?: number): Promise<void> {
    const body: Record<string, unknown> = {}
    if (duration !== undefined) {
      body.duration = duration
    }
    await this.writeOrApplyLocally(
      `${API_BASE}/${id}/silence`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      },
      (alert) => alert.id === id && isSilenceable(alert),
      silenced,
      NOT_ACTIVE_MESSAGE
    )
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

  /**
   * Silence all unacknowledged alerts. During an outage they are silenced on
   * this display only.
   */
  async silenceAll(): Promise<void> {
    await this.writeOrApplyLocally(
      `${API_BASE}/silence-all`,
      { method: 'POST' },
      isSilenceable,
      silenced
    )
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
      this.onSocketLost(socket)
    }
  }

  private onSocketLost(socket: WebSocket): void {
    if (socket !== this.ws) return
    this.ws = null
    if (this.currentAvailability === 'live') this.setAvailability('reconnecting')
    this.scheduleRetry()
  }

  /**
   * Close a socket and treat it as lost now: over a dead connection the
   * browser fires onclose only after the closing handshake times out.
   */
  private dropSocket(socket: WebSocket): void {
    if (socket !== this.ws) return
    socket.onclose = null
    socket.close()
    this.onSocketLost(socket)
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
      this.dropSocket(socket)
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

        this.localOnly.delete(alert.id)
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

/** No answer, a 5xx, or a 404, which a proxy whose backend is down also sends. */
function mayBeOutage(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 0 || error.status >= 500 || error.status === 404)
  )
}

function isUnacknowledged(alert: Alert): boolean {
  return alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
}

/** What the server's silence covers: unacknowledged and not yet silenced. */
function isSilenceable(alert: Alert): boolean {
  return isUnacknowledged(alert) && !alert.silenced
}

function silenced(alert: Alert): Alert {
  return { ...alert, silenced: true }
}

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

/**
 * The server's OIDC login, returning to this page, when it advertises one;
 * else the admin UI's login.
 */
async function fetchSignInUrl(): Promise<string> {
  try {
    const response = await request('/skServer/loginStatus')
    const body = (await response.json()) as unknown
    if (typeof body === 'object' && body !== null) {
      const { oidcEnabled, oidcLoginUrl } = body as Record<string, unknown>
      if (oidcEnabled === true && typeof oidcLoginUrl === 'string') {
        return oidcLoginWithRedirect(oidcLoginUrl) ?? DEFAULT_SIGN_IN_URL
      }
    }
  } catch {
    // The admin login is always there.
  }
  return DEFAULT_SIGN_IN_URL
}

/**
 * The login URL with `redirect` set to this page, or undefined unless it is
 * http(s). Core honours only a safe relative redirect, so it gets the path,
 * not the full address.
 */
function oidcLoginWithRedirect(loginUrl: string): string | undefined {
  let url: URL
  try {
    url = new URL(loginUrl, location.origin)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  url.searchParams.set('redirect', location.pathname + location.search + location.hash)
  return url.origin === location.origin ? url.pathname + url.search + url.hash : url.href
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
