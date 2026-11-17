/*
 * Action buttons for DSH Web UI plugins: chat, done, snooze, event and link,
 * the same look and behaviour wherever an item offers them.
 *
 * A DSH client chunk: dsh-card-board's client loads it with
 * `require.async('./client.actions.js')`. Another plugin can ship a copy as
 * its own `client.actions.js`, changing OWNER below to its package name; the
 * file has no imports and takes React and the client context as arguments.
 *
 *   const { createActions } = await require.async('./client.actions.js')
 *   const ui = createActions({ React, ctx, locale: 'en', press })
 *   h(ui.ActionBar, { actions, states, chat, onPress })
 *
 * `press(action, extra)` is the plugin's own server call for done, snooze and
 * event (extra carries `until` for a snooze); it should resolve once the
 * server has accepted the press. `chat` and `link` never reach the server:
 * chat opens a conversation with a prefilled, editable draft through the Web
 * UI's own workspace service (so the person sends it themselves, signed in as
 * themselves), and link opens the URL.
 */
const OWNER = '@soffits/dsh-notify-inbox'

const WORDS = {
  en: {
    chat: 'Ask',
    chatAbout: 'Chat about this',
    done: 'Done',
    snooze: 'Snooze',
    open: 'Open',
    in3h: 'In 3 hours',
    tomorrow: 'Tomorrow 9:00',
    pick: 'Pick a time…',
    set: 'Snooze',
    cancel: 'Cancel',
    sending: 'Sending…',
    pending: 'Waiting for it to be picked up',
    handled: 'Done',
    unhandled: 'Nothing picked this up yet',
    failed: 'Didn’t go through: {message}',
    noWorkspace: 'Open a conversation once first, then try again.',
  },
  zh: {
    chat: '问问',
    chatAbout: '聊聊这个',
    done: '完成',
    snooze: '稍后提醒',
    open: '打开',
    in3h: '3 小时后',
    tomorrow: '明天 9:00',
    pick: '选个时间…',
    set: '稍后提醒',
    cancel: '取消',
    sending: '发送中…',
    pending: '等待处理',
    handled: '已处理',
    unhandled: '还没有被处理',
    failed: '没有成功：{message}',
    noWorkspace: '请先打开一次对话，再试一次。',
  },
}

const CSS = `
.ua-bar{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.ua-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:5px;height:28px;padding:0 10px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;text-decoration:none;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3)}
.ua-btn svg{flex:none;width:14px;height:14px}
.ua-btn:disabled{cursor:default;opacity:.7}
@media (hover:hover){.ua-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}
.ua-icon{width:26px;height:26px;padding:0;justify-content:center;box-shadow:none;color:var(--dsw-alias-label-tertiary)}
.ua-btn[data-state=pending] svg,.ua-btn[data-state=sending] svg{animation:ua-pulse 1.2s ease-in-out infinite}
.ua-btn[data-state=done]{color:var(--dsw-alias-state-success-primary)}
.ua-btn[data-state=unhandled]{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary))}
@keyframes ua-pulse{50%{opacity:.35}}
.ua-wrap{position:relative;display:inline-flex}
.ua-menu{position:absolute;z-index:20;top:calc(100% + 4px);right:0;min-width:168px;padding:4px;border-radius:12px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-base));box-shadow:0 6px 24px #0000001f,inset 0 0 0 .5px var(--dsw-alias-border-l2);display:flex;flex-direction:column}
.ua-menu button{display:flex;align-items:center;gap:8px;padding:7px 10px;border:0;border-radius:8px;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:left;cursor:pointer}
@media (hover:hover){.ua-menu button:hover{background:var(--dsw-alias-interactive-bg-hover)}}
.ua-menu input{margin:4px 6px;padding:6px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:transparent;color:inherit;font:inherit;font-size:13px}
.ua-menuRow{display:flex;justify-content:flex-end;gap:4px;padding:2px 4px}
.ua-error{color:var(--dsw-alias-state-error-primary);font-size:12px}
`

