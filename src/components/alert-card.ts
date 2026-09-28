/**
 * AlertCard - Individual alert display component.
 *
 * Shows priority color bar, message, state badge, group tag,
 * time since raised, and stale indicator.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../types.js'
import { ICON_ACKNOWLEDGE, ICON_DISMISS, ICON_SILENCE } from '../styles/icons.js'
import { priorityVars, PRIORITY_LABELS, STATE_LABELS, offersSilence } from '../styles/priority.js'
import { themeStyles } from '../styles/theme.js'
import { formatTime } from '../utils/format.js'
import type { ApiError } from '../services/alert-service.js'
import { actionErrorStyles, renderActionError, renderLocalOnly } from './action-error.js'

/** Timeout before re-enabling buttons if no WebSocket update arrives. */
const ACTION_TIMEOUT_MS = 5000

export class AlertCard extends LitElement {
  static properties = {
    alert: { type: Object },
    actionError: { attribute: false },
    signInUrl: { attribute: false },
    localOnly: { attribute: false },
    actionInFlight: { state: true }
  }

  static styles = [
    themeStyles,
    actionErrorStyles,
    css`
      :host {
        display: block;
      }

      .card {
        display: flex;
        align-items: stretch;
        border: 2px solid var(--priority-color, #666);
        border-radius: 6px;
        background: var(--priority-bg, #888);
        margin-bottom: 0.5rem;
        overflow: hidden;
      }

      .priority-bar {
        width: 6px;
        flex-shrink: 0;
        background: var(--priority-color, #666);
      }

      .card.flashing .priority-bar {
        animation: bar-pulse 1s ease-in-out infinite;
      }

      @keyframes bar-pulse {
        0%,
        100% {
          opacity: 1;
        }
        50% {
          opacity: 0.2;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .card.flashing .priority-bar {
          animation: none;
        }
      }

      .main {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
      }

      .content {
        flex: 1;
        padding: 0.75rem;
        cursor: pointer;
      }

      /* Outside the selectable summary, so its links are ordinary links. */
      .outcome {
        padding: 0 0.75rem 0.75rem;
        margin-top: -0.75rem;
      }

      .content:focus-visible {
        outline: 3px solid var(--link-text);
        outline-offset: -3px;
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

      .message {
        font-size: 0.9rem;
        color: var(--text-primary);
        margin-bottom: 0.25rem;
      }

      .time {
        font-size: 0.75rem;
        color: var(--text-dim);
      }

      .silenced {
        font-size: 0.7rem;
        padding: 0.125rem 0.375rem;
        border-radius: 3px;
        background: var(--badge-silenced-bg);
        color: var(--badge-silenced-text);
      }

      .actions {
        display: flex;
        flex-direction: row;
        gap: 0.375rem;
        padding: 0.75rem;
        align-items: center;
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

      @media (max-width: 480px) {
        .card {
          flex-wrap: wrap;
        }

        .actions {
          flex-direction: row;
          width: 100%;
          padding: 0 0.75rem 0.75rem;
        }

        .actions button {
          flex: 1;
        }
      }
    `
  ]

  declare alert: Alert
  /** Why the last action on this alert was refused; set by the list. */
  declare actionError: ApiError | null
  declare signInUrl: string
  /** Acknowledged or silenced on this display only; set by the list. */
  declare localOnly: boolean
  declare actionInFlight: boolean

  private safetyTimer: ReturnType<typeof setTimeout> | null = null

  constructor() {
    super()
    this.actionInFlight = false
    this.actionError = null
    this.signInUrl = ''
    this.localOnly = false
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.clearSafetyTimer()
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('alert') || (changed.has('actionError') && this.actionError)) {
      this.actionInFlight = false
      this.clearSafetyTimer()
    }
  }

  private clearSafetyTimer(): void {
    if (this.safetyTimer !== null) {
      clearTimeout(this.safetyTimer)
      this.safetyTimer = null
    }
  }

  private startAction(eventName: string): void {
    this.actionInFlight = true
    this.safetyTimer = setTimeout(() => {
      this.actionInFlight = false
    }, ACTION_TIMEOUT_MS)
    this.dispatchEvent(
      new CustomEvent(eventName, {
        detail: { id: this.alert.id },
        bubbles: true,
        composed: true
      })
    )
  }

  private onAcknowledge(): void {
    this.startAction('alert-acknowledge')
  }

  private onSilence(): void {
    this.startAction('alert-silence')
  }

  private onDismiss(): void {
    this.startAction('alert-dismiss')
  }

  /** Focus lands on the area that opens the detail, so it can return there on close. */
  focus(options?: FocusOptions): void {
    this.renderRoot.querySelector<HTMLElement>('.content')?.focus(options)
  }

  private onSelectKey(e: KeyboardEvent): void {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    this.onSelect()
  }

  private onSelect(): void {
    this.dispatchEvent(
      new CustomEvent('alert-select', {
        detail: { id: this.alert.id },
        bubbles: true,
        composed: true
      })
    )
  }

  render() {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- unset until the parent binds it
    if (!this.alert) {
      return nothing
    }

    const colors = priorityVars(this.alert.priority)
    const isUnacked =
      this.alert.state === 'unacknowledged' || this.alert.state === 'rtn-unacknowledged'
    const showAck = isUnacked
    const showSilence = offersSilence(this.alert)
    // Caution never returns to normal on acknowledgement, so a source that
    // never retracts its condition needs an operator exit (issue #99).
    const showDismiss = this.alert.priority === 'caution' && this.alert.state !== 'normal'
    const hasActions = showAck || showSilence || showDismiss

    return html`
      <div
        class="card ${isUnacked ? 'flashing' : ''}"
        style="--priority-color: ${colors.color}; --priority-bg: ${colors.background}"
      >
        <div class="priority-bar"></div>
        <div class="main">
          <div
            class="content"
            role="button"
            tabindex="0"
            @click=${this.onSelect}
            @keydown=${this.onSelectKey}
          >
            <div class="header">
              <span class="priority">${PRIORITY_LABELS[this.alert.priority]}</span>
              <span class="state">${STATE_LABELS[this.alert.state]}</span>
              ${this.alert.group ? html`<span class="group">${this.alert.group}</span>` : nothing}
              ${this.alert.stale ? html`<span class="stale">Stale</span>` : nothing}
              ${this.alert.silenced ? html`<span class="silenced">Silenced</span>` : nothing}
            </div>
            <div class="message">${this.alert.message}</div>
            <div class="time">${formatTime(this.alert.raisedAt)}</div>
          </div>
          ${
            this.localOnly || this.actionError
              ? html`<div class="outcome">
                  ${this.localOnly ? renderLocalOnly() : nothing}
                  ${
                    this.actionError ? renderActionError(this.actionError, this.signInUrl) : nothing
                  }
                </div>`
              : nothing
          }
        </div>
        ${
          hasActions
            ? html`
                <div class="actions">
                  ${
                    showSilence
                      ? html`<button
                          data-action="silence"
                          title="Silence"
                          aria-label="Silence: ${this.alert.message}"
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
                          aria-label="Acknowledge: ${this.alert.message}"
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
                          aria-label="Dismiss: ${this.alert.message}"
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
      </div>
    `
  }
}

customElements.define('alert-card', AlertCard)
