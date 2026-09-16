/**
 * One command to run JARVIS: the bridge (brain) and the Vite dev server (face)
 * together, so a student types `npm start` and nothing else.
 *
 * Two long-running processes normally mean two terminals. This launcher spawns
 * both as children, tags their output so you can tell them apart, and shuts
 * them down together on Ctrl-C — no extra dependency, just Node.
 *
 * Pass --writes to allow JARVIS to take real actions (drive the phone, the
 * browser, send things): `npm start -- --writes`.
 *
 * This fork talks to Grok Bot by default: it also opens Grok Bot with its
 * control port so the bridge can type into the chat. Pass --claude to run the
 * original Claude brain instead: `npm start -- --claude`.
 */

import { spawn, execFile } from 'node:child_process'
import process from 'node:process'
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { promisify } from 'node:util'

const exec = promisify(execFile)

/**
 * Open Grok Bot with its control port, so the bridge can type into it.
 *
 * Grok Bot has no API. The bridge drives its window over Chrome's DevTools
 * protocol, which only exists when the app is launched with
 * `--remote-debugging-port`. So: if the port already answers, Grok Bot is
 * already open the right way and nothing happens. If Grok Bot is open the
 * ordinary way (from the Dock), it is asked to quit politely and reopened with
 * the flag. If it is closed, it is opened. It is launched through `open`, not
 * as a child of this script, so quitting it does not take JARVIS down and
 * Ctrl-C here does not close it.
 *
 * The port binds to 127.0.0.1 only. While it is open, any program on this Mac
 * could drive Grok Bot; reopening the app from the Dock closes it again.
 */
async function portAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok
  } catch {
    return false
  }
}

