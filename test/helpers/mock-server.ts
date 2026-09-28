/**
 * Fetch stand-in that answers the availability probe and the login status on
 * their own mocks, so a suite's own fetch mock sees only the requests it cares
 * about (and its queued one-off responses are not consumed by the probe).
 */

import { expect, vi } from 'vitest'
import type { Mock } from 'vitest'

export const STATUS_PATH = '/signalk/v2/api/alerts/status'
export const LOGIN_STATUS_PATH = '/skServer/loginStatus'

/** Matches the timeout signal every request carries. */
export const ANY_SIGNAL = expect.any(AbortSignal) as AbortSignal

type FetchFn = (input: string, init?: RequestInit) => unknown

export interface MockServer {
  /** Answers `GET /signalk/v2/api/alerts/status`; 200 by default. */
  status: Mock<FetchFn>
  /** Answers `GET /skServer/loginStatus`; OIDC off by default. */
  loginStatus: Mock<FetchFn>
}

export function jsonResponse(status: number, body: unknown, statusText = ''): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' }
  })
}

export function textResponse(status: number, body: string, statusText = ''): Response {
  return new Response(body, { status, statusText, headers: { 'Content-Type': 'text/plain' } })
}

/** A status answer; each call builds a fresh Response since a body reads once. */
export function statusReply(status: number): () => Promise<Response> {
  return () =>
    Promise.resolve(
      status === 200
        ? jsonResponse(200, { store: { degraded: false } })
        : textResponse(status, status === 401 ? 'Unauthorized' : 'Error')
    )
}

/**
 * A request the server accepts but never answers. Like a real fetch, it
 * rejects when the request's signal aborts.
 */
export function hangingReply(_input: string, init?: RequestInit): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(init.signal?.reason as Error)
    })
  })
}

/** Stub the global fetch; requests other than the probe and login status go to `api`. */
export function stubServer(api: FetchFn): MockServer {
  const status = vi.fn<FetchFn>(statusReply(200))
  const loginStatus = vi.fn<FetchFn>(() =>
    Promise.resolve(jsonResponse(200, { oidcEnabled: false }))
  )
  vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
    const { pathname } = new URL(input, 'http://my-server.local')
    if (pathname === STATUS_PATH) return status(input, init)
    if (pathname === LOGIN_STATUS_PATH) return loginStatus(input, init)
    return api(input, init)
  })
  return { status, loginStatus }
}
