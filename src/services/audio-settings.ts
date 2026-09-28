/**
 * Per-browser minimum audible priority, kept in localStorage.
 *
 * Storage can be missing, blocked or full; every failure falls back to the
 * default so the console keeps sounding alerts.
 */

import { DEFAULT_MIN_AUDIBLE_PRIORITY } from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'

export const MIN_AUDIBLE_PRIORITY_KEY = 'signalk-alert-console.minAudiblePriority'

const VALID_VALUES: readonly string[] = [
  'off',
  'emergency',
  'alarm',
  'warning'
] satisfies MinAudiblePriority[]

function isMinAudiblePriority(value: string | null): value is MinAudiblePriority {
  return value !== null && VALID_VALUES.includes(value)
}

export function loadMinAudiblePriority(): MinAudiblePriority {
  try {
    const stored = localStorage.getItem(MIN_AUDIBLE_PRIORITY_KEY)
    return isMinAudiblePriority(stored) ? stored : DEFAULT_MIN_AUDIBLE_PRIORITY
  } catch {
    return DEFAULT_MIN_AUDIBLE_PRIORITY
  }
}

export function saveMinAudiblePriority(value: MinAudiblePriority): void {
  try {
    localStorage.setItem(MIN_AUDIBLE_PRIORITY_KEY, value)
  } catch {
    // The value still applies for this page session.
  }
}
