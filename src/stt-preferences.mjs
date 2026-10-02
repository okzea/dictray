// Speech to Text model, device and language preferences: the names the tray
// menu and speech-preferences.json use, and how they map onto the runtime
// values the faster-whisper daemon understands. Pure, so scripts/check.mjs can
// exercise it without starting the tray.

export const STT_DEVICE_CPU = 'cpu'
export const STT_DEVICE_GPU = 'gpu'
export const STT_MODEL_TINY = 'tiny'
export const STT_MODEL_MIDDLE = 'middle'
export const STT_MODEL_ADVANCED = 'advanced'
export const STT_MODEL_PRECISE = 'precise'
export const STT_LANGUAGE_EN = 'en'
export const STT_LANGUAGE_OPTIONS = [
  { code: STT_LANGUAGE_EN, label: 'English' },
  { code: 'fr', label: 'French' },
  { code: 'es', label: 'Spanish' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' }
]
export const SPEECH_EFFORT_LOW = 'low'
export const SPEECH_EFFORT_MID = 'mid'
export const SPEECH_EFFORT_HIGH = 'high'

export function normalizeSttDevicePreference(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case 'gpu':
    case 'cuda':
      return STT_DEVICE_GPU
    case 'cpu':
      return STT_DEVICE_CPU
    default:
      return ''
  }
}

export function normalizeSttModelPreference(value) {
  const lowered = String(value || '').trim().toLowerCase()
  if (!lowered) {
    return ''
  }

  if (lowered === STT_MODEL_TINY || lowered === 'tiny.en') {
    return STT_MODEL_TINY
  }
  if (lowered === STT_MODEL_MIDDLE || lowered === 'base' || lowered === 'base.en') {
    return STT_MODEL_MIDDLE
  }
  if (lowered === STT_MODEL_ADVANCED || lowered === 'small' || lowered === 'small.en') {
    return STT_MODEL_ADVANCED
  }
  if (lowered === STT_MODEL_PRECISE || lowered === 'distil' || lowered === 'distil-large-v3.5'
    || lowered === 'turbo' || lowered === 'large-v3-turbo') {
    return STT_MODEL_PRECISE
  }
  return ''
}

export function sttModelPreferenceOptions() {
  return [STT_MODEL_TINY, STT_MODEL_MIDDLE, STT_MODEL_ADVANCED, STT_MODEL_PRECISE]
}

// The `.en` checkpoints and distil-large-v3.5 only know English: any other
// language needs the multilingual checkpoint of the same size.
export function sttModelNameForPreference(value, languages = []) {
  const english = sttLanguagesAreEnglishOnly(languages)
  switch (String(value || '').trim().toLowerCase()) {
    case STT_MODEL_TINY:
      return english ? 'tiny.en' : 'tiny'
    case STT_MODEL_MIDDLE:
      return english ? 'base.en' : 'base'
    case STT_MODEL_ADVANCED:
      return english ? 'small.en' : 'small'
    case STT_MODEL_PRECISE:
      return english ? 'distil-large-v3.5' : 'large-v3-turbo'
    default:
      return ''
  }
}

export function sttLanguageOptionCodes() {
  return STT_LANGUAGE_OPTIONS.map((option) => option.code)
}

// Kept in option order so the saved list and the runtime value stay stable.
export function normalizeSttLanguages(value) {
  const requested = new Set(
    (Array.isArray(value) ? value : String(value || '').split(','))
      .map((code) => String(code || '').trim().toLowerCase())
      .filter(Boolean)
  )
  return sttLanguageOptionCodes().filter((code) => requested.has(code))
}

export function sttLanguagesAreEnglishOnly(languages) {
  const normalized = normalizeSttLanguages(languages)
  return !normalized.length || (normalized.length === 1 && normalized[0] === STT_LANGUAGE_EN)
}

export function normalizeSpeechEffort(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case SPEECH_EFFORT_LOW:
    case 'fast':
    case 'faster':
      return SPEECH_EFFORT_LOW
    case SPEECH_EFFORT_HIGH:
    case 'quality':
      return SPEECH_EFFORT_HIGH
    case SPEECH_EFFORT_MID:
    case 'medium':
    case 'middle':
    case 'balanced':
      return SPEECH_EFFORT_MID
    default:
      return ''
  }
}

export function speechEffortForModel(value) {
  switch (normalizeSttModelPreference(value)) {
    case STT_MODEL_TINY:
      return SPEECH_EFFORT_LOW
    case STT_MODEL_ADVANCED:
    case STT_MODEL_PRECISE:
      return SPEECH_EFFORT_HIGH
    case STT_MODEL_MIDDLE:
    default:
      return SPEECH_EFFORT_MID
  }
}

export function speechPreferenceRuntimePatch(devicePreference) {
  const normalized = normalizeSttDevicePreference(devicePreference)
  if (normalized === STT_DEVICE_GPU) {
    return {
      device: 'cuda',
      computeType: 'float16'
    }
  }
  return {
    device: 'cpu',
    computeType: 'int8'
  }
}

// The tier a Quick Start speech effort picks when no model is stored.
export function sttModelPreferenceForSpeechEffort(value) {
  switch (normalizeSpeechEffort(value)) {
    case SPEECH_EFFORT_LOW:
      return STT_MODEL_TINY
    case SPEECH_EFFORT_HIGH:
      return STT_MODEL_ADVANCED
    case SPEECH_EFFORT_MID:
    default:
      return STT_MODEL_MIDDLE
  }
}

// Quick Start asks for an effort, not a model. A model already chosen from the
// menu is kept when it belongs to that effort (Precise is a high-effort model
// too); otherwise the effort's default tier applies.
export function onboardingSttModelPreference(speechEffort, storedModel) {
  const stored = normalizeSttModelPreference(storedModel)
  const effort = normalizeSpeechEffort(speechEffort) || SPEECH_EFFORT_MID
  if (stored && speechEffortForModel(stored) === effort) {
    return stored
  }
  return sttModelPreferenceForSpeechEffort(effort)
}

// The runtime the stored preferences ask for at startup, as a patch over the
// configured one. Without a stored model, stored languages still decide
// between the English-only and multilingual checkpoint of the configured tier.
export function startupSttRuntimePatch(stored = {}, configuredModel = '') {
  const patch = normalizeSttDevicePreference(stored?.sttDevice)
    ? speechPreferenceRuntimePatch(stored.sttDevice)
    : {}
  const modelPreference = normalizeSttModelPreference(stored?.sttModel)
  const languages = normalizeSttLanguages(stored?.sttLanguages)
  if (modelPreference || languages.length) {
    patch.model = sttModelNameForPreference(
      modelPreference || normalizeSttModelPreference(configuredModel) || STT_MODEL_MIDDLE,
      languages
    )
  }
  return patch
}
