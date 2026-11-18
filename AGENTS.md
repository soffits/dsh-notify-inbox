# dsh-notify-inbox

A DeepSeek Harness (DSH) plugin: a per-person notification inbox read from JSON-lines files, with Web Push and buttons on each notification.

## Layout

- `index.js`: Host plugin (`notify-inbox` row): config schema, wiring, pushing new records when the inbox file changes.
- `src/routes.js`: the `/api/notify-inbox/*` exact Fetch routes. Every answer is decided per request from `requestIdentity` and the person mapping (`src/access.js`, shared in shape with dsh-card-board).
- `src/store.js`: reading `inbox.jsonl` incrementally (records and `type: handled` status lines), read marks, the summary line, the asks (`asks.json`, read fresh each time).
- `src/view.js`: records and asks → items (threads folded, asks deciding Needs you, the group each shows in now, counts); `src/changes.js`: `fs.watch` on the folders, change notices for the events stream and the push; `src/domains.js`: the domain → icon map.
- `src/push.js`: subscriptions, cursor, pushing new records; `src/webpush.js`: RFC 8291 encryption and RFC 8292 VAPID on node:crypto; `src/sw.js`: the service worker (served as is).
- `src/actions.js`: presses on buttons → action events (log + `cronJobs` service when present); `src/reply.js`: a reply to an ask, steered into the session that asked, or into a new session when there is none or it is gone (DSH's `agents`, `sessionController`, `sessionQuery`, `sessions`, `workspaceRegistry`, `sessionTitle` services, looked up per reply).
- `client.js`: Web UI half in DSH's Client module format: sidebar entry with unread badge, the page, push control. The buttons come from `@soffits/dsh-ui-actions` (`ctx.uiActions`, injected when installed): the page passes each notification as `about` and its own press call; the package owns the buttons' words and the chat card. It is built from DSH's primitives and `ctx.uiKit` first; the little CSS of its own is listed with reasons in `docs/ui.md` (keep that list true).

## Rules

- The plugin never writes `inbox.jsonl`; the writer never writes the plugin's files. Everything the plugin owns lives in `dataDir` (or `vapidFile`).
- Access is checked on the server for every route; hiding in the browser is never the control.
- No runtime dependencies beyond `@deepseek-ai/schemastery`; Web Push stays on node:crypto (tested against the RFC 8291 vector).
- Nothing about any particular home, person or deployment in code, docs, tests or commits.

## Checks

After UI changes, look at the page at 390 and 1280 px, light and dark, in two languages. `test/fixtures/` holds the export lists the names test checks against; refresh them from the npm tarballs when the supported DSH or kit version moves.


`npm run check` (syntax), `npm test` (Node test runner, offline). Conventional Commits; versions follow semver from commit types.
- Releases: after bumping the version and `CHANGELOG.md` and merging, pushing the tag `vX.Y.Z` runs `.github/workflows/publish.yml`, which publishes to npm by trusted publishing (OIDC, with provenance, no stored token; the package's trusted publisher on npmjs.com names this repo and `publish.yml`, so renaming either breaks it) and creates the GitHub release. Don't publish by hand.
