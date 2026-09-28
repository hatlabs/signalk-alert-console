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
import { buildHistoryRecords } from '../utils/history.js'
import type { HistoryRecord } from '../utils/history.js'

const PAGE_SIZE = 50

export class AlertHistoryList extends LitElement {
  static properties = {
    records: { state: true },
    total: { state: true },
    loading: { state: true },
    filterFrom: { state: true },
    filterTo: { state: true },
    filterPriority: { state: true },
    filterText: { state: true }
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
  declare filterText: string

  private allEntries: HistoryEntry[] = []
  private offset = 0
  private allLoaded = false
  /** Identifies the latest request; a response to an earlier one is dropped. */
  private requestSeq = 0
  private observer: IntersectionObserver | null = null

  constructor() {
    super()
    this.records = []
    this.total = 0
    this.loading = false
    this.filterFrom = ''
    this.filterTo = ''
    this.filterPriority = ''
    this.filterText = ''
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
    // A reset supersedes a load in flight; a next page waits for it.
    if (!reset && (this.loading || this.allLoaded)) return

    const seq = ++this.requestSeq
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
        eventType: ['raise', 'clear', 'acknowledge'],
        limit: PAGE_SIZE,
        offset: this.offset
      })
      if (seq !== this.requestSeq) return

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
      if (seq === this.requestSeq) this.loading = false
    }
  }

  private rebuildRecords(): void {
    let records = buildHistoryRecords(this.allEntries)

    if (this.filterPriority) {
      records = records.filter((r) => r.priority === this.filterPriority)
    }
    if (this.filterText) {
      const needle = this.filterText.toLowerCase()
      records = records.filter(
        (r) => r.message.toLowerCase().includes(needle) || r.path.toLowerCase().includes(needle)
      )
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

  private onTextChange(e: Event): void {
    this.filterText = (e.target as HTMLInputElement).value
    this.rebuildRecords()
  }

  private onFromChange(e: Event): void {
    const value = (e.target as HTMLInputElement).value
    // A bare date parses as UTC; the time part makes it local midnight.
    this.filterFrom = value ? new Date(value + 'T00:00:00').toISOString() : ''
    this.onFilterChange()
  }

  private onToChange(e: Event): void {
    const value = (e.target as HTMLInputElement).value
    // Through the last millisecond of the local day
    this.filterTo = value ? new Date(value + 'T23:59:59.999').toISOString() : ''
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
          Filter
          <input
            type="text"
            placeholder="Filter by message or path"
            .value=${this.filterText}
            @input=${this.onTextChange}
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
