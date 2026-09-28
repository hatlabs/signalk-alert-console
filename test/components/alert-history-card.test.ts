import { describe, it, expect, afterEach } from 'vitest'
import type { HistoryEntry } from '../../src/types.js'
import { buildHistoryRecords } from '../../src/components/alert-history-card.js'
import type { AlertHistoryCard, HistoryRecord } from '../../src/components/alert-history-card.js'

function makeEntry(
  overrides: Partial<HistoryEntry> & { alertId: string; eventType: HistoryEntry['eventType'] }
): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    path: 'test.alert',
    priority: 'warning',
    message: 'Test alert',
    $source: 'test',
    timestamp: new Date().toISOString(),
    ...(overrides.eventType === 'clear' ? { newState: 'normal' as const } : {}),
    ...overrides
  }
}

describe('buildHistoryRecords', () => {
  it('returns empty array for no entries', () => {
    expect(buildHistoryRecords([])).toEqual([])
  })

  it('returns empty array when there are no clear events', () => {
    const entries: HistoryEntry[] = [makeEntry({ alertId: 'a1', eventType: 'raise' })]
    expect(buildHistoryRecords(entries)).toEqual([])
  })

  it('builds a record from the top-level snapshot of a raise + clear pair', () => {
    const raisedAt = '2026-02-18T08:58:00Z'
    const clearedAt = '2026-02-18T10:12:00Z'
    const snapshot = {
      message: 'GPS signal degraded',
      priority: 'alarm' as const,
      path: 'navigation.gnss.signalDegraded'
    }

    const entries: HistoryEntry[] = [
      makeEntry({ alertId: 'a1', eventType: 'raise', timestamp: raisedAt, ...snapshot }),
      makeEntry({ alertId: 'a1', eventType: 'clear', timestamp: clearedAt, ...snapshot })
    ]

    const records = buildHistoryRecords(entries)
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      alertId: 'a1',
      message: 'GPS signal degraded',
      priority: 'alarm',
      path: 'navigation.gnss.signalDegraded',
      raisedAt,
      clearedAt,
      acknowledgedBy: undefined
    })
    expect(records[0]).not.toHaveProperty('group')
  })

  it('uses the clear entry when the raise is not in the loaded entries', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: '2026-02-18T09:00:00Z',
        message: 'Shore power lost',
        priority: 'caution',
        path: 'electrical.shore.lost'
      })
    ]

    const [record] = buildHistoryRecords(entries)
    expect(record.message).toBe('Shore power lost')
    expect(record.priority).toBe('caution')
    expect(record.path).toBe('electrical.shore.lost')
    expect(record.raisedAt).toBe('2026-02-18T09:00:00Z')
  })

  // Core returns history newest first. One alert id logs a raise per
  // re-annunciation and a clear per condition clear; only the clear into
  // `normal` ends the alert.
  const reannouncedLifecycle: HistoryEntry[] = [
    makeEntry({
      alertId: 'a1',
      eventType: 'clear',
      timestamp: '2026-02-18T08:50:00Z',
      previousState: 'rtn-unacknowledged',
      newState: 'normal',
      userId: 'captain'
    }),
    makeEntry({
      alertId: 'a1',
      eventType: 'clear',
      timestamp: '2026-02-18T08:40:00Z',
      previousState: 'unacknowledged',
      newState: 'rtn-unacknowledged'
    }),
    makeEntry({
      alertId: 'a1',
      eventType: 'raise',
      timestamp: '2026-02-18T08:30:00Z',
      previousState: 'rtn-unacknowledged',
      newState: 'unacknowledged'
    }),
    makeEntry({
      alertId: 'a1',
      eventType: 'clear',
      timestamp: '2026-02-18T08:20:00Z',
      previousState: 'unacknowledged',
      newState: 'rtn-unacknowledged'
    }),
    makeEntry({
      alertId: 'a1',
      eventType: 'raise',
      timestamp: '2026-02-18T08:00:00Z',
      newState: 'unacknowledged'
    })
  ]

  it('spans a re-announced alert from its first raise to the clear into normal', () => {
    const records = buildHistoryRecords(reannouncedLifecycle)

    expect(records).toHaveLength(1)
    expect(records[0].raisedAt).toBe('2026-02-18T08:00:00Z')
    expect(records[0].clearedAt).toBe('2026-02-18T08:50:00Z')
  })

  it('makes no record while the alert is still active after a condition clear', () => {
    const stillActive = reannouncedLifecycle.slice(1)

    expect(buildHistoryRecords(stillActive)).toEqual([])
  })

  it('takes acknowledgedBy from the latest acknowledgement', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: '2026-02-18T09:00:00Z',
        newState: 'normal'
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'acknowledge',
        timestamp: '2026-02-18T08:40:00Z',
        userId: 'mate'
      }),
      makeEntry({ alertId: 'a1', eventType: 'raise', timestamp: '2026-02-18T08:30:00Z' }),
      makeEntry({
        alertId: 'a1',
        eventType: 'acknowledge',
        timestamp: '2026-02-18T08:10:00Z',
        userId: 'captain'
      }),
      makeEntry({ alertId: 'a1', eventType: 'raise', timestamp: '2026-02-18T08:00:00Z' })
    ]

    expect(buildHistoryRecords(entries)[0].acknowledgedBy).toBe('mate')
  })

  it('includes acknowledgedBy from ack events', () => {
    const entries: HistoryEntry[] = [
      makeEntry({ alertId: 'a1', eventType: 'raise', timestamp: '2026-02-18T08:00:00Z' }),
      makeEntry({
        alertId: 'a1',
        eventType: 'acknowledge',
        timestamp: '2026-02-18T08:05:00Z',
        userId: 'captain'
      }),
      makeEntry({ alertId: 'a1', eventType: 'clear', timestamp: '2026-02-18T09:00:00Z' })
    ]

    const records = buildHistoryRecords(entries)
    expect(records[0].acknowledgedBy).toBe('captain')
  })

  it('sorts records by cleared time, newest first', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'raise',
        timestamp: '2026-02-18T08:00:00Z',
        message: 'First'
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: '2026-02-18T09:00:00Z',
        message: 'First'
      }),
      makeEntry({
        alertId: 'a2',
        eventType: 'raise',
        timestamp: '2026-02-18T10:00:00Z',
        message: 'Second'
      }),
      makeEntry({
        alertId: 'a2',
        eventType: 'clear',
        timestamp: '2026-02-18T11:00:00Z',
        message: 'Second'
      })
    ]

    const records = buildHistoryRecords(entries)
    expect(records[0].message).toBe('Second')
    expect(records[1].message).toBe('First')
  })
})

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
