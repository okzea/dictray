// Regression checks for how stored Speech to Text preferences become the
// runtime the tray starts with. Run by scripts/check.mjs.
import assert from 'node:assert/strict'
import {
  SPEECH_EFFORT_HIGH,
  SPEECH_EFFORT_LOW,
  SPEECH_EFFORT_MID,
  STT_MODEL_ADVANCED,
  STT_MODEL_MIDDLE,
  STT_MODEL_PRECISE,
  STT_MODEL_TINY,
  onboardingSttModelPreference,
  startupSttRuntimePatch
} from '../src/stt-preferences.mjs'

const checks = []
function check(name, run) {
  checks.push({ name, run })
}

// The 0.3.0 report: Precise stored with English and French, the config on
// small.en, and the tray came up on Advanced.
check('a stored multilingual Precise model wins over the configured model', () => {
  const patch = startupSttRuntimePatch({
    sttDevice: 'gpu',
    sttModel: 'precise',
    sttLanguages: ['en', 'fr']
  }, 'small.en')
  assert.deepEqual(patch, { device: 'cuda', computeType: 'float16', model: 'large-v3-turbo' })
})

check('a stored English-only model uses the English checkpoint', () => {
  assert.equal(startupSttRuntimePatch({ sttModel: 'precise', sttLanguages: ['en'] }, 'small.en').model, 'distil-large-v3.5')
  assert.equal(startupSttRuntimePatch({ sttModel: 'tiny', sttLanguages: [] }, 'small.en').model, 'tiny.en')
})

check('stored languages alone switch the configured tier to its multilingual checkpoint', () => {
  assert.deepEqual(startupSttRuntimePatch({ sttLanguages: ['fr'] }, 'small.en'), { model: 'small' })
  assert.deepEqual(startupSttRuntimePatch({ sttLanguages: ['fr'] }, ''), { model: 'base' })
})

check('nothing stored leaves the configured runtime alone', () => {
  assert.deepEqual(startupSttRuntimePatch({}, 'small.en'), {})
  assert.deepEqual(startupSttRuntimePatch({ sttDevice: 'cpu' }, 'small.en'), { device: 'cpu', computeType: 'int8' })
})

check('Quick Start keeps a stored model that matches the chosen effort', () => {
  assert.equal(onboardingSttModelPreference(SPEECH_EFFORT_HIGH, STT_MODEL_PRECISE), STT_MODEL_PRECISE)
  assert.equal(onboardingSttModelPreference(SPEECH_EFFORT_HIGH, STT_MODEL_ADVANCED), STT_MODEL_ADVANCED)
  assert.equal(onboardingSttModelPreference(SPEECH_EFFORT_LOW, STT_MODEL_TINY), STT_MODEL_TINY)
})

check('Quick Start falls back to the effort default otherwise', () => {
  assert.equal(onboardingSttModelPreference(SPEECH_EFFORT_HIGH, ''), STT_MODEL_ADVANCED)
  assert.equal(onboardingSttModelPreference(SPEECH_EFFORT_LOW, STT_MODEL_PRECISE), STT_MODEL_TINY)
  assert.equal(onboardingSttModelPreference(SPEECH_EFFORT_MID, STT_MODEL_PRECISE), STT_MODEL_MIDDLE)
  assert.equal(onboardingSttModelPreference('', ''), STT_MODEL_MIDDLE)
})

let failed = 0
for (const { name, run } of checks) {
  try {
    run()
  } catch (error) {
    failed += 1
    console.error(`[check] FAIL ${name}\n${error?.message || error}`)
  }
}
if (failed) {
  process.exitCode = 1
} else {
  console.log(`[check] Speech to Text preferences: ${checks.length} checks passed.`)
}
