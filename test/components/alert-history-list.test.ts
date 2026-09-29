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
    {
      ...base,
      id: `${alertId}-clear`,
      eventType: 'clear',
      newState: 'normal',
      timestamp: '2026-02-18T09:00:00Z'
    }
  ]
}

const fetchMock = vi.fn()

async function mountList(entries: HistoryEntry[]): Promise<AlertHistoryList> {
  fetchMock.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ entries })
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

function dateInputs(el: AlertHistoryList): { from: HTMLInputElement; to: HTMLInputElement } {
  const [from, to] = Array.from(
    el.shadowRoot?.querySelectorAll<HTMLInputElement>('input[type="date"]') ?? []
  )
  return { from, to }
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
    expect(url.searchParams.has('before')).toBe(false)
  })

  it('refetches on a filter change during a load and drops the superseded response', async () => {
    const respond: ((entries: HistoryEntry[]) => void)[] = []
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond.push((entries) => {
            resolve({ ok: true, json: () => Promise.resolve({ entries }) })
          })
        })
    )
    await import('../../src/components/alert-history-list.js')
    const el = document.createElement('alert-history-list') as AlertHistoryList
    document.body.appendChild(el)
    await el.updateComplete
    expect(respond).toHaveLength(1)

    dateInputs(el).from.value = '2026-02-18'
    dateInputs(el).from.dispatchEvent(new Event('change'))
    expect(respond).toHaveLength(2)

    respond[1](clearedPair('fresh', 'Fresh result', 'a.fresh'))
    await new Promise((r) => setTimeout(r, 0))
    respond[0](clearedPair('stale', 'Stale result', 'a.stale'))
    await new Promise((r) => setTimeout(r, 0))
    await el.updateComplete

    expect(shownMessages(el)).toEqual(['Fresh result'])
  })

  it('loads the next page from the cursor and keeps both pages', async () => {
    const pairs = (prefix: string) =>
      Array.from({ length: 25 }, (_, i) =>
        clearedPair(`${prefix}${String(i)}`, `${prefix} ${String(i)}`, `a.${prefix}${String(i)}`)
      ).flat()
    const pages: Record<string, { entries: HistoryEntry[]; next?: string }> = {
      '': { entries: pairs('first'), next: 'cursor-1' },
      'cursor-1': { entries: pairs('second') }
    }
    fetchMock.mockImplementation((input: string) => {
      const before = new URL(input, 'http://my-server.local').searchParams.get('before') ?? ''
      return Promise.resolve({ ok: true, json: () => Promise.resolve(pages[before]) })
    })
    await import('../../src/components/alert-history-list.js')
    const el = document.createElement('alert-history-list') as AlertHistoryList
    document.body.appendChild(el)
    await new Promise((r) => setTimeout(r, 0))
    await el.updateComplete
    expect(shownMessages(el)).toHaveLength(25)

    // Stands in for the sentinel scrolling into view, twice: the second page
    // carries no cursor, so the second scroll must not request anything.
    const list = el as unknown as { fetchPage(reset: boolean): Promise<void> }
    await list.fetchPage(false)
    await list.fetchPage(false)
    await el.updateComplete

    const cursors = fetchMock.mock.calls.map(([input]) =>
      new URL(input as string, 'http://my-server.local').searchParams.get('before')
    )
    expect(cursors).toEqual([null, 'cursor-1'])
    const shown = shownMessages(el)
    expect(shown).toHaveLength(50)
    expect(shown).toContain('first 0')
    expect(shown).toContain('second 24')
  })

  it('stays loading until the fresh response settles when a stale one arrives first', async () => {
    const respond: ((entries: HistoryEntry[]) => void)[] = []
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond.push((entries) => {
            resolve({ ok: true, json: () => Promise.resolve({ entries }) })
          })
        })
    )
    await import('../../src/components/alert-history-list.js')
    const el = document.createElement('alert-history-list') as AlertHistoryList
    document.body.appendChild(el)
    await el.updateComplete

    dateInputs(el).from.value = '2026-02-18'
    dateInputs(el).from.dispatchEvent(new Event('change'))
    expect(respond).toHaveLength(2)

    respond[0](clearedPair('stale', 'Stale result', 'a.stale'))
    await new Promise((r) => setTimeout(r, 0))
    await el.updateComplete

    expect(el.loading).toBe(true)
    expect(el.shadowRoot?.querySelector('.loading')).not.toBeNull()
    expect(shownMessages(el)).toEqual([])

    respond[1](clearedPair('fresh', 'Fresh result', 'a.fresh'))
    await new Promise((r) => setTimeout(r, 0))
    await el.updateComplete

    expect(el.loading).toBe(false)
    expect(shownMessages(el)).toEqual(['Fresh result'])
  })

  describe('date filters (test zone America/New_York, UTC-5 in February)', () => {
    async function queryAfterDateChange(input: 'from' | 'to', value: string) {
      const el = await mountList([])
      const field = dateInputs(el)[input]
      field.value = value
      field.dispatchEvent(new Event('change'))
      const [url] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string]
      return new URL(url, 'http://my-server.local').searchParams
    }

    it('From starts at local midnight', async () => {
      const params = await queryAfterDateChange('from', '2026-02-18')
      expect(params.get('from')).toBe('2026-02-18T05:00:00.000Z')
    })

    it('To includes the whole local day', async () => {
      const params = await queryAfterDateChange('to', '2026-02-18')
      expect(params.get('to')).toBe('2026-02-19T04:59:59.999Z')
    })
  })

  it('lists an alert escalated to alarm under the Alarm filter', async () => {
    const base = { alertId: 'esc', path: 'propulsion.coolant', $source: 'test' }
    const el = await mountList([
      {
        ...base,
        id: 'esc-clear',
        eventType: 'clear',
        newState: 'normal',
        priority: 'alarm',
        message: 'Coolant temperature critical',
        timestamp: '2026-02-18T09:00:00Z'
      },
      {
        ...base,
        id: 'esc-escalate',
        eventType: 'escalate',
        priority: 'alarm',
        message: 'Coolant temperature critical',
        timestamp: '2026-02-18T08:30:00Z'
      },
      {
        ...base,
        id: 'esc-raise',
        eventType: 'raise',
        priority: 'warning',
        message: 'Coolant temperature high',
        timestamp: '2026-02-18T08:00:00Z'
      }
    ])

    const select = el.shadowRoot?.querySelector<HTMLSelectElement>('select')
    if (!select) throw new Error('priority filter not rendered')
    select.value = 'alarm'
    select.dispatchEvent(new Event('change'))
    await el.updateComplete

    expect(shownMessages(el)).toEqual(['Coolant temperature critical'])
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
