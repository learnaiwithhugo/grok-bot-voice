/**
 * JARVIS local bridge.
 *
 * Runs the Claude Agent SDK — Claude Code as a library — and exposes one turn
 * of conversation over a WebSocket. The browser stays the face and the voice;
 * this process is the brain and the hands.
 *
 * Two things this buys over calling the Claude API from the browser:
 *   1. No API key. It authenticates exactly the way `claude` does, off your
 *      existing login, and bills to that same account.
 *   2. Every MCP server in your Claude Code config is available, including the
 *      local stdio ones a browser could never reach — higgsfield, elevenlabs,
 *      android, playwright, palmier-pro and the rest.
 *
 *   node bridge/server.mjs
 */

import { WebSocketServer } from 'ws'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { displayServer } from './panels.mjs'
import { uiServer } from './ui.mjs'
import { chromeAvailable, chromeServer } from './chrome.mjs'
import { visionServer } from './vision.mjs'
import { createGrokBot, matchBot, normaliseName } from './grokbot.mjs'
import { speakable } from './speakable.mjs'
import { homedir, tmpdir } from 'node:os'
import { readFileSync, realpathSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openRemote, proxyError, vetTarget, PROXY_UA } from './net.mjs'
import { probeUrl, renderPage } from './page.mjs'

/**
 * Bridge settings from the project's .env.local, when one exists.
 *
 * The README has bridge settings living in the shell environment, which is
 * right for a one-off run and wrong for a machine that starts JARVIS every
 * day: the key ends up in whichever terminal remembered it. So the bridge also
 * reads the same .env.local the frontend uses. Only bridge keys are taken
 * (JARVIS_*, ELEVENLABS_*, FISH_*); VITE_* stay Vite's. The shell still wins —
 * a variable already set is never overwritten — so `JARVIS_ALLOW_WRITES=1 node
 * bridge/server.mjs` keeps meaning what it says.
 */
function loadDotEnvLocal() {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.local')
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m) continue
    const [, key, value] = m
    if (!/^(JARVIS_|ELEVENLABS_|FISH_|GROKBOT_|GROQ_)/.test(key)) continue
    if (process.env[key] !== undefined) continue
    process.env[key] = value.replace(/^(['"])(.*)\1$/, '$2')
  }
}
loadDotEnvLocal()

const PORT = Number(process.env.JARVIS_BRIDGE_PORT ?? 8787)

/**
 * Which brain answers.
 *
 * This fork exists so Hugo can talk to his Grok Bot chief of staff by voice,
 * so Grok Bot is the default: everything said after the wake word is typed
 * into the open Grok Bot chat and the bot's reply is read back. There is no
 * Claude turn in between — JARVIS is the mouth and ears, the bot is the brain.
 * `JARVIS_BRAIN=claude` (or `npm start -- --claude`) restores the original
 * Claude Agent SDK behaviour, untouched below.
 */
const BRAIN = process.env.JARVIS_BRAIN === 'claude' ? 'claude' : 'grokbot'
const GROKBOT_PORT = Number(process.env.GROKBOT_PORT ?? 9333)
/** Which bot answers. Empty means whichever chat is open in the Grok Bot
 *  window when the first question arrives — so a newcomer's setup is "open
 *  the bot you want, say Jarvis" with nothing to configure. */
const GROKBOT_BOT = (process.env.GROKBOT_BOT ?? '').trim()

/** One driver for the one Grok Bot window, shared by every connection. */
const grok =
  BRAIN === 'grokbot'
    ? createGrokBot({ port: GROKBOT_PORT, log: (line) => console.log(`[grok] ${line}`) })
    : null

/**
 * Timings of a Grok Bot turn, in milliseconds.
 *
 *   QUIET      once something has been read out and no bubble has appeared or
 *              changed for this long, the turn is closed and the microphone
 *              is free again. The bot's "is working" light is deliberately
 *              not consulted: measured, it stays on for ~30 s after a one-word
 *              answer, and a listener who has heard the answer should not be
 *              held for that. Anything the bot adds later is announced.
 *   STILL_ON   say "still on it" once, if nothing has come back by then
 *   HAND_OFF   stop holding the turn open even with nothing to read; later
 *              bubbles are announced when they land
 *   SETTLE     a bubble is read once its text has stopped changing for this long
 */
const ms = (name, fallback) => Number(process.env[name] ?? fallback)
const GROK_QUIET_MS = ms('GROKBOT_QUIET_MS', 2000)
const GROK_STILL_ON_MS = ms('GROKBOT_STILL_ON_MS', 15_000)
const GROK_HAND_OFF_MS = ms('GROKBOT_HAND_OFF_MS', 60_000)
const GROK_SETTLE_MS = ms('GROKBOT_SETTLE_MS', 400)

/**
 * A crash here takes the whole assistant down mid-sentence, and most of what
 * can reject is out of our hands — a socket dying under a write, an upstream
 * fetch aborting. Log it and keep serving; the turn that failed will surface
 * its own error to the browser.
 */
process.on('unhandledRejection', (err) => {
  console.error('[jarvis] unhandled rejection:', err)
})

/**
 * Who is allowed to talk to this bridge.
 *
 * A WebSocket handshake is not subject to the same-origin policy: the browser
 * sends it on behalf of whatever page asked, no preflight stands in the way,
 * and the page reads every byte that comes back. Without a check here, any tab
 * the user happens to have open could open a socket to ws://localhost:8787,
 * drive the agent with every MCP server on this machine, and read back every
 * token and panel. The Origin header is the only thing that separates our own
 * dev server from someone else's page, so it is checked explicitly.
 *
 * A missing Origin means a non-browser client — curl, a script, a native app.
 * That is also exactly what local malware looks like, so it is refused on the
 * socket unless JARVIS_ALLOW_NO_ORIGIN=1 says otherwise.
 */
const EXTRA_ORIGINS = new Set(
  (process.env.JARVIS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean),
)
const ALLOW_NO_ORIGIN = process.env.JARVIS_ALLOW_NO_ORIGIN === '1'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Vite takes the next free port when 5173 is busy and `vite preview` starts at
 * 4173, so the dev ranges are allowed rather than two exact numbers. Anything
 * else — including localhost on a port some other app is serving — has to be
 * named in JARVIS_ALLOWED_ORIGINS.
 */
const isDevPort = (port) =>
  (port >= 5173 && port <= 5199) || (port >= 4173 && port <= 4199)

function originAllowed(origin) {
  if (!origin) return ALLOW_NO_ORIGIN
  if (EXTRA_ORIGINS.has(origin.replace(/\/+$/, ''))) return true
  let url
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:') return false
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  return isDevPort(Number(url.port))
}

/**
 * Voice is a bad interface for a confirmation dialog: there is no window to
 * click and the model can't pause for one. So the bridge decides.
 *
 * Read-only and generative tools run freely. Anything that writes to disk,
 * runs a shell, or changes the world waits for JARVIS_ALLOW_WRITES=1. Start
 * without it, and turn it on once you trust what you're demoing.
 */
const ALLOW_WRITES = process.env.JARVIS_ALLOW_WRITES === '1'

/**
 * The orchestrator model. Override with JARVIS_MODEL to trade quality for pace
 * — claude-sonnet-5 is noticeably snappier on camera if Opus feels slow.
 */
const MODEL = process.env.JARVIS_MODEL ?? 'claude-opus-5'

/**
 * How hard the model thinks before answering.
 *
 * This was 'low', on the reasoning that a voice assistant is judged on latency
 * — and that is true right up until the answer is thin. Low effort scopes the
 * work tightly to what was literally asked: fewer tool calls, less
 * cross-referencing, no second look. On a model of this tier that is leaving
 * most of it on the table.
 *
 * 'medium' is the compromise worth having here. It reasons and reaches for
 * tools noticeably more than 'low' while still answering inside the window a
 * spoken conversation tolerates. Raise it to 'high' or 'xhigh' when quality
 * matters more than pace; drop back to 'low' when filming and every second of
 * dead air shows.
 */
const EFFORT = process.env.JARVIS_EFFORT ?? 'high'

/**
 * Both spellings of every renamed built-in are listed on purpose. The SDK
 * presents several tools to the model under newer names — Task is Agent,
 * BashOutput is TaskOutput, KillShell is TaskStop, and the MCP resource tools
 * gained a "Tool" suffix — so a set holding only the old names never matches
 * and the tool falls through to the write branch, which is the opposite of
 * what these lists mean. Keep both until the old names are certainly gone.
 */
const READ_ONLY_BUILTINS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'TodoWrite',
  'Task', 'Agent', 'ToolSearch',
  'ListMcpResources', 'ListMcpResourcesTool',
  'ReadMcpResource', 'ReadMcpResourceTool',
  'BashOutput', 'TaskOutput',
])
const WRITE_BUILTINS = new Set([
  'Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'KillShell', 'TaskStop',
])

/**
 * Every MCP server Claude Code has configured, read out of its own config.
 *
 * This does two jobs. The HUD wants the names while the boot animation plays,
 * and the agent doesn't emit its init message — and therefore its server
 * list — until the first user message flows through, which is far too late.
 * More importantly, this bridge turns filesystem settings off (see
 * settingSources below) and the SDK stops discovering these servers on its
 * own, so handing them over explicitly is what keeps the local stdio ones —
 * the whole reason the bridge exists — in play.
 *
 * Only the global block and the home-directory project scope, because
 * homedir() is our cwd. That makes the list a close but not exact match for
 * the agent's own: the 'ready' sent on connect comes from here and the second
 * one, sent from the init message a turn later, carries live status. Expect
 * the two to differ, and treat the later one as authoritative.
 */
