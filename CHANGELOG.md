# Changelog

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
