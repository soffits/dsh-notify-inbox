/*
 * Browser half of dsh-notify-inbox: the Inbox entry in the sidebar (with the
 * unread count), its page, turning Web Push on for this browser, and the
 * buttons on each notification.
 *
 * Plain JavaScript in DSH's Client module format (no build step). The page is
 * built from DSH's own controls (@deepseek-ai/dsh-client-ui-primitives, from
 * the page's module table), the shared pieces DSH doesn't have from
 * @soffits/dsh-ui-kit (ctx.uiKit) and the buttons from @soffits/dsh-ui-actions
 * (ctx.uiActions); the little CSS of its own is in docs/ui.md, with why.
 * Everything the page shows comes from the plugin's /api/notify-inbox routes,
 * which decide per request who is asking. A link with ?notify-inbox=<id>
 * opens the page on that notification. Counts follow the plugin's events
 * stream (the inbox files' own changes), never a timer.
 *
 * An ask (a notification that waits on the person's answer, or an open ask
 * from their list) shows its points and a reply box: the server logs the
 * reply on the ask through its writer, then puts it into the session that
 * asked as the person, with the ask quoted in, or into a new session when
 * that one is gone or the ask names none. Once answered (a choice, a snooze
 * or a reply) the item says what was done and how far it has got, the next
 * item that needs the person opens, and a closed ask stays settled, with
 * Undo, until the view is left.
 */
