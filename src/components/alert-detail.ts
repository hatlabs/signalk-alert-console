/**
 * AlertDetail - Expanded view for a single alert.
 *
 * Shows full alert information, history timeline, and action buttons in a
 * modal dialog over the list. A press on the backdrop, Escape, the close
 * button, or the browser closing the dialog asks the parent, once, to close
 * it with alert-detail-close.
 * Uses AlertService for live alert updates and fetches history from REST API.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert, HistoryEntry, HistoryEventType } from '../types.js'
import {
  AlertService,
  acquireAlertService,
  releaseAlertService
} from '../services/alert-service.js'
import type { ApiError } from '../services/alert-service.js'
import {
  actionErrorStyles,
  renderActionError,
  renderLocalOnly,
  toApiError
} from './action-error.js'
import { ICON_ACKNOWLEDGE, ICON_DISMISS, ICON_SILENCE } from '../styles/icons.js'
import { priorityVars, PRIORITY_LABELS, STATE_LABELS, offersSilence } from '../styles/priority.js'
import { themeStyles } from '../styles/theme.js'
import { formatTime } from '../utils/format.js'
import { lifecycleOf } from '../utils/history.js'

/** Timeout before re-enabling buttons if no WebSocket update arrives. */
const ACTION_TIMEOUT_MS = 5000

/** Card colors while the alert is loading or not found. */
const NEUTRAL_COLORS = { color: 'var(--border-secondary)', background: 'var(--bg-primary)' }

const EVENT_TYPE_LABELS: Record<HistoryEventType, string> = {
  raise: 'Raised',
  acknowledge: 'Acknowledged',
  silence: 'Silenced',
  unsilence: 'Unsilenced',
  clear: 'Cleared',
  escalate: 'Escalated'
}

export class AlertDetail extends LitElement {
  static properties = {
    alertId: { type: String, attribute: 'alert-id' },
    alert: { state: true },
    history: { state: true },
    historyError: { state: true },
    error: { state: true },
    actionError: { state: true },
    actionInFlight: { state: true }
  }

