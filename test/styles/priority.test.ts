/**
 * Priority helper tests.
 */

import { describe, it, expect } from 'vitest'
import { isAudible } from '../../src/styles/priority.js'
import type { MinAudiblePriority } from '../../src/styles/priority.js'

const THRESHOLDS: MinAudiblePriority[] = ['off', 'emergency', 'alarm', 'warning']

describe('isAudible', () => {
  it.each(THRESHOLDS)('never treats caution as audible at %s', (threshold) => {
    expect(isAudible('caution', threshold)).toBe(false)
  })

  it('treats priorities at or above the threshold as audible', () => {
    expect(isAudible('emergency', 'alarm')).toBe(true)
    expect(isAudible('alarm', 'alarm')).toBe(true)
    expect(isAudible('warning', 'alarm')).toBe(false)
  })

  it('treats nothing as audible when off', () => {
    expect(isAudible('emergency', 'off')).toBe(false)
  })
})