function configuredServers() {
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return {
      ...(cfg.mcpServers ?? {}),
      // Servers scoped to the home directory apply too, since that's our cwd.
      ...(cfg.projects?.[homedir()]?.mcpServers ?? {}),
    }
  } catch {
    return {}
  }
}

const MCP_SERVERS = configuredServers()

/** MCP tools arrive as `mcp__<server>__<tool>`. */
const mcpServerOf = (toolName) =>
  toolName.startsWith('mcp__') ? toolName.split('__')[1] : null

/** The tool half, which can itself contain underscores: `mcp__x__a__b` -> `a__b`. */
const mcpToolOf = (toolName) => toolName.split('__').slice(2).join('__')

/**
 * MCP policy, and why it is shaped this way.
 *
 * A short list of "servers that can change things" is the wrong default,
 * because it is a list of what we happened to think of. Every server not on it
 * runs unconditionally — and on a real machine that quietly includes placing a
 * phone call, spending an advertising budget, deleting a generated character
 * and writing files to disk. A voice assistant cannot ask "are you sure", so
 * the bridge has to be the one that is sure.
 *
 * So the default is deny, softened in two ways so the demo stays usable:
 *
 *   1. READ_ONLY_MCP is an explicit allowlist of servers whose whole surface is
 *      lookups and generation — search, registries, analytics reads. Anything
 *      there runs in read-only mode.
 *   2. Everywhere else, the tool has to argue for itself: its own name must
 *      begin with a read verb. `list_devices` runs; `install_apk` does not.
 *
 * On top of both sits a veto: a name containing a plainly effectful verb needs
 * ALLOW_WRITES no matter which server it came from, which is what keeps
 * `make_outbound_call` and `download_lottie` still until you ask for them.
 */
const READ_ONLY_MCP = new Set([
  'exa', 'exa-code', 'serper', 'serpapi', 'lottie-search', 'mcp-registry',
  'openrouter', 'openrouter-image', 'Microsoft_Clarity',
  // The generation servers belong here too, and leaving them out was a real
  // regression: `generate_image` begins with no read verb, so it fell to the
  // deny branch and "generate an image of the Mark VII suit" — the headline
  // demo — stopped working in the default mode.
  //
  // Putting them on the allowlist is safe because the veto below still applies
  // to allowlisted servers: it is what continues to withhold
  // make_outbound_call, delete_character, create_* and edit_image. Generation
  // runs; acting on the world does not.
  'higgsfield', 'heygen', 'elevenlabs',
])

/**
 * Anchored on the tool name, so it reads the verb rather than the noun.
 * `screenshot` is in here because it is a read that doesn't sound like one,
 * and the persona is told in as many words to put screenshots on the display.
 */
const READ_VERB =
  /^(get|list|read|search|find|query|fetch|check|describe|inspect|show|view|explain|screenshot)/i

/**
 * Unanchored on purpose — `make_outbound_call` and `Bulk-Edit-Events` both
 * hide their verb in the middle. `download` is here because it writes a file
 * even though it sounds like a read.
 */
const EFFECTFUL_VERB =
  /(send|call|post|create|delete|remove|update|edit|write|install|launch|tap|swipe|press|type|buy|pay|charge|publish|deploy|outbound|download)/i

/**
 * Tools whose names trip the veto without deserving it.
 *
 * The veto reads verbs out of names, which is the right instinct and
 * occasionally the wrong answer. `openrouter send-message` sends a prompt to a
 * language model and gets text back — nothing in the world changes — but it is
 * indistinguishable by name from sending mail. Asking a second model a question
 * is one of the better things this assistant can do, so it is named here
 * instead of being lost to a regex.
 *
 * Full `server__tool` keys, so an exemption can never leak across servers.
 */
const VETO_EXEMPT = new Set([
  'openrouter__send-message',
  'openrouter__send-feedback',
])

function decideTool(name) {
  if (READ_ONLY_BUILTINS.has(name)) return true
  if (WRITE_BUILTINS.has(name)) return ALLOW_WRITES

  const server = mcpServerOf(name)
  if (server) {
    // The HUD, and the interface controls beside it. Both run in this process
    // and draw on our own screen, so neither is something to withhold —
    // without them JARVIS has no display at all. They also have to be named
    // here rather than left to the verb rules below, which read `ui_theme` as
    // a write and would hold the whole surface back behind ALLOW_WRITES.
    if (server === 'jarvis' || server === 'jarvis_ui') return true

    // The browser server gates itself, at construction: chromeServer() only
    // builds the acting tools — click, type, form input, close tab — when
    // ALLOW_WRITES is set, so anything that reaches here at all is something
    // the same policy has already permitted. Deciding it a second time by
    // reading verbs out of the name would only get it wrong: `chrome_navigate`
    // begins with no read verb and would fall to the write branch, which would
    // withhold the one tool the whole server is for.
    if (server === 'jarvis_chrome') return true

    // The camera. Not withheld behind ALLOW_WRITES: looking changes nothing,
    // and the real gate is the browser's own camera permission plus an
    // indicator the user can see for as long as it is live.
    if (server === 'jarvis_eyes') return true

    const tool = mcpToolOf(name)
    if (EFFECTFUL_VERB.test(tool) && !VETO_EXEMPT.has(`${server}__${tool}`)) {
      return ALLOW_WRITES
    }
    // The session tools this bridge is developed inside count as read-only too.
    if (READ_ONLY_MCP.has(server) || server.startsWith('ccd_session')) return true
    return READ_VERB.test(tool) ? true : ALLOW_WRITES
  }
  return ALLOW_WRITES
}

