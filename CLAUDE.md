# Grok Bot Voice

JARVIS (the voice face and bridge from github.com/adewaskar/jarvis) rewired so
the user talks to their Grok Bot by voice. JARVIS is the mouth and ears (wake
word, Groq hearing, Fish Audio voice, HUD); the Grok Bot desktop app is the
brain. No Claude turn in between unless `JARVIS_BRAIN=claude`.

Read `README.md` first. `docs/UPSTREAM-README.md` documents the original
Claude-brain mode.

## Layout

- `bridge/server.mjs` — the bridge. In Grok Bot mode each `ask` frame from the
  face goes to `runGrokTurn()`; the reply comes back as the same `text` /
  `done` frames a Claude turn produces. Late replies go out as `announce`
  frames. `/stt` is hearing (Groq → ElevenLabs), `/tts` is voice (Fish →
  ElevenLabs), `/health` says which engines are live.
- `bridge/grokbot.mjs` — drives the Grok Bot window over Chrome DevTools
  Protocol. Reads only accessibility labels (`[aria-label="Bot list"]`,
  `[role="textbox"][aria-label="Prompt"]`, `[aria-label="<Bot> message"]`,
  `[role="status"]`), never generated class names. Polls from the bridge every
  300 ms; never install a timer in the page (throttled to once per 30–45 s when
  the window is hidden). The same poll reads the sidebar (`SIDEBAR`: each
  bot's name plus its ", Working" / ", Unread activity" label, which can stack)
  and emits `bots`; the bridge forwards it to the face as a `bots` frame with
  the active bot marked, which is what the BOTS rail draws. A bot marked
  "working" while another is being spoken to is a delegation in progress.
- `bridge/speakable.mjs` — markdown → speech text.
- `scripts/start.mjs` — opens Grok Bot with `--remote-debugging-port`, then the
  bridge and the Vite face.
- `src/` — the face. Untouched apart from the `announce` frame (`App.tsx`,
  `lib/bridge.ts`, `lib/brain.ts`) and the capability flags.
- `scripts/grokbot-proof.mjs`, `scripts/grokbot-e2e.mjs` — manual checks:
  type into the window; play the part of the face over the socket.

## Things measured, don't re-learn them

- Grok Bot's "is working" light stays on ~30 s after a one-word reply. Turns
  close on quiet, not on that light.
- A `prompt` hint to Whisper ("Jarvis.") made every click transcribe as
  "Jarvis.". No prompt.
- Whisper on pure noise returns "you", "Bye.", "." at `avg_logprob` ≤ -0.78;
  clear speech scores about -0.15. Hence `GROQ_MIN_LOGPROB=-0.7`.
- Sidebar bot buttons carry a status suffix (", Working", ", Unread
  activity") that must be stripped before matching names.
- Delegated answers arrive as later bubbles in the same chat, sometimes 20 s
  after the bot went idle. The reader is per-connection and always on.

## Rules

- Keys live only in `.env.local` (gitignored). Never commit one, never print one.
- Don't launch Grok Bot with the debug port from an autonomous agent session;
  hand that to the user (`npm start`).
- Verify changes end to end: `npm run build`, `npx oxlint`, then
  `node scripts/grokbot-e2e.mjs "Reply with just the word test."` against a
  running bridge.
