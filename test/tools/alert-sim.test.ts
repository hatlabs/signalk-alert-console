// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  CATALOGUE,
  ESCALATION_TIMEOUT_SECONDS,
  FLOOD_CELLS,
  HEARTBEAT_SECONDS,
  SOURCE_TIMEOUT_SECONDS,
  clearDelta,
  createSim,
  main,
  raiseDelta,
  randomTick,
  resolveBaseUrl,
  scenario,
  streamUrl
} from '../../tools/alert-sim.mjs'
import type { AlertDelta, Clock, Deps } from '../../tools/alert-sim.mjs'

// Core's ingress rules at signalk-server aadd08a3: alertPath.ts and description.ts.
const PATH_SEGMENT = /^[A-Za-z0-9_-]+$/
const MAX_PATH_LENGTH = 255
const MAX_MESSAGE_LENGTH = 1000
const PRIORITIES = ['emergency', 'alarm', 'warning', 'caution']

const SECOND = 1000

interface FakeClock extends Clock {
  advance(ms: number): void
}

function fakeClock(): FakeClock {
  let now = 0
  let nextId = 0
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = ++nextId
      pending.set(id, { at: now + ms, fn })
      return id
    },
    clearTimeout(handle) {
      pending.delete(handle as number)
    },
    advance(ms) {
      const end = now + ms
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined
        for (const timer of pending) {
          if (timer[1].at <= end && (!due || timer[1].at < due[1].at)) {
            due = timer
          }
        }
        if (!due) {
          break
        }
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    }
  }
}

