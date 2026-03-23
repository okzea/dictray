const FALLBACK_HOTKEY_PRESETS = [
  { value: 'CommandOrControl+Space', label: 'Ctrl+Space' },
  { value: 'Alt+Space', label: 'Alt+Space' },
  { value: 'CommandOrControl+Alt+F12', label: 'Ctrl+Alt+F12' },
  { value: 'CommandOrControl+Alt+F13', label: 'Ctrl+Alt+F13' },
  { value: 'CommandOrControl+Alt+O', label: 'Ctrl+Alt+O' }
]

const STEP_DEFS = [
  {
    title: 'Welcome to DicTray.',
    subtitle: 'A few quick questions and you are ready to talk instead of type.'
  },
  {
    title: "What's your name?",
    subtitle: 'DicTray will use it in the tray greeting and in your daily savings line.'
  },
  {
    title: 'Show me your typing pace.',
    subtitle: 'Type one sentence once so DicTray can estimate your saved typing time each day.'
  },
  {
    title: 'Do you want improved text?',
    subtitle: 'This is optional. Built-in speech to text works on its own.'
  },
  {
    title: 'How much effort should speech to text use?',
    subtitle: 'You can favor speed or spend a bit more time for higher quality.'
  },
  {
    title: 'Choose your push-to-talk shortcut.',
    subtitle: 'Hold this shortcut when you want DicTray to listen.'
  },
  {
    title: 'You are ready.',
    subtitle: 'Review the setup and finish Quick Start.'
  }
]

const state = {
  step: 0,
  sampleText: '',
  existingBenchmark: null,
  runtime: null,
  profile: {
    name: ''
  },
  choices: {
    rewriteCleanup: false,
    speechEffort: 'mid',
    pushToTalkHotkey: ''
  },
  benchmarkStartedAt: 0,
  benchmarkElapsedMs: 0,
  saving: false
}

const elements = {
  progress: document.getElementById('progress'),
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  runtime: document.getElementById('runtime'),
  steps: Array.from(document.querySelectorAll('[data-step]')),
  profileName: document.getElementById('profile-name'),
  nameHint: document.getElementById('name-hint'),
  sampleText: document.getElementById('sample-text'),
  benchmarkSummary: document.getElementById('benchmark-summary'),
  typingInput: document.getElementById('typing-input'),
  typingHint: document.getElementById('typing-hint'),
  rewriteInputs: Array.from(document.querySelectorAll('input[name="rewrite-choice"]')),
  effortInputs: Array.from(document.querySelectorAll('input[name="speech-effort"]')),
  shortcutManagedNote: document.getElementById('shortcut-managed-note'),
  shortcutOptions: document.getElementById('shortcut-options'),
  shortcutHint: document.getElementById('shortcut-hint'),
  finishSummary: document.getElementById('finish-summary'),
  backButton: document.getElementById('back-button'),
  nextButton: document.getElementById('next-button'),
  finishButton: document.getElementById('finish-button'),
  closeButtons: Array.from(document.querySelectorAll('[data-close]'))
}

function normalizeTypedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
}

function normalizeProfileName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

function normalizeSpeechEffort(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case 'low':
    case 'fast':
    case 'faster':
      return 'low'
    case 'high':
    case 'quality':
      return 'high'
    case 'mid':
    case 'middle':
    case 'medium':
    case 'balanced':
      return 'mid'
    default:
      return ''
  }
}

function speechEffortLabel(value) {
  switch (normalizeSpeechEffort(value)) {
    case 'low':
      return 'Low (Faster)'
    case 'high':
      return 'High (Quality)'
    case 'mid':
    default:
      return 'Mid (Balanced)'
  }
}

function hotkeyPresets() {
  const presets = Array.isArray(state.runtime?.hotkeyPresets) && state.runtime.hotkeyPresets.length
    ? state.runtime.hotkeyPresets
    : FALLBACK_HOTKEY_PRESETS
  return presets
    .map((preset) => ({
      value: String(preset?.value || '').trim(),
      label: String(preset?.label || preset?.value || '').trim()
    }))
    .filter((preset) => preset.value && preset.label)
}

function normalizeHotkey(value) {
  const presets = hotkeyPresets()
  const normalized = String(value || '').trim()
  return presets.some((preset) => preset.value === normalized)
    ? normalized
    : presets[0]?.value || ''
}

