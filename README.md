# Grok Bot Voice

Talk to your Grok Bot out loud.

Say **"Jarvis, what's on today"** and the words are typed into the open chat in
the Grok Bot desktop app. When your bot answers, JARVIS reads the reply back in
his own voice and shows it on a holographic heads-up display. No Claude in the
middle: JARVIS is the mouth and ears, your Grok Bot is the brain, so everything
your bot can do (its memory, its skills, the bots it delegates to) works exactly
as it does when you type.

Built on [J.A.R.V.I.S. by Aditya Dewaskar](https://github.com/adewaskar/jarvis)
(the face, the wake word, the interface), rewired to drive Grok Bot instead of
Claude. The original Claude brain is still there behind a flag.

> Grok Bot has no API and no voice mode. This works by launching Grok Bot with a
> local control port and driving its window the way a browser extension drives a
> tab. The port only listens on your own machine.

---

## What you need

- **macOS** (the launcher opens Grok Bot for you; Windows and Linux work if you
  open Grok Bot with the control port yourself, see below).
- **Grok Bot** installed and signed in, on a plan that includes it.
- **Node.js 20 or newer** from <https://nodejs.org>.
- **Google Chrome** (or Edge), in a real window, for the microphone.
- **Two free keys**, both optional but strongly recommended:
  - **Fish Audio** for the voice: <https://fish.audio> → Developers → API keys.
    The default voice is Fish's public "Jarvis (MCU)" library voice, and the
    `s2.1-pro-free` model costs nothing.
  - **Groq** for the ears: <https://console.groq.com> → API keys. Free, about a
    quarter of a second per sentence, 8 hours of audio a day.

Without keys JARVIS still runs on the browser's own voice and hearing. An
ElevenLabs key also works for either job and is used as the fallback.

## Install

```bash
git clone https://github.com/learnaiwithhugo/grok-bot-voice.git
cd grok-bot-voice
npm install
cp .env.example .env.local
```

Open `.env.local` and paste your keys:

```
FISH_API_KEY=...
GROQ_API_KEY=...
```

Then check the machine:

```bash
npm run setup
```

## Run

```bash
npm start
```

That opens Grok Bot with its control port (quitting and reopening it if it was
already open the normal way), then starts the bridge and the interface. Open
<http://localhost:5173> in Chrome, click **INITIALISE**, and say **"Jarvis,
…"**. Ctrl-C stops everything except Grok Bot.

Open the bot you want to talk to in Grok Bot first. JARVIS talks to whichever
chat is open, or set `GROKBOT_BOT=Chief of Staff` in `.env.local` to pin one.
`npm run setup` offers to do that for you: with Grok Bot open it lists your
bots and asks which one is the main one (Enter keeps "whichever chat is open").

## Using it

- **Talk normally.** Everything after "Jarvis" goes to the bot as typed text.
  The reply is read out word for word, with markdown, links and code stripped
  for speech, and shown in full on the display.
- **Interrupt him** by talking over him.
- **"Jarvis, switch to Researcher"** / "talk to Delivery" / "open Scout" changes
  bot (any name in your sidebar). **"Jarvis, which bot"** tells you who you're
  talking to.
- **Long jobs and delegation.** The turn closes two seconds after the last
  thing the bot said ("Inbox is on it"), and anything the bot posts later,
  including answers relayed from other bots, is read out on its own when it
  lands. If nothing has come back after 15 s JARVIS says "still on it"; at 60 s
  he says he'll tell you when it lands.
- **Your bots on the left.** The BOTS rail lists every bot in your Grok Bot
  sidebar. The one JARVIS is talking to is bright; when it hands a job to
  another bot, that bot pulses with a "working" tag until it answers, then
  shows "replied" until you open its chat. It's read straight off Grok Bot's
  own sidebar, so it's only ever as current as the app.
- **Clap** to wake him instead of clicking, if the tab is open.

## Settings

All in `.env.local`. Only the keys are normally needed.

| Setting | Default | What it does |
| --- | --- | --- |
| `FISH_API_KEY` | | Voice. Free `s2.1-pro-free` model. |
| `FISH_VOICE_ID` | Jarvis (MCU) | Any voice id from fish.audio's library. |
| `FISH_MODEL` | `s2.1-pro-free` | Fish model; paid models need API credit. |
| `GROQ_API_KEY` | | Ears. Free Whisper transcription. |
| `GROQ_STT_MODEL` | `whisper-large-v3-turbo` | |
| `GROQ_STT_LANGUAGE` | `en` | |
| `GROQ_MIN_LOGPROB` | `-0.7` | Transcripts less confident than this are treated as noise. |
| `ELEVENLABS_API_KEY` | | Optional fallback for both voice and ears. |
| `GROKBOT_BOT` | open chat | Pin a bot by name (`npm run setup` can set it). |
| `GROKBOT_PORT` | `9333` | Grok Bot's control port (localhost only). |
| `JARVIS_BRAIN` | `grokbot` | `claude` runs the original Claude brain. |
| `GROKBOT_QUIET_MS` | `2000` | Close the turn this long after the last bubble. |
| `GROKBOT_STILL_ON_MS` | `15000` | When to say "still on it". |
| `GROKBOT_HAND_OFF_MS` | `60000` | When to stop holding the turn open. |

## Windows and Linux

The launcher's "open Grok Bot with the port" step is macOS-only. Open Grok Bot
yourself with the flag, then run `npm start` as normal:

```
Windows:  start "" "Grok Bot.exe" --remote-debugging-port=9333
Linux:    grok-bot --remote-debugging-port=9333
```

## How it works

- `scripts/start.mjs` opens Grok Bot as `open -a "Grok Bot" --args --remote-debugging-port=9333`.
- `bridge/grokbot.mjs` connects to that port over Chrome's DevTools protocol,
  reads the bot list from the sidebar, types into the chat box, presses Enter,
  and polls the transcript every 300 ms for new bubbles and the "is working"
  status. It reads the app's accessibility labels, not its styling, so it
  survives Grok Bot's frequent redesigns better than it otherwise would.
- `bridge/server.mjs` turns each spoken sentence into a Grok Bot turn and
  streams the reply back to the interface as the same frames a Claude answer
  would use, so the face, the voice and interruption all work unchanged.
- Hearing: the browser detects that you're speaking and posts the audio to the
  bridge, which sends it to Groq (then ElevenLabs, then nothing). Noise is
  filtered on the bridge: audio-event labels are stripped, low-confidence
  output and Whisper's known noise-words ("you", "Bye.") are dropped.
- Speaking: the interface asks the bridge for audio a sentence at a time; the
  bridge generates it with Fish Audio (then ElevenLabs, then the browser).

## Troubleshooting

- **"Grok Bot isn't open with its control port, sir."** Grok Bot was opened
  from the Dock. Quit it and run `npm start` again, or open it with the flag.
- **The interface hears nothing.** Chrome must be a real window, not a preview
  pane, and the microphone must be allowed. `npm run setup` reports the keys.
- **Replies are read but the turn feels slow to close.** Lower
  `GROKBOT_QUIET_MS`.
- **JARVIS hears "Jarvis" when you click or a notification pings.** Shouldn't
  happen with Groq or ElevenLabs. If it does, raise `GROQ_MIN_LOGPROB` towards
  `-0.5`.
- **Startup banner says "grok bot window NOT reachable".** Grok Bot isn't
  running with the port, or isn't signed in.

## Claude mode

`npm start -- --claude` (or `npm run start:claude`) runs the original J.A.R.V.I.S.
with Claude Code as the brain. See `docs/UPSTREAM-README.md` for everything
that mode can do.

## Credits and license

The interface, wake word, voice pipeline and Claude bridge are
[adewaskar/jarvis](https://github.com/adewaskar/jarvis), MIT licensed. The Grok
Bot driver, the hearing and voice changes and this README are additions by
[Hugo Manning](https://learnaiwithhugo.com), also MIT. Grok Bot is xAI's product;
this project isn't affiliated with xAI, Fish Audio, Groq or ElevenLabs.
