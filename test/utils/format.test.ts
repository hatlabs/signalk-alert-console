import { describe, it, expect } from 'vitest'
import { formatDuration } from '../../src/utils/format.js'

describe('formatDuration', () => {
  it('returns "< 1m" for durations under 1 minute', () => {
    expect(formatDuration(0)).toBe('< 1m')
    expect(formatDuration(30_000)).toBe('< 1m')
    expect(formatDuration(59_999)).toBe('< 1m')
  })

  it('formats minutes only', () => {
    expect(formatDuration(60_000)).toBe('1m')
    expect(formatDuration(37 * 60_000)).toBe('37m')
    expect(formatDuration(59 * 60_000)).toBe('59m')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(74 * 60_000)).toBe('1h 14m')
    expect(formatDuration(150 * 60_000)).toBe('2h 30m')
  })

  it('formats exact hours without minutes', () => {
    expect(formatDuration(60 * 60_000)).toBe('1h')
    expect(formatDuration(3 * 60 * 60_000)).toBe('3h')
  })

  it('truncates partial minutes', () => {
    // 1 minute and 30 seconds → still 1m
    expect(formatDuration(90_000)).toBe('1m')
  })
})
