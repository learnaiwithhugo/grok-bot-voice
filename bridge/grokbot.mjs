/**
 * The Grok Bot driver.
 *
 * Grok Bot (the desktop app) has no API, no CLI and no voice mode: the only way
 * a message reaches a bot is the chat box in its window. So JARVIS drives the
 * window itself, over Chrome's DevTools protocol, the way the Claude Chrome
 * extension drives a browser tab. That needs Grok Bot to be launched once with
 * `--remote-debugging-port=<port>` (scripts/start.mjs does it), which opens a
 * control port on 127.0.0.1 only. Anything on this Mac can then type into Grok
 * Bot for as long as it stays open that way; reopening it from the Dock closes
 * the port again.
 *
 * What this module gives the bridge:
 *   available()      the port answers and the Grok Bot window is there
 *   bots()           names in the sidebar
 *   currentBot()     the heading of the open chat
 *   openBot(name)    click a bot in the sidebar and wait for its chat
 *   send(text)       type into the composer and press Enter
 *   on('message')    every bubble that appears or changes in the open chat,
 *                    flagged `isNew` when it was not there before
 *   on('working')    the "<Bot> is working" indicator turning on and off
 *
 * The window is read by polling from this side (see SNAPSHOT), never by a
 * timer inside the page.
 *
 * The page is read through the accessibility labels Grok Bot sets on its own
 * elements (`aria-label="Chief of Staff message"`, `role="textbox"
 * aria-label="Prompt"`, `aria-label="Bot list"`), not through its generated
 * class names, because the labels are what the app itself relies on and the
 * class names change every build.
 */

import { EventEmitter } from 'node:events'
import WebSocket from 'ws'

const RENDERER = /renderer\/index\.html/

/**
 * One reading of the window, taken from the bridge side.
 *
 * Evaluated every POLL_MS over the protocol rather than run as a timer inside
 * the page: a page timer is throttled hard when its window is hidden behind
 * others — measured at once every 30–45 s with Grok Bot sitting behind Chrome —
 * and a reply that lands in three seconds would be read half a minute late.
 * A Runtime.evaluate from outside runs immediately regardless.
 *
 * Returns the open chat's name, whether the bot is marked working, and the
 * last few transcript rows keyed by their timestamp, label and ordinal, which
 * is stable across the virtualised list recycling its elements.
 */
const SNAPSHOT = `(() => {
  const heading = document.querySelector('[role="heading"]')
  const status = [...document.querySelectorAll('[role="status"]')]
    .map((e) => (e.textContent || '').trim()).filter(Boolean)
  const counts = new Map()
  const rows = []
  for (const row of document.querySelectorAll('[role="article"]')) {
    const group = row.querySelector('[role="group"][aria-label]')
    const time = row.querySelector('time[datetime]')
    if (!group || !time) continue
    const label = group.getAttribute('aria-label') || ''
    const at = time.getAttribute('datetime') || ''
    const n = (counts.get(at + label) || 0) + 1
    counts.set(at + label, n)
    rows.push({ key: at + '|' + label + '|' + n, label, at, text: (group.innerText || '').trim() })
  }
  return {
    bot: heading ? heading.textContent.trim() : '',
    working: status.some((t) => /is working|working on|thinking/i.test(t)),
    status,
    rows: rows.slice(-15),
  }
})()`

const POLL_MS = 300

/** "chief of staff" ~ "Chief Of Staff." — names are matched loosely. */
export const normaliseName = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** Pick the bot a spoken name refers to, or null when nothing fits. */
export function matchBot(spoken, names) {
  const want = normaliseName(spoken)
  if (!want) return null
  const norm = names.map((n) => [normaliseName(n), n])
  return (
    norm.find(([n]) => n === want)?.[1] ??
    norm.find(([n]) => n.startsWith(want))?.[1] ??
    norm.find(([n]) => n.includes(want) || want.includes(n))?.[1] ??
    null
  )
}

