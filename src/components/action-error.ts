/**
 * Inline outcome of an alert action, shared by the card, the list toolbar and
 * the detail view: a refused or failed action, or one that took effect on this
 * display only because the server could not be reached.
 */

import { html, css } from 'lit'
import { ApiError } from '../services/alert-service.js'

export const actionErrorStyles = css`
  .action-error {
    margin-top: 0.375rem;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--error-text);
  }
  .action-error a {
    color: inherit;
  }
  .local-only {
    display: inline-block;
    margin-top: 0.375rem;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    background: var(--badge-stale-bg);
    color: var(--badge-stale-text);
    font-size: 0.75rem;
    font-weight: 600;
  }
`

/** The service rejects with ApiError; anything else is shown by its message. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(0, error instanceof Error ? error.message : String(error))
}

/** A 401 links "sign in" to the sign-in target; other errors show their message. */
export function renderActionError(error: ApiError, signInUrl: string) {
  return html`<div class="action-error" role="alert">
    ${
      error.status === 401
        ? html`Not permitted — <a href=${signInUrl}>sign in</a> with a read/write account`
        : error.message
    }
  </div>`
}

/** Marks an alert acknowledged or silenced here while the server could not be told. */
export function renderLocalOnly() {
  return html`<div class="local-only" role="status">
    On this display only — not confirmed by the server
  </div>`
}
