# Changelog

## 0.10.0

- **All** lists items strictly by time, newest first, whatever group they are in. Before, it was cut into sections (Urgent, Needs you, Live, …), so a newer notification could sit below an older one. The group still shows on each item's icon.
- A new **Unread** view: only unread items, in the same time order, with the unread count on its tab. An item you open stays in the list until you leave the view or tap the tab again, as in Needs you.
- **Needs you** is unchanged.

## 0.9.0

- `quiet`: people whose bell shows a soft grey dot when something is new, never a red count, so their inbox invites rather than nags. The summary says which (`badge`: `count` or `dot`).

## 0.8.1

- A link to an item from another page of the app (`/?notify-inbox=<id>`, pushed in place) opens it; before, only a page load or a push did.
- `@deepseek-ai/schemastery` is a peer dependency, so an update never moves a private copy out from under the plugin.

## 0.8.0

- A reply never dead-ends: when the ask names no session, or the one it names is gone, archived, can't be loaded or was a finished helper, it opens a new top-level session with the whole ask quoted in and the session that asked named, so someone can act on it. New options `replyCwd` and `replyPreset` say where that session starts. Every ask has a reply box now, not only those that name a session.
- The ask's `session` is the one that counts, also when it has none: a notification filed earlier no longer sends a reply to a session the ask has dropped.

## 0.7.0

- A reply is sent by the server: `POST /api/notify-inbox/reply` checks the item is yours and steers the session that asked, as you, with the ask quoted in. Before, the page sent it through the browser, which could stall on a long conversation and never arrive.
- The page's words are read from the language files for each request and never cached, so an update in place can't leave the page showing raw keys.

## 0.6.1

- The reply box has a visible border (it used a colour token DSH doesn't define).

## 0.6.0

- Asks: whatever keeps the person's list of open asks (a Todo) writes them to `<person>/asks.json`, and with that file there it alone decides **Needs you**. Each open ask is one item, with the notifications of its thread folded in; one that left the file shows as Handled ("Settled"). An ask's `points` show beside its title, and its own buttons, title and session win over its notifications'.
- Reply where you read: an ask (or a notification with `session`) has a reply box that sends your answer into the session that asked, as you, through `@soffits/dsh-ui-actions`' `start`, with the ask quoted in.
- **Breaking:** a new group **Urgent** on top: interrupts default to it (done and snooze move them on as before). `needs-you` is no longer a default for interrupts or for notifications with done or snooze buttons; it is for asks.
- No polling: the plugin watches the folders (`fs.watch`) for the page's change notices and pushes new records the moment the inbox file changes, and the Web UI follows the events stream for its counts instead of a timer. The `pollSeconds` option is gone (an old value is ignored).

## 0.5.0

- A new page, built from DSH's own components and the shared [@soffits/dsh-ui-kit](https://github.com/soffits/dsh-ui-kit), which is now required. Notifications are grouped as Needs you, Live, Handled and To know, with the counts on top, an optional summary line (`summary.json`) and each domain's icon on a tinted tile (`domains` setting). [docs/ui.md](docs/ui.md) lists what is DSH's and what is the plugin's own.
- Records may carry `attention`, `thread`, `live` and `handled`. Without `attention`, interrupts and notifications with done or snooze buttons need you and the rest is to know. A needs-you item marked done moves to Handled, a snoozed one waits under To know, a live item drops to To know when its time is over.
- Notifications with the same `thread` are one item with their history beneath; a live thread's newest notification replaces the item in place.
- New notifications and changes show up while the page is open, through `GET /api/notify-inbox/events` (Server-Sent Events), with a short cue on what changed. The page polls while the stream is down.
- The filters are Needs you and All (Unread is gone: unread items carry a dot). Items stay where they first showed until you leave the view. Mark unread is in the opened item. Push settings moved into the ⋯ menu.
- An inbox file rewritten in place is read again even when it grew.
- Needs DSH 0.2.2-rc.1 or later.
## 0.4.0

- Suggested next steps: a notification's `step` actions show as their own buttons (from @soffits/dsh-ui-actions 0.2.0). A tap is recorded here like done and snooze, as the event `ui.action.step` with who pressed it, then the step is sent to the assistant; the row says "Started".
- Button labels may be maps from language tag to text.
- Each press remembers which button it was, so several steps on one notification keep their own state.

## 0.3.0

- The buttons come from [@soffits/dsh-ui-actions](https://github.com/soffits/dsh-ui-actions), installed as its own plugin, instead of a copy of the card board's chunk. "Ask" now opens a conversation with the notification attached as a card the person can remove and write beside; the sent message shows the same card, and the agent gets the notification as compact text with its id. Without the package the page works and shows no buttons.
- The buttons' words moved to that package; the page's locale files keep only its own.

## 0.2.1

- Under Unread, a notification you open, mark done or snooze stays where it is, shown as read, until you leave the view or tap Unread again, so the list never moves under your finger. Mark all read works the same way.
- Read notifications have a Mark unread button, in the row and in the open notification. It works on ones that Mark all read covered too.
- A done or snoozed notification shows its state in the collapsed row.
- On narrow screens the header wraps under the title instead of squeezing it.

## 0.2.0

- Every word on the page comes from `locale/<tag>.json`, one file per language, picked up by what files exist; a missing key falls back to the primary language, then English. French joins English and Chinese.
- The test push speaks the page's language; the push payload and service worker carry no built-in words.
- The buttons module is the card board's current one (words come from the page's own table).

## 0.1.3

- The buttons chunk keeps its names inside its own scope, so it loads next to another plugin's copy on the same page (DSH runs chunks as classic scripts in one global scope).
- Touch targets are at least 40 px on phones and touch screens.
- A notification you open under Unread stays on screen instead of vanishing as it turns read.

## 0.1.2

- The buttons chunk registers as a chunk of the package (`{ id, chunk }`), so a page that got the plugin while it was open loads the buttons instead of failing with "loaded without registering"; a failed load is retried next time and never hides the list.
- A press that gets handled shows as handled without reloading the page.

## 0.1.1

- Buttons come from the shared action bar (`client.actions.js`, the same one the card board uses), so both pages look and behave alike; buttons without a label get the shared words.

## 0.1.0

- First release: per-person inbox from JSON lines, read and unread kept on the server, Web Push (RFC 8291 encryption and VAPID on node:crypto) with deep links, buttons on notifications (ask about this, done, snooze, event, link) whose presses become `ui.action.<kind>` events, English and Chinese.
