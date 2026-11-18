# What the page is made of

The inbox page should look like it always was part of DSH, so it is built from DSH's own pieces first, then the shared kit, and only a little of its own.

## DSH's own

From `@deepseek-ai/dsh-client-ui-primitives`, which DSH puts in every plugin's module table (`require` at runtime, no copy):

| Piece | Where |
|---|---|
| `Button` (outline, small) | Mark all read, Mark unread, Show older, the ⋯ trigger |
| `Pill` | The Needs you / All / Unread filters, as on the Automation page |
| `Menu`, `Tooltip` | The ⋯ menu: notifications on this device, a test push |
| `StateDot` | The green dot on a live item |
| `IconCheckCircleOutlineRegular`, `IconEllipsisOutlineRegular`, `IconSendOutlineRegular`, `IconLoadingOutlineRegular`, `IconWarningTriangleOutlineRegular` | The handled check, the ⋯ trigger, the reply's Send, an answer on its way, an answer that has not landed |
| Theme tokens (`--dsw-alias-*`) | Every colour, so light and dark follow the Web UI |

The page's layout copies the numbers of DSH's own pages, since their CSS modules aren't shared: the frame (960 px column, 28 px top inset, `clamp(24px, 4vw, 48px)` sides) and rows (12 px radius, 8 px padding, 12 px gap, 13 px tertiary summary) of the Automation page, and the group headings (14 px medium title, count beside it, shown in the Needs you view only) of the plugin manager.

`test/client-names.test.js` checks every primitive the page takes against the export list of the oldest DSH it supports (`test/fixtures/`), so a wrong name fails a test instead of the page.

## The shared kit

From [@soffits/dsh-ui-kit](https://github.com/soffits/dsh-ui-kit) (`ctx.uiKit`), for what DSH has no piece for and other plugin pages need too: `Tile` and `Icon` (a domain's Lucide icon on a tinted tile), `TimeAgo` and `TimeUntil` (times that tick, full date on hover), `LiveStatus` and `useEventStream` (the live line and the events stream), `useWash` and `NewDot` (the two-second cue on an item that just changed, the unread dot), `History` (a thread's earlier entries), `Progress` (a live item's bar through time) and `Suggested` (the suggested steps). The buttons themselves come from [@soffits/dsh-ui-actions](https://github.com/soffits/dsh-ui-actions).

## Ours

About fifty lines of CSS in `client.js`, only for layout DSH doesn't expose:

- **The page frame, rows and group headings**, with the values above. A row is a disclosure (the header is a button, the details open below it), which no DSH primitive draws.
- **Two-line titles and summaries** (`line-clamp`), so a phone shows the whole of a short title instead of cutting it.
- **The counts line** (`Urgent 1 · Needs you 2 · Live 1 · …`), joined the way DSH joins row metadata.
- **An ask's points** (`+3`): a small tinted label beside the title in the accent colour; DSH has no badge primitive for a row.
- **The answer line** (what you chose or wrote, how far it has got, Undo): the handled line's layout, with DSH's warn colour on the icon when an answer has not landed and a text-only button that looks like a link for "Open it"; an answered item's title loses its emphasis.
- **The reply box** under an opened ask: a native `textarea` with DSH's border, radius and background tokens, since DSH exports no multi-line input.
- **The unread badge on the sidebar bell**: DSH's sidebar has no count badge for an entry.
- **Phone sizes**: at 640 px and below, or with a touch pointer, every control is at least 40 px tall, as DSH's own controls are only on desktop.

Nothing else: no colours, fonts or shadows of its own.
