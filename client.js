/*
 * Browser half of dsh-notify-inbox: the Inbox entry in the sidebar (with the
 * unread count), its page, turning Web Push on for this browser, and the
 * buttons on each notification.
 *
 * Plain JavaScript in DSH's Client module format (no build step); React comes
 * from the page's module table. Everything the page shows comes from the
 * plugin's /api/notify-inbox routes, which decide per request who is asking.
 * A link with ?notify-inbox=<id> opens the page on that notification.
 */
window.__ModuleLoader__.load({
  id: '@soffits/dsh-notify-inbox',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useSyncExternalStore } = React

    const NS = 'dsh-notify-inbox'
    const PANEL = 'dsh-notify-inbox'
    const LINK_PARAM = 'notify-inbox'
    const STYLE_ID = 'dsh-notify-inbox-style'
    const PENDING_MS = 2 * 60 * 1000
    const api = path => new URL(`api/notify-inbox/${path}`, document.baseURI).href

    const CSS = `
.nib-page{width:100%;min-width:0;height:100%;min-height:0;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;line-height:1.6}
.nib-scroll{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.nib-content{max-width:820px;margin:0 auto;padding:0 clamp(16px,4vw,48px) 48px}
.nib-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding-top:28px;margin-bottom:16px}
[data-platform=darwin] .nib-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}
.nib-head h1{margin:0;font-size:20px;font-weight:500;line-height:28px;flex:1;min-width:0}
.nib-count{color:var(--dsw-alias-label-tertiary);font-size:13px;margin-left:8px;font-weight:400}
.nib-tabs{display:inline-flex;gap:2px;padding:2px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover))}
.nib-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;padding:2px 12px;border-radius:8px;cursor:pointer}
.nib-tab[aria-pressed=true]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);box-shadow:0 0 0 .5px var(--dsw-alias-border-l3)}
.nib-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:none;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsh-button-outline-color,var(--dsw-alias-border-l3));text-decoration:none;white-space:nowrap}
.nib-btn:disabled{cursor:not-allowed;opacity:.4}
@media (hover:hover){.nib-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.nib-item:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.nib-primary{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-color,#fff);box-shadow:none}
.nib-push{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:10px 12px;margin-bottom:16px;border-radius:12px;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-size:13px}
.nib-push strong{font-weight:500;color:var(--dsw-alias-label-primary)}
.nib-push .nib-grow{flex:1;min-width:120px}
.nib-hint{width:100%;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nib-list{display:flex;flex-direction:column;gap:2px;margin:0;padding:0;list-style:none}
.nib-item{border-radius:12px;padding:10px 12px;position:relative}
.nib-item.nib-open{background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-interactive-bg-hover))}
.nib-row{display:flex;gap:10px;align-items:flex-start;width:100%;border:none;background:transparent;color:inherit;font:inherit;text-align:left;padding:0;cursor:pointer}
.nib-dot{flex:none;width:8px;height:8px;border-radius:50%;margin-top:8px;background:transparent}
.nib-unread .nib-dot{background:var(--dsw-alias-state-business-primary)}
.nib-unread.nib-urgent .nib-dot{background:var(--dsw-alias-state-error-primary)}
.nib-main{flex:1;min-width:0}
.nib-titleLine{display:flex;align-items:baseline;gap:8px;min-width:0}
.nib-title{flex:1;min-width:0;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.nib-unread .nib-title{font-weight:600;color:var(--dsw-alias-label-primary)}
.nib-open .nib-title{white-space:normal;overflow-wrap:anywhere}
.nib-time{flex:none;color:var(--dsw-alias-label-caption);font-size:12px}
.nib-spoken{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.nib-chip{display:inline-block;flex:none;padding:0 6px;border-radius:6px;font-size:11px;line-height:18px;font-weight:500;color:var(--dsw-alias-state-error-primary);box-shadow:inset 0 0 0 .5px currentColor}
.nib-chip.nib-muted{color:var(--dsw-alias-label-tertiary)}
.nib-body{margin:8px 0 0 18px;display:flex;flex-direction:column;gap:10px}
.nib-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:22px}
.nib-links{display:flex;flex-direction:column;gap:2px;font-size:13px}
.nib-links a{color:var(--dsw-alias-state-business-primary);overflow-wrap:anywhere}
.nib-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.nib-route{display:inline-flex;gap:3px;margin-right:10px}
.nib-ok{color:var(--dsw-alias-state-success-primary)}
.nib-bad{color:var(--dsw-alias-state-error-primary)}
.nib-actions{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.nib-status{color:var(--dsw-alias-label-tertiary);font-size:12px}
.nib-empty{color:var(--dsw-alias-label-tertiary);padding:24px 12px}
.nib-error{color:var(--dsw-alias-state-error-primary);padding:12px}
.nib-more{margin:12px auto 0;display:flex}
.nib-icon{position:relative;display:inline-flex}
.nib-badge{position:absolute;top:-5px;right:-8px;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:9px;font-weight:600;line-height:14px;text-align:center;pointer-events:none}
@media (width<=640px),(pointer:coarse){.nib-btn,.nib-tab,.nib-page .ua-btn{min-height:40px;min-width:40px}.nib-tab{padding-inline:14px}.nib-tabs{border-radius:12px}}
@media (width<=640px){.nib-content{padding-inline:12px}.nib-head{padding-top:16px}.nib-body{margin-left:0}.nib-item{padding:10px 8px}}
`

    // ---- shared state: the unread count and a version that bumps when anything changes ----

    const shared = { unread: 0, version: 0, pollSeconds: 30, linked: null }
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
        shared.pollSeconds = summary.pollSeconds || 30
        const key = `${summary.unread}|${summary.latest}|${summary.total}|${summary.handled}`
        if (key !== lastSummary) {
          lastSummary = key
          shared.unread = summary.unread
          shared.version += 1
          emit()
        }
      } catch {
        // Signed out or DSH restarting; try again at the next tick.
      }
    }
    const changed = () => { lastSummary = ''; refreshSummary() }

    // ---- time ----

    function relative(iso, t) {
      const seconds = (Date.parse(iso) - Date.now()) / 1000
      const format = new Intl.RelativeTimeFormat(t('time.locale'), { numeric: 'auto', style: 'short' })
      const abs = Math.abs(seconds)
      if (abs < 60) return format.format(Math.round(seconds), 'second')
      if (abs < 3600) return format.format(Math.round(seconds / 60), 'minute')
      if (abs < 86400) return format.format(Math.round(seconds / 3600), 'hour')
      if (abs < 86400 * 7) return format.format(Math.round(seconds / 86400), 'day')
      return new Date(iso).toLocaleDateString(t('time.locale'), { month: 'short', day: 'numeric' })
    }
    const absolute = (iso, t) => new Date(iso).toLocaleString(t('time.locale'), { dateStyle: 'medium', timeStyle: 'short' })

    /** What happened to this item's latest press, in words, or null. */
    function pressStatus(item, t) {
      const press = item.presses[item.presses.length - 1]
      if (press === undefined) return null
      const handled = item.handled.find(row => row.press === press.press)
      if (handled !== undefined) {
        if (handled.result === 'snoozed' && handled.until) return t('press.snoozed', { time: absolute(handled.until, t) })
        if (handled.result === 'done') return t('press.done')
        return handled.result
      }
      return Date.now() - Date.parse(press.at) < PENDING_MS ? t('press.pending') : t('press.unhandled')
    }

    // ---- the buttons: the shared action bar (client.actions.js, also used by the card board) ----

    let actionsModule
    const loadActions = () => (actionsModule ??= require.async('./client.actions.js').catch(error => { actionsModule = undefined; throw error }))

    /** The server's view of each button's last press: pending, done or unhandled. */
    function pressStates(item) {
      const states = {}
      for (const press of item.presses) {
        const action = item.actions.find(row => row.kind === press.action) ?? { id: press.action }
        const handled = item.handled.some(row => row.press === press.press)
        states[action.id] = handled ? 'done' : Date.now() - Date.parse(press.at) < PENDING_MS ? 'pending' : 'unhandled'
      }
      return states
    }

    function Actions({ item, t, ui }) {
      if (ui === null) return null
      const declared = item.actions.some(action => action.kind === 'chat') ? item.actions : [{ kind: 'chat', id: 'chat', payload: {} }, ...item.actions]
      const chat = action => ui.startChat({
        text: ui.chatText({ prompt: action.payload?.prompt ?? '', title: item.title || item.spoken, lines: (item.text || item.spoken).split('\n'),
          context: { notification: item.id, time: item.time, lane: item.lane, domain: item.domain || undefined, links: item.links.length ? item.links : undefined } }),
        session: action.payload?.session,
      })
      const onPress = async (action, extra) => {
        await call('action', { record: item.id, action: action.id, ...(extra?.until ? { until: extra.until } : {}) })
        changed()
      }
      const status = pressStatus(item, t)
      return h('div', { className: 'nib-actions' }, h(ui.ActionBar, { actions: declared, states: pressStates(item), chat, onPress }),
        status && h('span', { className: 'nib-status' }, status))
    }

    // ---- one notification ----

    function Item({ item, t, open, onToggle, ui }) {
      const urgent = item.lane === 'interrupt'
      const className = ['nib-item', item.read ? '' : 'nib-unread', urgent ? 'nib-urgent' : '', open ? 'nib-open' : ''].filter(Boolean).join(' ')
      const title = item.title || item.spoken || item.text.slice(0, 80)
      const sub = item.spoken && item.spoken !== title ? item.spoken : item.text !== title ? item.text : ''
      return h('li', { className, id: `nib-${item.id}` },
        h('button', { type: 'button', className: 'nib-row', 'aria-expanded': open, onClick: () => onToggle(item) },
          h('span', { className: 'nib-dot', 'aria-hidden': true }),
          h('span', { className: 'nib-main' },
            h('span', { className: 'nib-titleLine' },
              urgent && h('span', { className: 'nib-chip' }, t('urgent')),
              item.test && h('span', { className: 'nib-chip nib-muted' }, t('test')),
              h('span', { className: 'nib-title' }, title),
              h('span', { className: 'nib-time', title: absolute(item.time, t) }, relative(item.time, t))),
            !open && sub && h('span', { className: 'nib-spoken' }, sub))),
        open && h('div', { className: 'nib-body' },
          item.text && item.text !== title && h('div', { className: 'nib-text' }, item.text),
          item.links.length > 0 && h('div', { className: 'nib-links' },
            item.links.map(link => h('a', { key: link, href: link, target: '_blank', rel: 'noopener noreferrer' }, link))),
          item.files.length > 0 && h('div', { className: 'nib-links' },
            h('span', { className: 'nib-meta' }, t('files')),
            item.files.map(file => file.stored
              ? h('a', { key: file.name, href: api(`file?id=${encodeURIComponent(item.id)}&name=${encodeURIComponent(file.name)}`), target: '_blank', rel: 'noopener' }, file.name)
              : h('span', { key: file.name, className: 'nib-meta' }, `${file.name} (${t('notStored', { reason: file.reason || '?' })})`))),
          h(Actions, { item, t, ui }),
          h('div', { className: 'nib-meta' },
            item.routed.length === 0 ? t('notSent') : h(React.Fragment, null, `${t('alsoSent')}: `,
              item.routed.map(row => h('span', { key: row.destination, className: 'nib-route', title: row.detail || '' },
                row.destination, h('span', { className: row.ok ? 'nib-ok' : 'nib-bad' }, row.ok ? '✓' : '✗'),
                !row.ok && row.detail ? ` ${row.detail}` : ''))),
            ` · ${absolute(item.time, t)}`)))
    }

    // ---- push on this device ----

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

    function PushControl({ t }) {
      const supported = pushSupported()
      const [state, setState] = useState('checking')
      const [note, setNote] = useState(null)
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        if (!supported) return
        let live = true
        currentSubscription()
          .then(async sub => (sub === null ? false : (await call('push/state', { endpoint: sub.endpoint })).subscribed))
          .then(on => { if (live) setState(on ? 'on' : 'off') }, () => { if (live) setState('off') })
        return () => { live = false }
      }, [supported])
      if (!supported) {
        return h('div', { className: 'nib-push' }, h('span', { className: 'nib-grow' }, h('strong', null, t('push.title'))),
          h('span', { className: 'nib-hint' }, isIos() && !standalone() ? t('push.ios') : t('push.unsupported')))
      }
      const run = task => async () => {
        setBusy(true)
        setNote(null)
        try {
          await task()
        } catch (reason) {
          setNote(reason.message)
        } finally {
          setBusy(false)
        }
      }
      const enable = run(async () => {
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
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
      return h('div', { className: 'nib-push' },
        h('span', { className: 'nib-grow' }, h('strong', null, t('push.title')), ' · ', state === 'on' ? t('push.on') : state === 'off' ? t('push.off') : '…'),
        state === 'on' && h('button', { type: 'button', className: 'nib-btn', disabled: busy, onClick: test }, t('push.test')),
        state === 'on' && h('button', { type: 'button', className: 'nib-btn', disabled: busy, onClick: disable }, t('push.disable')),
        state === 'off' && h('button', { type: 'button', className: 'nib-btn nib-primary', disabled: busy, onClick: enable }, t('push.enable')),
        note && h('span', { className: 'nib-hint' }, note))
    }

    // ---- the page ----

    function InboxPage({ translate: t, makeActions }) {
      const version = useShared(s => s.version)
      const unread = useShared(s => s.unread)
      const linked = useShared(s => s.linked)
      const [filter, setFilter] = useState(() => (shared.linked ? 'all' : 'unread'))
      const [items, setItems] = useState(null)
      const [more, setMore] = useState(false)
      const [error, setError] = useState(null)
      const [open, setOpen] = useState(() => shared.linked)
      const openRef = useRef(open)
      openRef.current = open
      const [ui, setUi] = useState(null)
      useEffect(() => {
        let live = true
        makeActions().then(made => { if (live) setUi(made) }, reason => { console.warn('notify-inbox: buttons unavailable', reason) })
        return () => { live = false }
      }, [])

      const load = useCallback(async (append) => {
        try {
          const params = new URLSearchParams()
          if (filter === 'unread') params.set('unread', '1')
          if (append && items?.length) params.set('before', items[items.length - 1].id)
          const page = await call(`items?${params}`)
          setItems(previous => {
            if (append && previous) return [...previous, ...page.items]
            // The open item stays where it was even when it no longer matches the filter (opening marks it read).
            const kept = previous?.findIndex(row => row.id === openRef.current) ?? -1
            if (kept < 0 || page.items.some(row => row.id === openRef.current)) return page.items
            const next = [...page.items]
            next.splice(Math.min(kept, next.length), 0, { ...previous[kept], read: true })
            return next
          })
          setMore(page.more)
          setError(null)
        } catch (reason) {
          setError(reason.message)
        }
      }, [filter, items])

      useEffect(() => { load(false) }, [filter, version])
      useEffect(() => {
        if (!linked) return
        setFilter('all')
        setOpen(linked)
        shared.linked = null
        call('read', { ids: [linked] }).then(changed, () => {})
        setTimeout(() => document.getElementById(`nib-${linked}`)?.scrollIntoView({ block: 'center' }), 300)
      }, [linked])

      const toggle = item => {
        const next = open === item.id ? null : item.id
        setOpen(next)
        if (next !== null && !item.read) {
          setItems(list => list.map(row => (row.id === item.id ? { ...row, read: true } : row)))
          call('read', { ids: [item.id] }).then(changed, () => {})
        }
      }
      const markAll = () => call('read', { all: true }).then(changed, reason => setError(reason.message))

      return h('div', { className: 'nib-page' },
        h('div', { className: 'nib-scroll' },
          h('div', { className: 'nib-content' },
            h('div', { className: 'nib-head' },
              h('h1', null, t('title'), unread > 0 && h('span', { className: 'nib-count' }, unread)),
              h('div', { className: 'nib-tabs', role: 'group' },
                ['unread', 'all'].map(key => h('button', { key, type: 'button', className: 'nib-tab', 'aria-pressed': filter === key, onClick: () => setFilter(key) }, t(`filter.${key}`)))),
              h('button', { type: 'button', className: 'nib-btn', disabled: unread === 0, onClick: markAll }, t('markAll'))),
            h(PushControl, { t }),
            error && h('p', { className: 'nib-error', role: 'alert' }, t('error', { message: error })),
            items !== null && items.length === 0 && h('p', { className: 'nib-empty' }, t(filter === 'unread' ? 'empty.unread' : 'empty.all')),
            items !== null && h('ul', { className: 'nib-list' },
              items.map(item => h(Item, { key: item.id, item, t, open: open === item.id, onToggle: toggle, ui }))),
            more && h('button', { type: 'button', className: 'nib-btn nib-more', onClick: () => load(true) }, t('loadMore')))))
    }

    function SidebarIcon({ size }) {
      const unread = useShared(s => s.unread)
      const stroke = { stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }
      return h('span', { className: 'nib-icon' },
        h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, focusable: 'false' },
          h('path', { d: 'M8 2.2c-2.3 0-3.9 1.8-3.9 4v2.3L3 10.4c-.2.4.1.9.5.9h9c.4 0 .7-.5.5-.9l-1.1-1.9V6.2c0-2.2-1.6-4-3.9-4Z', ...stroke }),
          h('path', { d: 'M6.5 13.2c.3.7.9 1.1 1.5 1.1s1.2-.4 1.5-1.1', ...stroke })),
        unread > 0 && h('span', { className: 'nib-badge' }, unread > 99 ? '99+' : String(unread)))
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

        const makeActions = () => loadActions().then(module => module.createActions({ React, ctx, t: (key, params) => t(`action.${key}`, params) }))

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL,
          locale: NS,
          inject: () => ({ translate: t, makeActions }),
        }, InboxPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL,
          order: 11,
          locale: NS,
          label: () => t('panel'),
        }, SidebarIcon))

        // The unread count: checked while the page is visible, and right away when it becomes visible.
        ctx.effect(() => {
          let timer
          const tick = () => {
            clearTimeout(timer)
            if (document.visibilityState === 'visible') refreshSummary()
            timer = setTimeout(tick, shared.pollSeconds * 1000)
          }
          const onVisible = () => { if (document.visibilityState === 'visible') tick() }
          document.addEventListener('visibilitychange', onVisible)
          tick()
          return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
        }, 'notify-inbox: unread count')

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
          const params = new URLSearchParams(location.search)
          if (params.has(LINK_PARAM)) {
            const id = params.get(LINK_PARAM)
            params.delete(LINK_PARAM)
            const query = params.toString()
            history.replaceState(history.state, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
            openLinked(id)
          }
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
          return () => navigator.serviceWorker?.removeEventListener('message', onMessage)
        }, 'notify-inbox: links')
      },
    }
  },
})
