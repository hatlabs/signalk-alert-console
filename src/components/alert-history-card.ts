/**
 * AlertHistoryCard - Displays a cleared alert from history.
 *
 * Shows priority color bar, group, message, raised/cleared timestamps,
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
  group?: string
  raisedAt: string
  clearedAt: string
  acknowledgedBy?: string
}

/**
 * Build HistoryRecords from raw history entries.
 *
 * Groups entries by alertId, pairing the latest raise with the latest clear.
 * Falls back gracefully when snapshot data is missing (old entries).
 */
export function buildHistoryRecords(entries: HistoryEntry[]): HistoryRecord[] {
  const byAlert = new Map<
    string,
    { raises: HistoryEntry[]; clears: HistoryEntry[]; acks: HistoryEntry[] }
  >()

  for (const entry of entries) {
    let group = byAlert.get(entry.alertId)
    if (!group) {
      group = { raises: [], clears: [], acks: [] }
      byAlert.set(entry.alertId, group)
    }
    if (entry.eventType === 'raise') group.raises.push(entry)
    else if (entry.eventType === 'clear') group.clears.push(entry)
    else if (entry.eventType === 'acknowledge') group.acks.push(entry)
  }

  const records: HistoryRecord[] = []

  for (const [alertId, group] of byAlert) {
    if (group.clears.length === 0) continue

    const clear = group.clears[group.clears.length - 1]
    const raise = group.raises.length > 0 ? group.raises[0] : undefined

    // Extract snapshot from raise or clear details
    const details = (raise?.details ?? clear.details) as
      | { message?: string; priority?: AlertPriority; group?: string }
      | undefined

    records.push({
      alertId,
      message: details?.message ?? 'Unknown alert',
      priority: details?.priority ?? 'caution',
      group: details?.group,
      raisedAt: raise?.timestamp ?? clear.timestamp,
      clearedAt: clear.timestamp,
      acknowledgedBy: group.acks.length > 0 ? group.acks[group.acks.length - 1].userId : undefined
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

      .group {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        background: var(--badge-group-bg);
        color: var(--badge-group-text);
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
            ${this.record.group ? html`<span class="group">${this.record.group}</span>` : nothing}
          </div>
          <div class="message">${this.record.message}</div>
          <div class="meta">
            <span><span class="meta-label">Raised:</span> ${formatTime(this.record.raisedAt)}</span>
            <span
              ><span class="meta-label">Cleared:</span> ${formatTime(this.record.clearedAt)}</span
            >
            <span><span class="meta-label">Duration:</span> ${formatDuration(durationMs)}</span>
            ${this.record.acknowledgedBy
              ? html`<span
                  ><span class="meta-label">Acked by:</span> ${this.record.acknowledgedBy}</span
                >`
              : nothing}
          </div>
        </div>
      </div>
    `
  }
}

customElements.define('alert-history-card', AlertHistoryCard)