window.__ModuleLoader__.load({
  id: '@soffits/dsh-notify-inbox',
  factory(require) {
    const React = require('react')
    const { Button, Pill, Menu, Tooltip, StateDot, IconCheckCircleOutlineRegular, IconEllipsisOutlineRegular, IconSendOutlineRegular, IconLoadingOutlineRegular, IconWarningTriangleOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React

    const NS = 'dsh-notify-inbox'
    const PANEL = 'dsh-notify-inbox'
    const OWNER = '@soffits/dsh-notify-inbox'
    const LINK_PARAM = 'notify-inbox'
    const STYLE_ID = 'dsh-notify-inbox-style'
    const PENDING_MS = 2 * 60 * 1000
    const GROUPS = ['urgent', 'needs-you', 'live', 'handled', 'info']
    /** The colour an item's tile takes from what it needs, unless its domain names one. */
    const GROUP_TONE = { urgent: 'bad', 'needs-you': 'accent', live: 'accent', handled: 'ok', info: 'muted' }
    const GROUP_ICON = { urgent: 'triangle-alert', 'needs-you': 'circle-help', live: 'activity', handled: 'circle-check', info: 'info' }
    const api = path => new URL(`api/notify-inbox/${path}`, document.baseURI).href

    // Only what DSH's components don't cover: the page frame and row layout mirror DSH's own pages
    // (ui-schedule TaskManagerPage, plugin manager groups), since their CSS modules are private.
    const CSS = `
.nib-page{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.nib-page :focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.nib-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;--dsh-scrollbar-width:9px;--dsh-scrollbar-thumb-border:2px}
.nib-content{max-width:960px;margin:0 auto;padding:0 clamp(24px,4vw,48px) 48px}
.nib-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px 16px;padding-top:28px;margin-bottom:4px}
[data-platform=darwin] .nib-heading{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.nib-heading h1{flex:0 1 auto;min-width:0;margin:0;font-size:20px;line-height:28px;font-weight:500}
.nib-tools{display:flex;align-items:center;gap:8px}
.nib-said{margin:0;font-size:15px;line-height:24px;overflow-wrap:anywhere}
.nib-status{display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;min-width:0;margin:2px 0 16px;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:21px}
.nib-counts>*+*::before{content:'·';padding:0 6px}
.nib-counts b{font-weight:500;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}
.nib-counts b[data-group=needs-you]{color:var(--dsw-alias-state-business-primary)}
.nib-counts b[data-group=urgent]{color:var(--dsw-alias-state-error-primary)}
.nib-filters{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.nib-n{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.nib-group{display:flex;flex-direction:column;gap:4px;margin-bottom:24px}
.nib-groupHead{display:flex;align-items:baseline;gap:8px;padding:0 8px}
.nib-groupHead h2{margin:0;font-size:14px;line-height:22px;font-weight:500}
.nib-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nib-flat{margin-bottom:24px}
.nib-item{border-radius:12px;padding:8px}
.nib-item.nib-open{background:var(--dsw-alias-bg-layer-1)}
@media (hover:hover){.nib-item:not(.nib-open):hover{background:var(--dsw-alias-interactive-bg-hover)}}
.nib-line{display:flex;gap:12px;align-items:flex-start}
.nib-main{flex:1;min-width:0}
.nib-head{display:block;width:100%;padding:0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.nib-titleLine{display:flex;align-items:flex-start;gap:8px;min-width:0;padding-top:4px}
.nib-titleLine>.uk-newDot{margin-top:8px}
.nib-title{flex:1;min-width:0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:23px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.nib-unread .nib-title,.nib-item[data-group=urgent] .nib-title,.nib-item[data-group=needs-you] .nib-title,.nib-item[data-group=live] .nib-title{font-weight:500;color:var(--dsw-alias-label-primary)}
.nib-points{flex:none;align-self:center;padding:0 6px;border-radius:9px;font-size:12px;line-height:18px;font-weight:500;font-variant-numeric:tabular-nums;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}
.nib-reply{display:flex;flex-direction:column;gap:6px;max-width:640px}
.nib-reply textarea{box-sizing:border-box;width:100%;min-height:64px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-base);color:inherit;font:inherit;resize:vertical}
.nib-replyBar{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.nib-open .nib-title{-webkit-line-clamp:unset}
.nib-when{flex:none;display:inline-flex;align-items:center;gap:6px;font-size:12px;line-height:23px;color:var(--dsw-alias-label-caption)}
.nib-sub{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:13px;line-height:21px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.nib-done{display:flex;gap:6px;align-items:flex-start;font-size:13px;line-height:21px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
.nib-done svg{flex:none;margin-top:3px;color:var(--dsw-alias-state-success-primary)}
.nib-answer{margin-top:4px;color:var(--dsw-alias-label-secondary)}
.nib-answer[data-phase=sending] svg,.nib-answer[data-phase=working] svg,.nib-answer[data-phase=applying] svg{color:var(--dsw-alias-label-tertiary)}
.nib-answer.nib-warn svg{color:var(--dsw-alias-state-warn-primary)}
.nib-link{padding:0;border:0;background:none;color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));font:inherit;text-decoration:underline;cursor:pointer}
.nib-answered .nib-title{font-weight:400;color:var(--dsw-alias-label-secondary)}
.nib-progress{margin-top:8px;max-width:560px}
.nib-body{display:flex;flex-direction:column;gap:12px;margin-top:10px}
.nib-text{white-space:pre-wrap;overflow-wrap:anywhere;line-height:22px}
.nib-links{display:flex;flex-direction:column;gap:2px;font-size:13px}
.nib-links a{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));overflow-wrap:anywhere}
.nib-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.nib-meta{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.nib-ok{color:var(--dsw-alias-state-success-primary)}
.nib-bad{color:var(--dsw-alias-state-error-primary)}
.nib-empty{padding:48px 20px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.nib-error{color:var(--dsw-alias-state-error-primary)}
.nib-more{display:flex;justify-content:center}
.nib-dot{position:absolute;top:-2px;right:-3px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-tertiary);pointer-events:none}
.nib-badge{position:absolute;top:-5px;right:-8px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:9px;font-weight:600;line-height:14px;text-align:center;pointer-events:none}
.nib-bell{position:relative;display:inline-flex}
@media (width<=640px){.nib-content{padding-inline:12px}.nib-heading{padding-top:16px}.nib-item{padding:8px 6px}.nib-line{gap:10px}}
@media (width<=640px),(pointer:coarse){.nib-page button,.nib-page .ua-btn,.nib-page .ua-step{min-height:40px}.nib-page .nib-tools button,.nib-page .nib-mark{min-width:40px}.nib-filters button{padding-inline:14px}.nib-head{min-height:40px}}
`

    // ---- shared state: the counts and a version that bumps when anything changes ----

    const shared = { unread: 0, badge: 'count', version: 0, linked: null, ui: null, kit: null, summary: null, openSession: () => {} }
    const listeners = new Set()
    const emit = () => { for (const listener of listeners) listener() }
    const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener) }
    const useShared = select => useSyncExternalStore(subscribe, () => select(shared))

    async function call(path, value) {
      const init = value === undefined
        ? { credentials: 'same-origin', headers: { accept: 'application/json' } }
        : { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(value) }
      const response = await fetch(api(path), init)
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
      return body
    }

    let lastSummary = ''
    async function refreshSummary() {
      try {
        const summary = await call('summary')
        const key = JSON.stringify([summary.unread, summary.badge, summary.latest, summary.total, summary.groups, summary.line])
        if (key !== lastSummary) {
          lastSummary = key
          shared.unread = summary.unread
          shared.badge = summary.badge === 'dot' ? 'dot' : 'count'
          shared.summary = summary
          shared.version += 1
          emit()
        }
      } catch {
        // Signed out or DSH restarting; the stream's next notice (or the page coming back) tries again.
      }
    }
    const changed = () => { lastSummary = ''; refreshSummary() }

    const absolute = (iso, t) => new Date(iso).toLocaleString(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' })
    /** Text a person reads: a string, or a map from language tag to text. */
    const said = (value, t) => (typeof value === 'string' ? value : value?.[t('time.locale').split('-')[0]] ?? Object.values(value ?? {})[0] ?? '')

    // ---- the buttons ----

    /** The server's view of each button's last press: pending, done or unhandled. */
    const pressesOfButtons = item => {
      const undone = new Set(item.presses.filter(press => press.action === 'undo').map(press => press.undoes))
      return item.presses.filter(press => press.action !== 'reply' && press.action !== 'undo' && !undone.has(press.press))
    }

    function pressStates(item) {
      const states = {}
      for (const press of pressesOfButtons(item)) {
        const action = item.actions.find(row => row.id === press.id) ?? item.actions.find(row => row.kind === press.action) ?? { id: press.action }
        const handled = item.outcomes.some(row => row.press === press.press)
        states[action.id] = handled ? 'done' : Date.now() - Date.parse(press.at) < PENDING_MS ? 'pending' : 'unhandled'
      }
      return states
    }

    /** What happened to the latest press, in words, or null. */
    function pressStatus(item, t) {
      const press = pressesOfButtons(item).at(-1)
      if (press === undefined || press.action === 'step') return null
      const outcome = item.outcomes.find(row => row.press === press.press)
      if (outcome !== undefined) {
        if (outcome.result === 'snoozed' && outcome.until) return t('press.snoozed', { time: absolute(outcome.until, t) })
        if (outcome.result === 'done') return t('press.done')
        return outcome.result
      }
      return Date.now() - Date.parse(press.at) < PENDING_MS ? t('press.pending') : t('press.unhandled')
    }

    // ---- what the person said to an item, and how far it got ----

    /** Where each reply went (press id → `{ session, fresh }` or `{ error }`): only this page knows it. */
    const sentTo = new Map()
    const ACTIVE = new Set(['sending', 'working', 'applying'])

    /**
     * How far an answer has got. The sources say whether it did (`received`, the ask closing); the clock only says when
     * the page stops waiting: `applyBy` for the source to take it in, `settleBy` for a reply to be dealt with.
     */
    function phaseOf(answer, settled, now) {
      if (settled) return 'settled'
      if (answer.kind === 'reply') {
        if (!answer.received) return now < Date.parse(answer.applyBy) ? 'sending' : 'lost'
        return now < Date.parse(answer.settleBy) ? 'working' : 'open'
      }
      return now < Date.parse(answer.applyBy) ? 'applying' : 'notApplied'
    }

    /** Re-render at the moment an answer's phase changes (the next of its two times), never on a poll. */
    function useAnswerClock(answer) {
      const [tick, setTick] = useState(0)
      useEffect(() => {
        if (!answer) return undefined
        const now = Date.now()
        const next = [answer.applyBy, answer.settleBy].map(Date.parse).filter(at => at > now).sort((a, b) => a - b)[0]
        if (next === undefined) return undefined
        const timer = setTimeout(() => setTick(n => n + 1), next - now + 50)
        return () => clearTimeout(timer)
      }, [answer?.press, answer?.applyBy, answer?.settleBy, tick])
    }

    /** What the person did, in words: the choice, the reply, the snooze. */
    function answerText(answer, t) {
      if (answer.kind === 'reply') return t('answer.replied', { text: answer.text })
      if (answer.kind === 'choice') return t('answer.chose', { label: answer.label })
      if (answer.kind === 'snooze') return answer.until ? t('answer.snoozedUntil', { time: absolute(answer.until, t) }) : t('answer.snoozed')
      return t('answer.done')
    }

    /** The answer's line: what they did, how far it got, where the reply went, and Undo where there is a way back. */
    function AnswerLine({ item, answer, phase, t, onUndo }) {
      const [undo, setUndo] = useState({ phase: 'idle' })
      const sent = sentTo.get(answer.press)
      const bad = phase === 'lost' || phase === 'notApplied' || phase === 'open'
      const icon = bad ? IconWarningTriangleOutlineRegular : ACTIVE.has(phase) ? IconLoadingOutlineRegular : IconCheckCircleOutlineRegular
      const run = async () => {
        setUndo({ phase: 'working' })
        try {
          await onUndo(item, answer)
        } catch (reason) {
          setUndo({ phase: 'failed', message: reason.message })
        }
      }
      return h('div', { className: `nib-done nib-answer${bad ? ' nib-warn' : ''}`, 'data-phase': phase, role: 'status' },
        h(icon, { size: 14 }),
        h('span', null, answerText(answer, t), ' · ', t(`answer.${phase}`),
          sent?.session && h(React.Fragment, null, ' · ', sent.fresh ? `${t('reply.sentNew')} ` : '', h('button', { type: 'button', className: 'nib-link', onClick: () => shared.openSession(sent.session) }, t('reply.open'))),
          sent?.error && h('span', { className: 'nib-bad' }, ` · ${t('reply.notDelivered', { message: sent.error })}`),
          answer.undoable && phase === 'settled' && h(React.Fragment, null, ' ',
            h(Button, { variant: 'outline', size: 'sm', disabled: undo.phase === 'working', onClick: run }, t(undo.phase === 'working' ? 'answer.undoing' : 'answer.undo'))),
          undo.phase === 'failed' && h('span', { className: 'nib-bad', role: 'alert' }, ` ${t('answer.undoFailed', { message: undo.message })}`)))
    }

    /** What "Ask" and a step attach to the conversation: the notification as a card. */
    const aboutOf = item => ({
      source: OWNER,
      title: item.title || item.spoken || item.text,
      lines: [item.title && item.spoken !== item.title ? item.spoken : '', ...(item.text || '').split('\n'), ...item.links].filter(line => line && line !== item.title),
      context: { notification: item.id, time: item.time, lane: item.lane, domain: item.domain || undefined, thread: item.thread || undefined, ask: item.ask?.id },
    })

    /** A reply to an ask, sent into the session that asked as the person, with the ask quoted in. */
    function Reply({ item, t, onSent }) {
      const [text, setText] = useState('')
      const [state, setState] = useState({ phase: 'idle' })
      const send = async () => {
        const words = text.trim()
        if (words === '' || state.phase === 'sending') return
        setState({ phase: 'sending' })
        try {
          const sent = await call('reply', { record: item.id, text: words })
          sentTo.set(sent.press, sent.delivered === false ? { error: sent.error } : { session: sent.session, fresh: sent.fresh === true })
          setText('')
          setState({ phase: 'idle' })
          onSent()
        } catch (reason) {
          setState({ phase: 'failed', message: reason.message })
        }
      }
      return h('div', { className: 'nib-reply' },
        h('textarea', {
          value: text,
          rows: 2,
          placeholder: t('reply.placeholder'),
          'aria-label': t('reply.label'),
          onChange: event => setText(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) send() },
        }),
        h('div', { className: 'nib-replyBar' },
          h(Button, { variant: 'outline', size: 'sm', disabled: text.trim() === '' || state.phase === 'sending', onClick: send },
            h(IconSendOutlineRegular, null), ' ', t(state.phase === 'sending' ? 'reply.sending' : 'reply.send')),
          state.phase === 'failed' && h('span', { className: 'nib-meta nib-bad', role: 'alert' }, t('reply.failed', { message: state.message }))))
    }

    // ---- one item ----

    function Item({ item, group, kit, ui, t, domains, open, settled = false, onToggle, onMark, onAnswered, onUndo }) {
      const wash = kit.useWash(item.id, item.key)
      const domain = domains[item.domain] ?? {}
      const tone = domain.tone ?? GROUP_TONE[group]
      const title = item.title || item.spoken || item.text.slice(0, 80)
      const sub = item.spoken && item.spoken !== title ? item.spoken : item.text !== title ? item.text : ''
      const answer = item.answer ?? null
      useAnswerClock(settled ? null : answer)
      const closed = settled || item.moved === 'closed'
      const phase = answer === null ? null : phaseOf(answer, closed, Date.now())
      const doneText = answer !== null ? null : item.handled?.text ?? (item.moved === 'done' ? t('moved.done') : item.moved === 'closed' ? t('moved.closed') : null)
      const status = item.moved === 'snoozed' ? pressStatus(item, t) : item.moved === 'ended' ? t('moved.ended') : null
      const history = !item.liveNow && item.history.length > 0 && item.history.map(row => ({ at: row.time, text: said(row.spoken, t) || said(row.title, t) }))
      const onPress = async (action, extra) => {
        await call('action', { record: item.id, action: action.id, ...(extra?.until ? { until: extra.until } : {}) })
        changed()
        if (action.kind === 'done' || action.kind === 'snooze') onAnswered(item)
      }
      const className = ['nib-item', item.read ? '' : 'nib-unread', open && !settled ? 'nib-open' : '', answer !== null ? 'nib-answered' : '', wash].filter(Boolean).join(' ')
      return h('li', { className, id: `nib-${item.key}`, 'data-group': group },
        h('div', { className: 'nib-line' },
          h(kit.Tile, { icon: domain.icon ?? GROUP_ICON[group], tone, size: 32 }),
          h('div', { className: 'nib-main' },
            h('button', { type: 'button', className: 'nib-head', 'aria-expanded': open, onClick: () => onToggle(item) },
              h('span', { className: 'nib-titleLine' },
                !item.read && h(kit.NewDot),
                h('span', { className: 'nib-title' }, title),
                group === 'needs-you' && item.ask?.points && h('span', { className: 'nib-points' }, t('points', { n: item.ask.points })),
                h('span', { className: 'nib-when' },
                  item.liveNow && h(StateDot, { state: 'done' }),
                  h(kit.TimeAgo, { at: item.time }))),
              !open && group !== 'handled' && answer === null && sub && h('span', { className: 'nib-sub' }, status ? `${sub} · ${status}` : sub)),
            answer !== null && h(AnswerLine, { key: answer.press, item, answer, phase, t, onUndo }),
            doneText && h('div', { className: 'nib-done' }, h(IconCheckCircleOutlineRegular, { size: 14 }), h('span', null, doneText)),
            item.liveNow && item.live?.progress && h('div', { className: 'nib-progress' },
              h(kit.Progress, { from: item.live.progress.from, to: item.live.progress.to, end: h(kit.TimeUntil, { to: item.live.progress.to }) })),
            history && h(kit.History, { items: history, max: 2 }),
            open && !settled && h(Details, { item, kit, ui, t, onPress, onMark, onAnswered, locked: answer !== null && ACTIVE.has(phase), phase }))))
    }

    /** Buttons that act in the page stay while an answer is on its way; the ones that would answer again wait. */
    const STAYING = new Set(['chat', 'link'])

    function Details({ item, kit, ui, t, onPress, onMark, onAnswered, locked, phase }) {
      const status = locked ? null : pressStatus(item, t)
      const actions = locked ? item.actions.filter(action => STAYING.has(action.kind)) : item.actions
      const about = aboutOf(item)
      const states = pressStates(item)
      return h('div', { className: 'nib-body' },
        item.text && item.text !== item.title && h('div', { className: 'nib-text' }, item.text),
        item.links.length > 0 && h('div', { className: 'nib-links' },
          item.links.map(link => h('a', { key: link, href: link, target: '_blank', rel: 'noopener noreferrer' }, link))),
        item.files.length > 0 && h('div', { className: 'nib-links' },
          h('span', { className: 'nib-meta' }, t('files')),
          item.files.map(file => file.stored
            ? h('a', { key: file.name, href: api(`file?id=${encodeURIComponent(item.id)}&name=${encodeURIComponent(file.name)}`), target: '_blank', rel: 'noopener' }, file.name)
            : h('span', { key: file.name, className: 'nib-meta' }, `${file.name} (${t('notStored', { reason: file.reason || '?' })})`))),
        h('div', { className: 'nib-actions' },
          ui !== null && h(ui.ActionBar, { actions, states, about, defaultChat: true, part: 'buttons', onPress }),
          item.read && h(Button, { variant: 'outline', size: 'sm', onClick: () => onMark(item, false) }, t('markUnread')),
          status && h('span', { className: 'nib-meta' }, status)),
        !locked && item.group === 'needs-you' && (item.session || item.ask) && h(Reply, { item, t, onSent: () => { if (!item.read) onMark(item, true); onAnswered(item) } }),
        h(kit.Suggested, { actions, about, states, onPress }),
        h('div', { className: 'nib-meta' },
          item.routed.length === 0 ? t('notSent') : h(React.Fragment, null, `${t('alsoSent')}: `,
            item.routed.map((row, i) => h(React.Fragment, { key: row.destination },
              i > 0 && ', ',
              h('span', { title: row.detail || '' }, row.destination, ' ', h('span', { className: row.ok ? 'nib-ok' : 'nib-bad' }, row.ok ? '✓' : '✗'))))),
          ` · ${absolute(item.time, t)}`))
    }

    // ---- push on this device: items of the page's "more" menu ----

    const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window.PushManager === 'function' && typeof window.Notification === 'function'
    const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true
    const keyBytes = base64url => {
      const base64 = base64url.replaceAll('-', '+').replaceAll('_', '/')
      return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), c => c.charCodeAt(0))
    }
    const deviceLabel = () => {
      const ua = navigator.userAgent
      const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
      const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser'
      return [browser, os].filter(Boolean).join(' · ')
    }
    async function currentSubscription() {
      const registration = await navigator.serviceWorker.getRegistration(api(''))
      return (await registration?.pushManager.getSubscription()) ?? null
    }

    /** This browser's push state and the steps to change it. */
    function usePush(t) {
      const supported = pushSupported()
      const [state, setState] = useState(supported ? 'checking' : 'unsupported')
      const [note, setNote] = useState(null)
      useEffect(() => {
        if (!supported) return undefined
        let live = true
        currentSubscription()
          .then(async sub => (sub === null ? false : (await call('push/state', { endpoint: sub.endpoint })).subscribed))
          .then(on => { if (live) setState(on ? 'on' : 'off') }, () => { if (live) setState('off') })
        return () => { live = false }
      }, [supported])
      const run = task => async () => {
        setNote(null)
        try {
          await task()
        } catch (reason) {
          setNote(reason.message)
        }
      }
      const enable = run(async () => {
        if (await Notification.requestPermission() !== 'granted') {
          setNote(t('push.denied'))
          return
        }
        const { publicKey } = await call('push/config')
        const registration = await navigator.serviceWorker.register(api('sw.js'), { scope: api('') })
        const worker = registration.installing ?? registration.waiting ?? registration.active
        if (worker && worker.state !== 'activated') {
          await new Promise(resolve => worker.addEventListener('statechange', () => { if (worker.state === 'activated') resolve() }))
        }
        let sub = await registration.pushManager.getSubscription()
        sub ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) })
        await call('push/subscribe', { subscription: sub.toJSON(), label: deviceLabel() })
        setState('on')
      })
      const disable = run(async () => {
        const sub = await currentSubscription()
        if (sub !== null) {
          await call('push/unsubscribe', { endpoint: sub.endpoint })
          await sub.unsubscribe()
        }
        setState('off')
      })
      const test = run(async () => {
        const result = await call('push/test', { title: t('push.testTitle'), body: t('push.testBody') })
        setNote(t('push.testSent', { n: result.sent }))
      })
      const explain = state === 'unsupported' ? t(isIos() && !standalone() ? 'push.ios' : 'push.unsupported') : null
      return { state, note: note ?? explain, enable, disable, test }
    }

    function MoreMenu({ t }) {
      const push = usePush(t)
      const [open, setOpen] = useState(false)
      const items = [
        { type: 'label', id: 'push', text: `${t('push.title')} · ${t(`push.${push.state === 'on' ? 'on' : push.state === 'off' ? 'off' : 'unavailable'}`)}` },
        ...(push.state === 'off' ? [{ id: 'enable', label: t('push.enable') }] : []),
        ...(push.state === 'on' ? [{ id: 'test', label: t('push.test') }, { id: 'disable', label: t('push.disable') }] : []),
      ]
      const pick = id => {
        setOpen(false)
        if (id === 'enable') push.enable()
        else if (id === 'disable') push.disable()
        else if (id === 'test') push.test()
      }
      return h(React.Fragment, null,
        push.note && h('span', { className: 'nib-meta', role: 'status' }, push.note),
        h(Menu, {
          open,
          onClose: () => setOpen(false),
          align: 'end',
          portal: true,
          items,
          onSelect: pick,
          anchor: h(Tooltip, { label: t('more'), side: 'bottom', portal: true, disabled: open },
            h(Button, { variant: 'outline', size: 'sm', 'aria-label': t('more'), 'aria-haspopup': 'menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) },
              h(IconEllipsisOutlineRegular, null))),
        }))
    }

    // ---- the page ----

    function InboxPage({ translate: t }) {
      const kit = useShared(s => s.kit)
      if (kit === null) return h('div', { className: 'nib-page' }, h('p', { className: 'nib-empty' }, t('kitMissing')))
      return h(Inbox, { t, kit })
    }

    function Inbox({ t, kit }) {
      const version = useShared(s => s.version)
      const unread = useShared(s => s.unread)
      const summary = useShared(s => s.summary)
      const linked = useShared(s => s.linked)
      const ui = useShared(s => s.ui)
      const [view, setView] = useState('all')
      const [items, setItems] = useState(null)
      const [more, setMore] = useState(false)
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(() => shared.linked)
      // Needs you and Unread keep the items they showed (Needs you in the group they first showed in) as
      // they turn read, done or snoozed, so nothing moves under the person's finger; leaving the view (or
      // tapping its filter again) lets them go. All and Unread are one list in time order, newest first,
      // exactly as the server sends it.
      const placed = useRef(new Map())
      const [visit, setVisit] = useState(0)
      // Answered items the source has since closed stay where they were, settled, until the view is left, so what
      // the person did stays in sight (with Undo) instead of vanishing under their finger.
      const [settled, setSettled] = useState(() => new Map())
      const answered = useRef(new Map())
      const order = useRef([])
      const [focusKey, setFocusKey] = useState(null)
      /** Remember where items first showed: the page's first items in order, later arrivals on top, older pages below. */
      const place = (rows, append) => {
        const ranks = [...placed.current.values()].map(spot => spot.rank)
        let top = Math.min(0, ...ranks)
        let bottom = Math.max(-1, ...ranks)
        const fresh = placed.current.size === 0 || append
        for (const row of fresh ? rows : [...rows].reverse()) {
          if (placed.current.has(row.key)) continue
          placed.current.set(row.key, { group: row.group, rank: fresh ? ++bottom : --top })
        }
      }
      const stream = kit.useEventStream('api/notify-inbox/events', changed)

      const load = useCallback(async append => {
        try {
          const params = new URLSearchParams()
          if (view !== 'all') {
            params.set('view', view)
            if (placed.current.size > 0) params.set('keep', [...placed.current.keys()].join(','))
          }
          if (append && items?.length) params.set('before', items[items.length - 1].key)
          const page = await call(`items?${params}`)
          place(page.items, append)
          if (!append) {
            const here = new Set(page.items.map(row => row.key))
            const gone = [...answered.current].filter(([key]) => !here.has(key))
            answered.current = new Map(page.items.filter(row => row.answer && row.group === 'needs-you').map(row => [row.key, row]))
            setSettled(previous => {
              const next = new Map([...previous].filter(([key]) => !here.has(key)))
              for (const [key, row] of gone) next.set(key, row)
              return next.size === previous.size && [...next.keys()].every(key => previous.has(key)) ? previous : next
            })
          }
          setItems(previous => (append && previous ? [...previous, ...page.items] : page.items))
          setMore(page.more)
          setError(null)
        } catch (reason) {
          setError(reason.message)
        }
      }, [view, items])

      useEffect(() => { load(false) }, [view, version, visit])
      const showView = key => {
        placed.current = new Map()
        answered.current = new Map()
        setSettled(new Map())
        if (key === view) setVisit(n => n + 1)
        else setView(key)
      }
      useEffect(() => {
        if (!linked) return
        showView('all')
        setOpen(linked)
        shared.linked = null
        call('items').then(page => {
          const item = page.items.find(row => row.ids.includes(linked) || row.key === linked)
          if (item === undefined) return
          setOpen(item.key)
          call('read', { ids: item.ids }).then(changed, () => {})
          setTimeout(() => document.getElementById(`nib-${item.key}`)?.scrollIntoView({ block: 'center' }), 300)
        }, () => {})
      }, [linked])

      const mark = (item, read) => {
        setItems(list => list.map(row => (row.key === item.key ? { ...row, read } : row)))
        call('read', { ids: read ? item.ids : [item.id], read }).then(changed, reason => setError(reason.message))
      }
      const toggle = item => {
        const next = open === item.key ? null : item.key
        setOpen(next)
        if (next !== null && !item.read) mark(item, true)
      }
      /** The person answered an item: it is handled now, so open the next one that still needs them. */
      const answeredItem = item => {
        const list = order.current
        const at = list.findIndex(row => row.key === item.key)
        const next = [...list.slice(at + 1), ...list.slice(0, Math.max(at, 0))].find(row => row.key !== item.key && !row.answer && !settled.has(row.key))
        setOpen(next?.key ?? null)
        if (next === undefined) return
        if (!next.read) mark(next, true)
        setFocusKey(next.key)
      }
      useEffect(() => {
        if (focusKey === null) return
        const head = document.querySelector(`#nib-${focusKey} .nib-head`)
        head?.focus({ preventScroll: true })
        head?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        setFocusKey(null)
      }, [focusKey])
      const undoAnswer = async (item, answer) => {
        await call('undo', { press: answer.press })
        changed()
      }
      const markAll = () => call('read', { all: true }).then(changed, reason => setError(reason.message))

      const groups = summary?.groups ?? {}
      const domains = summary?.domains ?? {}
      const total = summary?.total ?? 0
      const grouped = view === 'needs-you'
      const byGroup = new Map(GROUPS.map(group => [group, []]))
      for (const item of items ?? []) byGroup.get(placed.current.get(item.key)?.group ?? item.group)?.push(item)
      const goneKeys = new Set()
      if (grouped) for (const [key, item] of settled) if (!(items ?? []).some(row => row.key === key)) { goneKeys.add(key); byGroup.get(placed.current.get(key)?.group ?? 'needs-you').push(item) }
      const rank = item => placed.current.get(item.key)?.rank ?? 0
      for (const list of byGroup.values()) list.sort((a, b) => rank(a) - rank(b))
      order.current = byGroup.get('needs-you')
      const itemRow = (item, group = item.group) => h(Item, { key: item.key, item, group, kit, ui, t, domains, open: open === item.key, settled: goneKeys.has(item.key), onToggle: toggle, onMark: mark, onAnswered: answeredItem, onUndo: undoAnswer })
      const filters = [['needs-you', t('group.needs-you'), groups['needs-you'] ?? 0], ['all', t('filter.all'), total], ['unread', t('filter.unread'), unread]]

      return h('div', { className: 'nib-page' },
        h('div', { className: 'nib-scroll' },
          h('div', { className: 'nib-content' },
            h('div', { className: 'nib-heading' },
              h('h1', null, t('title')),
              h('div', { className: 'nib-tools' },
                h(Button, { variant: 'outline', size: 'sm', disabled: unread === 0, onClick: markAll }, t('markAll')),
                h(MoreMenu, { t }))),
            summary?.line && h('p', { className: 'nib-said' }, said(summary.line.text, t)),
            h('div', { className: 'nib-status' },
              h(kit.LiveStatus, { status: stream, updatedAt: summary?.latest ?? undefined }),
              total > 0 && h('span', { className: 'nib-counts' },
                GROUPS.filter(group => (groups[group] ?? 0) > 0).map(group => h('span', { key: group }, `${t(`group.${group}`)} `, h('b', { 'data-group': group }, groups[group]))))),
            h('div', { className: 'nib-filters', role: 'group', 'aria-label': t('filter.label') },
              filters.map(([key, label, n]) => h(Pill, { key, active: view === key, 'aria-pressed': view === key, onClick: () => showView(key) },
                label, n > 0 && h('span', { className: 'nib-n' }, n)))),
            error && h('p', { className: 'nib-error', role: 'alert' }, t('error', { message: error })),
            items !== null && items.length === 0 && h('p', { className: 'nib-empty' }, t(`empty.${view}`)),
            !grouped && items !== null && items.length > 0 && h('ul', { className: 'nib-list nib-flat' }, items.map(item => itemRow(item))),
            grouped && GROUPS.map(group => byGroup.get(group).length > 0 && h('section', { key: group, className: 'nib-group', 'data-group': group, 'aria-label': t(`group.${group}`) },
              h('div', { className: 'nib-groupHead' },
                h('h2', null, t(`group.${group}`)),
                h('span', { className: 'nib-n' }, byGroup.get(group).filter(item => !goneKeys.has(item.key)).length)),
              h('ul', { className: 'nib-list' },
                byGroup.get(group).map(item => itemRow(item, group))))),
            more && h('div', { className: 'nib-more' }, h(Button, { variant: 'outline', size: 'sm', onClick: () => load(true) }, t('loadMore'))))))
    }

    /** The bell, from the kit's icons (DSH has none). */
    function BellGlyph({ size }) {
      const kit = useShared(s => s.kit)
      return kit === null ? null : h(kit.Icon, { name: 'bell', size })
    }

    function SidebarIcon({ size }) {
      const unread = useShared(s => s.unread)
      const badge = useShared(s => s.badge)
      return h('span', { className: 'nib-bell' },
        h(BellGlyph, { size }),
        unread > 0 && (badge === 'dot'
          ? h('span', { className: 'nib-dot' })
          : h('span', { className: 'nib-badge' }, unread > 99 ? '99+' : String(unread))))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The words come from the plugin's locale/<tag>.json files, served complete per tag.
        ctx.effect(() => {
          let disposers = []
          let live = true
          call('strings').then(({ tables }) => {
            if (!live) return
            disposers = Object.entries(tables).map(([tag, table]) => ctx.locale.register(NS, tag, table))
          }, reason => console.warn('notify-inbox: words unavailable', reason))
          return () => { live = false; for (const dispose of disposers) dispose() }
        }, 'notify-inbox: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return () => {}
          const tag = document.createElement('style')
          tag.id = STYLE_ID
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'notify-inbox: styles')

        // Shared pieces DSH doesn't have (tiles, time, live status, history): @soffits/dsh-ui-kit.
        ctx.inject(['uiKit'], scope => {
          scope.effect(() => {
            shared.kit = scope.uiKit
            emit()
            return () => { shared.kit = null; emit() }
          }, 'notify-inbox: kit')
        })

        // The buttons, when @soffits/dsh-ui-actions is installed; without it the page shows no buttons.
        ctx.inject(['uiActions'], scope => {
          scope.effect(() => {
            shared.ui = scope.uiActions
            emit()
            const unregister = scope.uiActions.registerSource({ id: OWNER, name: () => t('panel'), icon: BellGlyph })
            return () => { unregister(); shared.ui = null; emit() }
          }, 'notify-inbox: buttons')
        })

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL,
          locale: NS,
          inject: () => ({ translate: t }),
        }, InboxPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL,
          order: 11,
          locale: NS,
          label: () => t('panel'),
        }, SidebarIcon))

        shared.openSession = id => ctx.get('uiWorkspace')?.openSession(id)

        // The counts: read when the app shows, and again whenever the events stream says the inbox
        // changed (the stream is open while the app is visible; EventSource reconnects by itself).
        ctx.effect(() => {
          let source = null
          const open = () => {
            if (source !== null || typeof EventSource !== 'function') return
            source = new EventSource(api('events'), { withCredentials: true })
            source.onmessage = changed
            source.onopen = changed
          }
          const close = () => { source?.close(); source = null }
          const onVisible = () => {
            if (document.visibilityState === 'visible') { open(); refreshSummary() } else close()
          }
          document.addEventListener('visibilitychange', onVisible)
          onVisible()
          return () => { close(); document.removeEventListener('visibilitychange', onVisible) }
        }, 'notify-inbox: counts')

        // ?notify-inbox=<id> (a tapped push, a shared link) opens the page on that notification.
        const openLinked = id => {
          shared.linked = id || null
          emit()
          let tries = 0
          const timer = setInterval(() => {
            const layout = ctx.get('layout')
            try {
              layout?.selectPanel(PANEL)
              if (layout) clearInterval(timer)
            } catch {
              // The main slot entry is not registered yet.
            }
            if (++tries > 50) clearInterval(timer)
          }, 100)
        }
        ctx.effect(() => {
          // A link to an item opens it, at page load and when another page of the app links here in place
          // (it pushes the URL and fires popstate, as DSH's own links do).
          const followLink = () => {
            const params = new URLSearchParams(location.search)
            if (!params.has(LINK_PARAM)) return
            const id = params.get(LINK_PARAM)
            params.delete(LINK_PARAM)
            const query = params.toString()
            history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
            openLinked(id)
          }
          followLink()
          window.addEventListener('popstate', followLink)
          const onMessage = event => {
            if (event.data?.type !== 'notify-inbox/open') return
            try {
              openLinked(new URL(event.data.url, location.href).searchParams.get(LINK_PARAM))
            } catch {
              // Not one of ours.
            }
          }
          navigator.serviceWorker?.addEventListener('message', onMessage)
          navigator.serviceWorker?.startMessages?.()
          return () => {
            window.removeEventListener('popstate', followLink)
            navigator.serviceWorker?.removeEventListener('message', onMessage)
          }
        }, 'notify-inbox: links')
      },
    }
  },
})
