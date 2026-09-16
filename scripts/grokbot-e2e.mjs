// Plays the part of the face: opens the bridge socket, asks one thing, prints
// every frame that comes back until the turn is done. Usage:
//   node scripts/grokbot-e2e.mjs "Reply with just the word received."
import WebSocket from 'ws'

const text = process.argv.slice(2).filter((a) => !a.startsWith('--')).join(' ') || 'Reply with just the word received.'
const ws = new WebSocket(`ws://localhost:${process.env.BRIDGE_PORT ?? 8787}`, { headers: { origin: 'http://localhost:5173' } })
const t0 = Date.now()
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`
let spoken = ''

ws.on('open', () => {
  console.log(stamp(), 'connected; asking:', JSON.stringify(text))
  ws.send(JSON.stringify({ type: 'ask', text, id: 't1' }))
})
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString())
  if (m.type === 'ready') return console.log(stamp(), 'ready', m.servers)
  if (m.type === 'text') {
    spoken += m.delta
    return console.log(stamp(), 'text ', JSON.stringify(m.delta))
  }
  if (m.type === 'announce') return console.log(stamp(), 'ANNOUNCE', JSON.stringify(m.text))
  if (m.type === 'done') {
    console.log(stamp(), 'done ', JSON.stringify(m.text))
    console.log('spoken so far:', JSON.stringify(spoken.trim()))
    if (!process.argv.includes('--stay')) process.exit(0)
    return
  }
  if (m.type === 'error') {
    console.log(stamp(), 'ERROR', m.message)
    process.exit(1)
  }
  console.log(stamp(), m.type, JSON.stringify(m).slice(0, 160))
})
ws.on('error', (e) => {
  console.log('socket error', e.message)
  process.exit(1)
})
setTimeout(() => {
  console.log(stamp(), 'timeout')
  process.exit(2)
}, Number(process.env.E2E_TIMEOUT_MS ?? 120_000))
