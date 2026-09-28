/**
 * AlertHistoryList - History view with filters, pagination, and history cards.
 *
 * Fetches cleared alert history from the REST API with date range filtering.
 * Uses IntersectionObserver for infinite scroll pagination.
 */

import { LitElement, html, css, nothing } from 'lit'
import type { HistoryEntry } from '../types.js'
import { AlertService } from '../services/alert-service.js'
import { themeStyles } from '../styles/theme.js'
import { buildHistoryRecords } from './alert-history-card.js'
import type { HistoryRecord } from './alert-history-card.js'

const PAGE_SIZE = 50

export class AlertHistoryList extends LitElement {
  static properties = {
    records: { state: true },
    total: { state: true },
    loading: { state: true },
    filterFrom: { state: true },
    filterTo: { state: true },
    filterPriority: { state: true },
    filterGroup: { state: true }
  }

  static styles = [
    themeStyles,
    css`
      :host {
        display: block;
      }

      .filters {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        margin-bottom: 1rem;
        padding-bottom: 0.5rem;
        border-bottom: 1px solid var(--border-primary);
        flex-wrap: wrap;
      }

      .filters label {
        font-size: 0.75rem;
        color: var(--text-muted);
      }

      .filters select,
      .filters input {
        min-height: 36px;
        padding: 0.25rem 0.5rem;
        border: 1px solid var(--border-secondary);
        border-radius: 4px;
        background: var(--btn-bg);
        color: var(--text-primary);
        font-size: 0.8rem;
      }

      .result-count {
        margin-left: auto;
        font-size: 0.8rem;
        color: var(--text-muted);
        white-space: nowrap;
      }

      .list {
        display: flex;
        flex-direction: column;
      }

      .empty {
        text-align: center;
        padding: 2rem;
        color: var(--text-dim);
        font-size: 0.9rem;
      }

      .loading {
        text-align: center;
        padding: 1rem;
        color: var(--text-dim);
        font-size: 0.85rem;
      }

      .sentinel {
        height: 1px;
      }
    `
  ]

  declare records: HistoryRecord[]
  declare total: number
  declare loading: boolean
  declare filterFrom: string
  declare filterTo: string
  declare filterPriority: string
  declare filterGroup: string

  private allEntries: HistoryEntry[] = []
  private offset = 0
  private allLoaded = false
  private observer: IntersectionObserver | null = null

  constructor() {
    super()
    this.records = []
    this.total = 0
    this.loading = false
    this.filterFrom = ''
    this.filterTo = ''
    this.filterPriority = ''
    this.filterGroup = ''
  }

  connectedCallback(): void {
    super.connectedCallback()
    void this.fetchPage(true)
  }

  disconnectedCallback(): void {
    super.disconnectedCallback()
    this.observer?.disconnect()
    this.observer = null
  }

  private async fetchPage(reset: boolean): Promise<void> {
    if (this.loading) return
    if (!reset && this.allLoaded) return

    this.loading = true

    if (reset) {
      this.offset = 0
      this.allEntries = []
      this.allLoaded = false
    }

    try {
      const result = await AlertService.fetchHistory({
        from: this.filterFrom || undefined,
        to: this.filterTo || undefined,
        eventType: 'raise,clear,acknowledge',
        limit: PAGE_SIZE,
        offset: this.offset
      })

      this.total = result.total
      this.allEntries = reset ? result.entries : [...this.allEntries, ...result.entries]
      this.offset += result.entries.length

      if (result.entries.length < PAGE_SIZE || this.offset >= result.total) {
        this.allLoaded = true
      }

      this.rebuildRecords()
    } catch {
      // Fetch failed; keep existing state
    } finally {
      this.loading = false
    }
  }

  private rebuildRecords(): void {
    let records = buildHistoryRecords(this.allEntries)

    if (this.filterPriority) {
      records = records.filter((r) => r.priority === this.filterPriority)
    }
    if (this.filterGroup) {
      const needle = this.filterGroup.toLowerCase()
      records = records.filter((r) => r.group?.toLowerCase().includes(needle))
    }

    this.records = records
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has('records')) {
      this.setupObserver()
    }
  }

  private setupObserver(): void {
    this.observer?.disconnect()

    const sentinel = this.renderRoot.querySelector('.sentinel')
    if (!sentinel || this.allLoaded) return

    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void this.fetchPage(false)
        }
      },
      { rootMargin: '200px' }
    )
    this.observer.observe(sentinel)
  }

  private onFilterChange(): void {
    void this.fetchPage(true)
  }

  private onPriorityChange(e: Event): void {
    this.filterPriority = (e.target as HTMLSelectElement).value
    this.rebuildRecords()
  }

  private onGroupChange(e: Event): void {
    this.filterGroup = (e.target as HTMLInputElement).value
    this.rebuildRecords()
  }

  private onFromChange(e: Event): void {
    const value = (e.target as HTMLInputElement).value
    this.filterFrom = value ? new Date(value).toISOString() : ''
    this.onFilterChange()
  }

  private onToChange(e: Event): void {
    const value = (e.target as HTMLInputElement).value
    // Set to end of day
    this.filterTo = value ? new Date(value + 'T23:59:59').toISOString() : ''
    this.onFilterChange()
  }

  render() {
    return html`
      <div class="filters">
        <label>
          Priority
          <select @change=${this.onPriorityChange}>
            <option value="">All</option>
            <option value="emergency">Emergency</option>
            <option value="alarm">Alarm</option>
            <option value="warning">Warning</option>
            <option value="caution">Caution</option>
          </select>
        </label>
        <label>
          Group
          <input
            type="text"
            placeholder="Filter..."
            .value=${this.filterGroup}
            @input=${this.onGroupChange}
          />
        </label>
        <label>
          From
          <input type="date" @change=${this.onFromChange} />
        </label>
        <label>
          To
          <input type="date" @change=${this.onToChange} />
        </label>
        <span class="result-count"
          >${String(this.records.length)} result${this.records.length !== 1 ? 's' : ''}</span
        >
      </div>

      ${
        this.records.length === 0 && !this.loading
          ? html`<div class="empty">No history found</div>`
          : html`
              <div class="list">
                ${this.records.map(
                  (record) => html` <alert-history-card .record=${record}></alert-history-card> `
                )}
              </div>
            `
      }
      ${this.loading ? html`<div class="loading">Loading...</div>` : nothing}
      ${!this.allLoaded ? html`<div class="sentinel"></div>` : nothing}
    `
  }
}

customElements.define('alert-history-list', AlertHistoryList)
