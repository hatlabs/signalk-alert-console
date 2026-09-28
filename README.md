# signalk-alert-console

Reference alerts UI for the Signal K core alerts API.

The console lists the vessel's active alerts, lets an operator acknowledge, silence and clear them, sounds an audible signal for new alerts, and shows the alert history. It is a webapp-only Signal K package: it installs no server plugin and keeps no alert state of its own. The alert lifecycle belongs to the server's core alerts API (`/signalk/v2/api/alerts` and `alerts.*` deltas), introduced in these Signal K server pull requests:

- [SignalK/signalk-server PR 3009](https://github.com/SignalK/signalk-server/pull/3009)
- [SignalK/signalk-server PR 3010](https://github.com/SignalK/signalk-server/pull/3010)
- [SignalK/signalk-server PR 3011](https://github.com/SignalK/signalk-server/pull/3011)
- [SignalK/signalk-server PR 3012](https://github.com/SignalK/signalk-server/pull/3012)

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

## License

Apache-2.0. Copyright Hat Labs Oy.
