# dsh-notify-inbox

A notification inbox for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Something outside DSH (a notification router, a cron script, a watcher) files notifications as JSON lines, one folder per person. The plugin shows each signed-in person their own inbox in the Web UI, keeps read and unread per person on the server, pushes new ones to the browsers and installed home-screen apps they turned notifications on for, and gives every notification buttons: ask the agent about it, mark it done, remind me later.

The page has two views, **All** and **Unread** (only what you haven't read), both strictly by time, newest first. It holds notices: what waits on your answer belongs to a list of your own (a Todo, a board) and is answered there, so an inbox never shows it a second time. Each item's icon and the counts line show its group: **Urgent** (a leak, a door left open), **Live** (a flight's status, a running job, updated in place), **Handled** (what was done for you, in one quiet line) and **To know**. Notifications about one thing fold into one item with its history underneath, new ones appear while the page is open, and an optional line at the top says what matters now. It is built from DSH's own components, so it looks like the rest of the Web UI in light and dark ([docs/ui.md](docs/ui.md) says which few pieces aren't DSH's, and why).

The contract is files, so nothing gets lost while DSH restarts: the writer keeps appending, and the plugin pushes whatever arrived once it's back.

## Install

```sh
npx @deepseek-ai/dsh plugin --profile web add @soffits/dsh-notify-inbox@latest
```

It needs two small shared plugins next to it, [@soffits/dsh-ui-kit](https://github.com/soffits/dsh-ui-kit) (icons, live time, history) and [@soffits/dsh-ui-actions](https://github.com/soffits/dsh-ui-actions) (the buttons):

```sh
npx @deepseek-ai/dsh plugin --profile web add @soffits/dsh-ui-kit@latest @soffits/dsh-ui-actions@latest
```

Restart `dsh web`. The inbox appears in the sidebar. Then set `dataDir` in a profile override of the `notify-inbox` row:

```yaml
- override:
    - id: notify-inbox
      config:
        dataDir: ~/notify-inbox
        # For a DSH several people sign in to (needs a sign-in plugin that provides requestIdentity):
        peopleFile: ~/people.json
        peopleKey: oidc_users
        vapidFile: ~/secrets/notify-inbox/vapid.json
        vapidSubject: mailto:you@example.org
```

| Option | Default | Meaning |
|---|---|---|
| `dataDir` | `~/.dsh/notify-inbox` | Where the writer files notifications: `<dataDir>/<person>/inbox.jsonl`. |
| `people` | `{}` | Verified user id (an OIDC `sub`) → person id (the folder name, compared case-insensitively). |
| `peopleFile`, `peopleKey` | | A JSON file with more of the same mapping, re-read when it changes; `peopleKey` picks a top-level key. |
| `vapidFile` | `<dataDir>/.push/vapid.json` | The Web Push key pair, made on first start with mode 600. Keep it: a new key means every device subscribes again. |
| `vapidSubject` | `mailto:admin@example.invalid` | A contact push services can reach. Set your own. |
| `domains` | `{}` | How each `domain` is drawn, on top of the built-in defaults (`mail`, `money`, `health`, `travel`, `home`, `orders`...): `{ "legal": { "icon": "scale", "tone": "violet" } }`. `icon` is a [Lucide](https://lucide.dev) name the kit bundles; `tone` (`ok`, `warn`, `bad`, `accent`, `violet`, `muted`) is usually left out, since an item's colour says what it needs. |
| `summaryHours` | `12` | How long the summary line is shown after it was written. |
| `quiet` | none | People (person ids) whose bell never shows a count: a soft grey dot says something is new instead of a red number, for someone who wants their inbox to invite rather than nag. |

**Who sees what.** With a mapping, every request is checked on the server: a person sees, marks and presses only their own inbox, and a request without a verified identity sees nothing. The identity comes from any plugin that provides a `requestIdentity` service (`current()` → `{ provider, issuer, id, name } | null`), such as [dsh-oidc](https://github.com/soffits/dsh-oidc) 0.3.0-alpha.9 or later. Without a mapping (a DSH only you use), you see every folder.

## Writing notifications

Append one JSON object per line to `<dataDir>/<person>/inbox.jsonl` (person ids are lower-case letters, digits, `-` and `_`). Append whole lines in one write; a line still being written is picked up when it ends.

```json
{"v": 1, "id": "20261117T155012Z-3f9a1c", "time": "2026-11-17T15:50:12Z", "lane": "interrupt",
 "domain": "home", "title": "Water leak", "spoken": "The kitchen sensor is wet.",
 "text": "The sensor under the sink reported water at 15:50.", "links": ["https://example.org/cam"],
 "files": [{"name": "photo.jpg", "size": 48213, "stored": true}],
 "source": "leak-watch", "key": "leak-kitchen", "test": false, "push": true,
 "actions": [{"kind": "done", "id": "done", "label": "Dealt with it", "payload": {}},
             {"kind": "snooze", "id": "snooze", "label": "", "payload": {}}],
 "routed": [{"destination": "chat", "type": "telegram", "ok": true},
            {"destination": "phone", "type": "ntfy", "ok": false, "detail": "timed out"}]}
```

- `id` (required, unique), `time` (required, ISO 8601). `lane: "interrupt"` makes it urgent (on top, a red tile, high push urgency).
- `title`, `spoken` (one short line: the push body), `text` (the full text), `links` (http/https).
- `files`: attachments the writer copied to `<dataDir>/<person>/files/<id>/<name>`; only those are served, and only to that person.
- `push: false` files it without a push. `test: true` labels it as a test.
- `routed`: where else the notification went and whether that worked; shown under the text.
- `actions`: buttons, see below.
- `attention`: the group, `urgent`, `live`, `handled` or `info` ("To know"). Left out (or any other value), it follows from the rest: `handled` when `handled` is set, `live` when `live` is, `urgent` for an interrupt, else `info`. An urgent item the person marked done moves to Handled, a snoozed one waits under To know until it comes back.
- `thread`: notifications with the same thread are one item, the newest on top and the older ones as its history (three reminders about one task).
- `live`: `{ "until"?, "progress"?: { "from", "to" } }`. The thread's newest notification replaces the item in place, shown as live until `until` (or six hours after its last update), with a bar from `from` to `to`.
- `handled`: `{ "text", "at"? }`, what was done for the person, shown as one quiet line with a check.

An optional `<dataDir>/<person>/summary.json`, `{ "text": "...", "at": "<ISO time>" }`, is the sentence shown above the items for `summaryHours`.

`/?notify-inbox=<id>` opens the inbox on one notification: from a push, on a page load, or from a link on another page of the app that moves there in place.

A line `{"v": 1, "type": "handled", "record": "<id>", "press": "<press id>", "action": "done", "result": "done", "time": "..."}` tells the inbox that a press on that record was dealt with (`result: "snoozed"` with `until` shows when it comes back). Bad lines are skipped and counted.

## Buttons

The buttons come from [@soffits/dsh-ui-actions](https://github.com/soffits/dsh-ui-actions); install it as a plugin too (`dsh plugin --profile web add @soffits/dsh-ui-actions`). Without it the inbox works and shows no buttons.

Every notification gets **Ask**: it opens a new session with the notification attached to the message box as a card (removable), and the person writes their own words beside it. The sent message shows the same card; the agent gets the notification as a short quote with its id. Since the person sends it from the Web UI, the sign-in plugin records them as the sender.

Declared `actions` add more: `step` (a suggested next step whoever filed the notification knows, like "Pay it from the joint account": one tap records the press, then sends the step with the notification to the assistant as the person, at most three; `label` required, text or `{ "en": …, "zh": … }`), `done`, `snooze` (a small picker: in an hour, this evening, tomorrow morning; or a fixed `payload.until`), `event` (anything else) and `link` (`payload.url`). A press on `step`, `done`, `snooze` or `event` is checked on the server (the record must be the caller's and declare that button), appended to `<dataDir>/<person>/actions.jsonl`, and published on the event channel `ui.action.<kind>` when [dsh-cron-jobs](https://github.com/soffits/dsh-cron-jobs) is installed, so a job listening there can act on it:

```json
{"action": "snooze", "id": "snooze", "payload": {"until": "2026-11-18T09:00:00-05:00"}, "person": "ana",
 "at": "2026-11-17T21:04:11Z", "source": {"plugin": "notify-inbox", "record": "20261117T155012Z-3f9a1c", "key": "leak-kitchen"},
 "press": "9f2c41aa07b3"}
```

The page shows the press as waiting until a `handled` line for it shows up.

## Push notifications

Open the inbox on the device, open its **⋯** menu and choose **Turn on**. The browser picks its own push service, and the plugin only ever talks to that service, with the message encrypted end to end (RFC 8291, VAPID per RFC 8292, no third-party library):

- **iPhone and iPad** (iOS 16.4+): add DSH to the Home Screen, open it from there, then turn notifications on. Pushes go through Apple's service.
- **Chrome, Edge, Android**: pushes go through Google's Firebase Cloud Messaging, so they don't arrive where Google is blocked.
- **Firefox**: Mozilla's push service.

Tapping a notification opens the inbox on it. A device whose subscription expired is dropped the first time its push service says so.

## Live updates

An open Web UI follows `GET /api/notify-inbox/events`, a Server-Sent Events stream that says when the caller's inbox changed (records, read marks, presses or the summary), and fetches again; the browser reconnects by itself when the stream drops. The plugin watches the data folder and each person's folder (`fs.watch`), so a change is noticed when the file changes, and new records are pushed the same moment; nothing polls. The data folder must be on a local file system for that (a network share may not report changes).

## Languages

The page follows DSH's language. Its words live in `locale/<tag>.json` (`ui` for the page, `meta` for the plugin list): English, French and Chinese ship. Another language is one more file with the same keys; anything it leaves out comes from its primary language (`pt` for `pt-BR`), then English. Notification text is shown as it was sent.

## Files the plugin writes

All under `dataDir`: `<person>/read.json` (read and unread marks), `<person>/actions.jsonl` (presses), `.push/subscriptions.json` and `.push/cursor.json` (how far each inbox was pushed, so a restart doesn't push the backlog), and the VAPID key unless `vapidFile` says otherwise. It never rewrites `inbox.jsonl`.

## Removing it

Remove the plugin from the profile. The data folder stays until you delete it; browsers keep a dormant service worker under `/api/notify-inbox/` until their site data is cleared.

## License

MIT
