#!/usr/bin/env node
// Grok Bot Voice preflight — a friendly, advisory check you run with `npm run setup`.
//
// It changes nothing and installs nothing. It looks at your machine, tells you
// what is ready and what is missing, and prints the command that starts
// everything. Every check degrades to a single friendly line if something is
// not there, and the script always exits 0 — it is advice, not a gate.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const tick = '  ok  '
const warn = ' note '
const info = '  ·   '
const line = (tag, msg) => console.log(`[${tag}] ${msg}`)

console.log('')
console.log('Grok Bot Voice preflight — checking your machine (nothing is changed)')
console.log('---------------------------------------------------------------------')

// --- Node version ----------------------------------------------------------
const major = Number(process.versions.node.split('.')[0])
if (major >= 20) line(tick, `Node.js ${process.versions.node} (20+ required).`)
else line(warn, `Node.js ${process.versions.node} is below 20. Please upgrade from https://nodejs.org.`)

// --- .env.local and keys ---------------------------------------------------
const env = {}
const envPath = join(process.cwd(), '.env.local')
if (existsSync(envPath)) {
  for (const l of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(l)
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  line(tick, '.env.local found.')
} else {
  line(warn, 'No .env.local yet. Run `cp .env.example .env.local` and paste your keys in.')
}
const has = (k) => Boolean((process.env[k] ?? env[k] ?? '').trim())

if (has('FISH_API_KEY')) line(tick, 'Voice: Fish Audio key found (free s2.1-pro-free model, Jarvis voice by default).')
else if (has('ELEVENLABS_API_KEY')) line(tick, 'Voice: ElevenLabs key found (Fish Audio key missing, so ElevenLabs speaks).')
else line(info, 'Voice: no Fish Audio or ElevenLabs key — JARVIS speaks with the browser voice. Fine, just less Jarvis. Get a free key at https://fish.audio.')

if (has('GROQ_API_KEY')) line(tick, 'Ears: Groq key found (free Whisper transcription).')
else if (has('ELEVENLABS_API_KEY')) line(tick, 'Ears: ElevenLabs key found (Groq key missing, so Scribe hears).')
else line(info, 'Ears: no Groq or ElevenLabs key — JARVIS hears with the browser recogniser. Works, but a free Groq key at https://console.groq.com is faster and sharper.')

// --- Grok Bot --------------------------------------------------------------
const brain = (process.env.JARVIS_BRAIN ?? env.JARVIS_BRAIN ?? 'grokbot').trim()
if (brain === 'claude') {
  line(info, 'JARVIS_BRAIN=claude: the original Claude brain. Needs the Claude CLI installed and logged in.')
  const res = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 })
  if (res.status === 0) line(tick, `Claude CLI found: ${res.stdout.trim()}`)
  else line(warn, 'Claude CLI not found on your PATH. Install: npm install -g @anthropic-ai/claude-code, then run `claude` once to log in.')
} else {
  if (process.platform === 'darwin') {
    if (existsSync('/Applications/Grok Bot.app')) line(tick, 'Grok Bot is installed.')
    else line(warn, 'Grok Bot not found in /Applications. Install it and sign in before running npm start.')
  } else {
    line(info, `Not macOS: open Grok Bot yourself with --remote-debugging-port=${process.env.GROKBOT_PORT ?? env.GROKBOT_PORT ?? 9333} before npm start.`)
  }
  const port = Number(process.env.GROKBOT_PORT ?? env.GROKBOT_PORT ?? 9333)
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })
    if (res.ok) line(tick, `Grok Bot is open with its control port (127.0.0.1:${port}).`)
  } catch {
    line(info, `Grok Bot's control port (${port}) is not answering yet. npm start opens Grok Bot the right way for you.`)
  }
  const bot = (process.env.GROKBOT_BOT ?? env.GROKBOT_BOT ?? '').trim()
  line(info, bot ? `JARVIS will talk to "${bot}".` : 'JARVIS will talk to whichever chat is open in Grok Bot (set GROKBOT_BOT to pin one).')
}

// --- Claude Code config, only relevant to Claude mode -----------------------
if (brain === 'claude' && !existsSync(join(homedir(), '.claude.json'))) {
  line(info, '~/.claude.json not found yet. It appears once you run `claude` and log in.')
}

// --- How to run ------------------------------------------------------------
console.log('')
console.log('To run:   npm start')
console.log('Then open http://localhost:5173 in Chrome, click INITIALISE, and say "Jarvis, …".')
console.log('Original Claude brain instead:   npm start -- --claude')
console.log('')
process.exit(0)
