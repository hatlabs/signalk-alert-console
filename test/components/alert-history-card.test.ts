import { describe, it, expect, afterEach } from 'vitest'
import type { AlertHistoryCard } from '../../src/components/alert-history-card.js'
import type { HistoryRecord } from '../../src/utils/history.js'

describe('AlertHistoryCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows message and priority without a group badge', async () => {
    await import('../../src/components/alert-history-card.js')
    const record: HistoryRecord = {
      alertId: 'a1',
      message: 'Bilge pump running',
      priority: 'alarm',
      path: 'bilge.main.pumpRunning',
      raisedAt: '2026-02-18T08:00:00Z',
      clearedAt: '2026-02-18T09:00:00Z'
    }
    const el = document.createElement('alert-history-card') as AlertHistoryCard
    el.record = record
    document.body.appendChild(el)
    await el.updateComplete

    const root = el.shadowRoot
    expect(root?.querySelector('.message')?.textContent).toContain('Bilge pump running')
    expect(root?.querySelector('.priority')?.textContent).toContain('Alarm')
    expect(root?.querySelector('.group')).toBeNull()
  })
})