/**
 * @param {{ port: number, log?: (line: string) => void }} options
 */
export function createGrokBot({ port, log = () => {} }) {
  const events = new EventEmitter()
  /** @type {WebSocket | null} */
  let ws = null
  /** @type {Promise<WebSocket> | null} */
  let dialling = null
  let nextId = 0
  const pending = new Map()
  /** Every bubble the sampler has ever reported, so a turn can tell new from old. */
  const known = new Map()
  let bot = ''
  let working = false

  const base = `http://127.0.0.1:${port}`

  async function targets() {
    const res = await fetch(`${base}/json`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) throw new Error(`debug port answered ${res.status}`)
    return res.json()
  }

  async function available() {
    try {
      return (await targets()).some((t) => t.type === 'page' && RENDERER.test(t.url))
    } catch {
      return false
    }
  }

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== ws.OPEN) {
        return reject(new Error('Grok Bot is not connected'))
      }
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, 10_000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(expression) {
    const r = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (r.exceptionDetails) {
      throw new Error(
        r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'page error',
      )
    }
    return r.result?.value
  }

  let primed = false
  let polling = null
  let inFlight = false

  /** Diff one snapshot against the last and emit what changed. */
  function absorb(snap) {
    if (snap.bot !== bot) {
      bot = snap.bot
      events.emit('bot', bot)
    }
    if (Boolean(snap.working) !== working) {
      working = Boolean(snap.working)
      events.emit('working', working, snap.status)
    }
    for (const row of snap.rows) {
      const before = known.get(row.key)
      if (before === row.text) continue
      const isNew = before === undefined
      known.set(row.key, row.text)
      // The first reading after connecting is history, not news.
      if (!primed) continue
      events.emit('message', { ...row, isNew, at: Date.parse(row.at) || 0 })
    }
    primed = true
  }

  async function poll() {
    if (inFlight || !ws || ws.readyState !== ws.OPEN) return
    inFlight = true
    try {
      absorb(await evaluate(SNAPSHOT))
    } catch (err) {
      log(`reading the window failed: ${err.message}`)
    } finally {
      inFlight = false
    }
  }

  async function connect() {
    if (ws && ws.readyState === ws.OPEN) return ws
    if (dialling) return dialling
    dialling = (async () => {
      const page = (await targets()).find((t) => t.type === 'page' && RENDERER.test(t.url))
      if (!page) throw new Error('the Grok Bot window is not there')
      const sock = new WebSocket(page.webSocketDebuggerUrl)
      await new Promise((resolve, reject) => {
        sock.once('open', resolve)
        sock.once('error', reject)
      })
      sock.on('message', (raw) => {
        let m
        try {
          m = JSON.parse(raw.toString())
        } catch {
          return
        }
        if (m.id && pending.has(m.id)) {
          const slot = pending.get(m.id)
          pending.delete(m.id)
          clearTimeout(slot.timer)
          if (m.error) slot.reject(new Error(`${m.error.message}`))
          else slot.resolve(m.result)
          return
        }
      })
      sock.on('close', () => {
        if (ws === sock) ws = null
        clearInterval(polling)
        polling = null
        known.clear()
        primed = false
        for (const [, slot] of pending) {
          clearTimeout(slot.timer)
          slot.reject(new Error('Grok Bot disconnected'))
        }
        pending.clear()
        log('grok bot window went away')
        events.emit('disconnected')
      })
      ws = sock
      await call('Runtime.enable')
      // A sampler left in the page by an earlier build of this driver would
      // keep ticking (throttled) for nothing; clear it.
      await evaluate(
        `(() => { if (window.__jarvisGrokSampler) { clearInterval(window.__jarvisGrokSampler); delete window.__jarvisGrokSampler; return 'cleared' } return 'clean' })()`,
      )
      await poll()
      polling = setInterval(poll, POLL_MS)
      log('connected to the Grok Bot window')
      return sock
    })()
    try {
      return await dialling
    } finally {
      dialling = null
    }
  }

  async function bots() {
    await connect()
    // Each bot in the sidebar is a button labelled with its name, with a
    // status appended while it has one: ", Unread activity", ", Working".
    return evaluate(`[...document.querySelectorAll('[aria-label="Pinned Bots"] button[aria-label], [aria-label="Bot list"] button[aria-label]')]
      .map((e) => (e.getAttribute('aria-label') || '').replace(/,\\s*(?:Unread activity|Working|Replied|Typing)$/i, '').trim())
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)`)
  }

  async function currentBot() {
    await connect()
    const heading = await evaluate(
      `(document.querySelector('[role="heading"]')?.textContent || '').trim()`,
    )
    bot = heading
    return heading
  }

  async function openBot(name) {
    await connect()
    const names = await bots()
    const hit = matchBot(name, names)
    if (!hit) throw new Error(`there is no bot called "${name}"`)
    if (normaliseName(await currentBot()) === normaliseName(hit)) return hit
    const clicked = await evaluate(`(() => {
      const items = [...document.querySelectorAll('[aria-label="Pinned Bots"] button[aria-label], [aria-label="Bot list"] button[aria-label]')]
      const want = ${JSON.stringify(hit)}
      const el = items.find((e) => (e.getAttribute('aria-label') || '').replace(/,\\s*(?:Unread activity|Working|Replied|Typing)$/i, '').trim() === want)
      if (!el) return false
      el.click()
      return true
    })()`)
    if (!clicked) throw new Error(`could not click "${hit}" in the sidebar`)
    const until = Date.now() + 5000
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150))
      if (normaliseName(await currentBot()) === normaliseName(hit)) return hit
    }
    throw new Error(`"${hit}" did not open`)
  }

  const key = (k, extra = {}) => ({
    key: k,
    code: k,
    windowsVirtualKeyCode: k === 'Enter' ? 13 : k === 'Backspace' ? 8 : 65,
    nativeVirtualKeyCode: k === 'Enter' ? 13 : k === 'Backspace' ? 8 : 65,
    ...extra,
  })
  const press = async (k, extra) => {
    await call('Input.dispatchKeyEvent', { type: 'keyDown', ...key(k, extra) })
    await call('Input.dispatchKeyEvent', { type: 'keyUp', ...key(k, extra) })
  }

  /** Types `text` into the composer and sends it. Returns the moment of sending. */
  async function send(text) {
    await connect()
    const focused = await evaluate(`(() => {
      const el = [...document.querySelectorAll('[role="textbox"][aria-label="Prompt"], [contenteditable="true"]')].find((e) => e.offsetParent !== null)
      if (!el) return false
      el.focus()
      return true
    })()`)
    if (!focused) throw new Error('the chat box is not on screen')
    // Clear anything already sitting in the box (a half-typed line of Hugo's)
    // rather than appending to it: select all, delete, then type.
    await press('a', { key: 'a', code: 'KeyA', modifiers: 4 })
    await press('Backspace')
    await call('Input.insertText', { text })
    await new Promise((r) => setTimeout(r, 120))
    const typed = await evaluate(
      `([...document.querySelectorAll('[role="textbox"][aria-label="Prompt"], [contenteditable="true"]')].find((e) => e.offsetParent !== null)?.innerText || '').trim()`,
    )
    if (!typed) throw new Error('the text did not land in the chat box')
    const at = Date.now()
    await press('Enter')
    return at
  }

  function close() {
    clearInterval(polling)
    polling = null
    try {
      ws?.close()
    } catch {
      /* already gone */
    }
    ws = null
  }

  return {
    available,
    connect,
    bots,
    currentBot,
    openBot,
    send,
    close,
    /** Last known state, without a round trip. */
    state: () => ({ bot, working, connected: Boolean(ws && ws.readyState === ws.OPEN) }),
    on: (name, fn) => {
      events.on(name, fn)
      return () => events.off(name, fn)
    },
  }
}
