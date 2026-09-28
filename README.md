# signalk-alert-console

Reference alerts UI for the Signal K core alerts API.

The console lists the vessel's active alerts, lets an operator acknowledge, silence and clear them, sounds an audible signal for new alerts, and shows the alert history. It is a webapp-only Signal K package: it installs no server plugin and keeps no alert state of its own. The alert lifecycle belongs to the server's core alerts API (`/signalk/v2/api/alerts` and `alerts.*` deltas), introduced in these Signal K server pull requests:

- [SignalK/signalk-server PR 3009](https://github.com/SignalK/signalk-server/pull/3009)
- [SignalK/signalk-server PR 3010](https://github.com/SignalK/signalk-server/pull/3010)
- [SignalK/signalk-server PR 3011](https://github.com/SignalK/signalk-server/pull/3011)
- [SignalK/signalk-server PR 3012](https://github.com/SignalK/signalk-server/pull/3012)

The one exception is an outage. While the server cannot be reached, or the session has expired, an acknowledge or silence takes effect at once on that display only, without being sent: its tone stops and the alert is marked "On this display only — not confirmed by the server". Nothing is sent later; the server's state replaces the local one as soon as the console hears from it again, so an alert the server still has unacknowledged sounds again. When an action fails while the console is connected, it asks the server at once whether it still answers: if it does, the failure is shown on the alert and nothing changes locally; if not, the console shows the connection as lost and the action takes effect on that display only.

## Requirements

- A Signal K server that carries the core alerts API.
- `signalk-alert-manager` uninstalled. Core ingests every `alerts.*` delta, so an installed alert-manager plugin feeds its own alerts into core and the console shows both sets mixed together.

## Development

Requires Node.js 22 or later.

```bash
npm install
./run install-hooks                          # lefthook pre-commit checks
SIGNALK_URL=http://my-server.local:3000 ./run dev
```

The dev server proxies `/signalk`, `/skServer` and `/admin` to `SIGNALK_URL` (default `http://localhost:3000`).

`./run help` lists every command. The common ones:

| Command | What it does |
|---|---|
| `./run build` | Build the webapp into `public/` |
| `./run test` | Run the Vitest suite |
| `./run ci` | Typecheck, lint, format check and tests, as CI runs them |

The server serves the built package at `/signalk-alert-console/` and lists it among its webapps as "Alert Console".

## Deploying to a HaLOS device

`./run deploy-halos <host>` builds locally, syncs `public/` and `package.json` into the device's Signal K data volume, registers the package as a `file:` dependency so later `npm install` runs keep it, and restarts Signal K only when the device is not already serving the new build. It exits non-zero unless the device serves this build's entry bundle, and warns when the server does not answer the core alerts status endpoint. It needs ssh access with passwordless sudo on the device; pass `local` to run it on the device itself.

## Generating test alerts

`./run simulate <host-or-url> [mode]` raises and clears synthetic alerts on a server the way a real source does: it sends `alerts.<path>` deltas over the Signal K WebSocket (`/signalk/v1/stream`), where a `{priority, message, group}` value raises or updates an alert and `null` clears its condition. It re-emits every path every 15 seconds as a liveness heartbeat, because core marks a delta-sourced alert stale when its source goes quiet (60 seconds by default). Alerts raised through REST are exempt from that check, so only delta ingress exercises stale handling.

```bash
export SIGNALK_TOKEN=...                  # a read/write token
export NODE_EXTRA_CA_CERTS=halos-ca.crt   # the server's private CA, if it has one
./run simulate my-boat.local              # https://my-boat.local:4430, random mode
./run simulate https://my-boat.local:4430 flood
```

- The target is a full URL, or a host, which means `https://<host>:4430` (HaLOS's Traefik port).
- `SIGNALK_TOKEN` must hold a token with read/write access: the server drops deltas from a read-only client without telling it, so the tool checks `/skServer/loginStatus` first and refuses to start otherwise. The token travels in an `Authorization` header, not the URL.
- TLS is always verified. For a server whose certificate comes from a private CA, point `NODE_EXTRA_CA_CERTS` at that CA's PEM file.
- Requires Node.js 22.4 or later (the global `WebSocket`); no dependencies. The tool is not part of the npm package.

| Mode | What it does |
|---|---|
| `random` (default) | Every 2 seconds, raises an alert at random priority and clears active ones at random, like the in-app simulator that alert-manager had |
| `escalation` | Raises one warning and keeps it live; left unacknowledged, core escalates it to alarm after 300 seconds |
| `stale` | Raises one warning, then stops its heartbeat without clearing it; core marks it stale 60 seconds after the last emission |
| `return-to-normal` | Raises an alarm and clears its condition after 30 seconds; unacknowledged, it stays as return-to-normal until acknowledged |
| `flood` | Raises 30 alerts at once and keeps them live |

Ctrl-C (or SIGTERM) sends `null` for every path the tool raised, then closes the connection. Clearing a condition does not remove an alert that nobody acknowledged: core keeps warnings, alarms and emergencies in return-to-normal until an operator acknowledges them, while cautions clear at once. Each emitted event prints one log line.

The alert paths are realistic (`propulsion.main.coolantTemperature`, `navigation.anchor.drag`, and so on), so do not point the tool at a vessel whose own sources raise alerts on the same paths: the simulator takes those alerts over and clears them on exit.

## License

Apache-2.0. Copyright Hat Labs Oy.
