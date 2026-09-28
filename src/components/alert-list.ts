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
import { VALID_AUDIBLE_PRIORITIES } from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'
import { SimulationService } from '../services/simulation-service.js'

type ViewMode = 'active' | 'history'

export class AlertList extends LitElement {
  static properties = {
    alerts: { state: true },
    minAudiblePriority: { state: true },
    simulationRunning: { state: true },
    simulationEnabled: { state: true },
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
        align-items: center;
        justify-content: space-between;
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

      .toolbar-actions {
        display: flex;
        gap: 0.5rem;
      }

      button[data-action='simulate'] {
        min-height: 44px;
        min-width: 44px;
        padding: 0.375rem 0.75rem;
        border: 1px solid var(--btn-sim-border);
        border-radius: 4px;
        background: var(--btn-bg);
        color: var(--btn-sim-text);
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
        touch-action: manipulation;
        white-space: nowrap;
      }

      button[data-action='simulate']:hover {
        background: var(--btn-sim-hover);
      }

      button[data-action='simulate'].sim-active {
        background: var(--btn-sim-active-bg);
        color: var(--btn-sim-active-text);
      }

      button[data-action='simulate'].sim-active:hover {
        background: var(--btn-sim-active-hover);
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
  declare minAudiblePriority: MinAudiblePriority | null
  declare simulationRunning: boolean
  declare simulationEnabled: boolean
  declare viewMode: ViewMode

  private service!: AlertService
  private audioService!: AudioService
  private simulation!: SimulationService

  constructor() {
    super()
    this.alerts = []
    this.minAudiblePriority = null
    this.simulationRunning = false
    this.simulationEnabled = false
    this.viewMode = 'active'
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service = acquireAlertService()
    this.audioService = acquireAudioService()
    this.simulation = new SimulationService(() => this.service.getAlerts())
    this.service.addEventListener('change', this.onServiceChange)
    this.addEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.addEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.addEventListener('alert-dismiss', this.onAlertDismiss as EventListener)
    // Service connects on first acquire; change event will fire when ready
    this.onServiceChange()
    this.fetchUiConfig()
  }

  private fetchUiConfig(): void {
    fetch('/plugins/signalk-alert-manager/config/ui')
      .then((res) =>
        res.ok
          ? (res.json() as Promise<{
              minAudiblePriority?: string
              enableSimulation?: boolean
            }>)
          : null
      )
      .then((config) => {
        if (config?.minAudiblePriority && VALID_AUDIBLE_PRIORITIES.has(config.minAudiblePriority)) {
          const priority = config.minAudiblePriority as MinAudiblePriority
          this.audioService.setMinAudiblePriority(priority)
          this.minAudiblePriority = priority
        }
        if (config?.enableSimulation === true) {
          this.simulationEnabled = true
        }
      })
      .catch(() => {
        // Config fetch failed; defaults apply
      })
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('change', this.onServiceChange)
    this.removeEventListener('alert-acknowledge', this.onAlertAcknowledge as EventListener)
    this.removeEventListener('alert-silence', this.onAlertSilence as EventListener)
    this.removeEventListener('alert-dismiss', this.onAlertDismiss as EventListener)
    this.simulation.stop()
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

  private onToggleSimulation(): void {
    if (this.simulation.running) {
      this.simulation.stop()
    } else {
      this.simulation.start()
    }
    this.simulationRunning = this.simulation.running
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
        <span class="alert-count"
          >${String(this.alerts.length)} alert${this.alerts.length !== 1 ? 's' : ''}</span
        >
        <div class="toolbar-actions">
          ${
            this.simulationEnabled
              ? html`<button
                  data-action="simulate"
                  class=${this.simulationRunning ? 'sim-active' : ''}
                  @click=${this.onToggleSimulation}
                >
                  ${this.simulationRunning ? 'Stop Sim' : 'Simulate'}
                </button>`
              : nothing
          }
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