const ICONS = {
  chat: 'M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v5A1.5 1.5 0 0 1 11.5 11H7l-3 2.5V11h.5A1.5 1.5 0 0 1 3 9.5z',
  done: 'M3.5 8.5l3 3 6-7',
  snooze: 'M8 4.5V8l2.2 1.4M13.5 8a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z',
  event: 'M8.8 2.5 4 9h4l-.8 4.5L12 7H8z',
  link: 'M6 3.5H3.5v9h9V10M9 3h4v4M13 3 7.5 8.5',
  pending: 'M8 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  unhandled: 'M8 3.5v5.5M8 12v.5',
}

function fill(text, params) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in params ? String(params[key]) : match))
}

/** The next 09:00 after now, as an ISO string. */
function tomorrowMorning(now = new Date()) {
  const date = new Date(now)
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.toISOString()
}

/**
 * The draft for a chat about an item: the person's question goes first (a
 * prompt from the data, or nothing yet), then the item quoted, then its
 * context as JSON for the agent.
 */
function chatText({ prompt = '', title, lines = [], context }) {
  const quote = [title ? `**${title}**` : null, ...lines].filter(Boolean).map(line => `> ${line}`).join('\n')
  const parts = [prompt, quote]
  if (context !== undefined) parts.push(`\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``)
  return `${parts.filter(Boolean).join('\n\n')}\n`
}

/**
 * @param {object} options
 * @param {object} options.React - the page's React
 * @param {object} options.ctx - the plugin's client context (ctx.get reaches the Web UI's services)
 * @param {string} [options.locale] - 'zh…' picks Chinese words, anything else English
 * @param {(action: object, extra: object) => Promise<unknown>} [options.press] - the server call for done, snooze and event
 */
function createActions({ React, ctx, locale = 'en', press }) {
  const h = React.createElement
  const { useState, useEffect, useRef } = React
  const words = WORDS[String(locale).toLowerCase().startsWith('zh') ? 'zh' : 'en']
  const t = key => words[key] ?? WORDS.en[key] ?? key

  if (typeof document !== 'undefined' && !document.getElementById('dsh-actions-ui-style')) {
    const style = document.createElement('style')
    style.id = 'dsh-actions-ui-style'
    style.dataset.plugin = OWNER
    style.textContent = CSS
    document.head.appendChild(style)
  }

  function Icon({ name }) {
    return h('svg', { viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, h('path', { d: ICONS[name] ?? ICONS.event }))
  }

  /**
   * Open a conversation with `text` as its editable draft: a new one in the
   * current (or most recent) workspace, or the given session.
   */
  async function startChat({ text, session }) {
    const workspace = ctx.get('uiWorkspace')
    if (workspace === undefined) throw new Error(t('noWorkspace'))
    if (session === undefined || session === 'new') {
      workspace.startSession(undefined, { prompt: text, whenDraftExists: 'replace' })
      return
    }
    workspace.openSession(session)
    const sessions = ctx.get('sessions')
    const conversation = ctx.get('conversation')
    for (let i = 0; i < 30 && sessions && conversation; i += 1) {
      const binding = sessions.binding(session)
      if (binding !== undefined) {
        try {
          conversation.input.requestDraftInitialization(binding, { prompt: text, whenDraftExists: 'append' })
        } catch {
          // the session moved on before the draft landed; it is open, the person can type
        }
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  function SnoozeMenu({ onPick, onClose }) {
    const [picking, setPicking] = useState(false)
    const [value, setValue] = useState('')
    const ref = useRef(null)
    useEffect(() => {
      const away = event => { if (ref.current && !ref.current.contains(event.target)) onClose() }
      const escape = event => { if (event.key === 'Escape') onClose() }
      document.addEventListener('pointerdown', away)
      document.addEventListener('keydown', escape)
      return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
    }, [onClose])
    return h('div', { className: 'ua-menu', ref, role: 'menu' },
      !picking && h('button', { type: 'button', role: 'menuitem', onClick: () => onPick(new Date(Date.now() + 3 * 3600 * 1000).toISOString()) }, t('in3h')),
      !picking && h('button', { type: 'button', role: 'menuitem', onClick: () => onPick(tomorrowMorning()) }, t('tomorrow')),
      !picking && h('button', { type: 'button', role: 'menuitem', onClick: () => setPicking(true) }, t('pick')),
      picking && h('input', { type: 'datetime-local', value, autoFocus: true, onChange: event => setValue(event.target.value) }),
      picking && h('div', { className: 'ua-menuRow' },
        h('button', { type: 'button', onClick: onClose }, t('cancel')),
        h('button', { type: 'button', disabled: value === '', onClick: () => onPick(new Date(value).toISOString()) }, t('set'))))
  }

  /**
   * One action as a button. `state` is the server's view of the last press
   * (pending, done, unhandled); `compact` draws an icon only.
   */
  function ActionButton({ action, state, compact, chat, onPress }) {
    const [local, setLocal] = useState(null)
    const [error, setError] = useState(null)
    const [menu, setMenu] = useState(false)
    useEffect(() => { if (state) setLocal(null) }, [state])
    const shown = local ?? state
    const label = action.label ?? t(action.kind === 'chat' ? 'chat' : action.kind === 'link' ? 'open' : action.kind)
    const title = shown === 'sending' ? t('sending') : shown === 'pending' ? t('pending') : shown === 'done' ? t('handled') : shown === 'unhandled' ? t('unhandled') : error ?? label
    const icon = shown === 'done' ? 'done' : shown === 'unhandled' ? 'unhandled' : action.kind
    const className = `ua-btn${compact ? ' ua-icon' : ''}`
    const content = [h(Icon, { key: 'i', name: icon }), !compact && h('span', { key: 'l' }, label)]

    if (action.kind === 'link') {
      const url = action.payload?.url
      const external = /^https?:/i.test(url ?? '')
      return h('a', { className, href: url, title: label, 'aria-label': label, ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}) }, content)
    }
    const send = async extra => {
      setMenu(false)
      setError(null)
      setLocal('sending')
      try {
        if (action.kind === 'chat') {
          await chat(action)
          setLocal(null)
        } else {
          await (onPress ?? press)(action, extra ?? {})
          setLocal('pending')
        }
      } catch (reason) {
        setLocal(null)
        setError(fill(t('failed'), { message: reason?.message ?? String(reason) }))
      }
    }
    const onClick = () => {
      if (action.kind === 'snooze' && action.payload?.until === undefined) setMenu(open => !open)
      else send()
    }
    const busy = shown === 'sending' || shown === 'pending'
    return h('span', { className: 'ua-wrap' },
      h('button', { type: 'button', className, title, 'aria-label': `${label}${title !== label ? ` (${title})` : ''}`, 'data-state': shown ?? undefined, disabled: busy, onClick }, content),
      menu && h(SnoozeMenu, { onPick: until => send({ until }), onClose: () => setMenu(false) }),
      error && !compact && h('span', { className: 'ua-error', role: 'alert' }, error))
  }

  /**
   * A row of action buttons.
   * @param {object} props
   * @param {object[]} props.actions - the item's actions, as the data declares them
   * @param {Record<string, string>} [props.states] - press state by action id
   * @param {boolean} [props.compact] - icons only (for rows)
   * @param {(action: object) => Promise<void>} props.chat - opens the chat for a chat action
   * @param {(action: object, extra: object) => Promise<unknown>} [props.onPress] - this bar's press call, instead of the one given to createActions
   */
  function ActionBar({ actions, states = {}, compact = false, chat, onPress }) {
    if (!actions || actions.length === 0) return null
    return h('div', { className: 'ua-bar' }, actions.map(action =>
      h(ActionButton, { key: action.id, action, state: states[action.id], compact, chat, onPress })))
  }

  return { ActionBar, ActionButton, Icon, startChat, chatText, t }
}

if (typeof window !== 'undefined' && window.__ModuleLoader__) {
  window.__ModuleLoader__.load({ id: `${OWNER}/client.actions.js`, factory: () => ({ createActions, chatText }) })
}
