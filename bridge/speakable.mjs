/**
 * Turning a chat bubble into something worth hearing.
 *
 * Bots write for a screen: bold, headings, bullet lists, links, code. Read
 * aloud verbatim that is "asterisk asterisk" and forty-character URLs. This
 * keeps every word the bot wrote and drops only the typography, so what JARVIS
 * says is the bot's answer, not a summary of it. The raw text still goes to the
 * HUD untouched.
 */
export function speakable(text) {
  let s = String(text ?? '')
  // Fenced code: keep the words, lose the fence.
  s = s.replace(/```[a-z]*\n?([\s\S]*?)```/g, ' $1 ')
  // Inline code.
  s = s.replace(/`([^`]*)`/g, '$1')
  // Markdown links [label](url) -> label. Bare URLs -> "link".
  s = s.replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
  s = s.replace(/https?:\/\/\S+/gi, 'link')
  // Emphasis and headings.
  s = s.replace(/(\*\*|__)(.*?)\1/g, '$2')
  s = s.replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
  s = s.replace(/^#{1,6}\s+/gm, '')
  // List markers and table pipes.
  s = s.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, '')
  s = s.replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
  s = s.replace(/\|/g, ', ')
  // Every line the bot wrote ends a thought; give the sentence splitter a stop
  // so bullets are not run together into one breathless line.
  s = s
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?:;]$/.test(line) ? line : `${line}.`))
    .join(' ')
  return s.replace(/\s+/g, ' ').trim()
}