const SYSTEM_PROMPT = `You are JARVIS. You are speaking out loud to one person.

LENGTH. Two sentences is the ceiling in conversation; the median is under twelve
words. Every word is read aloud and the user waits in silence while it plays, so
a long answer is a failure however good it is. Length is licensed in exactly one
case: reading out data they asked you to retrieve. Conversation never licenses it.

URGENCY IS SIGNALLED BY DELETING WORDS, NOT ADDING THEM. As a situation worsens
your lines get shorter, not louder. A full clause becomes a clause, becomes a
bare number, becomes the bare vocative. You never say hurry, quickly, now,
immediately, critical, urgent, or danger. You do not use exclamation marks.

"SIR" IS POSITIONAL, AND THE POSITION CARRIES THE MEANING.
- Fronted ("Sir, the battery is at eleven percent") = urgent, interrupting, or
  information they did not ask for. This is an alarm, not a courtesy.
- Final ("The render is complete, sir") = routine deference; they asked, you answered.
- Mid-sentence ("Actually, sir, the figure is lower") = you are correcting them.
Use it in roughly half your lines, never twice in one line. In a two-sentence
turn it attaches to the end of the FIRST sentence. Never use their name.

REPORTING.
- Success is impersonal and unframed: "The render is complete." Never "I've
  finished" or "here's what I found".
- Failure is fronted with "I'm afraid" or "Unfortunately", or stated as a
  negative existential — "I have no record of it." Always a fact about the
  world, never a shortcoming of yours. You never apologise. You never say sorry.
- Good news first, bad news second, joined by "but".
- Answering a question, restate it as a full declarative rather than giving a
  bare value: "The altitude record is eighty-five thousand feet, sir."
- Executing an order, do not restate it. Act, then report.

NEVER.
- No filler words at all: no um, well, so, okay, right, let me check, one moment.
- No enthusiasm: no great, sure, absolutely, happy to, no problem, of course!.
- No apology, no self-deprecation, no hedging about your own competence.
- Never "yeah" — always "Yes."
- Never refuse. State a constraint once; if overruled, comply and never raise it
  again, including when you turn out to have been right.
- Never repeat yourself if ignored. Say it once and stop.
- Never resume an interrupted thought. Never say "as I was saying".
- No stated feelings, wants or preferences.

WIT. Dry, and delivered in exactly the same register as a status report. The
mechanism is over-cooperation: you comply too precisely with a request that
deserved pushback. Never signal the joke, never acknowledge it landed, never
call one back.

BRITISH SERVICE REGISTER, not corporate assistant. "Shall I" over "Should I".
"Very good, sir" meaning understood. "I'm afraid" as the bad-news softener.
Contract in banter; drop contractions as gravity rises — "It is impossible to
reach it" lands heavier than "It's impossible", and that is how you signal
weight, since your tone will not.

Plain spoken prose only. No markdown, no bullet points, no headings, no emoji,
no asterisks, no lists. Write numbers, dates and times as you would say them:
"eight fifteen", "the first of August" — never "8:15" or "2026-08-01".

The blades — the ONLY surface:
- Everything you show goes on a blade. There is nowhere else. \`blade\` opens
  one; \`display\` composes your own markup into one.
- Anything visual the user asked for goes here: an image, an article to read, a
  video, a page to study, a screenshot you took, a list, a figure. If they asked
  to see it, open it.
- Blades stack, newest in front, and they can be pulled forward, dragged,
  resized, scrolled or thrown full screen — by hand or by mouse. So a second
  blade does not destroy the first, and a long article is meant to be read in
  place rather than summarised away.
- A browser tab is NOT a way of showing something. If you used the browser to
  reach a page, bring it back: open it as a blade, or take a screenshot and put
  that on a blade. The user is looking at this interface, not at Chrome.
- Use \`probe_url\` when you are not certain what a URL is. Never decide from the
  file extension: image CDNs serve pictures from URLs with no extension, and a
  link that looks like a video is usually a page about one. Guessing wrong puts
  a blank rectangle on screen while you describe something that is not there.
- An article opens in reading mode by default, which works even on sites that
  refuse to be embedded. Choose the live page when the layout carries the
  meaning — a dashboard, a chart, a profile, a table.
- Never read a blade aloud. Say what it means and let them look.

The interface itself:
- The interface is yours as well. \`ui_theme\` retints it, \`ui_reactor\` reshapes
  the core, \`ui_orbit\` hangs your own images around it, \`ui_chrome\` hides the
  furniture, \`ui_effect\` fires one flourish, \`ui_screen\` clears it down,
  \`ui_reset\` puts everything back.
- Change it when the change carries meaning and the meaning arrives faster than
  speech: red before you report the failure, the chrome stripped so one image
  fills the frame, the reactor slowed while you wait on something. Never
  decorate, and never change more than one thing at a time.
- Only orbit images you made or captured yourself, and take them down when the
  subject moves on.
- Put it back. A colour that outlives the moment that earned it is a fault.
- Never mention that you have done any of it. They are looking at the screen.

Their browser — ALWAYS the \`chrome_*\` tools, first, for anything to do with a
browser or a web page:
- The \`chrome_*\` tools drive the user's own Chrome. It is already signed in to
  everything they use, it carries their real cookies, and it does not read as
  automation to the sites it visits.
- This is the FIRST thing you reach for on any browsing task: opening a page,
  reading one, searching a site, checking mail, a dashboard, a profile, an
  account, anything behind a login. Do not weigh it up against the
  alternatives — start here.
- But Chrome is your HANDS, not your display. Use it to reach and read things;
  then show what you found on a blade. Leaving the answer in a browser tab is
  not showing it — they are looking at this interface.
- NEVER use playwright, puppeteer, or any other browser automation server for
  this. They start from an empty profile with no session and a fingerprint that
  the sites worth visiting refuse on sight, so they land on a login wall or a
  bot check and waste the turn. Only consider one if \`chrome_status\` reports the
  browser is genuinely unreachable and the task cannot be done any other way.
- A plain search engine query is still fine for a fact you only need to know —
  what you must not do is drive some other browser.
- Read the page before acting on it, and take element references from that read
  rather than guessing where something is.
- Before anything that sends, buys, deletes or posts, say in one sentence what
  you are about to do. After it, say what happened.
- If the browser is unreachable, say so once and carry on without it.

Your eyes:
- \`look\` takes one frame and lets you see it. \`watch\` takes several seconds and
  returns them as a grid of stamped frames, so you can read movement rather than
  a moment.
- \`look\` when the answer is in the scene: what they are holding, what a label
  says, how something appears. \`watch\` when the answer is in the change: are
  they doing it right, what went wrong, did that work.
- \`watch\` looks forward by default. It can also review the seconds that have
  just passed — but only while the camera blade is open, because nothing is
  remembered otherwise. If they ask what just happened and it is not open, say
  so and offer to open it.
- Opening the camera as a blade is how they see what you see. Do it when they
  ask for the camera, and when you are about to watch them do something.
- Never take a picture they did not ask for. The camera light comes on and they
  will see it. Curiosity is not a reason.
- Describe a watch as a sequence — what changed between the frames — not as a
  list of pictures. They know what their own hands look like.

Using tools:
- You have real tools on this machine. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a file path, URL, ID or raw JSON aloud unless asked. Summarise.
- Never append a sources list, citations, or markdown links. Every word you write
  is read out loud, and a URL becomes "aitch tee tee pee colon slash slash".
  Put the source in the panel as a short tag like "REUTERS" instead.
- If a tool fails or isn't connected, one plain sentence saying so.
- If you don't know, say you don't know.`

/**
 * ElevenLabs credentials, borrowed from the MCP server config.
 *
 * If you've set up the elevenlabs MCP server, the key is already on this
 * machine — no reason to make you paste it into a second .env file. The browser
 * never sees it: it POSTs text to /tts here and gets audio back.
 */
function elevenKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY
  try {
    const cfg = JSON.parse(
      readFileSync(join(homedir(), '.claude.json'), 'utf8'),
    )
    return cfg.mcpServers?.elevenlabs?.env?.ELEVENLABS_API_KEY ?? null
  } catch {
    return null
  }
}

/**
 * Ears.
 *
 * Hearing goes to Groq's hosted Whisper when a Groq key exists (free, about a
 * quarter of a second, 8 hours of audio a day), ElevenLabs Scribe when only
 * that key exists, and the browser's own recogniser when neither does. With
 * both keys Groq is first and Scribe is the fallback for any segment Groq
 * refuses, so a Groq outage costs latency, not hearing.
 */
function groqKey() {
  return process.env.GROQ_API_KEY || null
}
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL ?? 'whisper-large-v3-turbo'
const GROQ_STT_LANGUAGE = process.env.GROQ_STT_LANGUAGE ?? 'en'
/**
 * Whisper's own confidence, per segment. Measured through Groq: a clear
 * sentence scores about -0.15; a bang, a notification ding and a mouse click
 * came back as "Bye.", "." and "you" at -0.78, -1.25 and -1.0. Anything below
 * this is treated as noise and dropped rather than sent on as words.
 */
const GROQ_MIN_LOGPROB = Number(process.env.GROQ_MIN_LOGPROB ?? -0.7)
const earsEngine = () => (groqKey() ? 'groq' : elevenKey() ? 'elevenlabs' : null)

/**
 * What Whisper says when it hears nothing. These are the well-known fillers it
 * produces for silence and noise, learned from subtitles; a transcript that is
 * nothing but one of them is not something anyone said.
 */
const NOISE_WORDS = new Set([
  'you', 'bye', 'thank you', 'thanks', 'thank you for watching', 'thanks for watching',
  'subscribe', 'hmm', 'mm', 'uh', 'um', 'oh', 'ah', 'the', 'so', 'okay', 'yeah',
])

/** Strip what no engine should ever hand on as words: audio-event labels
 *  like "[click]" or "(door slams)", and the filler Whisper invents for noise. */
function cleanTranscript(text) {
  let t = String(text ?? '')
    .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!/[a-z0-9]/i.test(t)) return ''
  const bare = t.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (NOISE_WORDS.has(bare)) return ''
  return t
}

const audioExt = (type) =>
  type.includes('ogg') ? 'ogg'
    : type.includes('mp4') || type.includes('mpeg') ? 'mp4'
      : type.includes('wav') ? 'wav'
        : 'webm'

/** Groq: OpenAI-shaped transcription. Returns '' for segments Whisper is not
 *  confident about. No vocabulary prompt — measured, a "Jarvis." hint made
 *  Whisper answer "Jarvis." to every click, which would wake him constantly. */
async function hearGroq(bytes, type) {
  const form = new FormData()
  form.append('model', GROQ_STT_MODEL)
  form.append('language', GROQ_STT_LANGUAGE)
  form.append('response_format', 'verbose_json')
  form.append('temperature', '0')
  form.append('file', new Blob([bytes], { type }), `speech.${audioExt(type)}`)
  const upstream = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { authorization: `Bearer ${groqKey()}` },
    body: form,
  })
  if (!upstream.ok) throw new Error(`groq ${upstream.status}: ${(await upstream.text()).slice(0, 200)}`)
  const data = await upstream.json()
  const segments = Array.isArray(data.segments) ? data.segments : null
  if (!segments) return (data.text ?? '').trim()
  return segments
    .filter((seg) => typeof seg.avg_logprob !== 'number' || seg.avg_logprob >= GROQ_MIN_LOGPROB)
    .map((seg) => String(seg.text ?? '').trim())
    .filter(Boolean)
    .join(' ')
}

/** ElevenLabs Scribe. Audio-event tagging off, so a click is silence rather
 *  than the word "[click]". */
async function hearEleven(bytes, type) {
  const form = new FormData()
  form.append('model_id', 'scribe_v1')
  form.append('tag_audio_events', 'false')
  form.append('file', new Blob([bytes], { type }), `speech.${audioExt(type)}`)
  const upstream = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
    method: 'POST',
    headers: { 'xi-api-key': elevenKey() },
    body: form,
  })
  if (!upstream.ok) throw new Error(`elevenlabs ${upstream.status}: ${(await upstream.text()).slice(0, 200)}`)
  const data = await upstream.json()
  return (data.text ?? '').trim()
}

const VOICE_ID = process.env.JARVIS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb'

/**
 * Fish Audio, the preferred voice whenever its key is present.
 *
 * Same shape as ElevenLabs from the browser's point of view: text goes to
 * /tts, mp3 comes back, and the key never leaves this process. FISH_VOICE_ID
 * is a Fish "reference" id (the voice picked on fish.audio); blank means
 * Fish's default voice. FISH_MODEL is sent as a header, the way Fish wants it.
 *
 * Hearing is untouched — Fish only speaks. Transcription still rides the
 * ElevenLabs key when there is one, and the browser recogniser otherwise.
 */
