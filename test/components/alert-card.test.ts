/**
 * AlertCard tests: the selectable summary and the action outcome shown below
 * it stay separate, so links in the outcome are ordinary links.
 */

import { describe, it, expect, afterEach, vi } from 'vitest'
import type { Alert } from '../../src/types.js'
import type { AlertCard } from '../../src/components/alert-card.js'
import { ApiError } from '../../src/services/alert-service.js'

const alert: Alert = {
  id: 'alert-1',
  path: 'test.alert',
  $source: 'test',
  priority: 'alarm',
  state: 'unacknowledged',
  condition: true,
  latching: false,
  silenced: false,
  message: 'Bilge high',
  raisedAt: '2026-02-19T10:00:00.000Z',
  stateChangedAt: '2026-02-19T10:00:00.000Z',
  sourceOnline: true,
  lastSourceUpdate: '2026-02-19T10:00:00.000Z',
  stale: false
}

async function mountCard(props: Partial<AlertCard>): Promise<AlertCard> {
  await import('../../src/components/alert-card.js')
  const el = document.createElement('alert-card') as AlertCard
  el.alert = alert
  el.signInUrl = '/admin/#/login'
  Object.assign(el, props)
  document.body.appendChild(el)
  await el.updateComplete
  return el
}

function selectable(el: AlertCard): Element {
  const found = el.shadowRoot?.querySelector('[role="button"]')
  if (!found) throw new Error('card has no selectable area')
  return found
}

describe('AlertCard', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('keeps the sign-in link of a refusal outside the selectable area', async () => {
    const el = await mountCard({ actionError: new ApiError(401, 'Permission Denied') })

    const link = el.shadowRoot?.querySelector('.action-error a')
    expect(link).not.toBeNull()
    expect(selectable(el).contains(link ?? null)).toBe(false)
    expect(selectable(el).textContent).toContain('Bilge high')
  })

  it('does not open the detail when the sign-in link is clicked', async () => {
    const el = await mountCard({ actionError: new ApiError(401, 'Permission Denied') })
    const selected = vi.fn()
    el.addEventListener('alert-select', selected)
    const link = el.shadowRoot?.querySelector('.action-error a')
    if (!link) throw new Error('no sign-in link')
    // Keep happy-dom from navigating; the click still propagates.
    link.addEventListener('click', (e) => {
      e.preventDefault()
    })

    link.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, cancelable: true }))

    expect(selected).not.toHaveBeenCalled()
  })

  it('keeps the on-this-display-only marker outside the selectable area', async () => {
    const el = await mountCard({ localOnly: true })

    const marker = el.shadowRoot?.querySelector('.local-only')
    expect(marker).not.toBeNull()
    expect(selectable(el).contains(marker ?? null)).toBe(false)
  })

  it('opens the detail from the summary', async () => {
    const el = await mountCard({})
    const selected = vi.fn()
    el.addEventListener('alert-select', selected)

    ;(selectable(el) as HTMLElement).click()

    expect(selected).toHaveBeenCalledOnce()
  })
})