function hotkeyLabel(value) {
  const preset = hotkeyPresets().find((item) => item.value === value)
  return preset?.label || value || 'Unknown'
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function benchmarkStats(elapsedMs) {
  const elapsed = Math.max(0, Math.floor(Number(elapsedMs || 0) || 0))
  const characters = Array.from(state.sampleText).length
  const words = state.sampleText.trim().split(/\s+/).filter(Boolean).length
  return {
    charactersPerMinute: elapsed > 0 ? Math.max(0, Math.round((characters / elapsed) * 60000)) : 0,
    wordsPerMinute: elapsed > 0 ? Math.max(0, Number(((words / elapsed) * 60000).toFixed(1)) || 0) : 0
  }
}

function updateChoiceCardState() {
  Array.from(document.querySelectorAll('.option-card')).forEach((card) => {
    const input = card.querySelector('input')
    card.dataset.selected = input?.checked ? 'true' : 'false'
  })
}

function renderRuntimeSummary() {
  const provider = String(state.runtime?.rewriteProvider || '').trim()
  const textImprovementSummary = provider && provider.toLowerCase() !== 'none'
    ? `Text improvement can use ${provider}.`
    : 'Text improvement stays optional.'
  elements.runtime.textContent = `Built-in speech to text is the default. ${textImprovementSummary}`
}

function renderHeader() {
  const step = STEP_DEFS[state.step] || STEP_DEFS[0]
  elements.progress.textContent = `Step ${state.step + 1} of ${STEP_DEFS.length}`
  elements.title.textContent = step.title
  elements.subtitle.textContent = step.subtitle
}

function syncProfileState() {
  state.profile = {
    name: normalizeProfileName(elements.profileName.value)
  }
}

function syncChoiceState() {
  const rewriteValue = elements.rewriteInputs.find((input) => input.checked)?.value || 'no'
  const speechEffort = normalizeSpeechEffort(elements.effortInputs.find((input) => input.checked)?.value || state.choices.speechEffort || 'mid') || 'mid'
  const shortcutInput = elements.shortcutOptions.querySelector('input[name="push-to-talk-hotkey"]:checked')

  state.choices = {
    rewriteCleanup: rewriteValue === 'yes',
    speechEffort,
    pushToTalkHotkey: state.runtime?.hotkeyManagedByEnv
      ? normalizeHotkey(state.runtime?.hotkey)
      : normalizeHotkey(shortcutInput?.value || state.choices.pushToTalkHotkey)
  }
}

function renderNameHint() {
  const name = normalizeProfileName(elements.profileName.value)
  if (!name) {
    elements.nameHint.textContent = 'This is what DicTray will use when it says hi and shows your time saved.'
    elements.nameHint.dataset.state = 'idle'
    return
  }

  elements.nameHint.textContent = `Perfect. The tray will say "Hi, ${name}".`
  elements.nameHint.dataset.state = 'ready'
}

function renderBenchmarkSummary() {
  const typedMatches = normalizeTypedText(elements.typingInput.value) === normalizeTypedText(state.sampleText)
  const elapsedMs = typedMatches && state.benchmarkElapsedMs
    ? state.benchmarkElapsedMs
    : state.existingBenchmark?.elapsedMs || 0

  if (!elapsedMs) {
    elements.benchmarkSummary.textContent = 'When you finish the sentence, DicTray will show your timing and average typing speed.'
    elements.benchmarkSummary.dataset.state = 'idle'
    return
  }

  const stats = benchmarkStats(elapsedMs)
  elements.benchmarkSummary.textContent = `Current timing: ${formatDuration(elapsedMs)} at ${stats.charactersPerMinute} ch/min and ${stats.wordsPerMinute} words/min.`
  elements.benchmarkSummary.dataset.state = typedMatches ? 'ready' : 'idle'
}

function updateTypingProgress() {
  const typed = elements.typingInput.value
  const normalizedTyped = normalizeTypedText(typed)
  const normalizedSample = normalizeTypedText(state.sampleText)

  if (typed.trim() && !state.benchmarkStartedAt) {
    state.benchmarkStartedAt = performance.now()
  }

  if (normalizedTyped && normalizedTyped === normalizedSample && state.benchmarkStartedAt) {
    state.benchmarkElapsedMs = Math.max(1, Math.round(performance.now() - state.benchmarkStartedAt))
  } else if (!typed.trim()) {
    state.benchmarkStartedAt = 0
    state.benchmarkElapsedMs = state.existingBenchmark?.elapsedMs || 0
  } else {
    state.benchmarkElapsedMs = 0
  }

  const progressCount = Array.from(typed).length
  const targetCount = Array.from(state.sampleText).length
  if (normalizedTyped === normalizedSample && state.benchmarkElapsedMs > 0) {
    const stats = benchmarkStats(state.benchmarkElapsedMs)
    elements.typingHint.textContent = `Captured in ${formatDuration(state.benchmarkElapsedMs)} at ${stats.charactersPerMinute} ch/min.`
    elements.typingHint.dataset.state = 'ready'
  } else if (!typed.trim() && state.existingBenchmark?.elapsedMs) {
    elements.typingHint.textContent = 'Retype the sentence exactly if you want to replace your current typing baseline.'
    elements.typingHint.dataset.state = 'idle'
  } else {
    elements.typingHint.textContent = `${progressCount}/${targetCount} characters. Match the sentence exactly.`
    elements.typingHint.dataset.state = progressCount > 0 ? 'progress' : 'idle'
  }

  renderBenchmarkSummary()
  renderStep()
}

function renderShortcutOptions() {
  const presets = hotkeyPresets()
  elements.shortcutOptions.replaceChildren()

  if (state.runtime?.hotkeyManagedByEnv) {
    elements.shortcutManagedNote.hidden = false
    elements.shortcutManagedNote.textContent = `This shortcut is managed outside the app right now: ${hotkeyLabel(state.runtime?.hotkey)}.`
    elements.shortcutHint.textContent = 'You can finish Quick Start, but the environment setting will keep control of the shortcut.'
    elements.shortcutHint.dataset.state = 'idle'
    return
  }

  elements.shortcutManagedNote.hidden = true
  presets.forEach((preset) => {
    const label = document.createElement('label')
    label.className = 'option-card'
    label.dataset.choiceCard = 'shortcut'

    const input = document.createElement('input')
    input.type = 'radio'
    input.name = 'push-to-talk-hotkey'
    input.value = preset.value
    input.checked = state.choices.pushToTalkHotkey === preset.value
    input.addEventListener('change', () => {
      syncChoiceState()
      renderShortcutHint()
      updateChoiceCardState()
      renderStep()
    })

    const copy = document.createElement('div')
    const title = document.createElement('strong')
    title.textContent = preset.label
    const detail = document.createElement('span')
    detail.textContent = 'Hold this to talk.'
    copy.append(title, detail)
    label.append(input, copy)
    elements.shortcutOptions.append(label)
  })

  renderShortcutHint()
  updateChoiceCardState()
}

function renderShortcutHint() {
  if (state.runtime?.hotkeyManagedByEnv) {
    return
  }

  if (!state.choices.pushToTalkHotkey) {
    elements.shortcutHint.textContent = 'Pick a shortcut before moving on.'
    elements.shortcutHint.dataset.state = 'error'
    return
  }

  elements.shortcutHint.textContent = `DicTray will listen when you hold ${hotkeyLabel(state.choices.pushToTalkHotkey)}.`
  elements.shortcutHint.dataset.state = 'ready'
}

function renderFinishSummary() {
  const stats = benchmarkStats(state.benchmarkElapsedMs || state.existingBenchmark?.elapsedMs || 0)
  const items = [
    ['Name', state.profile.name || 'Not set'],
    ['Typing baseline', state.benchmarkElapsedMs ? `${formatDuration(state.benchmarkElapsedMs)} at ${stats.charactersPerMinute} ch/min` : 'Not captured yet'],
    ['Improved text', state.choices.rewriteCleanup ? 'Yes' : 'No'],
    ['Speech effort', speechEffortLabel(state.choices.speechEffort)],
    ['Push to talk', state.runtime?.hotkeyManagedByEnv ? `${hotkeyLabel(state.runtime?.hotkey)} (managed outside the app)` : hotkeyLabel(state.choices.pushToTalkHotkey)]
  ]

  elements.finishSummary.replaceChildren()
  for (const [label, value] of items) {
    const row = document.createElement('div')
    row.className = 'summary-item'
    const title = document.createElement('strong')
    title.textContent = `${label}: `
    row.append(title, document.createTextNode(value))
    elements.finishSummary.append(row)
  }
}

function canAdvanceStep() {
  switch (state.step) {
    case 0:
      return true
    case 1:
      return Boolean(state.profile.name)
    case 2:
      return Boolean(state.benchmarkElapsedMs)
    case 3:
      return true
    case 4:
      return Boolean(state.choices.speechEffort)
    case 5:
      return state.runtime?.hotkeyManagedByEnv ? true : Boolean(state.choices.pushToTalkHotkey)
    default:
      return false
  }
}

function focusCurrentStep() {
  if (state.step === 1) {
    elements.profileName.focus()
    return
  }
  if (state.step === 2) {
    elements.typingInput.focus()
  }
}

function renderStep() {
  renderHeader()
  elements.steps.forEach((stepElement, index) => {
    stepElement.hidden = index !== state.step
  })

  renderNameHint()
  renderBenchmarkSummary()
  renderFinishSummary()
  updateChoiceCardState()

  elements.backButton.hidden = state.step === 0
  elements.nextButton.hidden = state.step === STEP_DEFS.length - 1
  elements.finishButton.hidden = state.step !== STEP_DEFS.length - 1

  elements.nextButton.textContent = state.step === 0 ? 'Get Started' : 'Next'
  elements.nextButton.disabled = !canAdvanceStep()
  elements.finishButton.disabled = state.saving || !state.profile.name || !state.benchmarkElapsedMs
  elements.finishButton.textContent = state.saving ? 'Saving...' : 'Finish Quick Start'
}

async function loadState() {
  const payload = await window.dictrayOnboarding.getState()
  state.sampleText = String(payload?.sampleText || '')
  state.runtime = payload?.runtime || {}
  state.profile = {
    name: normalizeProfileName(payload?.state?.profile?.name)
  }
  state.choices = {
    rewriteCleanup: Boolean(payload?.state?.choices?.rewriteCleanup ?? false),
    speechEffort: normalizeSpeechEffort(payload?.state?.choices?.speechEffort || payload?.runtime?.speechEffort || 'mid') || 'mid',
    pushToTalkHotkey: normalizeHotkey(payload?.state?.choices?.pushToTalkHotkey || payload?.runtime?.hotkey)
  }
  state.existingBenchmark = payload?.state?.typingBenchmark?.elapsedMs ? payload.state.typingBenchmark : null
  state.benchmarkElapsedMs = state.existingBenchmark?.elapsedMs || 0

  elements.profileName.value = state.profile.name
  elements.sampleText.textContent = state.sampleText
  const rewriteTarget = state.choices.rewriteCleanup ? 'yes' : 'no'
  elements.rewriteInputs.forEach((input) => {
    input.checked = input.value === rewriteTarget
  })
  elements.effortInputs.forEach((input) => {
    input.checked = input.value === state.choices.speechEffort
  })

  renderRuntimeSummary()
  renderShortcutOptions()
  renderShortcutHint()
  updateTypingProgress()
  renderStep()
}

async function finishOnboarding() {
  syncProfileState()
  syncChoiceState()
  if (!state.profile.name || !state.benchmarkElapsedMs || state.saving) {
    return
  }

  state.saving = true
  renderStep()
  try {
    await window.dictrayOnboarding.complete({
      profile: state.profile,
      choices: state.choices,
      typingBenchmark: {
        elapsedMs: state.benchmarkElapsedMs
      }
    })
  } catch (error) {
    state.saving = false
    elements.typingHint.textContent = String(error?.message || error)
    elements.typingHint.dataset.state = 'error'
    renderStep()
  }
}

elements.profileName.addEventListener('input', () => {
  syncProfileState()
  renderNameHint()
  renderStep()
})

elements.profileName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && state.step === 1 && canAdvanceStep()) {
    event.preventDefault()
    state.step += 1
    renderStep()
    focusCurrentStep()
  }
})

