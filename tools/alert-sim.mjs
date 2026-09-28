#!/usr/bin/env node
/**
 * Terminal alert generator for the Signal K core alerts API.
 *
 * Sends `alerts.<path>` deltas over the Signal K WebSocket, the ingress real
 * sources use: a `{priority, message, group}` value raises or updates an
 * alert, `null` clears its condition. Active paths are re-emitted as a
 * liveness heartbeat, because core marks a delta-sourced alert stale when its
 * source goes quiet. On SIGINT or SIGTERM every path it raised is cleared.
 *
 * Plain ESM with no dependencies, so it runs on Node 22.4+ as is.
 */

import { pathToFileURL } from 'node:url'

/** Core's `escalation.timeoutSeconds` default (`src/api/alerts/index.ts`). */
export const ESCALATION_TIMEOUT_SECONDS = 300

/** Core's `DEFAULT_SOURCE_TIMEOUT_SECONDS` (`src/api/alerts/alertManager.ts`). */
export const SOURCE_TIMEOUT_SECONDS = 60

/** Well inside the source timeout, so a live alert never goes stale. */
export const HEARTBEAT_SECONDS = 15

/** The old UI simulator's tick. */
export const RANDOM_TICK_SECONDS = 2

const RAISE_PROBABILITY = 0.114
const CLEAR_PROBABILITY = 0.05

const DEFAULT_PORT = '4430'
const MS_PER_SECOND = 1000
const CLOSE_TIMEOUT_MS = 2000
const FLOOD_CELLS = 20

export const MODES = /** @type {const} */ ([
  'random',
  'escalation',
  'stale',
  'return-to-normal',
  'flood'
])

/** @typedef {(typeof MODES)[number]} Mode */
/** @typedef {'emergency' | 'alarm' | 'warning' | 'caution'} Priority */
/** @typedef {{ priority: Priority, message: string, group: string }} AlertValue */
/** @typedef {{ path: string, value: AlertValue }} AlertSpec */
/**
 * @typedef {{
 *   context: string,
 *   updates: { values: { path: string, value: AlertValue | null }[] }[]
 * }} AlertDelta
 */
/**
 * @typedef {{ at: number, kind: 'raise', path: string, value: AlertValue }
 *   | { at: number, kind: 'clear', path: string }
 *   | { at: number, kind: 'silence', path: string }
 *   | { at: number, kind: 'note', text: string }} Step
 */
/** @typedef {{ description: string, steps: Step[] }} Scenario */
/**
 * @typedef {{
 *   now(): number,
 *   setTimeout(fn: () => void, ms: number): unknown,
 *   clearTimeout(handle: unknown): void
 * }} Clock
 */

/** @type {Clock} */
export const systemClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => {
    clearTimeout(/** @type {NodeJS.Timeout} */ (handle))
  }
}

/** @type {readonly AlertSpec[]} */
export const CATALOGUE = /** @type {AlertSpec[]} */ ([
  {
    path: 'propulsion.main.coolantTemperature',
    value: { priority: 'warning', message: 'Engine coolant temperature high', group: 'engine' }
  },
  {
    path: 'propulsion.main.oilPressure',
    value: { priority: 'alarm', message: 'Low oil pressure', group: 'engine' }
  },
  {
    path: 'electrical.batteries.house.voltage',
    value: { priority: 'warning', message: 'Battery voltage below threshold', group: 'electrical' }
  },
  {
    path: 'environment.inside.bilge.waterLevel',
    value: { priority: 'alarm', message: 'Bilge water level high', group: 'safety' }
  },
  {
    path: 'navigation.gnss.signalLost',
    value: { priority: 'warning', message: 'GPS signal lost', group: 'navigation' }
  },
  {
    path: 'navigation.closestApproach.cpa',
    value: { priority: 'alarm', message: 'AIS target CPA alarm', group: 'navigation' }
  },
  {
    path: 'navigation.anchor.drag',
    value: { priority: 'emergency', message: 'Anchor drag detected', group: 'navigation' }
  },
  {
    path: 'environment.depth.belowKeel',
    value: { priority: 'warning', message: 'Depth below minimum', group: 'navigation' }
  },
  {
    path: 'tanks.fuel.main.currentLevel',
    value: { priority: 'caution', message: 'Fuel level low', group: 'engine' }
  },
  {
    path: 'steering.rudderAngle.sensorFault',
    value: { priority: 'caution', message: 'Rudder angle sensor fault', group: 'steering' }
  }
]).map(({ path, value }) => ({
  path,
  value: { ...value, message: `SIM: ${value.message}` }
}))

