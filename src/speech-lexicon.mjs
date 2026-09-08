function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function phrasePattern(phrase) {
  const parts = String(phrase || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => escapeRegex(part))
  if (!parts.length) {
    return null
  }
  return new RegExp(`(?<!\\w)${parts.join('\\s+')}(?!\\w)`, 'gi')
}

const DEFAULT_TRANSCRIPT_LEXICON = [
  ['codecs', 'codex'],
  ['codec', 'codex'],
  ['olama', 'ollama'],
  ['allama', 'ollama'],
  ['oxy', 'okzea'],
  ['o x y', 'okzea'],
  ['oxe', 'okzea'],
  ['o x e', 'okzea']
]

const TRANSCRIPT_LEXICON = DEFAULT_TRANSCRIPT_LEXICON
  .map(([from, to]) => ({
    from,
    to: String(to || '').trim(),
    pattern: phrasePattern(from)
  }))
  .filter((entry) => entry.pattern && entry.to)

export function normalizeSpeechTranscript(value) {
  let text = String(value || '').trim()
  if (!text) {
    return ''
  }

  for (const entry of TRANSCRIPT_LEXICON) {
    text = text.replace(entry.pattern, entry.to)
  }

  return text.replace(/\s+/g, ' ').trim()
}

export function listSpeechLexiconEntries() {
  return TRANSCRIPT_LEXICON.map((entry) => ({
    from: entry.from,
    to: entry.to
  }))
}
