# dsh-notify-inbox

A notification inbox for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Something outside DSH (your assistant's notification router, a cron script, a watcher) files notifications as JSON lines, one folder per person. The plugin shows each signed-in person their own inbox in the Web UI, keeps read and unread per person on the server, pushes new ones to the browsers and installed home-screen apps they turned notifications on for, and gives every notification buttons: ask the agent about it, mark it done, remind me later.

The contract is files, so nothing gets lost while DSH restarts: the writer keeps appending, and the plugin pushes whatever arrived once it's back.

## Install

```sh
npx @deepseek-ai/dsh plugin --profile web add @soffits/dsh-notify-inbox@latest
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
| `pollSeconds` | `5` | How often new lines are looked for (to push them). |

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

- `id` (required, unique), `time` (required, ISO 8601). `lane: "interrupt"` marks it urgent (red dot, high push urgency).
- `title`, `spoken` (one short line: the push body), `text` (the full text), `links` (http/https).
- `files`: attachments the writer copied to `<dataDir>/<person>/files/<id>/<name>`; only those are served, and only to that person.
- `push: false` files it without a push. `test: true` labels it as a test.
- `routed`: where else the notification went and whether that worked; shown under the text.
- `actions`: buttons, see below.

A line `{"v": 1, "type": "handled", "record": "<id>", "press": "<press id>", "action": "done", "result": "done", "time": "..."}` tells the inbox that a press on that record was dealt with (`result: "snoozed"` with `until` shows when it comes back). Bad lines are skipped and counted.

## Buttons

Every notification gets **Ask about this**: it opens a new session with the notification quoted into the message box, ready to edit and send. Since the person sends it from the Web UI, the sign-in plugin records them as the sender.

Declared `actions` add more: `done`, `snooze` (a small picker: in an hour, this evening, tomorrow morning; or a fixed `payload.until`), `event` (anything else) and `link` (`payload.url`). A press on `done`, `snooze` or `event` is checked on the server (the record must be the caller's and declare that button), appended to `<dataDir>/<person>/actions.jsonl`, and published on the event channel `ui.action.<kind>` when [dsh-cron-jobs](https://github.com/soffits/dsh-cron-jobs) is installed, so a job listening there can act on it:

```json
{"action": "snooze", "id": "snooze", "payload": {"until": "2026-11-18T09:00:00-05:00"}, "person": "ana",
 "at": "2026-11-17T21:04:11Z", "source": {"plugin": "notify-inbox", "record": "20261117T155012Z-3f9a1c", "key": "leak-kitchen"},
 "press": "9f2c41aa07b3"}
```

The page shows the press as waiting until a `handled` line for it shows up.

## Push notifications

Open the inbox on the device and press **Turn on**. The browser picks its own push service, and the plugin only ever talks to that service, with the message encrypted end to end (RFC 8291, VAPID per RFC 8292, no third-party library):

- **iPhone and iPad** (iOS 16.4+): add DSH to the Home Screen, open it from there, then turn notifications on. Pushes go through Apple's service.
- **Chrome, Edge, Android**: pushes go through Google's Firebase Cloud Messaging, so they don't arrive where Google is blocked.
- **Firefox**: Mozilla's push service.

Tapping a notification opens the inbox on it. A device whose subscription expired is dropped the first time its push service says so.

## Languages

The page follows DSH's language. Its words live in `locale/<tag>.json` (`ui` for the page, `meta` for the plugin list): English, French and Chinese ship. Another language is one more file with the same keys; anything it leaves out comes from its primary language (`pt` for `pt-BR`), then English. Notification text is shown as it was sent.

## Files the plugin writes

All under `dataDir`: `<person>/read.json` (read and unread marks), `<person>/actions.jsonl` (presses), `.push/subscriptions.json` and `.push/cursor.json` (how far each inbox was pushed, so a restart doesn't push the backlog), and the VAPID key unless `vapidFile` says otherwise. It never rewrites `inbox.jsonl`.

## Removing it

Remove the plugin from the profile. The data folder stays until you delete it; browsers keep a dormant service worker under `/api/notify-inbox/` until their site data is cleared.

## License

MIT