/** A deterministic uniform RNG (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Sent {
  at: number
  path: string
  value: unknown
}

function recorder(clock: Clock) {
  const sent: Sent[] = []
  const lines: string[] = []
  const send = (delta: AlertDelta) => {
    expect(delta.context).toBe('vessels.self')
    for (const update of delta.updates) {
      for (const { path, value } of update.values) {
        expect(path.startsWith('alerts.')).toBe(true)
        sent.push({ at: clock.now(), path: path.slice('alerts.'.length), value })
      }
    }
  }
  return { sent, lines, send, log: (line: string) => lines.push(line) }
}

function expectValidAlert(path: string, value: unknown) {
  expect(path.length).toBeLessThanOrEqual(MAX_PATH_LENGTH)
  for (const segment of path.split('.')) {
    expect(segment).toMatch(PATH_SEGMENT)
  }
  const { priority, message } = value as { priority: string; message: string }
  expect(PRIORITIES).toContain(priority)
  expect(message.length).toBeGreaterThan(0)
  expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
}

describe('delta builders', () => {
  it('raises with the description as the value under alerts.<path>', () => {
    const value = { priority: 'alarm', message: 'SIM: Low oil pressure', group: 'engine' } as const
    expect(raiseDelta('propulsion.main.oilPressure', value)).toEqual({
      context: 'vessels.self',
      updates: [{ values: [{ path: 'alerts.propulsion.main.oilPressure', value }] }]
    })
  })

  it('clears with a null value', () => {
    expect(clearDelta('navigation.anchor.drag')).toEqual({
      context: 'vessels.self',
      updates: [{ values: [{ path: 'alerts.navigation.anchor.drag', value: null }] }]
    })
  })

  it('catalogue entries pass core path and description rules', () => {
    for (const { path, value } of CATALOGUE) {
      expectValidAlert(path, value)
    }
  })
})

describe('random mode', () => {
  it('raises when nothing is active', () => {
    const actions = randomTick(new Set(), () => 0.99)
    expect(actions).toHaveLength(1)
    expect(actions[0]?.kind).toBe('raise')
  })

  it('never raises a path that is already active', () => {
    const all = new Set(CATALOGUE.map(({ path }) => path))
    expect(randomTick(all, () => 0.99)).toEqual([])
  })

  it('emits valid raises and later clears a subset', () => {
    const clock = fakeClock()
    const rec = recorder(clock)
    const sim = createSim({ send: rec.send, log: rec.log, clock })
    sim.runRandom(seeded(42))
    clock.advance(600 * SECOND)

    const raises = rec.sent.filter((s) => s.value !== null)
    const clears = rec.sent.filter((s) => s.value === null)
    expect(raises.length).toBeGreaterThan(0)
    for (const { path, value } of raises) {
      expectValidAlert(path, value)
    }
    const raised = new Set(raises.map((s) => s.path))
    const cleared = new Set(clears.map((s) => s.path))
    expect(cleared.size).toBeGreaterThan(0)
    for (const path of cleared) {
      expect(raised).toContain(path)
    }
    // A subset: something is still active at the end.
    expect(sim.active().size).toBeGreaterThan(0)
  })
})

describe('named scenarios', () => {
  function play(mode: Parameters<typeof scenario>[0], seconds: number) {
    const clock = fakeClock()
    const rec = recorder(clock)
    const sim = createSim({ send: rec.send, log: rec.log, clock })
    sim.run(scenario(mode).steps)
    clock.advance(seconds * SECOND)
    return rec
  }

  it('escalation keeps one warning live past the escalation timeout', () => {
    const { description } = scenario('escalation')
    expect(description).toContain(`${String(ESCALATION_TIMEOUT_SECONDS)} s`)

    const rec = play('escalation', ESCALATION_TIMEOUT_SECONDS + 30)
    const paths = new Set(rec.sent.map((s) => s.path))
    expect([...paths]).toEqual(['propulsion.main.coolantTemperature'])
    expect(rec.sent[0]).toMatchObject({ at: 0, value: { priority: 'warning' } })
    // Every emission is the unchanged warning: a heartbeat, not a new report.
    for (const s of rec.sent) {
      expect(s.value).toEqual(rec.sent[0]?.value)
    }
    const last = rec.sent[rec.sent.length - 1]
    expect(last.at).toBeGreaterThan(ESCALATION_TIMEOUT_SECONDS * SECOND)
    expect(rec.lines.some((l) => l.includes('escalates it to alarm'))).toBe(true)
  })

  it('stale stops heartbeats for its alert and never clears it', () => {
    const { description } = scenario('stale')
    expect(description).toContain(`${String(SOURCE_TIMEOUT_SECONDS)} s`)

    const rec = play('stale', 300)
    expect(rec.sent.every((s) => s.path === 'environment.depth.belowKeel')).toBe(true)
    expect(rec.sent.some((s) => s.value === null)).toBe(false)
    const times = rec.sent.map((s) => s.at)
    expect(times).toEqual([0, HEARTBEAT_SECONDS * SECOND])
    expect(rec.lines.some((l) => l.includes('silence'))).toBe(true)
  })

  it('return-to-normal clears the condition and keeps reporting it clear', () => {
    const rec = play('return-to-normal', 60)
    expect(rec.sent[0]).toMatchObject({
      at: 0,
      path: 'electrical.batteries.house.voltage',
      value: { priority: 'alarm' }
    })
    const firstClear = rec.sent.findIndex((s) => s.value === null)
    expect(rec.sent[firstClear]?.at).toBe(30 * SECOND)
    // After the clear, the heartbeat keeps re-emitting null as liveness.
    const after = rec.sent.slice(firstClear)
    expect(after.length).toBeGreaterThan(1)
    expect(after.every((s) => s.value === null)).toBe(true)
  })

  it('flood raises many distinct valid alerts at once', () => {
    const rec = play('flood', 0)
    expect(rec.sent).toHaveLength(CATALOGUE.length + FLOOD_CELLS)
    expect(new Set(rec.sent.map((s) => s.path)).size).toBe(rec.sent.length)
    for (const { at, path, value } of rec.sent) {
      expect(at).toBe(0)
      expectValidAlert(path, value)
    }
  })

  it('heartbeats re-emit every active path well inside the source timeout', () => {
    expect(HEARTBEAT_SECONDS).toBeLessThan(SOURCE_TIMEOUT_SECONDS / 2)
    const rec = play('flood', HEARTBEAT_SECONDS)
    const count = rec.sent.filter((s) => s.at === 0).length
    expect(rec.sent.filter((s) => s.at === HEARTBEAT_SECONDS * SECOND)).toHaveLength(count)
  })
})

describe('host resolution', () => {
  it('assumes https and the Traefik port for a bare host', () => {
    expect(resolveBaseUrl('my-boat.local').href).toBe('https://my-boat.local:4430/')
  })

  it('keeps an explicit port on a bare host', () => {
    expect(resolveBaseUrl('my-boat.local:3443').href).toBe('https://my-boat.local:3443/')
  })

  it('uses a full URL as given', () => {
    expect(resolveBaseUrl('http://my-boat.local:3000/admin').href).toBe(
      'http://my-boat.local:3000/'
    )
  })

  it('builds the stream URL with a matching WebSocket scheme', () => {
    expect(streamUrl(new URL('https://my-boat.local:4430'))).toBe(
      'wss://my-boat.local:4430/signalk/v1/stream?subscribe=none'
    )
    expect(streamUrl(new URL('http://my-boat.local:3000'))).toBe(
      'ws://my-boat.local:3000/signalk/v1/stream?subscribe=none'
    )
  })
})

describe('main', () => {
  const events: string[] = []
  const sockets: FakeSocket[] = []

  class FakeSocket extends EventTarget {
    readonly sent: AlertDelta[] = []
    constructor(
      readonly url: string,
      readonly init: { headers: Record<string, string> }
    ) {
      super()
      sockets.push(this)
    }
    send(data: string) {
      const delta = JSON.parse(data) as AlertDelta
      this.sent.push(delta)
      for (const { values } of delta.updates) {
        for (const { path, value } of values) {
          events.push(`${value === null ? 'clear' : 'send'} ${path}`)
        }
      }
    }
    close() {
      events.push('close')
      this.dispatchEvent(Object.assign(new Event('close'), { code: 1000, reason: '' }))
    }
  }

  function deps(overrides: Partial<Deps> = {}) {
    events.length = 0
    sockets.length = 0
    const out: string[] = []
    const err: string[] = []
    let signal: (() => void) | undefined
    const d: Deps = {
      env: { SIGNALK_TOKEN: 'secret-token' },
      fetch: vi.fn(() =>
        Promise.resolve(
          Response.json({
            authenticationRequired: true,
            status: 'loggedIn',
            userLevel: 'readwrite'
          })
        )
      ),
      WebSocket: FakeSocket as unknown as Deps['WebSocket'],
      clock: fakeClock(),
      rng: seeded(1),
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      onSignal: (handler) => {
        signal = handler
      },
      ...overrides
    }
    return { d, out, err, sigint: () => signal?.() }
  }

  it('exits 2 with a message when the token is missing', async () => {
    const { d, err } = deps({ env: {} })
    await expect(main(['my-boat.local', 'flood'], d)).resolves.toBe(2)
    expect(err.join('\n')).toContain('SIGNALK_TOKEN')
    expect(sockets).toHaveLength(0)
  })

  it('exits 2 on an unknown mode', async () => {
    const { d, err } = deps()
    await expect(main(['my-boat.local', 'party'], d)).resolves.toBe(2)
    expect(err.join('\n')).toContain('Usage')
  })

  it('exits 1 when the token only has read access', async () => {
    const { d, err } = deps({
      fetch: vi.fn(() =>
        Promise.resolve(
          Response.json({ authenticationRequired: true, status: 'loggedIn', userLevel: 'readonly' })
        )
      )
    })
    await expect(main(['my-boat.local'], d)).resolves.toBe(1)
    expect(err.join('\n')).toContain('readonly')
    expect(sockets).toHaveLength(0)
  })

  it('exits 1 when the server rejects the token', async () => {
    const { d, err } = deps({
      fetch: vi.fn(() =>
        Promise.resolve(Response.json({ authenticationRequired: true, status: 'notLoggedIn' }))
      )
    })
    await expect(main(['my-boat.local'], d)).resolves.toBe(1)
    expect(err.join('\n')).toContain('did not accept')
  })

  it('exits 1 with a message when loginStatus is not JSON', async () => {
    const { d, err } = deps({
      fetch: vi.fn(() =>
        Promise.resolve(
          new Response('<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } })
        )
      )
    })
    await expect(main(['my-boat.local'], d)).resolves.toBe(1)
    expect(err.join('\n')).toContain(
      'https://my-boat.local:4430/skServer/loginStatus did not return JSON; is this a Signal K server?'
    )
    expect(sockets).toHaveLength(0)
  })

  it('opens a socket when the server does not require authentication', async () => {
    const { d, sigint } = deps({
      fetch: vi.fn(() => Promise.resolve(Response.json({ authenticationRequired: false })))
    })
    const run = main(['my-boat.local', 'stale'], d)
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    sigint()
    await run
  })

  it('points at NODE_EXTRA_CA_CERTS when TLS verification fails', async () => {
    const { d, err } = deps({
      fetch: vi.fn(() =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: new Error('self-signed certificate in certificate chain')
          })
        )
      )
    })
    await expect(main(['my-boat.local'], d)).resolves.toBe(1)
    expect(err.join('\n')).toContain('NODE_EXTRA_CA_CERTS')
    expect(sockets).toHaveLength(0)
  })

  it('exits 1 when loginStatus answers with an HTTP error', async () => {
    const { d, err } = deps({
      fetch: vi.fn(() => Promise.resolve(new Response('oops', { status: 500 })))
    })
    await expect(main(['my-boat.local'], d)).resolves.toBe(1)
    expect(err.join('\n')).toContain('HTTP 500')
    expect(sockets).toHaveLength(0)
  })

  it('exits 2 on a target that is neither a URL nor a host', async () => {
    const { d, err } = deps()
    await expect(main(['my boat'], d)).resolves.toBe(2)
    expect(err.join('\n')).toContain('neither a URL nor a host name')
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('exits 1 and stops sending when the server closes a running session', async () => {
    const clock = fakeClock()
    const { d, err } = deps({ clock })
    const run = main(['my-boat.local', 'flood'], d)
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    sockets[0].dispatchEvent(new Event('open'))
    const sentBeforeClose = sockets[0].sent.length
    expect(sentBeforeClose).toBeGreaterThan(0)

    sockets[0].dispatchEvent(Object.assign(new Event('close'), { code: 1001, reason: '' }))
    await expect(run).resolves.toBe(1)
    expect(err.join('\n')).toContain('raised alerts were not cleared')

    clock.advance(2 * HEARTBEAT_SECONDS * SECOND)
    expect(sockets[0].sent).toHaveLength(sentBeforeClose)
  })

  it('exits 1 on SIGINT before the socket opens', async () => {
    const { d, sigint } = deps()
    const run = main(['my-boat.local', 'flood'], d)
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    sigint()
    await expect(run).resolves.toBe(1)
    expect(sockets[0].sent).toHaveLength(0)
  })

  it('exits 1 with a message when the connection is refused', async () => {
    const { d, err } = deps()
    const run = main(['my-boat.local', 'flood'], d)
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    sockets[0].dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }))
    await expect(run).resolves.toBe(1)
    expect(err.join('\n')).toContain('refused the connection')
  })

  it('authenticates the WebSocket with a bearer header, not the URL', async () => {
    const { d, sigint } = deps()
    const run = main(['my-boat.local', 'stale'], d)
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    expect(sockets[0].url).toBe('wss://my-boat.local:4430/signalk/v1/stream?subscribe=none')
    expect(sockets[0].url).not.toContain('secret-token')
    expect(sockets[0].init.headers.Authorization).toBe('Bearer secret-token')
    sigint()
    await run
  })

  it('on SIGINT clears every raised path before closing', async () => {
    const { d, sigint } = deps()
    const run = main(['my-boat.local', 'flood'], d)
    await vi.waitFor(() => {
      expect(sockets).toHaveLength(1)
    })
    sockets[0].dispatchEvent(new Event('open'))
    const raised = events.filter((e) => e.startsWith('send')).map((e) => e.slice(5))
    expect(raised.length).toBeGreaterThan(0)

    sigint()
    await expect(run).resolves.toBe(0)

    const closeAt = events.indexOf('close')
    expect(closeAt).toBe(events.length - 1)
    const cleared = events.slice(0, closeAt).filter((e) => e.startsWith('clear'))
    expect(cleared.map((e) => e.slice(6)).sort()).toEqual([...raised].sort())
  })
})