/** @type {readonly { priority: Priority, weight: number }[]} */
const PRIORITY_WEIGHTS = [
  { priority: 'emergency', weight: 0.05 },
  { priority: 'alarm', weight: 0.15 },
  { priority: 'warning', weight: 0.4 },
  { priority: 'caution', weight: 0.4 }
]

/**
 * @param {string} path
 * @param {AlertValue} value
 * @returns {AlertDelta}
 */
export function raiseDelta(path, value) {
  return {
    context: 'vessels.self',
    updates: [{ values: [{ path: `alerts.${path}`, value }] }]
  }
}

/**
 * @param {string} path
 * @returns {AlertDelta}
 */
export function clearDelta(path) {
  return {
    context: 'vessels.self',
    updates: [{ values: [{ path: `alerts.${path}`, value: null }] }]
  }
}

/**
 * @param {() => number} rng
 * @returns {Priority}
 */
function pickPriority(rng) {
  const r = rng()
  let cumulative = 0
  for (const { priority, weight } of PRIORITY_WEIGHTS) {
    cumulative += weight
    if (r < cumulative) {
      return priority
    }
  }
  return 'caution'
}

/**
 * One tick of the old UI simulator's raise/clear mix: always raise when nothing
 * is active, otherwise sometimes; clear each active path with a small chance.
 *
 * @param {ReadonlySet<string>} active paths currently raised
 * @param {() => number} rng uniform in [0, 1)
 * @returns {({ kind: 'raise', path: string, value: AlertValue } | { kind: 'clear', path: string })[]}
 */
export function randomTick(active, rng) {
  /** @type {({ kind: 'raise', path: string, value: AlertValue } | { kind: 'clear', path: string })[]} */
  const actions = []
  for (const path of active) {
    if (rng() < CLEAR_PROBABILITY) {
      actions.push({ kind: 'clear', path })
    }
  }
  if (active.size === 0 || rng() < RAISE_PROBABILITY) {
    const idle = CATALOGUE.filter((entry) => !active.has(entry.path))
    if (idle.length > 0) {
      const entry = idle[Math.floor(rng() * idle.length)]
      actions.push({
        kind: 'raise',
        path: entry.path,
        value: { ...entry.value, priority: pickPriority(rng) }
      })
    }
  }
  return actions
}

/**
 * @param {string} path
 * @returns {AlertSpec}
 */
function entry(path) {
  const found = CATALOGUE.find((candidate) => candidate.path === path)
  if (!found) {
    throw new Error(`no catalogue entry for ${path}`)
  }
  return found
}

/**
 * The named scenarios as timed steps, `at` in seconds from the start.
 *
 * @param {Exclude<Mode, 'random'>} mode
 * @returns {Scenario}
 */
