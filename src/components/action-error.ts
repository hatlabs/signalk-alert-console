/**
 * Inline message for a refused or failed alert action, shared by the card,
 * the list toolbar and the detail view.
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