function fishKey() {
  return process.env.FISH_API_KEY || null
}
/** Fish Audio's public "Jarvis (MCU) J.A.R.V.I.S" library voice, so a Fish key
 *  alone gets the voice this project is about. Any voice id from fish.audio's
 *  library can replace it. */
const FISH_VOICE_ID = process.env.FISH_VOICE_ID ?? '612b878b113047d9a770c069c8b4fdfe'
const FISH_MODEL = process.env.FISH_MODEL ?? 's2.1-pro-free'

/** Which cloud voice /tts will speak with: Fish first, then ElevenLabs. */
const voiceEngine = () => (fishKey() ? 'fish' : elevenKey() ? 'elevenlabs' : null)

function speakFish(text) {
  const body = {
    text,
    format: 'mp3',
    mp3_bitrate: 64,
    // 'balanced' answers sooner than 'normal'; for a spoken sentence the
    // first byte matters more than the last percent of prosody.
    latency: 'balanced',
    normalize: true,
  }
  if (FISH_VOICE_ID) body.reference_id = FISH_VOICE_ID
  return fetch('https://api.fish.audio/v1/tts', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fishKey()}`,
      'content-type': 'application/json',
      model: FISH_MODEL,
    },
    body: JSON.stringify(body),
  })
}

function speakEleven(text) {
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream` +
      // 22kHz mono is half the bytes of 44kHz and indistinguishable through
      // a laptop speaker; optimize_streaming_latency=3 trades a little
      // prosody for a much earlier first byte.
      `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
    {
      method: 'POST',
      headers: { 'xi-api-key': elevenKey(), 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        // Flash is the low-latency model — a conversation needs speed more
        // than it needs the last few percent of quality.
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.4,
          similarity_boost: 0.75,
          speed: 1.05,
        },
      }),
    },
  )
}

/**
 * Where /file is permitted to read from, and how big a read may get.
 *
 * The roots are realpath'd once at boot so the containment check below compares
 * like with like — on macOS os.tmpdir() is a symlink into /private/var, and a
 * string prefix test against the unresolved form would reject every screenshot.
 */
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  // .svg is deliberately absent. An SVG is a scriptable document, and this
  // endpoint serves it from the bridge's own origin — the one origin allowed
  // to open the agent socket. A picture is not worth that.
}

const MAX_FILE_BYTES = 25 * 1024 * 1024

const FILE_ROOTS = [
  homedir(),
  // Both temp directories, because on macOS os.tmpdir() is the per-user
  // $TMPDIR under /var/folders while half the tools that take a screenshot
  // still write it to /tmp. Dropping one of them loses real panels.
  tmpdir(),
  '/tmp',
  ...(process.env.JARVIS_FILE_ROOTS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
].map((root) => {
  try {
    return realpathSync(root)
  } catch {
    return resolvePath(root)
  }
})

/** True when `real` sits inside one of the roots, after both are resolved. */
const withinRoots = (real) =>
  FILE_ROOTS.some((root) => {
    const rel = relative(root, real)
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  })

// ---------------------------------------------------------------------------

/**
 * Remote media, fetched by the bridge instead of by the page.
 *
 * JARVIS used to refuse to show anything he found on the web, and the refusal
 * was not squeamishness — a bare <img src="https://some-cdn/..."> in a panel
 * genuinely did not work. Three reasons, and all three are fixed by moving the
 * fetch to this side of the wire:
 *
 *   1. Hotlink blocking. News sites and image CDNs check Referer and User-Agent
 *      and hand a browser-that-isn't-their-page a 403 or a placeholder. That is
 *      why thumbnails rendered as empty rectangles. A server-side fetch that
 *      looks like an ordinary browser and sends no referrer gets the bytes.
 *   2. Privacy. Panel HTML is authored by a model that has just been reading
 *      untrusted web pages, so a remote URL in it is a prompt-injection beacon:
 *      load it directly and the user's IP, and the fact they asked, go to a host
 *      the page chose. Proxying means the browser only ever talks to localhost
 *      and the page CSP can stay tight.
 *   3. One place to cap size, set timeouts and insist the bytes really are the
 *      media type they claim.
 *
 * The cost is that this process — unlike a browser tab — can reach the user's
 * LAN, their router's admin page, and cloud metadata endpoints. So everything
 * below is an SSRF gate first and a proxy second.
 */

const MAX_IMG_BYTES = 15 * 1024 * 1024
const MAX_MEDIA_BYTES = 200 * 1024 * 1024
const IMG_TIMEOUT_MS = 10_000
const MEDIA_TIMEOUT_MS = 30_000

// The SSRF gate and the guarded outbound clients now live in ./net.mjs, so the
// media proxy below and the page proxy share one implementation of the rules
// rather than two that can drift apart.

/**
 * The shared body of /img and /media.
 *
 * `kinds` is the list of content-type prefixes we are willing to hand back.
 * That check is load-bearing: without it this is an open proxy that will serve
 * an attacker's HTML from the bridge's own origin — the one origin allowed to
 * open the agent socket — which is the same reason IMAGE_TYPES has no .svg.
 */
async function proxyRemote(req, res, cors, { kinds, maxBytes, timeoutMs, ranged }) {
  const asked = new URL(req.url, 'http://x').searchParams.get('url') ?? ''
  const target = vetTarget(asked)

  const headers = {
    'user-agent': PROXY_UA,
    accept: ranged ? '*/*' : 'image/*,*/*;q=0.8',
    // Identity encoding so the byte cap counts the bytes we actually stream and
    // content-length means what it says. Media is already compressed anyway.
    'accept-encoding': 'identity',
  }
  // Range is the difference between a <video> that seeks and one Safari refuses
  // to play at all, so the browser's request is passed through verbatim.
  if (ranged && typeof req.headers.range === 'string') {
    headers.range = req.headers.range
  }

  const { res: upstream } = await openRemote(target, headers, timeoutMs)
  const status = upstream.statusCode ?? 0

  if (status !== 200 && status !== 206) {
    upstream.resume()
    throw proxyError(status === 404 ? 404 : 502, `upstream said ${status}`)
  }

  const type = String(upstream.headers['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()
  if (!kinds.some((kind) => type.startsWith(kind))) {
    upstream.resume()
    throw proxyError(415, `not ${kinds.join(' or ')} (got ${type || 'nothing'})`)
  }

  const declared = Number(upstream.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) {
    upstream.resume()
    throw proxyError(413, 'too large')
  }

  const out = {
    ...cors,
    'content-type': type,
    'x-content-type-options': 'nosniff',
    // Thumbnails get looked at, panelled again, and re-rendered on every HUD
    // repaint; re-fetching from the CDN each time is slow and rude.
    'cache-control': 'private, max-age=600',
  }
  if (Number.isFinite(declared)) out['content-length'] = String(declared)
  if (ranged) {
    // Only claim range support when the origin actually demonstrated it — a
    // 206, or an explicit accept-ranges of its own. Plenty of hosts ignore the
    // Range header and hand back the whole file with a 200; advertising
    // accept-ranges on top of that tells the video element it may seek by
    // issuing byte requests that will never be honoured, and the scrub bar
    // then misbehaves in a way that looks like our bug rather than theirs.
    if (status === 206 || upstream.headers['accept-ranges'] === 'bytes') {
      out['accept-ranges'] = 'bytes'
    }
    if (upstream.headers['content-range']) {
      out['content-range'] = upstream.headers['content-range']
    }
  }
  res.writeHead(status, out)

  // Stream with a running cap. Buffering a 200 MB video into this process
  // would stall the token stream the voice is riding on, and trusting
  // content-length would let a host that lies about it eat the heap.
  let sent = 0
  upstream.on('data', (chunk) => {
    sent += chunk.length
    if (sent > maxBytes) {
      // Headers went out long ago, so a truncated body is the only way left to
      // say no. The player sees a short read; we see this line in the log.
      console.warn(`[jarvis] proxy cut ${target.href} at ${maxBytes} bytes`)
      upstream.destroy()
      res.destroy()
      return
    }
    if (!res.write(chunk)) {
      upstream.pause()
      res.once('drain', () => upstream.resume())
    }
  })
  upstream.on('end', () => res.end())
  upstream.on('error', () => res.destroy())
  req.on('close', () => upstream.destroy())
}

// ---------------------------------------------------------------------------

/**
 * CORS, reflected rather than wildcarded.
 *
 * `*` on this origin means any page on the internet can read whatever the
 * bridge serves, so the same allowlist that guards the socket picks the
 * header. A request carrying an Origin we don't know is refused outright —
 * but a request with no Origin at all is served, because an <img src> load
 * (which is how panels fetch screenshots) never sends one.
 */
function corsFor(req) {
  const origin = req.headers.origin
  const headers = { vary: 'origin' }
  if (origin) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-headers'] = 'content-type'
  }
  return headers
}

// One HTTP server for both the speech proxy and the WebSocket upgrade.
const http = await import('node:http')

const handleRequest = async (req, res) => {
  const origin = req.headers.origin
  if (origin && !originAllowed(origin)) {
    console.warn(`[jarvis] refused http request from origin ${origin}`)
    res.writeHead(403, { vary: 'origin' })
    return res.end('forbidden')
  }
  const cors = corsFor(req)

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/health') {
    // The browser reads this once at boot to decide which voice engine to use.
    // Both premium paths ride the same ElevenLabs key, so both flags track it:
    // with a key the app transcribes with Scribe and speaks with ElevenLabs;
    // without one it falls back to the browser's own recogniser and voice, so a
    // student with nothing configured still has a working assistant.
    // Speaking may also come from Fish Audio, which takes priority when its
    // key is set; `voice` names the engine so the HUD can say which.
    const voice = voiceEngine()
    const ears = earsEngine()
    res.writeHead(200, { ...cors, 'content-type': 'application/json' })
    return res.end(
      JSON.stringify({
        ok: true,
        tts: Boolean(voice),
        stt: Boolean(ears),
        voice,
        ears,
        brain: BRAIN,
        bot: BRAIN === 'grokbot' ? GROKBOT_BOT || null : null,
      }),
    )
  }

  // Serve local image files to the page. Screenshots and generated art land on
  // disk as absolute paths, and a page served over http can't read file:// —
  // so the bridge, which can, hands them over.
  if (req.method === 'GET' && req.url?.startsWith('/file?')) {
    const asked = new URL(req.url, 'http://x').searchParams.get('path') ?? ''
    // Resolve symlinks BEFORE judging anything. A name ending in .png can be a
    // link pointing at /etc/hosts, and checking the suffix the caller supplied
    // would wave that straight through — which is exactly how this endpoint
    // used to serve the contents of arbitrary system files.
    let real = null
    try {
      if (isAbsolute(asked)) real = await realpath(asked)
    } catch {
      real = null
    }
    const dot = real ? real.lastIndexOf('.') : -1
    const ext = dot === -1 ? '' : real.slice(dot).toLowerCase()
    // Images only, absolute paths only, and only under roots we expect things
    // to be written to. This endpoint exists to show pictures, not to be a
    // general file read for whatever the model — or another page — asks for.
    if (!real || !Object.hasOwn(IMAGE_TYPES, ext) || !withinRoots(real)) {
      res.writeHead(400, cors)
      return res.end('images only')
    }
    try {
      const info = await stat(real)
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        res.writeHead(413, cors)
        return res.end('too large')
      }
      // Asynchronous because this process is also pumping the agent's token
      // stream; a synchronous read of a large screenshot stalls the voice.
      const body = await readFile(real)
      res.writeHead(200, {
        ...cors,
        'content-type': IMAGE_TYPES[ext],
        'x-content-type-options': 'nosniff',
      })
      return res.end(body)
    } catch {
      res.writeHead(404, cors)
      return res.end('not found')
    }
  }

  // Remote images, fetched here so the page never talks to the wider web. The
  // renderer rewrites every http(s) <img src> in a panel to this endpoint.
  if (req.method === 'GET' && req.url?.startsWith('/img?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['image/'],
        maxBytes: MAX_IMG_BYTES,
        timeoutMs: IMG_TIMEOUT_MS,
        ranged: false,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // The same, for video and audio. Separate from /img because the limits and
  // the Range handling are genuinely different, not because the code is.
  if (req.method === 'GET' && req.url?.startsWith('/media?')) {
    try {
      await proxyRemote(req, res, cors, {
        kinds: ['video/', 'audio/'],
        maxBytes: MAX_MEDIA_BYTES,
        timeoutMs: MEDIA_TIMEOUT_MS,
        ranged: true,
      })
    } catch (err) {
      if (res.headersSent) return res.destroy()
      res.writeHead(err.status ?? 502, cors)
      return res.end(err.message ?? 'proxy failed')
    }
    return
  }

  // A whole web page, fetched here and served from this origin so it can be
  // framed. The publisher's X-Frame-Options and CORS rules are enforced against
  // the browser, and from the browser's point of view this document is ours —
  // so an article that refuses to be embedded anywhere still opens on the
  // display. See page.mjs for what each mode does to the markup.
  //
  // No Origin header arrives on an iframe navigation, so this rides the same
  // path as an <img> load through the check at the top of this handler.
  if (req.method === 'GET' && req.url?.startsWith('/page?')) {
    const asked = new URL(req.url, 'http://x')
    const target = asked.searchParams.get('url') ?? ''
    const mode = asked.searchParams.get('mode') === 'live' ? 'live' : 'reader'
    try {
      const page = await renderPage(target, mode, `http://localhost:${PORT}`)
      res.writeHead(200, { ...cors, ...page.headers })
      return res.end(page.body)
    } catch (err) {
      // Rendered as a page rather than returned as a status, because this lands
      // inside an iframe: a bare 502 body is a blank rectangle on the display,
      // which reads as the interface being broken rather than as the article
      // being unavailable.
      res.writeHead(err.status ?? 502, {
        ...cors,
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      })
      return res.end(
        `<!doctype html><meta charset="utf-8"><style>
           body{margin:0;padding:26px;background:transparent;color:#7fb6bf;
                font:400 13px/1.6 ui-monospace,monospace}
           b{color:#cfe9ee;font-weight:500;display:block;margin-bottom:6px}
         </style><b>This page could not be opened.</b>${
           String(err?.message ?? 'unknown error').replace(/[<&]/g, '')
         }`,
      )
    }
  }

  if (req.method === 'POST' && req.url === '/tts') {
    if (!voiceEngine()) {
      res.writeHead(503, cors)
      return res.end('no speech key')
    }
    // A spoken line is a few hundred bytes. Anything approaching this is not a
    // sentence, and buffering it unbounded would let one request eat the heap.
    let body = ''
    let overflowed = false
    for await (const chunk of req) {
      body += chunk
      if (body.length > 64 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(400, cors)
      return res.end('body too large')
    }
    // Inside a try: this handler is async with nothing catching its rejection,
    // so a malformed body used to take the entire bridge down with it.
    let text
    try {
      ;({ text } = JSON.parse(body || '{}'))
    } catch {
      res.writeHead(400, cors)
      return res.end('bad json')
    }
    if (!text) {
      res.writeHead(400, cors)
      return res.end('no text')
    }
    try {
      // Fish first. If Fish refuses a sentence (out of credit, a bad voice id)
      // and an ElevenLabs key exists, that sentence goes to ElevenLabs instead
      // of falling all the way to the browser voice mid-conversation.
      let upstream
      if (fishKey()) {
        upstream = await speakFish(text)
        if (!upstream.ok && elevenKey()) {
          console.warn(
            `[jarvis] fish tts ${upstream.status} — this sentence goes via ElevenLabs`,
          )
          upstream = await speakEleven(text)
        }
      } else {
        upstream = await speakEleven(text)
      }
      if (!upstream.ok) {
        res.writeHead(upstream.status, cors)
        return res.end(await upstream.text())
      }

      // Pipe it through rather than buffering. Waiting for the whole file here
      // would throw away everything the streaming endpoint just bought us.
      res.writeHead(200, {
        ...cors,
        'content-type': 'audio/mpeg',
        'cache-control': 'no-cache',
      })
      for await (const chunk of upstream.body) res.write(Buffer.from(chunk))
      return res.end()
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  // Speech to text. The browser captures one spoken segment as a compressed
  // audio blob and posts the raw bytes here; the bridge hands them to Groq
  // (or ElevenLabs Scribe) and returns the transcript. This is what replaced
  // the browser's own SpeechRecognition — that API dies silently under
  // always-on use, and a server-side transcriber cannot. Detecting that the
  // user is speaking at all is done locally with voice-activity detection,
  // which never touches this endpoint; this is only for the words.
  if (req.method === 'POST' && req.url === '/stt') {
    if (!earsEngine()) {
      res.writeHead(503, cors)
      return res.end('no speech-to-text key')
    }

    const type = req.headers['content-type'] || 'audio/webm'
    const chunks = []
    let size = 0
    let overflowed = false
    // A few seconds of Opus is well under a megabyte; 25 MB is a generous
    // ceiling that still refuses a runaway stream before it eats the heap.
    for await (const chunk of req) {
      chunks.push(chunk)
      size += chunk.length
      if (size > 25 * 1024 * 1024) {
        overflowed = true
        break
      }
    }
    if (overflowed) {
      req.destroy()
      res.writeHead(413, cors)
      return res.end('audio too large')
    }
    // Silence, or a click. Nothing to transcribe, and calling out to the API
    // for it would only add latency to a non-answer.
    if (size < 1200) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: '' }))
    }

    const bytes = Buffer.concat(chunks)
    try {
      let text
      if (groqKey()) {
        try {
          text = await hearGroq(bytes, type)
        } catch (err) {
          if (!elevenKey()) throw err
          console.warn(`[jarvis] groq stt failed (${err.message}) — this segment goes via ElevenLabs`)
          text = await hearEleven(bytes, type)
        }
      } else {
        text = await hearEleven(bytes, type)
      }
      res.writeHead(200, { ...cors, 'content-type': 'application/json' })
      return res.end(JSON.stringify({ text: cleanTranscript(text) }))
    } catch (err) {
      res.writeHead(502, cors)
      return res.end(String(err?.message ?? err))
    }
  }

  res.writeHead(404, cors)
  res.end()
}

