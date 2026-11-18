# Decisions

## Two buttons: chat and read (0.13)

A notification's own buttons (done, snooze, steps, events, links) gave a notice ways to act that its source's own view already had, and pressing one changed a second copy of the state (the inbox's handled lines) instead of the thing itself. A notice informs, so each one has **Ask** (talk about it, in a new conversation) and **Mark read / Mark unread**, and nothing else. The press route, the presses log and the handled lines went, and so did the groups they moved items between (an urgent item no longer goes to Handled on a done; it stays urgent until it is read and scrolls away with time). Links in the text stay links. Not chosen: keeping `link` buttons, since the record's `links` already show as links.

## Notices only: asks are answered where they live (0.12)

The page showed each open ask from `asks.json` as a Needs you item and every notification about it as well, while the list the ask lived in (a Todo on a board) showed it again, so one question reached the person three or four times. A person reads what waits on them in that list, and the list's own views can carry its buttons and a way to answer, so the inbox goes back to what its name says.

- **No asks, no Needs you.** `asks.json` is no longer read or watched, `needs-you` is no longer a group, and a record that still says `needs-you` (an older writer) falls back to the default group like any unknown value: notices about an ask show as ordinary items, with whatever buttons their writer gave them.
- **No reply box.** It only ever showed under Needs you; a typed answer to an ask belongs where the ask is answered, as a message to the session that asked. The `reply` route, the answer line and the `undo` route only that line used went with it, and so did `replyCwd` and `replyPreset`.
- Not chosen: keeping asks as an optional feed for homes that want them in the inbox. One place for a question is the point; two would need rules for which shows when, and the duplicates come back.

(The section below describes 0.11, superseded by this one.)

## An answer lands on its source, and the page shows how far it got (0.11)

A reply typed under an ask went only into a conversation, quoted with the item and nothing about how to settle it, and the page showed nothing afterwards: the buttons stayed live, the reply box was empty again, and the person could not tell whether anything had happened. A choice button never had the first problem, because it is an action event the list's own writer applies.

- **A reply is an event too.** `reply` is logged and published like a press (`ui.action.reply`), addressed to the writer the ask's buttons name, so the words are on the ask before any conversation sees them. Closing stays with whoever reads the words: a sentence can mean yes, no or not yet, so the plugin never closes an ask because a reply exists. The conversation's message carries the ask's own `how` (its id and the close command, written by the list's owner so this plugin names no tool), and says the words are already logged.
- **The page keeps no state of the answer.** What it shows comes from the presses log (what the person did and when) and the asks file (`replied` says the words arrived; the ask leaving says it closed; `since` says which showing an answer belongs to). Only the in-flight moment is local, and the clock decides when to stop waiting (two minutes for a source to take an answer in, ten for a reply to be dealt with), at that moment and not by polling.
- **Buttons give way instead of greying.** While an answer is on its way the answering buttons and the reply box are replaced by one line saying what was chosen or written and how far it has got; the buttons come back, with the line turned to a warning, when the time is up. The DSH button primitives offer no disabled state per button through the shared action bar, and a line is clearer than a row of dimmed buttons.
- **Settled rows stay until you leave the view.** A closed ask would vanish the instant its source says so, taking Undo with it. The page keeps the last copy of an answered item it was showing and draws it settled in the same place, so the person sees what they did and can take it back; Undo sends the press's own declared inverse.
- Not chosen: closing the ask from the reply route (a sentence is not a decision); a timer that reopens or re-asks (the source's own watchers do that where it matters); disabling buttons inside the shared action package (every plugin page would inherit a change nobody asked for).
