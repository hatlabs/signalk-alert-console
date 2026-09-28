/**
 * AlertList - Main alert list component.
 *
 * Connects to AlertService for real-time data and renders alert-card
 * elements for each alert.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { Alert } from '../types.js'
import { acquireAlertService, releaseAlertService } from '../services/alert-service.js'
import type { AlertService } from '../services/alert-service.js'
import { themeStyles } from '../styles/theme.js'
import { acquireAudioService, releaseAudioService } from '../services/audio-service.js'
import type { AudioService } from '../services/audio-service.js'
import { loadMinAudiblePriority, saveMinAudiblePriority } from '../services/audio-settings.js'
import { DEFAULT_MIN_AUDIBLE_PRIORITY } from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'
import { ICON_SILENCE } from '../styles/icons.js'

type ViewMode = 'active' | 'history'

const SOUND_OPTIONS: readonly { value: MinAudiblePriority; label: string }[] = [
  { value: 'off', label: 'Off (no sound)' },
  { value: 'emergency', label: 'Emergency only' },
  { value: 'alarm', label: 'Alarm and above' },
  { value: 'warning', label: 'Warning and above' }
]

export class AlertList extends LitElement {
  static properties = {
    alerts: { state: true },
    minAudiblePriority: { state: true },
    viewMode: { state: true }
  }

  static styles = [
    themeStyles,
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
        gap: 0.5rem;
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
  declare minAudiblePriority: MinAudiblePriority
  declare viewMode: ViewMode

  private service!: AlertService
  private audioService!: AudioService

  constructor() {
    super()
    this.alerts = []
    this.minAudiblePriority = DEFAULT_MIN_AUDIBLE_PRIORITY
    this.viewMode = 'active'
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service = acquireAlertService()
    this.audioService = acquireAudioService()
    this.service.addEventListener('change', this.onServiceChange)
    this.addEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.addEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.addEventListener('alert-dismiss', this.onAlertDismiss as EventListener)
    this.applyMinAudiblePriority(loadMinAudiblePriority())
    // Service connects on first acquire; change event will fire when ready
    this.onServiceChange()
  }

  private applyMinAudiblePriority(value: MinAudiblePriority): void {
    this.minAudiblePriority = value
    this.audioService.setMinAudiblePriority(value)
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
    const selected = (e.target as HTMLSelectElement).value
    const option = SOUND_OPTIONS.find((o) => o.value === selected)
    if (!option) return
    saveMinAudiblePriority(option.value)
    this.applyMinAudiblePriority(option.value)
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
    this.alerts = alerts
    this.audioService.update(alerts)
  }

  private onAlertAcknowledge = (e: CustomEvent<{ id: string }>): void => {
    this.service.acknowledgeAlert(e.detail.id).catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
  }

  private onAlertSilence = (e: CustomEvent<{ id: string }>): void => {
    this.service.silenceAlert(e.detail.id).catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
  }

  private onAlertDismiss = (e: CustomEvent<{ id: string }>): void => {
    this.service.dismissAlert(e.detail.id).catch(() => {
      // Error handling — state will remain unchanged via WebSocket
    })
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
    this.service.silenceAll().catch(() => {
      // Error handling — state will remain unchanged via WebSocket
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
        <alert-card .alert=${alert} .minAudiblePriority=${this.minAudiblePriority}></alert-card>
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
              ${SOUND_OPTIONS.map((o) => html`<option value=${o.value}>${o.label}</option>`)}
            </select>
          </div>
          <button
            data-action="silence-all"
            ?disabled=${!this.hasUnsilencedUnacknowledged()}
            @click=${this.onSilenceAll}
          >
            Silence All
          </button>
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
