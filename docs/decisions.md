# Decisions

## Two buttons: chat and read (0.13)

A notification's own buttons (done, snooze, steps, events, links) gave a notice ways to act that its source's own view already had, and pressing one changed a second copy of the state instead of the thing itself. A notice informs, so each one has **Ask** (talk about it, in a new conversation) and **Mark read / Mark unread**, and nothing else. Links in the text stay links. Not chosen: keeping `link` buttons, since the record's `links` already show as links.

## Notices only: asks are answered where they live (0.12)

One question reached the person three or four times: as an ask in the inbox, as each notification about it, and in the list it lived in. A person reads what waits on them in that list, so the inbox holds notices only. `asks.json` is not read, `needs-you` is not a group (a record that says so falls back to the default group), and there is no reply box. Not chosen: asks as an optional feed; two places for one question need rules for which shows when, and the duplicates come back.
