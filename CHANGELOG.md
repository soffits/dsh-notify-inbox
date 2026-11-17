# Changelog

## 0.1.2

- The buttons chunk registers as a chunk of the package (`{ id, chunk }`), so a page that got the plugin while it was open loads the buttons instead of failing with "loaded without registering"; a failed load is retried next time and never hides the list.
- A press that gets handled shows as handled without reloading the page.

## 0.1.1

- Buttons come from the shared action bar (`client.actions.js`, the same one the card board uses), so both pages look and behave alike; buttons without a label get the shared words.

## 0.1.0

- First release: per-person inbox from JSON lines, read and unread kept on the server, Web Push (RFC 8291 encryption and VAPID on node:crypto) with deep links, buttons on notifications (ask about this, done, snooze, event, link) whose presses become `ui.action.<kind>` events, English and Chinese.
