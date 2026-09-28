/**
 * AlertHistoryList Tests
 *
 * Tests the history query the view sends and its client-side text filter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { HistoryEntry } from '../../src/types.js'
import type { AlertHistoryList } from '../../src/components/alert-history-list.js'
import type { AlertHistoryCard } from '../../src/components/alert-history-card.js'

function clearedPair(alertId: string, message: string, path: string): HistoryEntry[] {
  const base = { alertId, message, path, priority: 'warning' as const, $source: 'test' }
  return [
    { ...base, id: `${alertId}-raise`, eventType: 'raise', timestamp: '2026-02-18T08:00:00Z' },
    { ...base, id: `${alertId}-clear`, eventType: 'clear', timestamp: '2026-02-18T09:00:00Z' }
  ]
}

const fetchMock = vi.fn()

async function mountList(entries: HistoryEntry[]): Promise<AlertHistoryList> {
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ entries, total: entries.length })
  })
  await import('../../src/components/alert-history-list.js')
  const el = document.createElement('alert-history-list') as AlertHistoryList
  document.body.appendChild(el)
  await el.updateComplete
  await new Promise((r) => setTimeout(r, 0))
  await el.updateComplete
  return el
}

function shownMessages(el: AlertHistoryList): string[] {
  const cards = Array.from(
    el.shadowRoot?.querySelectorAll<AlertHistoryCard>('alert-history-card') ?? []
  )
  return cards.map((card) => card.record.message)
}

function textFilter(el: AlertHistoryList): HTMLInputElement {
  const input = el.shadowRoot?.querySelector<HTMLInputElement>('input[type="text"]')
  if (!input) throw new Error('text filter not rendered')
  return input
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('AlertHistoryList', () => {
  it('requests raise, clear and acknowledge as separate eventType parameters', async () => {
    await mountList([])

    const [input] = fetchMock.mock.calls[0] as [string]
    const url = new URL(input, 'http://my-server.local')
    expect(url.pathname).toBe('/signalk/v2/api/alerts/history')
    expect(url.searchParams.getAll('eventType')).toEqual(['raise', 'clear', 'acknowledge'])
    expect(url.searchParams.get('limit')).toBe('50')
    expect(url.searchParams.get('offset')).toBe('0')
  })

  it('labels the text filter by what it matches', async () => {
    const el = await mountList([])

    expect(textFilter(el).placeholder).toBe('Filter by message or path')
  })

  it('text filter matches message or path case-insensitively', async () => {
    const el = await mountList([
      ...clearedPair('a1', 'Bilge pump running', 'electrical.pumps.one'),
      ...clearedPair('a2', 'Water level high', 'tanks.bilge.level'),
      ...clearedPair('a3', 'Anchor drag', 'navigation.anchor.drag')
    ])
    expect(shownMessages(el)).toHaveLength(3)

    const input = textFilter(el)
    input.value = 'bilge'
    input.dispatchEvent(new Event('input'))
    await el.updateComplete

    expect(shownMessages(el).sort()).toEqual(['Bilge pump running', 'Water level high'])
  })
})
