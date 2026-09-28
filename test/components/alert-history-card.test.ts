import { describe, it, expect } from 'vitest'
import type { HistoryEntry } from '../../src/types.js'
import { buildHistoryRecords } from '../../src/components/alert-history-card.js'

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
    ...overrides
  }
}

describe('buildHistoryRecords', () => {
  it('returns empty array for no entries', () => {
    expect(buildHistoryRecords([])).toEqual([])
  })

  it('returns empty array when there are no clear events', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'raise',
        details: { message: 'test', priority: 'warning' }
      })
    ]
    expect(buildHistoryRecords(entries)).toEqual([])
  })

  it('builds a record from raise + clear pair with snapshot data', () => {
    const raisedAt = '2026-02-18T08:58:00Z'
    const clearedAt = '2026-02-18T10:12:00Z'

    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'raise',
        timestamp: raisedAt,
        details: { message: 'GPS signal degraded', priority: 'warning', group: 'navigation' }
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: clearedAt,
        details: { message: 'GPS signal degraded', priority: 'warning', group: 'navigation' }
      })
    ]

    const records = buildHistoryRecords(entries)
    expect(records).toHaveLength(1)
    expect(records[0].alertId).toBe('a1')
    expect(records[0].message).toBe('GPS signal degraded')
    expect(records[0].priority).toBe('warning')
    expect(records[0].group).toBe('navigation')
    expect(records[0].raisedAt).toBe(raisedAt)
    expect(records[0].clearedAt).toBe(clearedAt)
  })

  it('includes acknowledgedBy from ack events', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'raise',
        timestamp: '2026-02-18T08:00:00Z',
        details: { message: 'test', priority: 'caution' }
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'acknowledge',
        timestamp: '2026-02-18T08:05:00Z',
        userId: 'captain'
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: '2026-02-18T09:00:00Z',
        details: { message: 'test', priority: 'caution' }
      })
    ]

    const records = buildHistoryRecords(entries)
    expect(records[0].acknowledgedBy).toBe('captain')
  })

  it('falls back gracefully when snapshot data is missing (old entries)', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'raise',
        timestamp: '2026-02-18T08:00:00Z'
        // no details
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: '2026-02-18T09:00:00Z'
        // no details
      })
    ]

    const records = buildHistoryRecords(entries)
    expect(records).toHaveLength(1)
    expect(records[0].message).toBe('Unknown alert')
    expect(records[0].priority).toBe('caution')
  })

  it('sorts records by cleared time, newest first', () => {
    const entries: HistoryEntry[] = [
      makeEntry({
        alertId: 'a1',
        eventType: 'raise',
        timestamp: '2026-02-18T08:00:00Z',
        details: { message: 'First', priority: 'warning' }
      }),
      makeEntry({
        alertId: 'a1',
        eventType: 'clear',
        timestamp: '2026-02-18T09:00:00Z',
        details: { message: 'First', priority: 'warning' }
      }),
      makeEntry({
        alertId: 'a2',
        eventType: 'raise',
        timestamp: '2026-02-18T10:00:00Z',
        details: { message: 'Second', priority: 'alarm' }
      }),
      makeEntry({
        alertId: 'a2',
        eventType: 'clear',
        timestamp: '2026-02-18T11:00:00Z',
        details: { message: 'Second', priority: 'alarm' }
      })
    ]

    const records = buildHistoryRecords(entries)
    expect(records[0].message).toBe('Second')
    expect(records[1].message).toBe('First')
  })
})
