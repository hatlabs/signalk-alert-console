/**
 * AlertApp - Root application component.
 *
 * Owns the alert service's lifetime and renders its availability: a state
 * screen while the list cannot be shown, a strip over the last known list
 * while the connection recovers. Switches between alert-list and
 * alert-detail based on user selection.
 */

import { LitElement, html, css, nothing } from 'lit'
import { themeStyles } from '../styles/theme.js'
import { acquireAlertService, releaseAlertService, showsList } from '../services/alert-service.js'
import type { AlertService, Availability } from '../services/alert-service.js'
import { acquireAudioService, releaseAudioService } from '../services/audio-service.js'
import type { AudioService } from '../services/audio-service.js'
import { loadMinAudiblePriority, saveMinAudiblePriority } from '../services/audio-settings.js'
import { DEFAULT_MIN_AUDIBLE_PRIORITY } from '../styles/priority.js'
import type { MinAudiblePriority } from '../styles/priority.js'

export class AlertApp extends LitElement {
  static properties = {
    selectedAlertId: { state: true },
    minAudiblePriority: { state: true },
    availability: { state: true },
    signInUrl: { state: true }
  }

  static styles = [
    themeStyles,
    css`
      :host {
        display: block;
        font-family: system-ui, sans-serif;
        padding: 1rem;
        max-width: 800px;
        margin: 0 auto;
        background: var(--bg-primary);
        color: var(--text-primary);
      }
      h1 {
        margin: 0 0 1rem 0;
        font-size: 1.25rem;
        color: var(--text-secondary);
      }
      a {
        color: var(--link-text);
      }
      .state {
        padding: 2rem 1rem;
        text-align: center;
      }
      .state h2 {
        margin: 0 0 0.5rem 0;
        font-size: 1.1rem;
        color: var(--text-primary);
      }
      .state h2:focus {
        outline: none;
      }
      .state p {
        margin: 0.5rem 0 0 0;
        font-size: 0.9rem;
        color: var(--text-muted);
      }
      .state a.sign-in {
        display: inline-block;
        margin-top: 1rem;
        min-height: 44px;
        line-height: 44px;
        padding: 0 1.25rem;
        border: 1px solid var(--btn-border);
        border-radius: 4px;
        background: var(--btn-bg);
        font-weight: 600;
        text-decoration: none;
      }
      .strip {
        margin-bottom: 1rem;
        padding: 0.625rem 0.75rem;
        border-radius: 4px;
        background: var(--badge-stale-bg);
        color: var(--badge-stale-text);
        font-size: 0.875rem;
        font-weight: 600;
      }
      .strip a {
        color: inherit;
      }
      .views.stale {
        opacity: 0.75;
      }
    `
  ]

  declare selectedAlertId: string | null
  /** This display's sound threshold, loaded once and saved on each change. */
  declare minAudiblePriority: MinAudiblePriority
  declare availability: Availability
  declare signInUrl: string

  private service!: AlertService
  private audioService!: AudioService

  constructor() {
    super()
    this.selectedAlertId = null
    this.minAudiblePriority = DEFAULT_MIN_AUDIBLE_PRIORITY
    this.availability = 'probing'
    this.signInUrl = ''
  }

  connectedCallback(): void {
    super.connectedCallback()
    this.service = acquireAlertService()
    this.audioService = acquireAudioService()
    this.applyMinAudiblePriority(loadMinAudiblePriority())
    this.service.addEventListener('availability', this.onAvailability)
    this.onAvailability()
    this.addEventListener('alert-select', this.onAlertSelect as EventListener)
    this.addEventListener('alert-detail-close', this.onDetailClose)
    window.addEventListener('focus', this.onWake)
    document.addEventListener('visibilitychange', this.onWake)
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.service.removeEventListener('availability', this.onAvailability)
    this.removeEventListener('alert-select', this.onAlertSelect as EventListener)
    this.removeEventListener('alert-detail-close', this.onDetailClose)
    window.removeEventListener('focus', this.onWake)
    document.removeEventListener('visibilitychange', this.onWake)
    releaseAlertService()
    releaseAudioService()
  }

  private get showsList(): boolean {
    return showsList(this.availability)
  }

  private onAvailability = (): void => {
    this.availability = this.service.availability
    this.signInUrl = this.service.signInUrl
    if (!this.showsList) {
      // Stop the tone here rather than leave it to the list's teardown.
      this.audioService.update([])
    }
  }

  /** A screen the operator comes back to re-checks the server at once. */
  private onWake = (): void => {
    if (document.visibilityState === 'visible') {
      this.service.retryNow()
    }
  }

  protected updated(changed: Map<string, unknown>): void {
    // The initial probing screen does not take focus; later screens replace
    // what was there, so focus follows them.
    if (changed.has('availability') && changed.get('availability') !== undefined) {
      this.renderRoot.querySelector<HTMLElement>('.state h2')?.focus()
    }
  }

  private onAlertSelect = (e: CustomEvent<{ id: string }>): void => {
    this.selectedAlertId = e.detail.id
  }

  private applyMinAudiblePriority(value: MinAudiblePriority): void {
    this.minAudiblePriority = value
    this.audioService.setMinAudiblePriority(value)
  }

  private onSoundThresholdChange(e: CustomEvent<{ value: MinAudiblePriority }>): void {
    saveMinAudiblePriority(e.detail.value)
    this.applyMinAudiblePriority(e.detail.value)
  }

  private onDetailClose = (): void => {
    this.selectedAlertId = null
  }

  private renderScreen(title: string, body: unknown = nothing) {
    return html`<section class="state">
      <h2 tabindex="-1">${title}</h2>
      ${body}
    </section>`
  }

  private renderAvailability() {
    switch (this.availability) {
      case 'probing':
        return this.renderScreen('Connecting to Signal K…')
      case 'unreachable':
        return this.renderScreen('Cannot reach the Signal K server — retrying')
      case 'no-api':
        return this.renderScreen(
          'Alerts API not available',
          html`<p>
              This Signal K server does not provide the alerts API (/signalk/v2/api/alerts). The
              console needs a server with core alerts support.
            </p>
            <p>Checking again automatically.</p>`
        )
      case 'sign-in':
        return this.renderScreen(
          'Sign in to see alerts',
          html`<p>This Signal K server shows alerts only to signed-in users.</p>
            <a class="sign-in" href=${this.signInUrl}>Sign in</a>`
        )
      case 'reconnecting':
        return html`<div class="strip">Connection lost — showing last known alerts</div>`
      case 'session-expired':
        return html`<div class="strip">
          Session expired — <a href=${this.signInUrl}>sign in</a>
        </div>`
      case 'live':
        return nothing
    }
  }

  private renderViews() {
    return html`<div class="views ${this.availability === 'live' ? '' : 'stale'}">
      <alert-list
        style=${this.selectedAlertId ? 'display:none' : ''}
        .minAudiblePriority=${this.minAudiblePriority}
        @sound-threshold-change=${this.onSoundThresholdChange}
      ></alert-list>
      ${
        this.selectedAlertId
          ? html`<alert-detail alert-id="${this.selectedAlertId}"></alert-detail>`
          : nothing
      }
    </div>`
  }

  render() {
    return html`
      <h1>Alert Console</h1>
      <div aria-live="polite">${this.renderAvailability()}</div>
      ${this.showsList ? this.renderViews() : nothing}
    `
  }
}

customElements.define('alert-app', AlertApp)