async function grokBotRunning() {
  try {
    const { stdout } = await exec('pgrep', ['-x', 'Grok Bot'])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function openGrokBot(port) {
  const tag = '\x1b[33mgrok\x1b[0m'
  if (await portAnswers(port)) {
    console.log(`${tag} Grok Bot already open with its control port (127.0.0.1:${port}).`)
    return true
  }
  if (process.platform !== 'darwin') {
    // The quit-and-reopen dance below uses macOS tools. Elsewhere, say what to
    // do by hand: the flag is the same, only the launcher differs.
    console.log(`${tag} open Grok Bot yourself with the control port, then this will connect:`)
    console.log(`${tag}   Windows:  start "" "Grok Bot.exe" --remote-debugging-port=${port}`)
    console.log(`${tag}   Linux:    grok-bot --remote-debugging-port=${port}`)
    return false
  }
  if (await grokBotRunning()) {
    console.log(`${tag} Grok Bot is open without the control port; asking it to quit and reopening…`)
    try {
      await exec('osascript', ['-e', 'tell application "Grok Bot" to quit'])
    } catch {
      /* it may already be on its way out */
    }
    const until = Date.now() + 10_000
    while (Date.now() < until && (await grokBotRunning())) await sleep(250)
    if (await grokBotRunning()) {
      console.log(`${tag} Grok Bot did not quit. Quit it yourself and run npm start again.`)
      return false
    }
    await sleep(500)
  }
  try {
    await exec('open', ['-a', 'Grok Bot', '--args', `--remote-debugging-port=${port}`])
  } catch (err) {
    console.log(`${tag} could not open Grok Bot: ${err.message}`)
    return false
  }
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    if (await portAnswers(port)) {
      console.log(`${tag} Grok Bot open on 127.0.0.1:${port}.`)
      return true
    }
    await sleep(300)
  }
  console.log(`${tag} Grok Bot opened but its control port never answered. Is it signed in?`)
  return false
}

/**
 * Put MediaPipe's WebAssembly where the page can actually load it.
 *
 * Hand tracking needs a WASM runtime, and the usual recipe fetches it from a
 * CDN. That fails here twice over. The page's CSP names no CDN in `script-src`,
 * and the runtime arrives as a script — so it is blocked, and the failure
 * surfaces as gesture control simply never starting. And a CDN import is a live
 * supply-chain dependency: executable code, re-resolved on every load, that we
 * do not control and cannot pin against being changed under us.
 *
 * Copying it out of node_modules solves both. It is served from our own origin,
 * so `'self'` covers it; and it is the exact bytes of the version in the
 * lockfile. It stays out of git — 34 MB of build output does not belong in a
 * repository — and is re-copied whenever it is missing, which costs nothing
 * after the first run.
 */
function vendorWasm() {
  const from = 'node_modules/@mediapipe/tasks-vision/wasm'
  const to = 'public/mediapipe'
  if (!existsSync(from)) return // gesture control is optional; carry on without it
  if (existsSync(`${to}/vision_wasm_internal.wasm`)) return
  try {
    mkdirSync(to, { recursive: true })
    cpSync(from, to, { recursive: true })
    console.log('  vendored the hand-tracking runtime into public/mediapipe.')
  } catch (err) {
    console.warn(`  could not vendor the hand-tracking runtime: ${err.message}`)
  }
}

const writes = process.argv.includes('--writes')
// --claude: the original brain (Claude Agent SDK) instead of Grok Bot.
const claude = process.argv.includes('--claude')
const GROKBOT_PORT = Number(process.env.GROKBOT_PORT ?? 9333)

// A dim label per process, so the interleaved logs stay readable.
const paint = (tag, colour) => (line) =>
  line
    .toString()
    .split('\n')
    .filter((l) => l.length)
    .map((l) => `\x1b[${colour}m${tag}\x1b[0m ${l}`)
    .join('\n')

const children = []

function run(name, command, args, colour, env) {
  const label = paint(name, colour)
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    shell: false,
  })
  child.stdout.on('data', (d) => process.stdout.write(label(d) + '\n'))
  child.stderr.on('data', (d) => process.stderr.write(label(d) + '\n'))
  child.on('exit', (code) => {
    // If either half dies the other is useless, so take the whole thing down
    // rather than leave a half-running app that looks alive but cannot answer.
    console.log(`\x1b[${colour}m${name}\x1b[0m exited (${code}); stopping the rest.`)
    shutdown(code ?? 0)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code) {
  if (stopping) return
  stopping = true
  for (const c of children) {
    try {
      c.kill('SIGTERM')
    } catch {
      /* already gone */
    }
  }
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Tell the bridge which port the face will actually be on.
 *
 * The bridge only trusts WebSocket origins on localhost:5173-5199 and
 * 4173-4199, which is the right default — a socket that any local page can open
 * is a socket that drives every MCP server on the machine. But a launcher that
 * assigns a port outside that range produces the single most confusing failure
 * this project has: the interface loads, the reactor spins, the microphone
 * hears you, and the brain answers nothing, because the handshake is being 403'd
 * somewhere neither half reports. Passing the port through closes that gap
 * without widening what the bridge trusts by default.
 */
const port = process.env.PORT
const bridgeEnv = writes ? { JARVIS_ALLOW_WRITES: '1' } : {}
if (port) {
  bridgeEnv.JARVIS_ALLOWED_ORIGINS = `http://localhost:${port},http://127.0.0.1:${port}`
  console.log(`  serving the face on port ${port}; the bridge will accept it.\n`)
}

vendorWasm()

if (claude) {
  bridgeEnv.JARVIS_BRAIN = 'claude'
  console.log('\nJ.A.R.V.I.S. starting — Claude brain, the face.\n')
} else {
  bridgeEnv.JARVIS_BRAIN = 'grokbot'
  bridgeEnv.GROKBOT_PORT = String(GROKBOT_PORT)
  console.log('\nJ.A.R.V.I.S. starting — Grok Bot as the brain, JARVIS as the voice.\n')
  await openGrokBot(GROKBOT_PORT)
}

run('bridge', 'node', ['bridge/server.mjs'], '36', bridgeEnv)
// npm is a shell script on most systems; call the vite binary directly so we do
// not need shell:true (which would break the argument handling above).
run('face', process.execPath, ['node_modules/vite/bin/vite.js'], '35', {})

console.log(
  '\nWhen it says the dev server is ready, open the URL it prints in Chrome,\n' +
    'click INITIALISE, and say "Hey Jarvis". Ctrl-C stops everything.\n',
)