elements.typingInput.addEventListener('input', () => {
  updateTypingProgress()
})

elements.rewriteInputs.forEach((input) => {
  input.addEventListener('change', () => {
    syncChoiceState()
    updateChoiceCardState()
    renderStep()
  })
})

elements.effortInputs.forEach((input) => {
  input.addEventListener('change', () => {
    syncChoiceState()
    updateChoiceCardState()
    renderStep()
  })
})

elements.backButton.addEventListener('click', () => {
  state.step = Math.max(0, state.step - 1)
  renderStep()
  focusCurrentStep()
})

elements.nextButton.addEventListener('click', () => {
  syncProfileState()
  syncChoiceState()
  if (!canAdvanceStep()) {
    if (state.step === 1) {
      elements.nameHint.textContent = 'Add your name before continuing.'
      elements.nameHint.dataset.state = 'error'
    } else if (state.step === 2) {
      elements.typingHint.textContent = 'Type the sentence exactly once before continuing.'
      elements.typingHint.dataset.state = 'error'
    } else if (state.step === 5) {
      elements.shortcutHint.textContent = 'Pick a shortcut before continuing.'
      elements.shortcutHint.dataset.state = 'error'
    }
    renderStep()
    return
  }

  state.step = Math.min(STEP_DEFS.length - 1, state.step + 1)
  renderStep()
  focusCurrentStep()
})

elements.finishButton.addEventListener('click', () => {
  finishOnboarding().catch(() => {})
})

elements.closeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    window.dictrayOnboarding.close()
  })
})

loadState().catch((error) => {
  elements.runtime.textContent = String(error?.message || error)
})