export function scenario(mode) {
  switch (mode) {
    case 'escalation': {
      const { path, value } = entry('propulsion.main.coolantTemperature')
      return {
        description:
          `Raises one warning and keeps it live. Leave it unacknowledged: core ` +
          `escalates an unacknowledged warning to alarm after ` +
          `${String(ESCALATION_TIMEOUT_SECONDS)} s (escalation.timeoutSeconds).`,
        steps: [
          { at: 0, kind: 'raise', path, value },
          {
            at: ESCALATION_TIMEOUT_SECONDS,
            kind: 'note',
            text: `${path} has been unacknowledged for ${String(ESCALATION_TIMEOUT_SECONDS)} s; core escalates it to alarm now`
          }
        ]
      }
    }
    case 'stale': {
      const { path, value } = entry('environment.depth.belowKeel')
      const silentAt = HEARTBEAT_SECONDS + 5
      return {
        description:
          `Raises one warning, heartbeats it, then goes silent at ` +
          `${String(silentAt)} s without clearing it. Core marks it stale ` +
          `${String(SOURCE_TIMEOUT_SECONDS)} s after its last emission.`,
        steps: [
          { at: 0, kind: 'raise', path, value },
          { at: silentAt, kind: 'silence', path }
        ]
      }
    }
    case 'return-to-normal': {
      const { path, value } = entry('electrical.batteries.house.voltage')
      const clearAt = 30
      return {
        description:
          `Raises an alarm and clears its condition at ${String(clearAt)} s. ` +
          `Leave it unacknowledged: core keeps it as rtn-unacknowledged until ` +
          `an operator acknowledges it.`,
        steps: [
          { at: 0, kind: 'raise', path, value: { ...value, priority: 'alarm' } },
          { at: clearAt, kind: 'clear', path }
        ]
      }
    }
    case 'flood':
      return {
        description:
          `Raises ${String(CATALOGUE.length + FLOOD_CELLS)} alerts at once ` +
          `and keeps them live.`,
        steps: [
          ...CATALOGUE.map(
            ({ path, value }) => /** @type {Step} */ ({ at: 0, kind: 'raise', path, value })
          ),
          ...Array.from({ length: FLOOD_CELLS }, (_, i) => {
            const cell = String(i + 1)
            return /** @type {Step} */ ({
              at: 0,
              kind: 'raise',
              path: `electrical.batteries.house.cell${cell}.voltage`,
              value: {
                priority: i % 2 === 0 ? 'warning' : 'caution',
                message: `SIM: Cell ${cell} voltage out of range`,
                group: 'electrical'
              }
            })
          })
        ]
      }
  }
}

/**
 * The emitting side: tracks what each path last said, heartbeats it, and
 * clears everything on shutdown.
 *
 * @param {{
 *   send: (delta: AlertDelta) => void,
 *   log: (line: string) => void,
 *   clock?: Clock
 * }} options
 */
export function createSim({ send, log, clock = systemClock }) {
  /** @type {Map<string, AlertValue | null>} */
  const values = new Map()
  /** @type {Set<string>} */
  const silent = new Set()
  /** @type {Set<unknown>} */
  const timers = new Set()

  /** @param {string} text */
  const stamp = (text) => {
    log(`${new Date(clock.now()).toTimeString().slice(0, 8)} ${text}`)
  }

  /**
   * @param {() => void} fn
   * @param {number} ms
   */
  const schedule = (fn, ms) => {
    const handle = clock.setTimeout(() => {
      timers.delete(handle)
      fn()
    }, ms)
    timers.add(handle)
  }

  const heartbeat = () => {
    const live = [...values].filter(([path]) => !silent.has(path))
    if (live.length > 0) {
      send({
        context: 'vessels.self',
        updates: [{ values: live.map(([path, value]) => ({ path: `alerts.${path}`, value })) }]
      })
      stamp(`heartbeat  ${String(live.length)} path(s)`)
    }
    schedule(heartbeat, HEARTBEAT_SECONDS * MS_PER_SECOND)
  }

  /** Paths that currently carry a raised value. */
  const active = () =>
    new Set([...values].filter(([, value]) => value !== null).map(([path]) => path))

  /**
   * @param {string} path
   * @param {AlertValue} value
   */
  const raise = (path, value) => {
    values.set(path, value)
    silent.delete(path)
    send(raiseDelta(path, value))
    stamp(`raise      ${value.priority.padEnd(9)} ${path}  "${value.message}"`)
  }

  /** @param {string} path */
  const clear = (path) => {
    values.set(path, null)
    silent.delete(path)
    send(clearDelta(path))
    stamp(`clear      ${path}`)
  }

  /**
   * Stop heartbeating a path, as a source that has gone quiet would.
   *
   * @param {string} path
   */
  const silence = (path) => {
    silent.add(path)
    stamp(
      `silence    ${path}  (no more heartbeats; core marks it stale ` +
        `${String(SOURCE_TIMEOUT_SECONDS)} s after its last emission)`
    )
  }

  /** @param {Step} step */
  const perform = (step) => {
    switch (step.kind) {
      case 'raise':
        raise(step.path, step.value)
        break
      case 'clear':
        clear(step.path)
        break
      case 'silence':
        silence(step.path)
        break
      case 'note':
        stamp(`note       ${step.text}`)
        break
    }
  }

  /** Cancel every pending step, tick and heartbeat. */
  const halt = () => {
    for (const handle of timers) {
      clock.clearTimeout(handle)
    }
    timers.clear()
  }

  return {
    active,

    /** @param {Step[]} steps */
    run(steps) {
      for (const step of steps) {
        if (step.at === 0) {
          perform(step)
        } else {
          schedule(() => {
            perform(step)
          }, step.at * MS_PER_SECOND)
        }
      }
      schedule(heartbeat, HEARTBEAT_SECONDS * MS_PER_SECOND)
    },

    /** @param {() => number} rng */
    runRandom(rng) {
      const tick = () => {
        for (const action of randomTick(active(), rng)) {
          if (action.kind === 'raise') {
            raise(action.path, action.value)
          } else {
            clear(action.path)
          }
        }
        schedule(tick, RANDOM_TICK_SECONDS * MS_PER_SECOND)
      }
      tick()
      schedule(heartbeat, HEARTBEAT_SECONDS * MS_PER_SECOND)
    },

    halt,

    /** Halt, then send a clear for every path ever raised. */
    shutdown() {
      halt()
      for (const path of values.keys()) {
        send(clearDelta(path))
        stamp(`clear      ${path}  (exit)`)
      }
      values.clear()
    }
  }
}

