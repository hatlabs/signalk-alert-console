/**
 * AlertHistoryCard - Displays a cleared alert from history.
 *
 * Shows priority color bar, message, raised/cleared timestamps,
 * duration, and acknowledgment info. Clicking dispatches alert-select.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { HistoryEntry, AlertPriority } from '../types.js'
import { priorityVars, PRIORITY_LABELS } from '../styles/priority.js'
import { themeStyles } from '../styles/theme.js'
import { formatTime, formatDuration } from '../utils/format.js'

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
 * Message, priority and path come from the raise entry's snapshot, or from
 * the clear entry when the raise is outside the loaded entries.
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

    const snapshot = raise ?? clear

    records.push({
      alertId,
      message: snapshot.message,
      priority: snapshot.priority,
      path: snapshot.path,
      raisedAt: raise?.timestamp ?? clear.timestamp,
      clearedAt: clear.timestamp,
      acknowledgedBy: ack?.userId
    })
  }

  // Sort by cleared time, newest first
  records.sort((a, b) => new Date(b.clearedAt).getTime() - new Date(a.clearedAt).getTime())

  return records
}

export class AlertHistoryCard extends LitElement {
  static properties = {
    record: { type: Object }
  }

  static styles = [
    themeStyles,
    css`
      :host {
        display: block;
      }

      .card {
        display: flex;
        align-items: stretch;
        border: 1px solid var(--history-card-border);
        border-radius: 6px;
        background: var(--history-card-bg);
        margin-bottom: 0.5rem;
        overflow: hidden;
        cursor: pointer;
      }

      .card:hover {
        background: var(--bg-hover);
      }

      .priority-bar {
        width: 6px;
        flex-shrink: 0;
        background: var(--priority-color, #666);
      }

      .content {
        flex: 1;
        padding: 0.75rem;
        min-width: 0;
      }

      .header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 0.25rem;
        flex-wrap: wrap;
      }

      .priority {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--priority-color, #666);
      }

      .message {
        font-size: 0.9rem;
        color: var(--text-primary);
        margin-bottom: 0.375rem;
      }

      .meta {
        font-size: 0.75rem;
        color: var(--text-dim);
        display: flex;
        flex-wrap: wrap;
        gap: 0.25rem 1rem;
      }

      .meta-label {
        color: var(--history-label-color);
      }
    `
  ]

  declare record: HistoryRecord

  private onClick(): void {
    this.dispatchEvent(
      new CustomEvent('alert-select', {
        detail: { id: this.record.alertId },
        bubbles: true,
        composed: true
      })
    )
  }

  render() {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- unset until the parent binds it
    if (!this.record) return nothing

    const colors = priorityVars(this.record.priority)
    const durationMs =
      new Date(this.record.clearedAt).getTime() - new Date(this.record.raisedAt).getTime()

    return html`
      <div class="card" style="--priority-color: ${colors.color}" @click=${this.onClick}>
        <div class="priority-bar"></div>
        <div class="content">
          <div class="header">
            <span class="priority">${PRIORITY_LABELS[this.record.priority]}</span>
          </div>
          <div class="message">${this.record.message}</div>
          <div class="meta">
            <span><span class="meta-label">Raised:</span> ${formatTime(this.record.raisedAt)}</span>
            <span
              ><span class="meta-label">Cleared:</span> ${formatTime(this.record.clearedAt)}</span
            >
            <span><span class="meta-label">Duration:</span> ${formatDuration(durationMs)}</span>
            ${
              this.record.acknowledgedBy
                ? html`<span
                    ><span class="meta-label">Acked by:</span> ${this.record.acknowledgedBy}</span
                  >`
                : nothing
            }
          </div>
        </div>
      </div>
    `
  }
}

customElements.define('alert-history-card', AlertHistoryCard)