  static styles = [
    themeStyles,
    actionErrorStyles,
    css`
      :host {
        display: block;
      }

      /* The dialog box is the panel itself, so a press whose target is the
         dialog landed on its backdrop. */
      dialog {
        box-sizing: border-box;
        width: min(44rem, 100vw - 3rem);
        max-width: none;
        max-height: calc(100vh - 3rem);
        max-height: calc(100dvh - 3rem);
        padding: 0;
        border: none;
        border-radius: 6px;
        background: var(--bg-primary);
        color: var(--text-primary);
        box-shadow: 0 12px 40px rgb(0 0 0 / 0.4);
        overflow: hidden;
      }

      dialog[open] {
        display: flex;
        flex-direction: column;
        animation: panel-in 140ms ease-out;
      }

      dialog::backdrop {
        background: rgb(0 0 0 / 0.55);
      }

      @keyframes panel-in {
        from {
          opacity: 0;
          transform: translateY(0.5rem);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        dialog[open] {
          animation: none;
        }
      }

      .panel {
        overflow-y: auto;
        overscroll-behavior: contain;
      }

      h2 {
        margin: 0;
        font: inherit;
      }

      .detail-card {
        border: 2px solid var(--priority-color, #666);
        border-radius: 6px;
        background: var(--priority-bg, #888);
        overflow: clip;
      }

      .header {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.75rem;
        border-bottom: 1px solid var(--border-primary);
        background: var(--priority-bg, #888);
      }

      .header-left {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        flex-wrap: wrap;
      }

      .priority {
        font-size: 0.75rem;
        font-weight: 700;
        text-transform: uppercase;
        color: var(--priority-color, #666);
      }

      .state {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        background: var(--badge-state-bg);
        color: var(--badge-state-text);
      }

      .group {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        background: var(--badge-group-bg);
        color: var(--badge-group-text);
      }

      .stale {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        background: var(--badge-stale-bg);
        color: var(--badge-stale-text);
      }

      .silenced {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        background: var(--badge-silenced-bg);
        color: var(--badge-silenced-text);
      }

      button[data-action='close'] {
        min-height: 44px;
        min-width: 44px;
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--btn-close-border);
        border-radius: 4px;
        background: var(--btn-close-bg);
        font-size: 0.8rem;
        cursor: pointer;
        touch-action: manipulation;
      }

      .body {
        padding: 0.75rem;
      }

      .message {
        font-size: 1rem;
        font-weight: 600;
        color: var(--text-primary);
        margin-bottom: 0.75rem;
      }

      .info-grid {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.25rem 0.75rem;
        font-size: 0.85rem;
        margin-bottom: 1rem;
      }

      .info-label {
        color: var(--text-muted);
        font-weight: 600;
      }

      .info-value {
        color: var(--text-secondary);
      }

      .source {
        color: var(--text-secondary);
      }

      .data {
        margin-bottom: 1rem;
      }

      .data-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-muted);
        margin-bottom: 0.25rem;
      }

      .data pre {
        background: var(--data-pre-bg);
        padding: 0.5rem;
        border-radius: 4px;
        font-size: 0.8rem;
        overflow-x: auto;
        max-height: 200px;
        overflow-y: auto;
        margin: 0;
      }

      .actions {
        display: flex;
        gap: 0.5rem;
        margin-bottom: 1rem;
      }

      .body > .action-error {
        margin: -0.5rem 0 1rem 0;
      }

      .actions button {
        min-height: 44px;
        min-width: 44px;
        padding: 0.375rem;
        border: 1px solid var(--btn-border);
        border-radius: 4px;
        background: var(--btn-bg);
        cursor: pointer;
        touch-action: manipulation;
        display: flex;
        align-items: center;
        justify-content: center;
      }

      .actions button svg {
        width: 20px;
        height: 20px;
        fill: currentColor;
      }

      .actions button:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      .actions button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .actions button[data-action='acknowledge'] {
        border-color: var(--btn-ack-border);
        color: var(--btn-ack-text);
      }

      .actions button[data-action='silence'] {
        border-color: var(--btn-silence-border);
        color: var(--btn-silence-text);
      }

      .actions button[data-action='dismiss'] {
        border-color: var(--btn-dismiss-border);
        color: var(--btn-dismiss-text);
      }

      .timeline-title {
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--text-secondary);
        margin-bottom: 0.5rem;
      }

      .timeline {
        border-left: 2px solid var(--timeline-border);
        padding-left: 1rem;
      }

      .timeline-entry {
        position: relative;
        margin-bottom: 0.75rem;
        padding-bottom: 0.75rem;
        border-bottom: 1px solid var(--timeline-entry-border);
      }

      .timeline-entry:last-child {
        border-bottom: none;
        margin-bottom: 0;
        padding-bottom: 0;
      }

      .timeline-entry::before {
        content: '';
        position: absolute;
        left: -1.35rem;
        top: 0.35rem;
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--timeline-dot);
      }

      .event-type {
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      .event-time {
        font-size: 0.75rem;
        color: var(--text-dim);
        margin-left: 0.5rem;
      }

      .event-details {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin-top: 0.125rem;
      }

      .timeline-empty {
        font-size: 0.85rem;
        color: var(--text-dim);
        font-style: italic;
      }

      .timeline-error {
        font-size: 0.85rem;
        color: var(--error-text);
        font-style: italic;
      }

      .error {
        color: var(--error-text);
      }

      .loading {
        color: var(--text-dim);
      }
    `
  ]

  declare alertId: string
  declare alert: Alert | null
  declare history: HistoryEntry[]
  declare historyError: boolean
  declare error: string | null
  /** Why the last action was refused, shown next to the actions. */
  declare actionError: ApiError | null
  declare actionInFlight: boolean

  private service!: AlertService
  private safetyTimer: ReturnType<typeof setTimeout> | null = null
  /** The page's overflow before the dialog locked it, restored on removal. */
  private savedPageOverflow: string | null = null
  /** Whether the current press began, and so far ended, on the backdrop rather than the panel. */
  private pressOnBackdrop = false
  /** Set once closing was asked for, so a later browser close does not ask again. */
  private closeRequested = false