/**
 * The server's base URL: a full URL is used as given, a bare host gets
 * `https://` and, without a port, the HaLOS Traefik port.
 *
 * @param {string} target
 * @returns {URL}
 */
export function resolveBaseUrl(target) {
  if (/^https?:\/\//i.test(target)) {
    return new URL(new URL(target).origin)
  }
  const url = new URL(`https://${target}`)
  if (url.port === '') {
    url.port = DEFAULT_PORT
  }
  return new URL(url.origin)
}

/**
 * @param {URL} base
 * @returns {string}
 */
export function streamUrl(base) {
  const url = new URL('/signalk/v1/stream?subscribe=none', base)
  url.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.href
}

const USAGE = `Usage: alert-sim <host-or-url> [${MODES.join('|')}]

  host-or-url  a URL (https://my-boat.local:4430) or a host (my-boat.local,
               which means https://my-boat.local:4430)
  mode         random (default), escalation, stale, return-to-normal, flood

Environment:
  SIGNALK_TOKEN        a read/write Signal K token (required)
  NODE_EXTRA_CA_CERTS  a PEM file with the server's private CA, for TLS`

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const cause = error.cause instanceof Error ? `: ${error.cause.message}` : ''
  return `${error.message}${cause}`
}

/**
 * Refuse to start with a token the server will not let write: a read-only
 * principal's deltas are dropped without a reply on the WebSocket.
 *
 * @param {URL} base
 * @param {string} token
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<string | undefined>} an error message, or undefined when writing is allowed
 */
export async function checkWriteAccess(base, token, fetchImpl) {
  /** @type {Response} */
  let res
  try {
    res = await fetchImpl(new URL('/skServer/loginStatus', base), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
    })
  } catch (error) {
    const reason = describeError(error)
    const hint = /certificate|self.signed/i.test(reason)
      ? ' For a server with a private CA, set NODE_EXTRA_CA_CERTS to its certificate.'
      : ''
    return `cannot reach ${base.origin} (${reason}).${hint}`
  }
  if (!res.ok) {
    return `${base.origin}/skServer/loginStatus answered HTTP ${String(res.status)}`
  }
  /** @type {{ authenticationRequired?: boolean, status?: string, userLevel?: string }} */
  let status
  try {
    status = /** @type {typeof status} */ (await res.json())
  } catch {
    return `${base.origin}/skServer/loginStatus did not return JSON; is this a Signal K server?`
  }
  if (status.authenticationRequired === false) {
    return undefined
  }
  if (status.status !== 'loggedIn') {
    return 'the server did not accept SIGNALK_TOKEN (expired, revoked or issued by another server)'
  }
  if (status.userLevel !== 'readwrite' && status.userLevel !== 'admin') {
    return `SIGNALK_TOKEN has ${String(status.userLevel)} access; sending deltas needs readwrite or admin`
  }
  return undefined
}

