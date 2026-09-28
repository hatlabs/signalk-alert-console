/**
 * OpenBridge-inspired priority color definitions and ordering.
 *
 * @see docs/SPEC.md Section 8.1 for design guidelines
 */

import type { AlertPriority, AlertState } from '../types.js'

/** Canonical light-mode priority colors. Kept as reference; components should use priorityVars() for dark mode support. */
export const PRIORITY_COLORS: Record<AlertPriority, { color: string; background: string }> = {
  emergency: { color: '#D32F2F', background: '#FFEBEE' },
  alarm: { color: '#F57C00', background: '#FFF3E0' },
  warning: { color: '#FBC02D', background: '#FFFDE7' },
  caution: { color: '#1976D2', background: '#E3F2FD' }
}

/** Lower number = higher priority (for sorting). */
export const PRIORITY_ORDER: Record<AlertPriority, number> = {
  emergency: 0,
  alarm: 1,
  warning: 2,
  caution: 3
}

export const PRIORITY_LABELS: Record<AlertPriority, string> = {
  emergency: 'Emergency',
  alarm: 'Alarm',
  warning: 'Warning',
  caution: 'Caution'
}

export const STATE_LABELS: Record<AlertState, string> = {
  normal: 'Normal',
  unacknowledged: 'Unacknowledged',
  acknowledged: 'Acknowledged',
  'rtn-unacknowledged': 'RTN Unacked'
}

/**
 * Priority values that can produce audio, plus 'off' to disable all audio.
 * Caution is visual only, per IMO/IEC alert management, so it is never a threshold.
 */
export type MinAudiblePriority = 'off' | Exclude<AlertPriority, 'caution'>

/** Threshold used until the operator picks one, and when the stored choice is unusable. */
export const DEFAULT_MIN_AUDIBLE_PRIORITY: MinAudiblePriority = 'warning'

/**
 * Return CSS variable references for a given priority.
 * Components using themeStyles should prefer this over PRIORITY_COLORS
 * so that dark mode overrides take effect automatically.
 */
export function priorityVars(priority: AlertPriority): { color: string; background: string } {
  return {
    color: `var(--priority-${priority}-color)`,
    background: `var(--priority-${priority}-bg)`
  }
}

/** Whether an alert at the given priority would produce audio. */
export function isAudible(
  priority: AlertPriority,
  minAudiblePriority: MinAudiblePriority
): boolean {
  if (minAudiblePriority === 'off') return false
  return PRIORITY_ORDER[priority] <= PRIORITY_ORDER[minAudiblePriority]
}
