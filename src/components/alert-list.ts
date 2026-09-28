/**
 * AlertList - Main alert list component.
 *
 * Connects to AlertService for real-time data and renders alert-card
 * elements for each alert.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../types.js'
import { acquireAlertService, releaseAlertService } from '../services/alert-service.js'
import type { AlertService, ApiError } from '../services/alert-service.js'
import { themeStyles } from '../styles/theme.js'
import { acquireAudioService, releaseAudioService } from '../services/audio-service.js'
import type { AudioService } from '../services/audio-service.js'
import {
  DEFAULT_MIN_AUDIBLE_PRIORITY,
  MIN_AUDIBLE_PRIORITIES,
  isMinAudiblePriority
} from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'
import { ICON_SILENCE } from '../styles/icons.js'
import { actionErrorStyles, renderActionError, toApiError } from './action-error.js'

type ViewMode = 'active' | 'history'

const SOUND_LABELS: Record<MinAudiblePriority, string> = {
  off: 'Off (no sound)',
  emergency: 'Emergency only',
  alarm: 'Alarm and above',
  warning: 'Warning and above'
}

export class AlertList extends LitElement {
  static properties = {
    alerts: { state: true },
    minAudiblePriority: { attribute: false },
    viewMode: { state: true },
    actionErrors: { state: true },
    silenceAllError: { state: true }
  }

  static styles = [
    themeStyles,
    actionErrorStyles,
    css`
      :host {
        display: block;
      }

      .toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        margin-bottom: 1rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid var(--border-primary);
      }

      .alert-count {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      button[data-action='silence-all'] {
        min-height: 44px;
        min-width: 44px;
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--btn-silence-all-border);
        border-radius: 4px;
        background: var(--btn-silence-all-bg);
        color: var(--btn-silence-all-text);
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
        white-space: nowrap;
      }

      button[data-action='silence-all']:hover:not(:disabled) {
        background: var(--btn-silence-all-hover);
      }

      button[data-action='silence-all']:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .toolbar-status {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
      }

      .sound-off {
        display: inline-flex;
        align-items: center;
        gap: 0.25rem;
        padding: 0.125rem 0.5rem;
        border-radius: 3px;
        background: var(--badge-stale-bg);
        color: var(--badge-stale-text);
        font-size: 0.8rem;
        font-weight: 600;
        white-space: nowrap;
      }

      .sound-off svg {
        width: 16px;
        height: 16px;
        fill: currentColor;
      }

      .toolbar-actions {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
      }

      .toolbar-actions .action-error {
        flex-basis: 100%;
        margin-top: 0;
        text-align: right;
      }

      .sound-setting {
        display: flex;
        align-items: center;
        gap: 0.375rem;
        font-size: 0.8rem;
        font-weight: 600;
        color: var(--text-secondary);
      }

      .sound-setting select {
        min-height: 44px;
        padding: 0.375rem 0.5rem;
        border: 1px solid var(--btn-border);
        border-radius: 4px;
        background: var(--btn-bg);
        color: var(--text-primary);
        font: inherit;
        cursor: pointer;
        touch-action: manipulation;
      }

      .view-toggle {
        display: flex;
        margin-bottom: 1rem;
        background: var(--toggle-bg);
        border-radius: 6px;
        padding: 3px;
      }

      .view-toggle button {
        flex: 1;
        min-height: 36px;
        border: none;
        border-radius: 4px;
        font-size: 0.85rem;
        font-weight: 600;
        cursor: pointer;
        background: var(--toggle-inactive-bg);
        color: var(--toggle-inactive-text);
        touch-action: manipulation;
      }

      .view-toggle button.active {
        background: var(--toggle-active-bg);
        color: var(--toggle-active-text);
      }

      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--text-dim);
        font-size: 0.9rem;
      }

      .list {
        display: flex;
        flex-direction: column;
      }

      .group-separator {
        height: 0;
        border: none;
        border-top: 1px solid var(--border-secondary);
        margin: 0.5rem 0;
      }
    `
  ]

  declare alerts: Alert[]
  /** This display's sound threshold; the app owns it and hears of changes. */
  declare minAudiblePriority: MinAudiblePriority
  declare viewMode: ViewMode
  /** Why the last action on an alert was refused, by alert id. */
  declare actionErrors: ReadonlyMap<string, ApiError>
  declare silenceAllError: ApiError | null

  private service!: AlertService
  private audioService!: AudioService

  constructor() {
    super()
    this.alerts = []
    this.minAudiblePriority = DEFAULT_MIN_AUDIBLE_PRIORITY
    this.viewMode = 'active'
    this.actionErrors = new Map()
    this.silenceAllError = null
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service = acquireAlertService()
    this.audioService = acquireAudioService()
    this.service.addEventListener('change', this.onServiceChange)
    this.addEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.addEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.addEventListener('alert-dismiss', this.onAlertDismiss as EventListener)
    // Service connects on first acquire; change event will fire when ready
    this.onServiceChange()
  }

  protected updated(): void {
    // Set on the select after render rather than per option: happy-dom drops
    // the selected state of an option that a nested template inserts.
    const select = this.renderRoot.querySelector<HTMLSelectElement>('select[data-setting="sound"]')
    if (select && select.value !== this.minAudiblePriority) {
      select.value = this.minAudiblePriority
    }
  }

  private onSoundChange(e: Event): void {
    const value = (e.target as HTMLSelectElement).value
    if (!isMinAudiblePriority(value)) return
    this.dispatchEvent(
      new CustomEvent('sound-threshold-change', {
        detail: { value },
        bubbles: true,
        composed: true
      })
    )
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    this.removeEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.removeEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.removeEventListener('alert-dismiss', this.onAlertDismiss as EventListener)
    releaseAlertService()
    releaseAudioService()
  }

  private onServiceChange = (): void => {
    const alerts = this.service.getAlerts()
    this.clearErrorsOfChangedAlerts(alerts)
    this.alerts = alerts
    this.audioService.update(alerts)
  }

  /** A delta replaces an alert's object; the error shown for it is then stale. */
  private clearErrorsOfChangedAlerts(alerts: Alert[]): void {
    if (this.actionErrors.size === 0) return
    const before = new Map(this.alerts.map((a) => [a.id, a]))
    const now = new Map(alerts.map((a) => [a.id, a]))
    const kept = new Map(
      [...this.actionErrors].filter(([id]) => now.has(id) && now.get(id) === before.get(id))
    )
    if (kept.size !== this.actionErrors.size) {
      this.actionErrors = kept
    }
  }

  private setActionError(id: string, error: ApiError | null): void {
    const next = new Map(this.actionErrors)
    if (error) {
      next.set(id, error)
    } else if (!next.delete(id)) {
      return
    }
    this.actionErrors = next
  }

  /** A new attempt clears the alert's last error; a refusal shows on its card. */
  private runAction(id: string, action: () => Promise<void>): void {
    this.setActionError(id, null)
    action().catch((error: unknown) => {
      this.setActionError(id, toApiError(error))
    })
  }

  private onAlertAcknowledge = (e: CustomEvent<{ id: string }>): void => {
    const { id } = e.detail
    this.runAction(id, () => this.service.acknowledgeAlert(id))
  }

  private onAlertSilence = (e: CustomEvent<{ id: string }>): void => {
    const { id } = e.detail
    this.runAction(id, () => this.service.silenceAlert(id))
  }

  private onAlertDismiss = (e: CustomEvent<{ id: string }>): void => {
    const { id } = e.detail
    this.runAction(id, () => this.service.dismissAlert(id))
  }

  /** Check all alerts — silence-all is a global action. */
  private hasUnsilencedUnacknowledged(): boolean {
    return this.service
      .getAlerts()
      .some(
        (a) => (a.state === 'unacknowledged' || a.state === 'rtn-unacknowledged') && !a.silenced
      )
  }

  private onSilenceAll(): void {
    this.silenceAllError = null
    this.service.silenceAll().catch((error: unknown) => {
      this.silenceAllError = toApiError(error)
    })
  }

  private isUnacked(alert: Alert): boolean {
    return alert.state === 'unacknowledged' || alert.state === 'rtn-unacknowledged'
  }

  // Assumes alerts are sorted with all unacked states before acknowledged,
  // per IMO MSC.302(87) default sort (enforced by applySort in alert-service).
  private renderAlertList() {
    const separatorIndex = this.alerts.findIndex(
      (a, i) => !this.isUnacked(a) && i > 0 && this.isUnacked(this.alerts[i - 1])
    )

    return this.alerts.map(
      (alert, i) => html`
        ${i === separatorIndex ? html`<hr class="group-separator" />` : nothing}
        <alert-card
          .alert=${alert}
          .actionError=${this.actionErrors.get(alert.id) ?? null}
          .signInUrl=${this.service.signInUrl}
          .localOnly=${this.service.isLocalOnly(alert.id)}
        ></alert-card>
      `
    )
  }

  private setViewMode(mode: ViewMode): void {
    this.viewMode = mode
  }

  private renderActiveView() {
    return html`
      <div class="toolbar">
        <div class="toolbar-status">
          <span class="alert-count"
            >${String(this.alerts.length)} alert${this.alerts.length !== 1 ? 's' : ''}</span
          >
          ${
            this.minAudiblePriority === 'off'
              ? html`<span class="sound-off" role="status">
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d=${ICON_SILENCE} /></svg>
                  Sound off
                </span>`
              : nothing
          }
        </div>
        <div class="toolbar-actions">
          <div class="sound-setting">
            <label for="sound-threshold">Sound:</label>
            <select
              id="sound-threshold"
              data-setting="sound"
              aria-label="Minimum priority that sounds"
              @change=${this.onSoundChange}
            >
              ${MIN_AUDIBLE_PRIORITIES.map(
                (value) => html`<option value=${value}>${SOUND_LABELS[value]}</option>`
              )}
            </select>
          </div>
          <button
            data-action="silence-all"
            ?disabled=${!this.hasUnsilencedUnacknowledged()}
            @click=${this.onSilenceAll}
          >
            Silence All
          </button>
          ${
            this.silenceAllError
              ? renderActionError(this.silenceAllError, this.service.signInUrl)
              : nothing
          }
        </div>
      </div>

      ${
        this.alerts.length === 0
          ? html`<div class="empty">No alerts</div>`
          : html` <div class="list">${this.renderAlertList()}</div> `
      }
    `
  }

  render() {
    return html`
      <div class="view-toggle">
        <button
          class=${this.viewMode === 'active' ? 'active' : ''}
          @click=${() => {
            this.setViewMode('active')
          }}
        >
          Active
        </button>
        <button
          class=${this.viewMode === 'history' ? 'active' : ''}
          @click=${() => {
            this.setViewMode('history')
          }}
        >
          History
        </button>
      </div>

      ${
        this.viewMode === 'active'
          ? this.renderActiveView()
          : html`<alert-history-list></alert-history-list>`
      }
    `
  }
}

customElements.define('alert-list', AlertList)
