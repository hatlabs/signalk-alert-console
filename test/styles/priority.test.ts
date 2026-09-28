/**
 * Priority helper tests.
 */

import { describe, it, expect } from 'vitest'
import { offersSilence } from '../../src/styles/priority.js'
import type { Alert } from '../../src/types.js'

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'a',
    path: 'test.alert',
    $source: 'test',
    priority: 'warning',
    state: 'unacknowledged',
    condition: true,
    latching: false,
    silenced: false,
    message: 'Test alert',
    raisedAt: '2026-02-19T10:00:00.000Z',
    stateChangedAt: '2026-02-19T10:00:00.000Z',
    sourceOnline: true,
    lastSourceUpdate: '2026-02-19T10:00:00.000Z',
    stale: false,
    ...overrides
  }
}

describe('offersSilence', () => {
  it.each(['emergency', 'alarm', 'warning'] as const)(
    'offers Silence on an unacknowledged %s',
    (priority) => {
      expect(offersSilence(makeAlert({ priority }))).toBe(true)
    }
  )

  it('offers Silence on a returned-to-normal alert not yet acknowledged', () => {
    expect(offersSilence(makeAlert({ state: 'rtn-unacknowledged' }))).toBe(true)
  })

  it('never offers Silence on a caution', () => {
    expect(offersSilence(makeAlert({ priority: 'caution' }))).toBe(false)
  })

  it('does not offer Silence once silenced or acknowledged', () => {
    expect(offersSilence(makeAlert({ silenced: true }))).toBe(false)
    expect(offersSilence(makeAlert({ state: 'acknowledged' }))).toBe(false)
  })
})
