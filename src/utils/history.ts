/**
 * Alert lifecycles reconstructed from history entries.
 */

import type { HistoryEntry, AlertPriority } from '../types.js'

/** Reconstructed alert lifecycle from paired raise/clear history entries. */
export interface HistoryRecord {
  alertId: string
  message: string
  priority: AlertPriority
  path: string
  raisedAt: string
  clearedAt: string
  acknowledgedBy?: string
}

/**
 * The raise that opened an alert, the clear that ended it, and its latest
 * acknowledgement, whatever order the entries arrive in.
 *
 * One alert id logs a raise on every re-annunciation and a clear whenever its
 * condition clears, even when the alert stays active awaiting acknowledgement.
 * Only the clear into `normal` ends the alert.
 */
export function lifecycleOf(entries: HistoryEntry[]): {
  raise?: HistoryEntry
  clear?: HistoryEntry
  ack?: HistoryEntry
} {
  let raise: HistoryEntry | undefined
  let clear: HistoryEntry | undefined
  let ack: HistoryEntry | undefined
  for (const entry of entries) {
    if (entry.eventType === 'raise' && (!raise || isBefore(entry, raise))) {
      raise = entry
    } else if (
      entry.eventType === 'clear' &&
      entry.newState === 'normal' &&
      (!clear || isBefore(clear, entry))
    ) {
      clear = entry
    }
    // Core logs an acknowledgement that ends the alert as a clear carrying the
    // acknowledging userId; condition and displacement clears carry none.
    const acknowledges =
      entry.eventType === 'acknowledge' || (entry.eventType === 'clear' && entry.userId)
    if (acknowledges && (!ack || isBefore(ack, entry))) {
      ack = entry
    }
  }
  return { raise, clear, ack }
}

function isBefore(a: HistoryEntry, b: HistoryEntry): boolean {
  return new Date(a.timestamp).getTime() < new Date(b.timestamp).getTime()
}

/**
 * Build HistoryRecords from raw history entries, one per ended alert.
 *
 * Message, priority and path come from the clear that ended the alert, which
 * core writes with the final (possibly escalated) snapshot. The earliest
 * raise only dates the record.
 */
export function buildHistoryRecords(entries: HistoryEntry[]): HistoryRecord[] {
  const byAlert = new Map<string, HistoryEntry[]>()
  for (const entry of entries) {
    const list = byAlert.get(entry.alertId)
    if (list) list.push(entry)
    else byAlert.set(entry.alertId, [entry])
  }

  const records: HistoryRecord[] = []

  for (const [alertId, alertEntries] of byAlert) {
    const { raise, clear, ack } = lifecycleOf(alertEntries)
    if (!clear) continue

    records.push({
      alertId,
      message: clear.message,
      priority: clear.priority,
      path: clear.path,
      raisedAt: raise?.timestamp ?? clear.timestamp,
      clearedAt: clear.timestamp,
      acknowledgedBy: ack?.userId
    })
  }

  // Sort by cleared time, newest first
  records.sort((a, b) => new Date(b.clearedAt).getTime() - new Date(a.clearedAt).getTime())

  return records
}