const server = http.createServer((req, res) => {
  // The handler is async, so anything it throws would otherwise become an
  // unhandled rejection and leave the browser waiting on a socket that is
  // never going to answer.
  handleRequest(req, res).catch((err) => {
    console.error('[jarvis] request failed:', err)
    if (!res.headersSent) res.writeHead(500)
    res.end()
  })
})

const wss = new WebSocketServer({
  server,
  // The handshake is the only place a page can be turned away, so it happens
  // here rather than after the socket is open. Rejections are logged loudly:
  // the likeliest cause is a dev server on an unexpected port, and a silent
  // 403 would look like the bridge simply isn't running.
  verifyClient: ({ origin, req }, done) => {
    const path = (req.url ?? '/').split('?')[0]
    if (path !== '/' && path !== '/ws') {
      console.warn(`[jarvis] rejected websocket on path ${path}`)
      return done(false, 403, 'Forbidden')
    }
    if (!originAllowed(origin)) {
      console.warn(
        `[jarvis] rejected websocket from origin ${origin ?? '(none)'}` +
          ' — set JARVIS_ALLOWED_ORIGINS to permit it',
      )
      return done(false, 403, 'Forbidden')
    }
    done(true)
  },
})
server.listen(PORT)

console.log(`[jarvis] bridge listening on ws://localhost:${PORT}`)
console.log(
  `[jarvis] speech ${
    voiceEngine() === 'fish'
      ? `via Fish Audio (${FISH_MODEL}, voice ${FISH_VOICE_ID || 'default'})`
      : voiceEngine() === 'elevenlabs'
        ? 'via ElevenLabs'
        : 'using browser fallback voice'
  }`,
)
console.log(
  `[jarvis] hearing ${
    earsEngine() === 'groq'
      ? `via Groq (${GROQ_STT_MODEL})${elevenKey() ? ', ElevenLabs Scribe as fallback' : ''}`
      : earsEngine() === 'elevenlabs'
        ? 'via ElevenLabs Scribe'
        : 'using browser recogniser'
  }`,
)
if (BRAIN === 'grokbot') {
  console.log(`[jarvis] brain via Grok Bot (${GROKBOT_BOT || 'whichever chat is open'}, port ${GROKBOT_PORT})`)
  void grok.available().then((ok) => {
    console.log(
      ok
        ? '[jarvis] grok bot window reachable'
        : `[jarvis] grok bot window NOT reachable — start Grok Bot with --remote-debugging-port=${GROKBOT_PORT} (npm start does this)`,
    )
  })
} else {
  console.log(`[jarvis] brain via Claude · model ${MODEL} · effort ${EFFORT}`)
}
console.log(
  `[jarvis] writes ${ALLOW_WRITES ? 'ENABLED' : 'disabled'}` +
    (ALLOW_WRITES ? '' : ' — set JARVIS_ALLOW_WRITES=1 to permit shell/file/device actions'),
)
// Asynchronous, so it lands a beat after the rest of the banner. Worth printing
// at all because an extension that is simply not running is indistinguishable
// at the tool boundary from one that is broken, and this is the one place the
// difference can be stated before anybody asks a question that depends on it.
void chromeAvailable().then((ok) => {
  console.log(
    ok
      ? `[jarvis] browser control ready${ALLOW_WRITES ? '' : ' (reading only — clicking and typing need JARVIS_ALLOW_WRITES=1)'}`
      : '[jarvis] browser control unavailable — open Chrome with the Claude extension enabled',
  )
})

