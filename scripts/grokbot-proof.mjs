// Five-minute proof: can JARVIS put a message into the Grok Bot chat window?
// Usage: node grokbot-proof.mjs [--send] ["message text"]
//   without --send: types the text into the composer, screenshots, stops.
//   with    --send: also presses Enter and waits up to 90 s for a reply.
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const PORT = 9333
const args = process.argv.slice(2)
const SEND = args.includes('--send')
const TEXT = args.filter((a) => a !== '--send')[0] ?? 'Test from JARVIS. Just reply with the word "received".'
const OUT = new URL('./grokbot-proof.png', import.meta.url).pathname

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
console.log('targets:')
for (const t of targets) console.log(`  ${t.type} | ${t.title.slice(0, 50)} | ${t.url.slice(0, 80)}`)
const page = targets.find((t) => t.type === 'page' && !/devtools|vnc|webview/i.test(t.url))
if (!page) throw new Error('no page target found')
console.log('using:', page.title, page.url)

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
let id = 0
const pending = new Map()
ws.on('message', (raw) => {
  const m = JSON.parse(raw)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const call = (method, params = {}) => new Promise((res, rej) => {
  const n = ++id
  pending.set(n, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)))
  ws.send(JSON.stringify({ id: n, method, params }))
})
const evaluate = async (expression) => {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''))
  return r.result.value
}

await call('Runtime.enable')
await call('Page.enable')

// 1. What does the page look like? Find the composer and the current bot.
const probe = await evaluate(`(() => {
  const eds = [...document.querySelectorAll('[contenteditable="true"]')]
  return {
    title: document.title,
    editors: eds.map(e => ({ cls: e.className.slice(0,80), ph: e.getAttribute('data-placeholder') || e.getAttribute('aria-placeholder') || e.getAttribute('aria-label') || '', visible: e.offsetParent !== null, rect: e.getBoundingClientRect().toJSON() })),
    heading: [...document.querySelectorAll('h1,h2,[role="heading"]')].map(h => h.textContent.trim()).filter(Boolean).slice(0,6),
  }
})()`)
console.log('probe:', JSON.stringify(probe, null, 2))

const editor = probe.editors.find((e) => e.visible)
if (!editor) {
  await call('Page.captureScreenshot', { format: 'png' }).then((r) => writeFileSync(OUT, Buffer.from(r.data, 'base64')))
  throw new Error(`no visible composer. Screenshot at ${OUT}`)
}

// 2. Focus it and type the text the way a keyboard would (ProseMirror needs real input events).
await evaluate(`(() => { const e=[...document.querySelectorAll('[contenteditable="true"]')].find(e=>e.offsetParent!==null); e.focus(); return true })()`)
// clear whatever is already in the box (select all, delete), then type
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 4, windowsVirtualKeyCode: 65 })
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 })
await call('Input.insertText', { text: TEXT })
await new Promise((r) => setTimeout(r, 400))
const typed = await evaluate(`[...document.querySelectorAll('[contenteditable="true"]')].find(e=>e.offsetParent!==null).innerText`)
console.log('composer now reads:', JSON.stringify(typed))

if (!SEND) {
  const shot = await call('Page.captureScreenshot', { format: 'png' })
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
  console.log('typed only (no --send). Screenshot:', OUT)
  ws.close(); process.exit(0)
}

// 3. Send it and watch for a new message from the bot.
const before = await evaluate(`document.body.innerText.length`)
await call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
console.log('sent. waiting for reply…')
const t0 = Date.now()
let last = ''
while (Date.now() - t0 < 90_000) {
  await new Promise((r) => setTimeout(r, 1500))
  const txt = await evaluate(`document.body.innerText`)
  if (txt.length !== before && txt !== last) {
    last = txt
    const tail = txt.slice(-600)
    if (/received/i.test(tail.replace(TEXT, ''))) { console.log('REPLY SEEN after', ((Date.now()-t0)/1000).toFixed(1), 's:\n', tail); break }
  }
}
const shot = await call('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log('Screenshot:', OUT)
ws.close(); process.exit(0)
