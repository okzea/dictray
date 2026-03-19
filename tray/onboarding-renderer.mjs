const state = {
  step: 0,
  sampleText: '',
  existingBenchmark: null,
  runtime: null,
  profile: {
    name: ''
  },
  choices: {
    localStt: true,
    externalProviders: false,
    rewriteCleanup: true
  },
  benchmarkStartedAt: 0,
  benchmarkElapsedMs: 0,
  saving: false
}

const elements = {
  title: document.getElementById('title'),
  subtitle: document.getElementById('subtitle'),
  runtime: document.getElementById('runtime'),
  steps: Array.from(document.querySelectorAll('[data-step]')),
  setupForm: document.getElementById('setup-form'),
  profileName: document.getElementById('profile-name'),
  nameHint: document.getElementById('name-hint'),
  localStt: document.getElementById('localStt'),
  externalProviders: document.getElementById('externalProviders'),
  rewriteCleanup: document.getElementById('rewriteCleanup'),
  sampleText: document.getElementById('sample-text'),
  typingInput: document.getElementById('typing-input'),
  typingHint: document.getElementById('typing-hint'),
  benchmarkSummary: document.getElementById('benchmark-summary'),
  backButton: document.getElementById('back-button'),
  nextButton: document.getElementById('next-button'),
  finishButton: document.getElementById('finish-button'),
  closeButtons: Array.from(document.querySelectorAll('[data-close]'))
}

function normalizeTypedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase()
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

function renderRuntimeSummary() {
  const runtime = state.runtime || {}
  elements.runtime.textContent = [
    runtime.sttProvider ? `STT: ${runtime.sttProvider}` : '',
    runtime.rewriteProvider ? `Rewrite: ${runtime.rewriteProvider}` : '',
    runtime.rewriteEnabled === false ? 'Cleanup off' : ''
  ].filter(Boolean).join(' | ') || 'Backends can be swapped later.'
}

function normalizeProfileName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

function syncProfileState() {
  state.profile = {
    name: normalizeProfileName(elements.profileName.value)
  }
}

function syncChoiceState() {
  state.choices = {
    localStt: Boolean(elements.localStt.checked),
    externalProviders: Boolean(elements.externalProviders.checked),
    rewriteCleanup: Boolean(elements.rewriteCleanup.checked)
  }
}

function renderNameHint() {
  const name = normalizeProfileName(elements.profileName.value)
  if (!name) {
    elements.nameHint.textContent = 'Add your name so the tray can greet you and personalize the daily savings line.'
    elements.nameHint.dataset.state = 'idle'
    return
  }
  elements.nameHint.textContent = `The tray will say "Hi, ${name}" and show your daily time savings.`
  elements.nameHint.dataset.state = 'ready'
}

function renderBenchmarkSummary() {
  const benchmark = state.existingBenchmark
  if (!benchmark?.elapsedMs) {
    elements.benchmarkSummary.textContent = 'Your typing baseline will be used to estimate time saved in the daily tray stats.'
    return
  }
  elements.benchmarkSummary.textContent = `Current baseline: ${benchmark.charactersPerMinute} cpm / ${benchmark.wordsPerMinute} wpm in ${formatDuration(benchmark.elapsedMs)}. Retake it below any time.`
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
  } else if (state.existingBenchmark?.elapsedMs) {
    state.benchmarkElapsedMs = 0
  }

  const progressCount = Array.from(typed).length
  const targetCount = Array.from(state.sampleText).length
  if (normalizeTypedText(typed) === normalizedSample && state.benchmarkElapsedMs > 0) {
    elements.typingHint.textContent = `Baseline captured in ${formatDuration(state.benchmarkElapsedMs)}.`
    elements.typingHint.dataset.state = 'ready'
  } else {
    elements.typingHint.textContent = `${progressCount}/${targetCount} characters. Match the phrase exactly to finish.`
    elements.typingHint.dataset.state = progressCount > 0 ? 'progress' : 'idle'
  }

  renderStep()
}

function renderStep() {
  elements.steps.forEach((stepElement, index) => {
    stepElement.hidden = index !== state.step
  })
  elements.backButton.hidden = state.step === 0
  elements.nextButton.hidden = state.step !== 0
  elements.nextButton.disabled = !state.profile.name
  elements.finishButton.hidden = state.step !== 1
  elements.finishButton.disabled = state.saving || !state.benchmarkElapsedMs || !state.profile.name
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
    localStt: Boolean(payload?.state?.choices?.localStt ?? true),
    externalProviders: Boolean(payload?.state?.choices?.externalProviders ?? false),
    rewriteCleanup: Boolean(payload?.state?.choices?.rewriteCleanup ?? true)
  }
  state.existingBenchmark = payload?.state?.typingBenchmark?.elapsedMs ? payload.state.typingBenchmark : null
  state.benchmarkElapsedMs = state.existingBenchmark?.elapsedMs || 0

  elements.profileName.value = state.profile.name
  elements.localStt.checked = state.choices.localStt
  elements.externalProviders.checked = state.choices.externalProviders
  elements.rewriteCleanup.checked = state.choices.rewriteCleanup
  elements.sampleText.textContent = state.sampleText

  renderRuntimeSummary()
  renderNameHint()
  renderBenchmarkSummary()
  updateTypingProgress()
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

elements.setupForm.addEventListener('change', () => {
  syncChoiceState()
})

elements.typingInput.addEventListener('input', () => {
  updateTypingProgress()
})

elements.backButton.addEventListener('click', () => {
  state.step = 0
  renderStep()
})

elements.nextButton.addEventListener('click', () => {
  syncProfileState()
  syncChoiceState()
  if (!state.profile.name) {
    elements.nameHint.textContent = 'Add your name before continuing.'
    elements.nameHint.dataset.state = 'error'
    renderStep()
    return
  }
  state.step = 1
  elements.typingInput.focus()
  renderStep()
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
  elements.typingHint.textContent = String(error?.message || error)
  elements.typingHint.dataset.state = 'error'
})
