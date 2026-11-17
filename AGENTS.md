# dsh-notify-inbox

A DeepSeek Harness (DSH) plugin: a per-person notification inbox read from JSON-lines files, with Web Push and buttons on each notification.

## Layout

- `index.js`: Host plugin (`notify-inbox` row): config schema, wiring, the push scan loop.
- `src/routes.js`: the `/api/notify-inbox/*` exact Fetch routes. Every answer is decided per request from `requestIdentity` and the person mapping (`src/access.js`, shared in shape with dsh-card-board).
- `src/store.js`: reading `inbox.jsonl` incrementally (records and `type: handled` status lines), read marks.
- `src/push.js`: subscriptions, cursor, pushing new records; `src/webpush.js`: RFC 8291 encryption and RFC 8292 VAPID on node:crypto; `src/sw.js`: the service worker (served as is).
- `src/actions.js`: presses on buttons → action events (log + `cronJobs` service when present).
- `client.js`: Web UI half in DSH's Client module format: sidebar entry with unread badge, the page, push control. `client.actions.js`: the action buttons, a copy of dsh-card-board's shared module (only `OWNER` differs); update both together.

## Rules

- The plugin never writes `inbox.jsonl`; the writer never writes the plugin's files. Everything the plugin owns lives in `dataDir` (or `vapidFile`).
- Access is checked on the server for every route; hiding in the browser is never the control.
- No runtime dependencies beyond `@deepseek-ai/schemastery`; Web Push stays on node:crypto (tested against the RFC 8291 vector).
- Nothing about any particular home, person or deployment in code, docs, tests or commits.

## Checks

`npm run check` (syntax), `npm test` (Node test runner, offline). Conventional Commits; versions follow semver from commit types.
