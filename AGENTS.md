# signalk-alert-console

Webapp-only Signal K package: a Lit 3 + Vite UI for the Signal K core alerts API. No server plugin, no `main`; the server serves `public/` at `/signalk-alert-console/`.

## Layout

- `src/index.html`, `src/main.ts` — entry point; Vite root is `src/`.
- `src/components/` — Lit elements (`alert-app` is the root; list, card, detail, history views).
- `src/services/alert-service.ts` — REST and WebSocket client. The API base is defined here.
- `src/services/audio-service.ts` — Web Audio alert tones.
- `src/styles/`, `src/utils/` — shared styles, priority tables and formatters.
- `src/types.ts` — alert types, vendored until a published `@signalk/server-api` carries them.
- `src/public/` — static assets (app icon) copied into the build.
- `test/` — mirrors `src/`; Vitest with happy-dom.

## Commands

`./run help` lists all. `./run build`, `./run dev` (proxies to `SIGNALK_URL`), `./run test`, `./run lint`, `./run format`, `./run typecheck`, `./run ci`. The PR workflow runs `npm run ci` and `npm run build`.

## Conventions

- Types come from `src/types.ts`; do not add ad-hoc alert shapes elsewhere.
- Server URLs are built from the API base in `services/alert-service.ts`.
- ESLint runs `strictTypeChecked` over `src` and `test`. `unbound-method` is off for components because Lit binds `this` for `@event` listeners.
- Tests render real Lit elements and stub `fetch` and `WebSocket` per file.
- No real hostnames or addresses in the repo; it is public. Use placeholders such as `my-server.local`.
