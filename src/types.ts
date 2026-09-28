/**
 * Client-facing types of the Signal K core alerts API.
 *
 * Vendored from signalk-server `src/api/alerts/types.ts` at aadd08a3, the head
 * of the SignalK/signalk-server PR 3012 stack, until a published
 * `@signalk/server-api` carries them. Server-only types (store, transitions,
 * history query) are left out; `Path`, `Context` and `SourceRef` are plain
 * strings here.
 *
 * The model follows IMO MSC.302(87) bridge alert management and the
 * IEC 62682 / IEC 62923-1 alarm lifecycle.
 */

/**
 * Alert priority levels following the IMO model.
 *
 * - emergency: Immediate danger to life or vessel; immediate action required
 * - alarm: Conditions requiring immediate attention to maintain safe operation
 * - warning: Conditions requiring attention for precautionary reasons
 * - caution: Conditions requiring attention but not immediately hazardous
 */
export const ALERT_PRIORITIES = Object.freeze(['emergency', 'alarm', 'warning', 'caution'] as const)

export type AlertPriority = (typeof ALERT_PRIORITIES)[number]

/**
 * Alert states based on the IEC 62682 simplified model.
 *
 * - normal: No active alert condition (State A / cleared)
 * - unacknowledged: Alert active, operator has not acknowledged (State B)
 * - acknowledged: Alert active, operator has acknowledged (State C)
 * - rtn-unacknowledged: Condition cleared before acknowledgment, awaiting ack (State D)
 */
export const ALERT_STATES = Object.freeze([
  'normal',
  'unacknowledged',
  'acknowledged',
  'rtn-unacknowledged'
] as const)

export type AlertState = (typeof ALERT_STATES)[number]

/**
 * Full alert instance representing an active or historical alert.
 */
export interface Alert {
  /** Unique alert instance ID (UUID) */
  id: string

  /**
   * Descriptive path naming the condition this alert reports, for example
   * `propulsion.port.oilPressureLow`. With `context`, the alert's identity.
   */
  path: string

  /** Data paths this alert concerns; informational, never part of identity */
  references?: string[]

  /** Signal K source reference (e.g., "n2k-on-ve.can-bus.115", "alertsApi") */
  $source: string

  /** Signal K structured source object, if available */
  source?: Record<string, unknown>

  /** Alert priority level */
  priority: AlertPriority

  /** Current alert state in the IEC 62682 model */
  state: AlertState

  /** Whether the triggering condition is currently active */
  condition: boolean

  /** Whether alert latches (stays active after condition clears) */
  latching: boolean

  /** Whether audible indicators are silenced */
  silenced: boolean

  /** ISO timestamp when silence expires */
  silencedUntil?: string

  /** Human-readable alert message */
  message: string

  /** Optional free-text UI grouping (e.g., "engine", "navigation"); not the IEC alert category A/B/C */
  group?: string

  /** Additional context data */
  data?: Record<string, unknown>

  /** ISO timestamp when alert was first raised */
  raisedAt: string

  /**
   * ISO timestamp of the last lifecycle state change
   * (raise/ack/clear/reactivate/escalate). A warning→alarm escalation bumps it,
   * but a latching alarm whose condition clears does NOT (its state stays
   * `unacknowledged`), and silence/unsilence never bump it. Used for
   * IEC 62923-1 6.4.2.2 list ordering.
   */
  stateChangedAt: string

  /** ISO timestamp when operator acknowledged */
  acknowledgedAt?: string

  /** User/client identifier that acknowledged */
  acknowledgedBy?: string

  /** ISO timestamp when condition cleared */
  clearedAt?: string

  /** Whether the source is currently reachable */
  sourceOnline: boolean

  /** ISO timestamp of last update from source */
  lastSourceUpdate: string

  /** Whether source went offline while alert was active */
  stale: boolean

  /** Vessel context for multi-vessel deployments */
  context?: string
}

/**
 * Filter criteria for querying alerts.
 */
export interface AlertFilter {
  /** Filter by alert state(s) */
  state?: AlertState | AlertState[]

  /** Filter by priority level(s) */
  priority?: AlertPriority | AlertPriority[]

  /** Filter by group */
  group?: string

  /** Filter by stale status */
  stale?: boolean
}

/**
 * Types of events recorded in alert history.
 */
export const HISTORY_EVENT_TYPES = Object.freeze([
  'raise',
  'acknowledge',
  'silence',
  'unsilence',
  'clear',
  'escalate'
] as const)

export type HistoryEventType = (typeof HISTORY_EVENT_TYPES)[number]

/**
 * A single entry in the alert history log.
 *
 * The alert's identity is copied onto each entry: a cleared alert leaves the
 * active set, and a new raise on the same path mints a new id, so `alertId`
 * alone cannot answer what a past event was about.
 */
export interface HistoryEntry {
  /** Unique history entry ID */
  id: string

  /** ID of the alert this entry relates to */
  alertId: string

  /** Descriptive path of the alert this entry relates to */
  path: string

  /** Vessel context of the alert, when it had one */
  context?: string

  /** Priority the alert carried when the event occurred */
  priority: AlertPriority

  /** Message the alert carried when the event occurred */
  message: string

  /** Source that owned the alert when the event occurred */
  $source: string

  /** Type of event that occurred */
  eventType: HistoryEventType

  /** ISO timestamp when the event occurred */
  timestamp: string

  /** User/client that triggered the event (if applicable) */
  userId?: string

  /** Alert state before the event */
  previousState?: AlertState

  /** Alert state after the event */
  newState?: AlertState

  /** Priority before escalation (for escalate events) */
  previousPriority?: AlertPriority

  /** Priority after escalation (for escalate events) */
  newPriority?: AlertPriority

  /** Additional event-specific details */
  details?: Record<string, unknown>
}
