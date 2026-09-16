import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Claude Code and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also has an ElevenLabs key (in their Claude Code config or a .env) gets Scribe
 * transcription and the ElevenLabs voice instead, automatically, with no flag to
 * set. This module is how the rest of the app learns which of those two worlds
 * it is in, so voice.ts and tts.ts never have to guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

export type Capabilities = {
  /** A cloud speech-to-text engine is reachable via the bridge. */
  stt: boolean
  /** Which one hears, when `stt` is true. */
  ears: 'groq' | 'elevenlabs' | null
  /** A cloud text-to-speech voice is reachable via the bridge. */
  tts: boolean
  /** Which one the bridge will speak with, when `tts` is true. */
  voice: 'fish' | 'elevenlabs' | null
  /** Who answers: Claude through the Agent SDK, or a Grok Bot driven over its
   *  window. In Grok Bot mode there is no Claude turn at all. */
  brain: 'claude' | 'grokbot'
  /** The bot being spoken to, in Grok Bot mode. */
  bot: string | null
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = { stt: false, tts: false, voice: null, ears: null, brain: 'claude', bot: null }
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey Jarvis" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = { stt: false, tts: false, voice: null, ears: null, brain: 'claude', bot: null }
    probed = true
    return current
  }
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const h = (await res.json()) as {
        stt?: boolean
        tts?: boolean
        voice?: 'fish' | 'elevenlabs' | null
        ears?: 'groq' | 'elevenlabs' | null
        brain?: 'claude' | 'grokbot'
        bot?: string | null
      }
      current = {
        stt: Boolean(h.stt),
        tts: Boolean(h.tts),
        voice: h.tts ? (h.voice ?? 'elevenlabs') : null,
        ears: h.stt ? (h.ears ?? 'elevenlabs') : null,
        brain: h.brain === 'grokbot' ? 'grokbot' : 'claude',
        bot: h.brain === 'grokbot' ? (h.bot ?? null) : null,
      }
    }
  } catch {
    // Bridge down or slow — stay on the browser engines rather than blocking
    // boot on a health check that is only an optimisation.
  }
  probed = true
  return current
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  const voice = c.voice === 'fish' ? 'Fish Audio' : 'ElevenLabs'
  const brain = c.brain === 'grokbot' && c.bot ? `${c.bot} · ` : ''
  const ears = c.ears === 'groq' ? 'Groq ears' : 'Scribe ears'
  if (c.stt && c.tts) return `${brain}${voice} voice · ${ears}`
  if (c.tts) return `${brain}${voice} voice`
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'browser speech'
}
