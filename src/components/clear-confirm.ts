/**
 * The prompt that replaces the action row while a Clear awaits confirmation,
 * shared by the card and the detail view. Each keeps its own layout rules.
 */

import { html, css } from 'lit'
import type { LitElement } from 'lit'
import { ICON_CLEAR } from '../styles/icons.js'

export const clearConfirmStyles = css`
  .actions.confirm {
    flex-wrap: wrap;
    align-items: center;
  }
  .confirm-prompt {
    font-weight: 600;
    color: var(--text-primary);
  }
  .actions button[data-action='confirm-clear'] {
    border-color: var(--btn-clear-border);
  }
  .actions.confirm button {
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    font: inherit;
    font-size: 0.85rem;
    font-weight: 600;
    color: var(--text-primary);
  }
`

export interface ClearConfirmOptions {
  /** The alert's message, naming what Confirm clears. */
  message: string
  inFlight: boolean
  onCancel: () => void
  onConfirm: () => void
  onKeydown?: (e: KeyboardEvent) => void
}

/** Cancel comes last, in the slot Clear held, so a second press on Clear cancels. */
export function renderClearConfirm({
  message,
  inFlight,
  onCancel,
  onConfirm,
  onKeydown
}: ClearConfirmOptions) {
  return html`<div
    class="actions confirm"
    role="group"
    aria-labelledby="clear-prompt"
    @keydown=${onKeydown}
  >
    <span id="clear-prompt" class="confirm-prompt">Source silent. Clear this alert?</span>
    <button
      data-action="confirm-clear"
      aria-label="Confirm clear: ${message}"
      ?disabled=${inFlight}
      @click=${onConfirm}
    >
      <svg viewBox="0 0 24 24"><path d=${ICON_CLEAR} /></svg>
      Clear
    </button>
    <button data-action="cancel-clear" aria-label="Cancel clear" @click=${onCancel}>Cancel</button>
  </div>`
}

/** Whether focus is inside the prompt, so dropping it would lose focus. */
export function promptHasFocus(host: LitElement): boolean {
  return (host.shadowRoot?.activeElement?.closest('.actions.confirm') ?? null) !== null
}

/** Focus an action button once the pending render has placed it. */
export async function focusActionAfterRender(host: LitElement, action: string): Promise<void> {
  await host.updateComplete
  host.renderRoot.querySelector<HTMLElement>(`button[data-action="${action}"]`)?.focus()
}