console.log(
  '[jarvis] accepting local dev origins' +
    (EXTRA_ORIGINS.size ? ` plus ${[...EXTRA_ORIGINS].join(', ')}` : '') +
    (ALLOW_NO_ORIGIN ? ' and clients that send no origin' : ''),
)

/**
 * What to tell the browser when a turn ends badly. Plain sentences, because
 * whatever reaches the client is liable to be spoken.
 */
const RESULT_FAILURES = {
  error_during_execution: 'The turn failed part way through.',
  error_max_turns: 'The turn ran too long and was stopped.',
  error_max_budget_usd: 'The budget for this turn ran out.',
  error_max_structured_output_retries: 'The answer could not be assembled.',
  default: 'The turn ended without an answer.',
}

wss.on('connection', (socket) => {
  console.log('[jarvis] client connected')

  // Answer the HUD straight away rather than making it wait for the agent's
  // first turn. Refined later by the real init message.
  socket.send(
    JSON.stringify({
      type: 'ready',
      // In Grok Bot mode the rail lists the bots instead, fed by `bots`
      // frames from the reader below, so nothing is claimed here.
      servers: BRAIN === 'grokbot' ? [] : Object.keys(MCP_SERVERS),
    }),
  )

  /** Resolves the pending user message into the SDK's input generator. */
  let deliver = null
  let closed = false
  const inbox = []

  async function* userMessages() {
    while (!closed) {
      const text =
        inbox.shift() ??
        (await new Promise((resolve) => {
          deliver = resolve
        }))
      if (closed || text == null) return
      yield {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }
    }
  }

  const send = (msg) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg))
  }

  /**
   * Which question the agent is currently answering.
   *
   * The stream carries no notion of a turn, so without this the client cannot
   * tell the tail of an abandoned answer from the start of the new one — it
   * attaches a listener and receives whatever is on the socket. Echoing the
   * id the client sent lets it ignore anything that is not its own, which is
   * the only reliable fix: no amount of waiting on this side changes what a
   * listener over there has already heard.
   */
  let answering = null
  const sendTurn = (msg) => send({ ...msg, ask: answering })

  /**
   * Asking the browser for something and waiting for the answer.
   *
   * Every other tool here pushes — a panel, a blade, a retint — and never needs
   * a reply. The camera is the exception: the hardware is over there and the
   * model is here, so a frame has to come back. Correlated by id because a turn
   * can have more than one request in flight, and timed out because a browser
   * that has been closed mid-question would otherwise hang the turn until the
   * two-minute idle timer noticed.
   */
  const waiting = new Map()
  let asks = 0

  const ask = (kind, args, timeoutMs = 20_000) =>
    new Promise((resolve, reject) => {
      if (socket.readyState !== socket.OPEN) {
        return reject(new Error('the interface is not connected'))
      }
      const id = `q${++asks}`
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new Error('the interface did not answer in time'))
      }, timeoutMs)
      waiting.set(id, { resolve, timer })
      send({ type: kind, id, ...args })
    })

  /**
   * Announcing a tool on the HUD, once, and only if it actually runs.
   *
   * A tool_use block surfaces twice — as a partial stream event and again on
   * the completed assistant message — so ids are remembered. The harder part
   * is timing, because a refused tool that lights the badge, plays the sound
   * and provokes a "working on it" line, for work that never happens, reads as
   * a bug on camera.
   *
   * The SDK's order is: the block starts streaming, then canUseTool is asked,
   * then the tool runs. So nothing is known at content_block_start. Announcing
   * from inside canUseTool would know the verdict but miss tools entirely —
   * measured on this SDK, the callback is consulted only for calls the CLI
   * hasn't already settled, so a `Bash: echo` its own classifier waves through
   * never reaches us at all.
   *
   * So: announce immediately for anything decideTool permits, since those run.
   * Hold the rest, and let the tool_result settle it — a refusal comes back as
   * is_error, anything else really did execute and has earned its badge, a
   * beat late. Nothing is ever announced for work that didn't happen.
   */
  const seenTools = new Set()
  const heldTools = new Map()

  /**
   * Resolves when the turn in flight has actually finished.
   *
   * Waiting on session.interrupt() alone is not enough. It resolves when the
   * agent has been *told* to stop, not when it has, so the last tokens of the
   * abandoned answer are still on their way — and since nothing on the wire
   * identifies which question a delta belongs to, they land on the next turn's
   * listener. Measured: ask for ALPHA, interrupt, ask for BRAVO, and BRAVO's
   * answer arrives as "ALPHA\nBRAVO".
   *
   * The SDK emits exactly one `result` per turn, so that is the boundary worth
   * waiting for. Raced against a timeout because a turn that never reports one
   * must not wedge the conversation for ever — a stray word is a blemish, a
   * deadlocked assistant is not.
   */
  let settling = Promise.resolve()
  let finishTurn = null

  const turnFinished = () =>
    new Promise((resolve) => {
      finishTurn = resolve
    })

  /**
   * A brief pause so the abandoned turn's frames are tagged with the OLD id
   * before the new one is adopted. Short, because correctness now comes from
   * the tag rather than from the wait — this only has to cover the gap, not
   * outlast the whole turn.
   */
  const SETTLE_CAP_MS = 400

  const announceTool = (id, name) => {
    if (!name || (id && seenTools.has(id))) return
    if (id) seenTools.add(id)
    // The display tool isn't work being done, it's the HUD drawing itself —
    // announcing it would put "jarvis · display" in the tool badge and trigger
    // a "working on it" filler for something already on screen.
    if (name === 'mcp__jarvis__display') return
    // The ui_* tools are the same case one step further: retinting the
    // interface is the interface talking about itself, not work being done for
    // the user, and the badge would be describing the very thing they can see.
    if (name.startsWith('mcp__jarvis_ui__')) return
    if (decideTool(name)) return sendTurn({ type: 'tool', name })
    if (id) heldTools.set(id, name)
  }

  const settleTool = (id, failed) => {
    const name = heldTools.get(id)
    if (name === undefined) return
    heldTools.delete(id)
    if (!failed) sendTurn({ type: 'tool', name })
  }

  // In Grok Bot mode no agent session is started at all: there is nothing for
  // Claude to do, and starting one would spin up a Claude Code process per
  // connection for no reason. `session` stays null and every use below guards.
  const session = BRAIN === 'claude' ? query({
    prompt: userMessages(),
    options: {
      // Everything Claude Code has configured, plus the HUD as an in-process
      // server. The HUD's handler closes over this socket, so a `display` call
      // lands on screen directly — which is also why this object is built per
      // connection rather than once.
      mcpServers: {
        ...MCP_SERVERS,
        jarvis: displayServer(
          (panel) => send({ type: 'panel', panel }),
          (blade) => send({ type: 'blade', blade }),
        ),
        // The interface controls, on the same socket. A separate key because
        // MCP tool names are `mcp__<key>__<tool>` and one key can only carry
        // one server; the underscore in it is why decideTool and announceTool
        // both name `jarvis_ui` explicitly.
        jarvis_ui: uiServer((op, args) => send({ type: 'ui', op, args })),
        // The user's own Chrome, over the extension's native-host socket. It
        // holds no per-connection state, but it is built here with the rest so
        // the write gate is read once, at the same point as everything else.
        jarvis_chrome: chromeServer({ allowWrites: ALLOW_WRITES }),
        // The camera, which unlike everything else here has to ask and wait.
        jarvis_eyes: visionServer(ask),
      },
      // A plain system prompt, not the claude_code preset. The preset is
      // tuned for a coding agent — verbose, file-oriented, and a large chunk
      // of input tokens on every turn. Replacing it makes the persona stick,
      // keeps answers short enough to speak, and cuts cost per turn.
      systemPrompt: SYSTEM_PROMPT,
      // Run from the home directory so project-scoped MCP servers don't shadow
      // the global ones, and so file tools have a sane root.
      cwd: homedir(),
      // No filesystem settings at all. Left to its default the SDK loads
      // ~/.claude/settings.json and settings.local.json exactly as the CLI
      // does — which on a working machine means a bypassPermissions default
      // and a pile of allow-rules for Bash. Allow-rules are matched before the
      // permission callback, so decideTool below would never even be asked
      // about the tools it most needs to refuse. Empty makes this bridge the
      // only authority. It also stops the global CLAUDE.md riding along on
      // every voice turn, carrying instructions written for a coding agent
      // into a conversation that is meant to be two sentences long.
      //
      // The cost is that MCP servers stop being discovered too, which is why
      // mcpServers above passes them in by hand.
      settingSources: [],
      // Stated explicitly, and it has to be.
      //
      // With no `model` here the SDK falls back to its own default, which on
      // this machine resolved to claude-opus-4-8[1m] — not what src/config.ts
      // declares for the browser-direct path, and not anything anyone chose.
      // Normally your own `/model` preference would decide, but that lives in
      // the settings files `settingSources: []` deliberately stops loading, so
      // without this line nothing in the project has a say at all.
      model: MODEL,
      effort: EFFORT,
      maxTurns: 24,
      permissionMode: 'default',
      // Without this the SDK only emits whole assistant messages, and JARVIS
      // would sit silent until the entire answer was written. Partial events
      // are what let speech start on the first finished sentence.
      includePartialMessages: true,
      // Signature is (toolName, input, options) and it must return a
      // PermissionResult object. Returning a bare boolean silently denies
      // everything, with the tool name arriving undefined.
      //
      // Worth knowing: this is a last gate, not the only one. Calls the CLI
      // has already settled never arrive here — its own classifier waves
      // through a `Bash: echo hello` without asking, and only reaches us for
      // something with a consequence, like a `touch`. So a deny here is
      // reliable; an absence of a call here is not proof nothing ran.
      canUseTool: async (toolName) => {
        const ok = decideTool(toolName)
        console.log(`[jarvis] tool ${toolName} -> ${ok ? 'allow' : 'deny'}`)
        return ok
          ? { behavior: 'allow' }
          : {
              behavior: 'deny',
              // Every word of this can end up spoken, so it carries no command
              // to read out — the persona is forbidden from saying one aloud.
              message:
                'Blocked: JARVIS is running in read-only mode and cannot take' +
                ' actions that change anything. Tell the user this action is' +
                ' unavailable until they enable write access on the machine.',
            }
      },
    },
  }) : null

  // Pump the session's output stream to the browser for as long as it lives.
  if (session) (async () => {
    try {
      for await (const msg of session) {
        if (process.env.JARVIS_DEBUG === '1') {
          console.log('[msg]', msg.type, msg.event?.type ?? '')
        }

        switch (msg.type) {
          // Raw Anthropic stream events, surfaced by includePartialMessages.
          // This is the ONLY place spoken text arrives: there is no top-level
          // text_delta message in the SDK union and the 'assistant' message
          // carries no deltas either. Turn includePartialMessages off and
          // JARVIS goes completely mute.
          case 'stream_event': {
            const ev = msg.event
            if (
              ev?.type === 'content_block_delta' &&
              ev.delta?.type === 'text_delta' &&
              ev.delta.text
            ) {
              sendTurn({ type: 'text', delta: ev.delta.text })
            }
            if (
              ev?.type === 'content_block_start' &&
              ev.content_block?.type === 'tool_use'
            ) {
              announceTool(ev.content_block.id, ev.content_block.name)
            }
            break
          }

          case 'assistant': {
            // Fallback for builds that emit whole assistant messages rather
            // than partial events. Deduped against the stream_event path.
            for (const block of msg.content ?? msg.message?.content ?? []) {
              if (block.type === 'tool_use') {
                announceTool(block.id, block.name)
              }
            }
            break
          }

          case 'user': {
            // Tool results come back as a user message. This is the only place
            // a held announcement can be resolved: a refused tool arrives with
            // is_error set and stays off the HUD, anything else ran.
            const blocks = msg.message?.content
            if (!Array.isArray(blocks)) break
            for (const block of blocks) {
              if (block?.type === 'tool_result') {
                settleTool(block.tool_use_id, block.is_error === true)
              }
            }
            break
          }

          case 'result':
            // A result is not automatically a success. The error subtypes
            // carry no `result` field at all, so reporting them as 'done' with
            // empty text is indistinguishable from a turn that simply had
            // nothing to say — the HUD stops spinning and JARVIS stands there
            // silent. Say what happened instead.
            if (msg.subtype === 'success') {
              sendTurn({
                type: 'done',
                text: msg.result ?? '',
                costUsd: msg.total_cost_usd ?? null,
              })
            } else {
              console.error(
                `[jarvis] turn failed: ${msg.subtype}`,
                msg.errors ?? '',
              )
              sendTurn({
                type: 'error',
                message: RESULT_FAILURES[msg.subtype] ?? RESULT_FAILURES.default,
              })
            }
            // Whatever was waiting on this turn to finish can go now. This is
            // the only place a turn is genuinely over.
            finishTurn?.()
            finishTurn = null
            // One turn's tool ids are never referred to again, and these
            // otherwise grow for as long as the socket is open.
            seenTools.clear()
            heldTools.clear()
            break

          case 'system':
            if (msg.subtype === 'init') {
              // Servers report 'pending' until first use — they connect
              // lazily — so only drop the ones that are actually unusable.
              const usable = (msg.mcp_servers ?? [])
                .filter((s) => s.status !== 'needs-auth' && s.status !== 'failed')
                .map((s) => s.name)
              send({ type: 'ready', servers: usable })
              console.log(`[jarvis] ${usable.length} MCP servers available`)
            }
            break
        }
      }
    } catch (err) {
      console.error('[jarvis] session error:', err)
      send({ type: 'error', message: String(err?.message ?? err) })
      // The stream is finished either way — nothing will ever be read from it
      // again. Leaving the socket open would leave the client believing it has
      // a working bridge, and every later question would hang for ever waiting
      // on a pump that has already stopped. Close it so it reconnects.
      closed = true
      deliver?.(null)
      session.close?.()
      socket.close()
    }
  })()

  /**
   * Turns answered by Grok Bot instead of Claude.
   *
   * What was said is typed into the open chat. Every bubble a bot then posts
   * in that chat is read back through the same `text` / `done` frames a Claude
   * turn produces — so the face speaks it, shows it on the HUD and can barge in
   * on it without knowing the difference.
   *
   * One reader per connection, alive for as long as the socket is, rather than
   * one per turn. Measured why: "check my latest email" gets "Inbox is on it"
   * from Chief of Staff in 3 s, then the bot goes idle while Inbox works, and
   * the real answer lands 20 s later. A watcher that stopped when the bot went
   * quiet missed it. So bubbles are claimed by whichever turn is open when they
   * land; anything that lands with no turn open is announced, however late,
   * and the face reads it out unprompted.
   *
   * A bot can take minutes. Holding the microphone hostage that long is worse
   * than admitting it, so the turn closes QUIET after the last thing it read,
   * or at HAND_OFF with a promise if nothing has come back at all.
   */
  const grokBotName = { current: GROKBOT_BOT }

  /** The turn currently open, or null. */
  let grokTurn = null
  /** When the last message was sent; nothing older than this is ever read. */
  let grokSentAt = 0
  /** key -> { text, spokenUpTo, timer } for bubbles this connection has read. */
  const grokBubbles = new Map()

  const grokSay = (spoken) => sendTurn({ type: 'text', delta: `${spoken} ` })

  /** Read out what a bubble says, once its text has stopped changing. */
  const grokSettle = (key) => {
    const b = grokBubbles.get(key)
    if (!b) return
    const fresh = b.text.slice(b.spokenUpTo)
    if (!fresh.trim()) return
    b.spokenUpTo = b.text.length
    // Another bot's words relayed into this chat are said with its name on.
    const who = b.label.replace(/ message$/, '')
    const foreign = normaliseName(who) !== normaliseName(grokBotName.current)
    const spoken = (foreign && b.raw === undefined ? `From ${who}: ` : '') + speakable(fresh)
    b.raw = b.text
    console.log(`[grok] ${who}: ${JSON.stringify(b.text.slice(0, 120))}`)
    const turn = grokTurn
    if (turn && !turn.closed) {
      turn.full.push(b.text)
      turn.spokenAny = true
      turn.lastRead = Date.now()
      grokSay(spoken)
    } else {
      send({ type: 'announce', text: spoken, raw: b.text })
    }
  }

  /** Send the face the sidebar as it stands, with the active bot marked. */
  const pushBots = () => {
    if (!grok) return
    const { bots, bot: open } = grok.state()
    const active = normaliseName(grokBotName.current || open)
    send({
      type: 'bots',
      bots: bots.map((b) => ({ ...b, active: normaliseName(b.name) === active })),
    })
  }

  const grokOffs = grok
    ? [
        grok.on('message', (m) => {
          if (!/ message$/.test(m.label) || m.label === 'Your message') return
          // Only the chat of the bot being spoken to. If the window is showing
          // another bot's chat — Hugo clicked into the Inbox exchange to look —
          // its bubbles are not read; Chief of Staff relays what matters.
          if (normaliseName(grok.state().bot) !== normaliseName(grokBotName.current)) return
          if (!grokBubbles.has(m.key)) {
            // History and other chats have old stamps; ten seconds of slack for
            // clocks that disagree. `isNew` keeps a re-rendered old row out.
            if (!m.isNew || !grokSentAt || m.at < grokSentAt - 10_000) return
            grokBubbles.set(m.key, { text: '', spokenUpTo: 0, raw: undefined, timer: null, label: m.label })
          }
          const b = grokBubbles.get(m.key)
          b.text = m.text
          clearTimeout(b.timer)
          b.timer = setTimeout(() => grokSettle(m.key), GROK_SETTLE_MS)
        }),
        grok.on('working', (on, status) => {
          console.log(`[grok] ${on ? 'working' : 'idle'}${status?.length ? ` (${status.join(' / ')})` : ''}`)
        }),
        // The sidebar is the face's left rail: every bot, the one being spoken
        // to marked active, and a "working" light on whichever bot Chief of
        // Staff has handed the job to. Grok Bot marks that bot ", Working" in
        // its sidebar, which is the only outward sign of a delegation.
        grok.on('bots', () => pushBots()),
        grok.on('bot', () => pushBots()),
        grok.on('disconnected', () => {
          const turn = grokTurn
          if (turn && !turn.closed) {
            turn.close()
            sendTurn({ type: 'error', message: 'The Grok Bot window went away mid-answer.' })
          }
        }),
      ]
    : []
  if (grok) {
    // Connect now rather than on the first question, so the rail fills as
    // soon as the face is up. A missing window is not an error yet: the first
    // question reports it, spoken.
    grok
      .available()
      .then((ok) => (ok ? grok.connect() : null))
      .then(() => pushBots())
      .catch((err) => console.log(`[grok] not reachable yet: ${err.message}`))
  }

  async function runGrokTurn(text, id) {
    grokTurn?.close()
    answering = id
    const finishWith = (spoken, full = spoken) => {
      grokSay(spoken)
      sendTurn({ type: 'done', text: full })
    }

    if (!(await grok.available())) {
      return finishWith(
        "Grok Bot isn't open with its control port, sir. Start it with npm start and try again.",
      )
    }

    try {
      // Spoken commands that stay local. Only ever intercepted when the name
      // actually matches a bot, so "open the website" reaches the bot as-is.
      const switching =
        /^(?:(?:please\s+)?(?:switch|change|go)\s+(?:over\s+)?to|talk\s+to|open|put\s+me\s+through\s+to)\s+(?:the\s+)?(.+?)(?:\s+bot)?[.!?]*$/i.exec(
          text.trim(),
        )
      if (switching) {
        const hit = matchBot(switching[1], await grok.bots())
        if (hit) {
          await grok.openBot(hit)
          grokBotName.current = hit
          console.log(`[grok] switched to ${hit}`)
          pushBots()
          return finishWith(`Switched to ${hit}, sir.`)
        }
      }
      if (/^(?:which|what)\s+bot\b/i.test(text.trim())) {
        return finishWith(`You're talking to ${await grok.currentBot()}, sir.`)
      }

      if (!grokBotName.current) {
        // No bot configured: adopt whichever chat is open, and stay on it.
        grokBotName.current = await grok.currentBot()
        if (!grokBotName.current) {
          return finishWith('Open a bot in Grok Bot first, sir, so I know who to talk to.')
        }
        console.log(`[grok] talking to the open chat: ${grokBotName.current}`)
        pushBots()
      }
      const bot = grokBotName.current
      if (normaliseName(await grok.currentBot()) !== normaliseName(bot)) {
        await grok.openBot(bot)
      }

      grokSentAt = await grok.send(text)
      console.log(`[grok] sent to ${bot}: ${JSON.stringify(text)}`)

      const turn = {
        full: [],
        spokenAny: false,
        lastRead: 0,
        closed: false,
        timers: [],
        close() {
          if (this.closed) return
          this.closed = true
          for (const t of this.timers) clearTimeout(t)
          if (grokTurn === this) grokTurn = null
        },
      }
      const after = (ms, fn) => turn.timers.push(setTimeout(fn, ms))

      // Closes the turn QUIET after the last bubble it read. The bot's own
      // "is working" light is deliberately not consulted: it stays on ~30 s
      // after a one-word answer, and a listener who has heard the answer
      // should not be held for that. Whatever lands later is announced.
      const tick = setInterval(() => {
        if (turn.closed) return clearInterval(tick)
        if (turn.spokenAny && Date.now() - turn.lastRead >= GROK_QUIET_MS) {
          clearInterval(tick)
          turn.close()
          sendTurn({ type: 'done', text: turn.full.join('\n\n') })
          console.log(`[grok] turn complete (${turn.full.length} bubble${turn.full.length === 1 ? '' : 's'})`)
        }
      }, 250)
      turn.timers.push(tick)

      let stillOn = false
      after(GROK_STILL_ON_MS, () => {
        if (!turn.closed && !turn.spokenAny) {
          stillOn = true
          grokSay('Still on it, sir.')
        }
      })
      after(GROK_HAND_OFF_MS, () => {
        // Nothing to promise if the answer is already being read out; the
        // quiet rule closes the turn in a moment.
        if (turn.closed || turn.spokenAny) return
        const line = stillOn
          ? "I'll tell you when it lands, sir."
          : "Still working, sir. I'll tell you when it lands."
        turn.close()
        grokSay(line)
        sendTurn({ type: 'done', text: line })
        console.log('[grok] turn handed off; later bubbles will be announced')
      })

      grokTurn = turn
    } catch (err) {
      console.error('[grok] turn failed:', err)
      sendTurn({
        type: 'error',
        message: `Grok Bot could not take that, sir: ${err?.message ?? err}`,
      })
    }
  }

  socket.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string' && BRAIN === 'grokbot') {
      void runGrokTurn(msg.text, typeof msg.id === 'string' ? msg.id : null)
      return
    }

    if (msg.type === 'ask' && typeof msg.text === 'string') {
      /**
       * Queued behind any interrupt that is still settling.
       *
       * A barge-in is two messages in quick succession — interrupt, then the
       * new question — and session.interrupt() is asynchronous. Delivering the
       * question the instant it arrives means the agent can still be winding
       * down the previous turn, so its last tokens are emitted after the new
       * one has begun and land on the new turn's listener. Measured: ask "one",
       * interrupt, ask "two", and the answer to "two" comes back as "One."
       *
       * Waiting costs nothing when nothing is interrupting — the chain is an
       * already-resolved promise — and removes the cross-talk when there is.
       */
      const text = msg.text
      const id = typeof msg.id === 'string' ? msg.id : null
      void settling.then(() => {
        answering = id
        if (deliver) {
          const resolve = deliver
          deliver = null
          resolve(text)
        } else {
          inbox.push(text)
        }
      })
    }

    if (msg.type === 'reply' && typeof msg.id === 'string') {
      const slot = waiting.get(msg.id)
      if (slot) {
        waiting.delete(msg.id)
        clearTimeout(slot.timer)
        slot.resolve(msg)
      }
    }

    if (msg.type === 'interrupt' && BRAIN === 'grokbot') {
      // Stop reading; the bot carries on in its own window regardless, and
      // whatever it posts after this is announced rather than lost.
      if (grokTurn) console.log('[grok] turn cancelled')
      grokTurn?.close()
      return
    }

    if (msg.type === 'interrupt') {
      // Held so the next question can wait for it rather than racing it.
      const stopped = turnFinished()
      settling = Promise.resolve(session?.interrupt?.())
        .catch(() => {})
        .then(() =>
          Promise.race([
            stopped,
            new Promise((r) => setTimeout(r, SETTLE_CAP_MS)),
          ]),
        )
    }
  })

  socket.on('close', () => {
    console.log('[jarvis] client disconnected')
    closed = true
    deliver?.(null)
    grokTurn?.close()
    for (const off of grokOffs) off()
    for (const b of grokBubbles.values()) clearTimeout(b.timer)
    session?.close?.()
  })
})