/**
 * @typedef {{
 *   env: Record<string, string | undefined>,
 *   fetch: typeof fetch,
 *   WebSocket: new (url: string, init: { headers: Record<string, string> }) => WebSocket,
 *   clock: Clock,
 *   rng: () => number,
 *   out: (line: string) => void,
 *   err: (line: string) => void,
 *   onSignal: (handler: () => void) => void
 * }} Deps
 */

/**
 * @param {string[]} args command-line arguments after the script name
 * @param {Deps} deps
 * @returns {Promise<number>} the exit code
 */
export async function main(args, deps) {
  const [target, requested = 'random'] = args
  if (!target || !MODES.includes(/** @type {Mode} */ (requested))) {
    deps.err(USAGE)
    return 2
  }
  const mode = /** @type {Mode} */ (requested)
  const token = deps.env.SIGNALK_TOKEN
  if (!token) {
    deps.err('SIGNALK_TOKEN is not set; it must hold a read/write Signal K token.')
    return 2
  }

  /** @type {URL} */
  let base
  try {
    base = resolveBaseUrl(target)
  } catch {
    deps.err(`"${target}" is neither a URL nor a host name.`)
    return 2
  }

  const refusal = await checkWriteAccess(base, token, deps.fetch)
  if (refusal) {
    deps.err(`alert-sim: ${refusal}`)
    return 1
  }

  const url = streamUrl(base)
  const ws = new deps.WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })

  return new Promise((resolve) => {
    let opened = false
    let stopping = false
    const sim = createSim({
      send: (delta) => {
        ws.send(JSON.stringify(delta))
      },
      log: deps.out,
      clock: deps.clock
    })

    ws.addEventListener('open', () => {
      opened = true
      deps.out(`Connected to ${url} (${mode}). Ctrl-C clears every raised alert and exits.`)
      if (mode === 'random') {
        deps.out(
          `Raises and clears alerts at random every ${String(RANDOM_TICK_SECONDS)} s; ` +
            `heartbeat every ${String(HEARTBEAT_SECONDS)} s.`
        )
        sim.runRandom(deps.rng)
      } else {
        const { description, steps } = scenario(mode)
        deps.out(description)
        sim.run(steps)
      }
    })

    ws.addEventListener('close', (event) => {
      if (stopping) {
        resolve(0)
        return
      }
      sim.halt()
      deps.err(
        opened
          ? `alert-sim: the server closed the connection (${String(event.code)}); raised alerts were not cleared.`
          : `alert-sim: ${url} refused the connection (${String(event.code)}${event.reason ? `: ${event.reason}` : ''}).`
      )
      resolve(1)
    })

    deps.onSignal(() => {
      if (stopping) {
        return
      }
      stopping = true
      if (!opened) {
        ws.close()
        resolve(1)
        return
      }
      sim.shutdown()
      ws.close(1000)
      deps.clock.setTimeout(() => {
        resolve(0)
      }, CLOSE_TIMEOUT_MS)
    })
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    fetch: globalThis.fetch,
    WebSocket: globalThis.WebSocket,
    clock: systemClock,
    rng: Math.random,
    out: (line) => {
      console.log(line)
    },
    err: (line) => {
      console.error(line)
    },
    onSignal: (handler) => {
      process.once('SIGINT', handler)
      process.once('SIGTERM', handler)
    }
  })
  process.exit(code)
}