  constructor() {
    super()
    this.alertId = ''
    this.alert = null
    this.history = []
    this.historyError = false
    this.error = null
    this.actionError = null
    this.actionInFlight = false
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service = acquireAlertService()
    this.service.addEventListener('change', this.onServiceChange)
    // Service connects on first acquire; change event will fire when ready
    this.onServiceChange()
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    releaseAlertService()
    this.clearSafetyTimer()
    if (this.savedPageOverflow !== null) {
      document.documentElement.style.overflow = this.savedPageOverflow
      this.savedPageOverflow = null
    }
  }

  protected firstUpdated(): void {
    this.renderRoot.querySelector('dialog')?.showModal()
    this.savedPageOverflow = document.documentElement.style.overflow
    document.documentElement.style.overflow = 'hidden'
    this.renderRoot.querySelector<HTMLElement>('button[data-action="close"]')?.focus()
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('alertId') && this.alertId) {
      void this.loadHistory()
    }
    // Reset actionInFlight when alert data changes (action completed)
    if (changed.has('alert') && this.alert) {
      const wasInFlight = this.actionInFlight
      this.actionInFlight = false
      this.clearSafetyTimer()
      // Refresh history if an action just completed
      if (wasInFlight) {
        void this.loadHistory()
      }
    }
  }

  private onServiceChange = (): void => {
    if (!this.alertId) return
    const alerts = this.service.getAlerts()
    const match = alerts.find((a) => a.id === this.alertId)
    if (match) {
      // A delta for the alert makes a refusal shown for it stale.
      if (match !== this.alert) this.actionError = null
      this.alert = match
      this.error = null
    } else if (this.alert && this.alert.state !== 'normal') {
      // The alert cleared while shown. Mark it cleared now so a failed
      // history fetch cannot leave its actions live; history then refines it.
      this.alert = { ...this.alert, state: 'normal', condition: false }
      void this.loadHistory()
    }
  }

  // Opening the view and the alert clearing both load history; only the latest request may apply.
  private historySeq = 0

  private async loadHistory(): Promise<void> {
    const seq = ++this.historySeq
    this.historyError = false
    try {
      const result = await AlertService.fetchHistory({ alertId: this.alertId })
      if (seq !== this.historySeq) return
      this.history = result.entries

      // An alert no longer in the active list is rebuilt from its history
      const live = this.service.getAlerts().some((a) => a.id === this.alertId)
      if (!live && result.entries.length > 0) {
        this.alert = this.reconstructAlertFromHistory(result.entries)
      } else if (!this.alert) {
        this.error = 'Alert not found'
      }
    } catch {
      if (seq !== this.historySeq) return
      this.historyError = true
      if (!this.alert) {
        this.error = 'Alert not found'
      }
    }
  }

  /**
   * Reconstruct a minimal Alert from history entries for cleared alerts,
   * using the snapshot each entry carries.
   */
  private reconstructAlertFromHistory(entries: HistoryEntry[]): Alert {
    const { raise, clear, ack } = lifecycleOf(entries)
    const byTime = [...entries].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
    const earliest = byTime[0]
    const latest = byTime[byTime.length - 1]

    // The ending clear carries the final (possibly escalated) snapshot.
    const snapshot = clear ?? latest

    return {
      id: this.alertId,
      path: snapshot.path,
      $source: snapshot.$source,
      priority: snapshot.priority,
      state: 'normal',
      condition: false,
      latching: false,
      silenced: false,
      message: snapshot.message,
      raisedAt: raise?.timestamp ?? earliest.timestamp,
      stateChangedAt: clear?.timestamp ?? latest.timestamp,
      clearedAt: clear?.timestamp,
      acknowledgedAt: ack?.timestamp,
      acknowledgedBy: ack?.userId,
      sourceOnline: false,
      lastSourceUpdate: latest.timestamp,
      stale: false
    }
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  /**
   * The one close path: Close, backdrop, Escape, cancel, and a browser close
   * without cancel (Chrome's close watcher) all ask the parent once.
   */
  private onClose(): void {
    if (this.closeRequested) return
    this.closeRequested = true
    this.dispatchEvent(new CustomEvent('alert-detail-close', { bubbles: true, composed: true }))
  }

  private onPointerDown(e: PointerEvent): void {
    this.pressOnBackdrop = e.target === e.currentTarget
  }

  private onPointerUp(e: PointerEvent): void {
    this.pressOnBackdrop &&= e.target === e.currentTarget
  }

  /**
   * Only a press that starts and ends on the backdrop closes. A drag between
   * backdrop and panel clicks their common ancestor, the dialog, so the click
   * target alone cannot tell.
   */
  private onDialogClick(e: MouseEvent): void {
    const onBackdrop = this.pressOnBackdrop && e.target === e.currentTarget
    this.pressOnBackdrop = false
    if (onBackdrop) this.onClose()
  }

  /** The parent owns closing, so Escape and the browser's own cancel both go through it. */
  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return
    e.preventDefault()
    this.onClose()
  }

  private onCancel(e: Event): void {
    e.preventDefault()
    this.onClose()
  }

  /** A new attempt clears the last error; a refusal re-enables the buttons at once. */
  private runAction(action: () => Promise<void>): void {
    this.actionError = null
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, ACTION_TIMEOUT_MS)
    action().catch((error: unknown) => {
      this.clearSafetyTimer()
      this.actionInFlight = false
      this.actionError = toApiError(error)
    })
  }

  private onAcknowledge(): void {
    this.runAction(() => this.service.acknowledgeAlert(this.alertId))
  }

  private onSilence(): void {
    this.runAction(() => this.service.silenceAlert(this.alertId))
  }

  private onDismiss(): void {
    this.runAction(() => this.service.dismissAlert(this.alertId))
  }

  render() {
    const colors = this.alert ? priorityVars(this.alert.priority) : NEUTRAL_COLORS
    // One header and close button in every state, so focus placed on the
    // button at open survives the alert arriving.
    return html`<dialog
      aria-modal="true"
      aria-labelledby="detail-title"
      @pointerdown=${this.onPointerDown}
      @pointerup=${this.onPointerUp}
      @click=${this.onDialogClick}
      @keydown=${this.onKeyDown}
      @cancel=${this.onCancel}
      @close=${this.onClose}
    >
      <div class="panel">
        <div
          class="detail-card"
          style="--priority-color: ${colors.color}; --priority-bg: ${colors.background}"
        >
          <div class="header">
            <div class="header-left">
              ${this.alert && !this.error ? this.renderBadges(this.alert) : nothing}
            </div>
            <button data-action="close" aria-label="Close details" @click=${this.onClose}>
              Close
            </button>
          </div>
          ${
            this.error
              ? html`<div class="body error"><h2 id="detail-title">${this.error}</h2></div>`
              : this.alert
                ? this.renderBody(this.alert)
                : html`<div class="body loading"><h2 id="detail-title">Loading...</h2></div>`
          }
        </div>
      </div>
    </dialog>`
  }

  private renderBadges(alert: Alert) {
    return html`<span class="priority">${PRIORITY_LABELS[alert.priority]}</span>
      <span class="state">${STATE_LABELS[alert.state]}</span>
      ${alert.group ? html`<span class="group">${alert.group}</span>` : nothing}
      ${alert.stale ? html`<span class="stale">Stale</span>` : nothing}
      ${alert.silenced ? html`<span class="silenced">Silenced</span>` : nothing}`
  }

  private renderBody(alert: Alert) {
    const isUnacked = alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
    const showAck = isUnacked
    const showSilence = offersSilence(alert)
    // Caution never returns to normal on acknowledgement, so a source that
    // never retracts its condition needs an operator exit (issue #99).
    // Alerts reconstructed from history are already cleared ('normal').
    const showDismiss = alert.priority === 'caution' && alert.state !== 'normal'

    return html`
      <div class="body">
        <h2 id="detail-title" class="message">${alert.message}</h2>

        <div class="info-grid">
          <span class="info-label">Path</span>
          <span class="info-value">${alert.path}</span>
          <span class="info-label">Source</span>
          <span class="info-value source">${alert.$source}</span>
          <span class="info-label">Raised</span>
          <span class="info-value">${formatTime(alert.raisedAt)}</span>
          ${
            alert.acknowledgedAt
              ? html`
                  <span class="info-label">Acknowledged</span>
                  <span class="info-value">${formatTime(alert.acknowledgedAt)}</span>
                `
              : nothing
          }
          ${
            alert.acknowledgedBy
              ? html`
                  <span class="info-label">Acknowledged by</span>
                  <span class="info-value">${alert.acknowledgedBy}</span>
                `
              : nothing
          }
          ${
            alert.clearedAt
              ? html`
                  <span class="info-label">Cleared</span>
                  <span class="info-value">${formatTime(alert.clearedAt)}</span>
                `
              : nothing
          }
          <span class="info-label">Source online</span>
          <span class="info-value">${alert.sourceOnline ? 'Yes' : 'No'}</span>
          <span class="info-label">Last update</span>
          <span class="info-value">${formatTime(alert.lastSourceUpdate)}</span>
        </div>

        ${
          alert.data && Object.keys(alert.data).length > 0
            ? html`
                <div class="data">
                  <div class="data-title">Data</div>
                  <pre>${JSON.stringify(alert.data, null, 2)}</pre>
                </div>
              `
            : nothing
        }
        ${
          showAck || showSilence || showDismiss
            ? html`
                <div class="actions">
                  ${
                    showSilence
                      ? html`<button
                          data-action="silence"
                          title="Silence"
                          aria-label="Silence: ${alert.message}"
                          ?disabled=${this.actionInFlight}
                          @click=${this.onSilence}
                        >
                          <svg viewBox="0 0 24 24"><path d=${ICON_SILENCE} /></svg>
                        </button>`
                      : nothing
                  }
                  ${
                    showAck
                      ? html`<button
                          data-action="acknowledge"
                          title="Acknowledge"
                          aria-label="Acknowledge: ${alert.message}"
                          ?disabled=${this.actionInFlight}
                          @click=${this.onAcknowledge}
                        >
                          <svg viewBox="0 0 24 24"><path d=${ICON_ACKNOWLEDGE} /></svg>
                        </button>`
                      : nothing
                  }
                  ${
                    showDismiss
                      ? html`<button
                          data-action="dismiss"
                          title="Dismiss"
                          aria-label="Dismiss: ${alert.message}"
                          ?disabled=${this.actionInFlight}
                          @click=${this.onDismiss}
                        >
                          <svg viewBox="0 0 24 24"><path d=${ICON_DISMISS} /></svg>
                        </button>`
                      : nothing
                  }
                </div>
              `
            : nothing
        }
        ${this.service.isLocalOnly(this.alertId) ? renderLocalOnly() : nothing}
        ${this.actionError ? renderActionError(this.actionError, this.service.signInUrl) : nothing}

        <div class="timeline-title">History</div>
        ${
          this.historyError
            ? html`<div class="timeline-error">Failed to load history</div>`
            : this.history.length === 0
              ? html`<div class="timeline-empty">No history available</div>`
              : html`
                  <div class="timeline" role="list">
                    ${this.history.map(
                      (entry) => html`
                        <div class="timeline-entry" role="listitem">
                          <span class="event-type">${EVENT_TYPE_LABELS[entry.eventType]}</span>
                          <span class="event-time">${formatTime(entry.timestamp)}</span>
                          ${this.renderEventDetails(entry)}
                        </div>
                      `
                    )}
                  </div>
                `
        }
      </div>
    `
  }

  private renderEventDetails(entry: HistoryEntry) {
    const parts: string[] = []

    if (entry.userId) {
      parts.push(`by ${entry.userId}`)
    }

    if (entry.eventType === 'escalate' && entry.previousPriority && entry.newPriority) {
      parts.push(
        `${PRIORITY_LABELS[entry.previousPriority]} → ${PRIORITY_LABELS[entry.newPriority]}`
      )
    }

    if (entry.previousState && entry.newState) {
      parts.push(`${STATE_LABELS[entry.previousState]} → ${STATE_LABELS[entry.newState]}`)
    }

    if (parts.length === 0) {
      return nothing
    }

    return html`<div class="event-details">${parts.join(' — ')}</div>`
  }
}

customElements.define('alert-detail', AlertDetail)
