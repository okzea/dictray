export const STT_PROMPT_TEMPLATE_OFF = 'off'
export const STT_PROMPT_TEMPLATE_CODER_WEB = 'coder-web'

const DEFAULT_STT_PROMPT_TEMPLATE = STT_PROMPT_TEMPLATE_CODER_WEB

const BUILTIN_STT_PROMPT_TEMPLATES = [
  {
    id: STT_PROMPT_TEMPLATE_OFF,
    label: 'General',
    menuLabel: 'General - no extra vocabulary biasing',
    prompt: ''
  },
  {
    id: STT_PROMPT_TEMPLATE_CODER_WEB,
    label: 'Coder / Web Dev',
    menuLabel: 'Coder / Web Dev - bias toward software and web vocabulary',
    prompt: [
      'The speaker mainly dictates software engineering content related to web applications and development.',
      'Prefer accurate technical vocabulary, punctuation, and casing for common terms such as JavaScript, TypeScript, React, Next.js, Node.js, Express, HTML, CSS, Tailwind, API, JSON, SQL, Postgres, SQLite, Redis, Git, GitHub, Docker, Kubernetes, OAuth, frontend, backend, full stack, endpoint, schema, query, async, props, state, repo, CLI, npm, pnpm, yarn, build, deploy, auth, websocket, and pull request.'
    ].join(' ')
  }
]

function templateById(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return BUILTIN_STT_PROMPT_TEMPLATES.find((template) => template.id === normalized) || null
}

export function defaultSttPromptTemplate() {
  return DEFAULT_STT_PROMPT_TEMPLATE
}

export function normalizeSttPromptTemplate(value, fallback = '') {
  const match = templateById(value)
  if (match) {
    return match.id
  }
  const normalizedFallback = String(fallback || '').trim().toLowerCase()
  return templateById(normalizedFallback)?.id || ''
}

export function sttPromptTemplateOptions() {
  return BUILTIN_STT_PROMPT_TEMPLATES.map((template) => template.id)
}

export function sttPromptTemplateLabel(value) {
  return templateById(value)?.label || 'General'
}

export function sttPromptTemplateMenuLabel(value) {
  return templateById(value)?.menuLabel || 'General - no extra vocabulary biasing'
}

export function sttPromptTextForTemplate(value) {
  return templateById(value)?.prompt || ''
}
