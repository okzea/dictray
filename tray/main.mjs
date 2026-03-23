import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  screen,
  session,
  shell,
  Tray
} from 'electron'
import { loadConfig, normalizeRewriteProviderId } from '../src/config.mjs'
import { createRewriteProvider } from '../src/rewrite-provider.mjs'
import { resolveBundledHelperExecutable } from '../src/runtime-paths.mjs'
import { normalizeSpeechTranscript } from '../src/speech-lexicon.mjs'
import { createSttProvider } from '../src/stt-provider.mjs'
import { SystemVolumeBridge } from '../src/system-volume.mjs'
import { UiAutomationBridge } from '../src/ui-automation.mjs'

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
if (process.platform === 'win32') {
  app.setAppUserModelId('com.okzea.dictray')
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_NAME = 'DicTray'
const DEFAULT_HOTKEY = 'CommandOrControl+Space'
const DUCKING_LEVEL_OPTIONS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
const REWRITE_TEMPERATURE_OPTIONS = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1]
const APP_ICON_SVG_PATH = path.join(__dirname, '..', 'assets', 'app-icon.svg')
const APP_ICON_PNG_PATH = path.join(__dirname, '..', 'assets', 'app-icon.png')
const APP_ICON_ICO_PATH = path.join(__dirname, '..', 'assets', 'app-icon.ico')
const TRAY_ICON_PALETTES = {
  ready: {
    primary: '#2fcb74',
    accent: '#84efb1',
    depth: '#18784e'
  },
  hot: {
    primary: '#ff5d5d',
    accent: '#ff9b9b',
    depth: '#b42323'
  }
}
const HOTKEY_PRESETS = [
  { value: 'CommandOrControl+Space', label: 'Ctrl+Space' },
  { value: 'Alt+Space', label: 'Alt+Space' },
  { value: 'CommandOrControl+Alt+F12', label: 'Ctrl+Alt+F12' },
  { value: 'CommandOrControl+Alt+F13', label: 'Ctrl+Alt+F13' },
  { value: 'CommandOrControl+Alt+O', label: 'Ctrl+Alt+O' }
]
const HOTKEY_BRIDGE = String(process.env.DICTATION_TRAY_HOTKEY_HELPER || '').trim()
  || resolveBundledHelperExecutable('windows-hotkey-hook', 'WindowsHotkeyHook.exe')
  || path.join(__dirname, '..', 'scripts', 'windows-hotkey-hook', 'bin', 'Release', 'net10.0-windows', 'WindowsHotkeyHook.exe')
const ALLOWED_PERMISSIONS = new Set(['media', 'microphone'])
const FORCE_ONBOARDING = /^(1|true|yes)$/i.test(String(process.env.DICTATION_TRAY_FORCE_ONBOARDING || '').trim())
const STT_DEVICE_CPU = 'cpu'
const STT_DEVICE_GPU = 'gpu'
const STT_MODEL_TINY = 'tiny'
const STT_MODEL_MIDDLE = 'middle'
const STT_MODEL_ADVANCED = 'advanced'
const SPEECH_EFFORT_LOW = 'low'
const SPEECH_EFFORT_MID = 'mid'
const SPEECH_EFFORT_HIGH = 'high'
const SPEECH_TO_TEXT_LABEL = 'Speech to Text'
const TEXT_IMPROVEMENT_LABEL = 'Text Improvement'
const DAILY_CHARACTER_STATS_RETENTION_DAYS = 7
const OUTPUT_HISTORY_LIMIT = 5
const ONBOARDING_SAMPLE_TEXT = "I'm ready to give up on typing with my keyboard for ever"
const HOTKEY_BRIDGE_RESTART_DELAY_MS = 150
const HOTKEY_BRIDGE_RESTART_WINDOW_MS = 60000
const HOTKEY_BRIDGE_MAX_RESTARTS = 20
const VOICE_OVERLAY_WIDTH = 308
const VOICE_OVERLAY_HEIGHT = 104
const VOICE_OVERLAY_MARGIN = 18
const VOICE_OVERLAY_GAP = 14
const VOICE_OVERLAY_IDLE_HIDE_DELAY_MS = 1800
const INPUT_SOURCE_WINDOW_WIDTH = 420
const INPUT_SOURCE_WINDOW_HEIGHT = 520
const TARGET_WINDOW_POLL_INTERVAL_MS = 280
const EXIT_EXISTING_INSTANCE_ARG = '--dictray-exit-existing'
const REQUEST_EXIT_EXISTING_INSTANCE = process.argv.includes(EXIT_EXISTING_INSTANCE_ARG)

let runtimeConfig = null
let speech = null
let rewriteProvider = null
let systemVolume = null
let uiAutomation = null
let stateDir = ''
let traySettingsPath = ''
let speechPreferencesPath = ''
let rewritePreferencesPath = ''
let legacyRewritePreferencesPath = ''
let dailyCharacterStatsPath = ''
let onboardingStatePath = ''
let outputHistoryPath = ''
let diagnosticsLogPath = ''
let tray = null
let voiceWindow = null
let inputSourceWindow = null
let onboardingWindow = null
let trayIcons = new Map()
let windowIcon = null
let hotkeyBridge = null
let hotkeyBridgeRestartTimer = null
let hotkeyBridgeRestartAtMs = []
let refreshTimer = null
let sttKeepWarmTimer = null
let voiceOverlayHideTimer = null
let voiceOverlayFocusedBounds = null
let voiceOverlayFocusedBoundsRefresh = null
let isQuitting = false
let isRestoringVolumeForQuit = false
let trayHotkey = DEFAULT_HOTKEY
let rewriteEnabled = false
let duckingEnabled = true
let duckingLevel = 0.3
let currentRewriteModel = ''
let currentRewriteThink = 'off'
let currentRewriteTemperature = 0.1
let rewriteModels = []
let latestHealth = {
  stt: null,
  rewrite: null,
  automation: null
}
let sttPreferences = {
  supported: false,
  options: [],
  modelOptions: [],
  selectedDevice: '',
  selectedModel: '',
  currentDevice: '',
  currentModel: '',
  provider: '',
  error: ''
}
let preferredInputDeviceId = ''
let inputDeviceState = {
  available: [],
  permission: 'unknown',
  activeDeviceId: '',
  activeLabel: '',
  error: ''
}
let voiceState = {
  phase: 'idle',
  transcript: '',
  finalText: '',
  targetWindow: '',
  targetBounds: null,
  targetElementBounds: null,
  note: '',
  error: ''
}
let activeTurnContext = null
let activeSubmission = null
let nextSubmissionId = 0
let sttWarmupInFlight = null
let sttReadyForDictation = false
let sttReadyNotificationAttached = false
let lastSttBlockedNotificationAt = 0
let sttKeepWarmInFlight = false
let runtimeReloadInFlight = null
let lastSttDiagnosticSignature = ''
let lastSttHealthLogSignature = ''
let volumeDuckState = null
let dailyCharacterStats = {
  days: {}
}
let outputHistory = {
  entries: []
}
let onboardingState = {
  version: 2,
  seenAt: '',
  completedAt: '',
  profile: {
    name: ''
  },
  choices: {
    rewriteCleanup: false,
    speechEffort: SPEECH_EFFORT_MID,
    pushToTalkHotkey: DEFAULT_HOTKEY
  },
  typingBenchmark: {
    sampleText: ONBOARDING_SAMPLE_TEXT,
    elapsedMs: 0,
    charactersPerMinute: 0,
    wordsPerMinute: 0,
    measuredAt: ''
  }
}

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance || REQUEST_EXIT_EXISTING_INSTANCE) {
  app.quit()
}

app.on('second-instance', (_event, commandLine = []) => {
  if (Array.isArray(commandLine) && commandLine.includes(EXIT_EXISTING_INSTANCE_ARG)) {
    isQuitting = true
    app.quit()
    return
  }
  void reloadRuntimeConfig().then(async () => {
    await scheduleSttWarmup({ notifyReady: true }).catch(() => null)
    await refreshRuntimeState(false)
    rebuildMenu()
  }).catch((error) => {
    console.error(`[dictray] Failed to reload runtime after relaunch: ${error?.message || error}`)
  })
})

function compactText(value, limit = 88) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`
}

function supportsAnsiTimingLogs() {
  return Boolean(process?.stdout?.isTTY) && process.env.NO_COLOR === undefined
}

function colorTimingText(text, colorName) {
  if (!supportsAnsiTimingLogs()) {
    return text
  }

  const code = colorName === 'green'
    ? '\u001b[32m'
    : colorName === 'orange'
      ? '\u001b[33m'
      : colorName === 'red'
        ? '\u001b[31m'
        : ''
  return code ? `${code}${text}\u001b[0m` : text
}

function timingColor(value, warnMs, badMs) {
  const durationMs = Number(value || 0)
  if (durationMs >= badMs) {
    return 'red'
  }
  if (durationMs >= warnMs) {
    return 'orange'
  }
  return 'green'
}

function formatTimingLine(label, value, warnMs, badMs) {
  const durationMs = Number(value || 0)
  const text = `- ${label}: ${durationMs}ms`
  return colorTimingText(text, timingColor(durationMs, warnMs, badMs))
}

function audioExtensionForMimeType(value) {
  const mimeType = String(value || '').split(';', 1)[0].trim().toLowerCase()
  switch (mimeType) {
    case 'audio/webm':
      return '.webm'
    case 'audio/ogg':
      return '.ogg'
    case 'audio/wav':
    case 'audio/x-wav':
      return '.wav'
    case 'audio/mp4':
    case 'audio/m4a':
      return '.m4a'
    case 'audio/mpeg':
      return '.mp3'
    default:
      return '.bin'
  }
}

function formatCount(value) {
  return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString('en-US')
}

function clampUnitInterval(value) {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(1, Number(value)))
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function normalizeDuckingEnabled(value) {
  return value === undefined ? true : Boolean(value)
}

function normalizeDuckingLevel(value) {
  const level = clampUnitInterval(Number(value))
  if (!level) {
    return 0
  }

  let best = DUCKING_LEVEL_OPTIONS[0]
  let bestDistance = Math.abs(best - level)
  for (const option of DUCKING_LEVEL_OPTIONS.slice(1)) {
    const distance = Math.abs(option - level)
    if (distance < bestDistance) {
      best = option
      bestDistance = distance
    }
  }
  return best
}

function duckingPercentLabel(value = duckingLevel) {
  return `${Math.round(clampUnitInterval(value) * 100)}%`
}

function hotkeyManagedByEnv() {
  return Boolean(String(process.env.DICTATION_TRAY_HOTKEY || '').trim())
}

function normalizeTrayHotkey(value) {
  const normalized = String(value || '').trim()
  if (HOTKEY_PRESETS.some((preset) => preset.value === normalized)) {
    return normalized
  }
  return DEFAULT_HOTKEY
}

function formatHotkey(value) {
  return String(value || DEFAULT_HOTKEY)
    .replace(/CommandOrControl/g, process.platform === 'darwin' ? 'CmdOrCtrl' : 'Ctrl')
}

function normalizeRewriteThink(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (['on', 'true', 'enabled', 'enable', '1'].includes(normalized)) {
    return 'on'
  }
  if (['off', 'false', 'disabled', 'disable', '0', 'none'].includes(normalized)) {
    return 'off'
  }
  return 'default'
}

function rewriteThinkMenuLabel(value) {
  switch (normalizeRewriteThink(value)) {
    case 'on':
      return 'On'
    case 'off':
      return 'Off'
    default:
      return 'Default'
  }
}

function normalizeRewriteTemperature(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 0.1
  }

  let best = REWRITE_TEMPERATURE_OPTIONS[0]
  let bestDistance = Math.abs(best - numeric)
  for (const option of REWRITE_TEMPERATURE_OPTIONS.slice(1)) {
    const distance = Math.abs(option - numeric)
    if (distance < bestDistance) {
      best = option
      bestDistance = distance
    }
  }
  return best
}

function rewriteTemperatureLabel(value = currentRewriteTemperature) {
  return normalizeRewriteTemperature(value).toFixed(1)
}

function normalizeInputDeviceId(value) {
  return String(value || '').trim()
}

function normalizeInputPermission(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'granted' || normalized === 'denied' || normalized === 'prompt') {
    return normalized
  }
  return 'unknown'
}

function normalizeAvailableInputDevices(values) {
  const devices = []
  const seen = new Set()
  let unnamedIndex = 0

  for (const value of Array.isArray(values) ? values : []) {
    const deviceId = normalizeInputDeviceId(value?.deviceId)
    const groupId = String(value?.groupId || '').trim()
    const label = compactText(String(value?.label || '').trim() || `Microphone ${unnamedIndex + 1}`, 64)
    const key = deviceId || `${groupId}:${label}`
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    devices.push({
      deviceId,
      groupId,
      label
    })
    unnamedIndex += 1
  }

  return devices
}

function selectedInputSource() {
  return inputDeviceState.available.find((device) => device.deviceId === preferredInputDeviceId) || null
}

function inputSourceMenuLabel() {
  if (preferredInputDeviceId) {
    if (!inputDeviceState.available.length) {
      return 'Selected microphone'
    }
    return selectedInputSource()?.label || 'Selected microphone unavailable'
  }

  const activeLabel = compactText(inputDeviceState.activeLabel || '', 40)
  return activeLabel ? `System Default (${activeLabel})` : 'System Default'
}

function normalizeSttDevicePreference(value) {
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

function runtimeSttDevicePreference(value) {
  return normalizeSttDevicePreference(value) || STT_DEVICE_CPU
}

function runtimeSttDeviceOptions(values) {
  const options = Array.isArray(values)
    ? values
      .map((value) => runtimeSttDevicePreference(value))
      .filter(Boolean)
    : []
  return options.length ? [...new Set(options)] : [STT_DEVICE_CPU]
}

function normalizeSttModelPreference(value) {
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
  return ''
}

function sttModelPreferenceOptions() {
  return [STT_MODEL_TINY, STT_MODEL_MIDDLE, STT_MODEL_ADVANCED]
}

function sttModelNameForPreference(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case STT_MODEL_TINY:
      return 'tiny.en'
    case STT_MODEL_MIDDLE:
      return 'base.en'
    case STT_MODEL_ADVANCED:
      return 'small.en'
    default:
      return ''
  }
}

function normalizeSpeechEffort(value) {
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

function speechEffortForModel(value) {
  switch (normalizeSttModelPreference(value)) {
    case STT_MODEL_TINY:
      return SPEECH_EFFORT_LOW
    case STT_MODEL_ADVANCED:
      return SPEECH_EFFORT_HIGH
    case STT_MODEL_MIDDLE:
    default:
      return SPEECH_EFFORT_MID
  }
}

function sttModelForSpeechEffort(value) {
  switch (normalizeSpeechEffort(value)) {
    case SPEECH_EFFORT_LOW:
      return 'tiny.en'
    case SPEECH_EFFORT_HIGH:
      return 'small.en'
    case SPEECH_EFFORT_MID:
    default:
      return 'base.en'
  }
}

function speechEffortLabel(value) {
  switch (normalizeSpeechEffort(value)) {
    case SPEECH_EFFORT_LOW:
      return 'Low (Faster)'
    case SPEECH_EFFORT_HIGH:
      return 'High (Quality)'
    case SPEECH_EFFORT_MID:
    default:
      return 'Mid (Balanced)'
  }
}

function runtimeSttModelPreference(value) {
  return normalizeSttModelPreference(value) || ''
}

function speechPreferenceRuntimePatch(devicePreference) {
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

function normalizeRewriteEnabled(value) {
  return value === undefined ? true : Boolean(value)
}

function nowMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function showNotification(title, body) {
  void appendDiagnosticsLog('notification', {
    title: String(title || '').trim(),
    body: String(body || '').trim()
  })
  if (!Notification.isSupported()) {
    return
  }
  new Notification({
    title,
    body,
    icon: appIcon()
  }).show()
}

function notifySttReady() {
  showNotification(APP_NAME, `${SPEECH_TO_TEXT_LABEL} is ready.`)
}

function maybeNotifySttBlocked(message, minIntervalMs = 4000) {
  const now = Date.now()
  if ((now - lastSttBlockedNotificationAt) < minIntervalMs) {
    return
  }
  lastSttBlockedNotificationAt = now
  showNotification(APP_NAME, message)
}

function providerUsesHttpStt() {
  const providerId = String(speech?.id || runtimeConfig?.stt?.provider || '').trim().toLowerCase()
  return providerId === 'http'
}

function sttDiagnosticSnapshot(health = latestHealth.stt) {
  if (!health) {
    return null
  }

  return {
    provider: String(health?.providerId || health?.provider || runtimeConfig?.stt?.provider || '').trim(),
    message: String(health?.error || '').trim(),
    detail: String(health?.detail || '').trim(),
    pythonBin: String(health?.pythonBin || runtimeConfig?.stt?.local?.pythonBin || '').trim(),
    daemonScript: String(health?.daemonScript || runtimeConfig?.stt?.local?.daemonScript || '').trim(),
    transcribeScript: String(health?.transcribeScript || runtimeConfig?.stt?.local?.transcribeScript || '').trim(),
    model: String(health?.model || runtimeConfig?.stt?.local?.model || '').trim(),
    modelDir: String(health?.modelDir || runtimeConfig?.stt?.local?.modelDir || '').trim(),
    device: String(health?.device || runtimeConfig?.stt?.local?.device || '').trim(),
    computeType: String(health?.computeType || runtimeConfig?.stt?.local?.computeType || '').trim(),
    bundledRuntimeDir: String(process.env.DICTATION_TRAY_BUNDLED_RUNTIME_DIR || '').trim(),
    stateDir: String(stateDir || '').trim()
  }
}

function logSttDiagnostic(context, health = latestHealth.stt, force = false) {
  if (!health || health.ok) {
    return
  }

  const snapshot = {
    context,
    ...sttDiagnosticSnapshot(health)
  }
  const signature = JSON.stringify(snapshot)
  if (!force && signature === lastSttDiagnosticSignature) {
    return
  }
  lastSttDiagnosticSignature = signature

  console.error('[dictray] Speech to Text diagnostic:', snapshot)
  if (snapshot.detail) {
    console.error(`[dictray] Speech to Text raw detail:\n${snapshot.detail}`)
  }
  void appendDiagnosticsLog('stt-diagnostic', snapshot)
}

async function appendDiagnosticsLog(kind, payload = {}) {
  if (!diagnosticsLogPath) {
    return
  }

  const entry = {
    at: new Date().toISOString(),
    kind,
    payload
  }

  try {
    await mkdir(path.dirname(diagnosticsLogPath), { recursive: true })
    await appendFile(diagnosticsLogPath, `${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // ignore diagnostics logging failures
  }
}

async function saveFailedSubmissionSample(kind, audioBytes, mimeType, metadata = {}) {
  if (!(audioBytes instanceof Uint8Array) || !audioBytes.length || !stateDir) {
    return null
  }

  const debugDir = path.join(stateDir, 'stt-debug')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const baseName = `${stamp}-${kind}`
  const audioPath = path.join(debugDir, `${baseName}${audioExtensionForMimeType(mimeType)}`)
  const metadataPath = path.join(debugDir, `${baseName}.json`)

  try {
    await mkdir(debugDir, { recursive: true })
    await writeFile(audioPath, Buffer.from(audioBytes))
    await writeFile(metadataPath, `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      mimeType: String(mimeType || 'application/octet-stream').trim(),
      audioBytes: audioBytes.length,
      ...metadata
    }, null, 2)}\n`, 'utf8')
    return {
      audioPath,
      metadataPath
    }
  } catch {
    return null
  }
}

function createAbortError(message = 'Dictation was cancelled.') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|cancelled|canceled/i.test(String(error?.message || error || ''))
}

function abortReasonAsError(reason, fallbackMessage = 'Dictation was cancelled.') {
  return reason instanceof Error ? reason : createAbortError(fallbackMessage)
}

function cancelActiveSubmission(reason = 'Dictation was cancelled by a new push-to-talk turn.') {
  const submission = activeSubmission
  if (!submission || submission.controller.signal.aborted) {
    return false
  }
  submission.controller.abort(createAbortError(reason))
  return true
}

function throwIfSubmissionCancelled(submission) {
  if (!submission) {
    return
  }
  if (submission.controller.signal.aborted) {
    throw abortReasonAsError(submission.controller.signal.reason)
  }
  if (activeSubmission !== submission) {
    throw createAbortError('Dictation was superseded by a newer push-to-talk turn.')
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearVoiceOverlayHideTimer() {
  if (voiceOverlayHideTimer) {
    clearTimeout(voiceOverlayHideTimer)
    voiceOverlayHideTimer = null
  }
}

function normalizeOverlayBounds(bounds, { allowPoint = false } = {}) {
  if (!bounds || typeof bounds !== 'object') {
    return null
  }

  const left = Number(bounds.left)
  const top = Number(bounds.top)
  const width = Number(bounds.width)
  const height = Number(bounds.height)
  if (![left, top, width, height].every(Number.isFinite)) {
    return null
  }

  if (width <= 0 || height <= 0) {
    if (!allowPoint) {
      return null
    }
    return {
      left,
      top,
      width: 1,
      height: 1
    }
  }

  return {
    left,
    top,
    width,
    height
  }
}

function sameOverlayBounds(a, b) {
  if (!a && !b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return a.left === b.left
    && a.top === b.top
    && a.width === b.width
    && a.height === b.height
}

function resolveVoiceOverlayWindowBounds(state = voiceState) {
  const focusedWindowBounds = normalizeOverlayBounds(voiceOverlayFocusedBounds)
  if (focusedWindowBounds) {
    return focusedWindowBounds
  }
  const windowBounds = normalizeOverlayBounds(state?.targetBounds)
  if (windowBounds) {
    return windowBounds
  }

  return null
}

function clampOverlayAxis(value, origin, availableSize, overlaySize) {
  const maxOffset = Math.max(0, availableSize - overlaySize)
  const min = origin + Math.min(VOICE_OVERLAY_MARGIN, maxOffset)
  const max = origin + Math.max(0, maxOffset - VOICE_OVERLAY_MARGIN)
  return Math.round(clampNumber(value, Math.min(min, max), Math.max(min, max)))
}

function computeVoiceOverlayBounds(state = voiceState) {
  const windowBounds = resolveVoiceOverlayWindowBounds(state)
  if (!windowBounds && voiceWindow && !voiceWindow.isDestroyed() && voiceWindow.isVisible()) {
    return voiceWindow.getBounds()
  }
  const matchingRect = windowBounds
    ? {
        x: Math.round(windowBounds.left),
        y: Math.round(windowBounds.top),
        width: Math.max(1, Math.round(windowBounds.width)),
        height: Math.max(1, Math.round(windowBounds.height))
      }
    : {
        x: 0,
        y: 0,
        width: VOICE_OVERLAY_WIDTH,
        height: VOICE_OVERLAY_HEIGHT
      }
  const display = windowBounds ? screen.getDisplayMatching(matchingRect) : screen.getPrimaryDisplay()
  const workArea = display?.workArea || {
    x: 0,
    y: 0,
    width: VOICE_OVERLAY_WIDTH + (VOICE_OVERLAY_MARGIN * 2),
    height: VOICE_OVERLAY_HEIGHT + (VOICE_OVERLAY_MARGIN * 2)
  }

  let x = workArea.x + Math.round((workArea.width - VOICE_OVERLAY_WIDTH) / 2)
  let y = workArea.y + workArea.height - VOICE_OVERLAY_HEIGHT - VOICE_OVERLAY_MARGIN
  if (windowBounds) {
    x = windowBounds.left + Math.round((windowBounds.width - VOICE_OVERLAY_WIDTH) / 2)
    y = windowBounds.top + windowBounds.height - VOICE_OVERLAY_HEIGHT - VOICE_OVERLAY_MARGIN
  }

  return {
    x: clampOverlayAxis(x, workArea.x, workArea.width, VOICE_OVERLAY_WIDTH),
    y: clampOverlayAxis(y, workArea.y, workArea.height, VOICE_OVERLAY_HEIGHT),
    width: VOICE_OVERLAY_WIDTH,
    height: VOICE_OVERLAY_HEIGHT
  }
}

function voiceOverlayVisible(state = voiceState) {
  return state.phase !== 'idle' || Boolean(state.error || state.note)
}

function buildVoiceOverlayPayload(state = voiceState) {
  return {
    visible: voiceOverlayVisible(state),
    phase: String(state?.phase || 'idle').trim() || 'idle',
    targetWindow: compactText(state?.targetWindow || '', 70),
    note: compactText(state?.note || '', 120),
    error: compactText(state?.error || '', 120)
  }
}

function syncAudioInputConfig(window, { refresh = false } = {}) {
  if (!window || window.isDestroyed() || window.webContents.isDestroyed()) {
    return
  }

  window.webContents.send('dictation:audio-input-config', {
    preferredInputDeviceId,
    refresh: Boolean(refresh)
  })
}

function syncAllAudioInputConfig({ refresh = false } = {}) {
  syncAudioInputConfig(voiceWindow, { refresh })
  syncAudioInputConfig(inputSourceWindow, { refresh })
}

function scheduleVoiceOverlayHide(delayMs = VOICE_OVERLAY_IDLE_HIDE_DELAY_MS) {
  clearVoiceOverlayHideTimer()
  voiceOverlayHideTimer = setTimeout(() => {
    voiceOverlayHideTimer = null
    if (!voiceWindow || voiceWindow.isDestroyed()) {
      return
    }
    if (voiceState.phase === 'idle') {
      voiceWindow.hide()
    }
  }, Math.max(0, Number(delayMs) || 0))
}

async function refreshVoiceOverlayFocusedBounds() {
  if (voiceOverlayFocusedBoundsRefresh || !uiAutomation || !voiceOverlayVisible()) {
    return voiceOverlayFocusedBoundsRefresh
  }

  voiceOverlayFocusedBoundsRefresh = (async () => {
    try {
      const focusedWindow = await getFocusedWindowSnapshot().catch(() => null)
      const nextBounds = normalizeOverlayBounds(focusedWindow?.bounds)
      if (!sameOverlayBounds(voiceOverlayFocusedBounds, nextBounds)) {
        voiceOverlayFocusedBounds = nextBounds
        if (voiceWindow && !voiceWindow.isDestroyed() && voiceOverlayVisible()) {
          voiceWindow.setBounds(computeVoiceOverlayBounds(), false)
        }
      }
    } finally {
      voiceOverlayFocusedBoundsRefresh = null
    }
  })()

  return voiceOverlayFocusedBoundsRefresh
}

function syncVoiceOverlay() {
  if (!voiceWindow || voiceWindow.isDestroyed()) {
    return
  }

  clearVoiceOverlayHideTimer()
  const payload = buildVoiceOverlayPayload()
  if (!payload.visible) {
    voiceOverlayFocusedBounds = null
    if (voiceWindow.isVisible()) {
      voiceWindow.hide()
    }
    return
  }

  void refreshVoiceOverlayFocusedBounds()
  voiceWindow.setBounds(computeVoiceOverlayBounds(), false)
  if (!voiceWindow.webContents.isDestroyed()) {
    voiceWindow.webContents.send('dictation:voice-state', payload)
  }
  if (!voiceWindow.isVisible()) {
    voiceWindow.showInactive()
  }
  if (voiceState.phase === 'idle') {
    scheduleVoiceOverlayHide()
  }
}

async function readJsonFile(filePath, fallback = {}) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

function dayKeyForDate(date = new Date()) {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function retainedDayKeys(referenceDate = new Date(), retentionDays = DAILY_CHARACTER_STATS_RETENTION_DAYS) {
  const keys = []
  for (let offset = 0; offset < retentionDays; offset += 1) {
    const date = new Date(referenceDate)
    date.setDate(referenceDate.getDate() - offset)
    keys.push(dayKeyForDate(date))
  }
  return keys
}

function buildTypingBenchmark(input = {}) {
  const elapsedMs = Math.max(0, Math.floor(Number(input?.elapsedMs || 0) || 0))
  const characters = Array.from(ONBOARDING_SAMPLE_TEXT).length
  const words = ONBOARDING_SAMPLE_TEXT.trim().split(/\s+/).filter(Boolean).length
  return {
    sampleText: ONBOARDING_SAMPLE_TEXT,
    elapsedMs,
    charactersPerMinute: elapsedMs > 0 ? Math.max(0, Math.round((characters / elapsedMs) * 60000)) : 0,
    wordsPerMinute: elapsedMs > 0 ? Math.max(0, Number(((words / elapsedMs) * 60000).toFixed(1)) || 0) : 0,
    measuredAt: elapsedMs > 0 ? String(input?.measuredAt || new Date().toISOString()).trim() : ''
  }
}

function normalizeProfileName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 40)
}

function normalizeOnboardingState(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const defaultRewriteCleanup = rewriteProviderId() !== 'none' && rewriteEnabled
  const defaultSpeechEffort = speechEffortForModel(runtimeConfig?.stt?.local?.model || sttPreferences.currentModel || 'base.en')
  const defaultPushToTalkHotkey = hotkeyManagedByEnv()
    ? String(process.env.DICTATION_TRAY_HOTKEY || DEFAULT_HOTKEY).trim() || DEFAULT_HOTKEY
    : normalizeTrayHotkey(trayHotkey || DEFAULT_HOTKEY)
  return {
    version: 2,
    seenAt: String(source?.seenAt || '').trim(),
    completedAt: String(source?.completedAt || '').trim(),
    profile: {
      name: normalizeProfileName(source?.profile?.name)
    },
    choices: {
      rewriteCleanup: source?.choices?.rewriteCleanup !== undefined ? Boolean(source.choices.rewriteCleanup) : defaultRewriteCleanup,
      speechEffort: normalizeSpeechEffort(source?.choices?.speechEffort) || defaultSpeechEffort,
      pushToTalkHotkey: normalizeTrayHotkey(source?.choices?.pushToTalkHotkey || defaultPushToTalkHotkey)
    },
    typingBenchmark: buildTypingBenchmark(source?.typingBenchmark || {})
  }
}

async function loadOnboardingState() {
  onboardingState = normalizeOnboardingState(await readJsonFile(onboardingStatePath, {}))
}

async function saveOnboardingState() {
  onboardingState = normalizeOnboardingState(onboardingState)
  await writeJsonFile(onboardingStatePath, onboardingState)
}

function typingBenchmarkCharactersPerMinute() {
  return Math.max(0, Math.floor(Number(onboardingState?.typingBenchmark?.charactersPerMinute || 0) || 0))
}

function typingBenchmarkReady() {
  return typingBenchmarkCharactersPerMinute() > 0
}

function onboardingProfileName() {
  return normalizeProfileName(onboardingState?.profile?.name)
}

function onboardingCompleted() {
  return Boolean(String(onboardingState?.completedAt || '').trim())
}

function estimateTypingMsForCharacters(count) {
  const characters = Math.max(0, Math.floor(Number(count || 0) || 0))
  const cpm = typingBenchmarkCharactersPerMinute()
  if (!characters || !cpm) {
    return 0
  }
  return Math.max(0, Math.round((characters / cpm) * 60000))
}

function formatDurationCompact(valueMs) {
  const totalSeconds = Math.max(0, Math.round((Number(valueMs) || 0) / 1000))
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function greetingLabel() {
  const name = onboardingProfileName()
  return name ? `Hi, ${name}` : `Hi from ${APP_NAME}`
}

function timeSavedTrayLabel() {
  if (!typingBenchmarkReady()) {
    return 'Finish Quick Start to estimate your typing time savings.'
  }
  return `You saved ${formatDurationCompact(currentDailyTimeSavedMs())} today instead of typing manually.`
}

function normalizeDailyCharacterEntry(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return {
      characters: Math.max(0, Math.floor(Number(value?.characters ?? value?.count ?? 0) || 0)),
      estimatedTypingMs: Math.max(0, Math.floor(Number(value?.estimatedTypingMs || 0) || 0))
    }
  }
  return {
    characters: Math.max(0, Math.floor(Number(value || 0) || 0)),
    estimatedTypingMs: 0
  }
}

function normalizeDailyCharacterStats(input = {}, referenceDate = new Date()) {
  const allowedKeys = new Set(retainedDayKeys(referenceDate))
  const source = input && typeof input === 'object' ? input : {}
  const days = {}
  for (const [key, value] of Object.entries(source.days || {})) {
    if (!allowedKeys.has(String(key))) {
      continue
    }
    const entry = normalizeDailyCharacterEntry(value)
    if (entry.characters > 0 || entry.estimatedTypingMs > 0) {
      days[String(key)] = entry
    }
  }
  return { days }
}

function normalizeOutputHistoryEntry(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const text = String(source?.text || '').replace(/\s+/g, ' ').trim()
  const mode = String(source?.mode || '').trim().toLowerCase() === 'improved'
    ? 'improved'
    : 'speech'
  const createdAt = String(source?.createdAt || '').trim()
  return {
    text: text.slice(0, 4000),
    mode,
    createdAt
  }
}

function normalizeOutputHistory(input = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const rawEntries = Array.isArray(source.entries) ? source.entries : []
  const entries = rawEntries
    .map((entry) => normalizeOutputHistoryEntry(entry))
    .filter((entry) => entry.text)
    .slice(0, OUTPUT_HISTORY_LIMIT)
  return { entries }
}

async function loadDailyCharacterStats() {
  dailyCharacterStats = normalizeDailyCharacterStats(await readJsonFile(dailyCharacterStatsPath, {}))
}

async function saveDailyCharacterStats() {
  dailyCharacterStats = normalizeDailyCharacterStats(dailyCharacterStats)
  await writeJsonFile(dailyCharacterStatsPath, dailyCharacterStats)
}

async function loadOutputHistory() {
  outputHistory = normalizeOutputHistory(await readJsonFile(outputHistoryPath, {}))
}

async function saveOutputHistory() {
  outputHistory = normalizeOutputHistory(outputHistory)
  await writeJsonFile(outputHistoryPath, outputHistory)
}

async function recordOutputHistory(text, { improved = false } = {}) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) {
    return null
  }

  outputHistory = normalizeOutputHistory(outputHistory)
  outputHistory.entries = [
    {
      text: normalized,
      mode: improved ? 'improved' : 'speech',
      createdAt: new Date().toISOString()
    },
    ...outputHistory.entries
  ].slice(0, OUTPUT_HISTORY_LIMIT)

  await saveOutputHistory()
  rebuildMenu()
  return outputHistory.entries[0]
}

function outputHistoryMenuLabel(entry) {
  const mode = String(entry?.mode || '').trim() === 'improved' ? 'Improved' : 'Speech'
  return `[${mode}] ${compactText(entry?.text || '', 96)}`
}

function currentDailyCharacterCount() {
  return normalizeDailyCharacterEntry(dailyCharacterStats?.days?.[dayKeyForDate()]).characters
}

function currentDailyTimeSavedMs() {
  const today = normalizeDailyCharacterEntry(dailyCharacterStats?.days?.[dayKeyForDate()])
  return Math.max(today.estimatedTypingMs, estimateTypingMsForCharacters(today.characters))
}

async function recordGeneratedCharacters(text) {
  const count = Array.from(String(text || '')).length
  if (!count) {
    return 0
  }

  dailyCharacterStats = normalizeDailyCharacterStats(dailyCharacterStats)
  const todayKey = dayKeyForDate()
  const today = normalizeDailyCharacterEntry(dailyCharacterStats.days[todayKey])
  dailyCharacterStats.days[todayKey] = {
    characters: today.characters + count,
    estimatedTypingMs: today.estimatedTypingMs + estimateTypingMsForCharacters(count)
  }
  await saveDailyCharacterStats()
  rebuildMenu()
  return count
}

async function readSharedSpeechPreferences() {
  const parsed = await readJsonFile(speechPreferencesPath, {})
  return {
    sttDevice: normalizeSttDevicePreference(parsed?.sttDevice),
    sttModel: normalizeSttModelPreference(parsed?.sttModel)
  }
}

async function writeSharedSpeechPreferences(input = {}) {
  const payload = {
    sttDevice: normalizeSttDevicePreference(input?.sttDevice),
    sttModel: normalizeSttModelPreference(input?.sttModel)
  }
  await writeJsonFile(speechPreferencesPath, payload)
  return payload
}

async function readSharedRewritePreferences() {
  const primary = await readJsonFile(rewritePreferencesPath, {})
  const hasPrimaryPreferences = primary && typeof primary === 'object'
    && ['provider', 'think', 'model', 'temperature'].some((key) => primary[key] !== undefined)
  const parsed = hasPrimaryPreferences
    ? primary
    : await readJsonFile(legacyRewritePreferencesPath, {})
  const rawThink = String(parsed?.think || '').trim()
  const migratedThink = !rawThink || rawThink.toLowerCase() === 'default'
    ? 'off'
    : rawThink
  return {
    provider: String(parsed?.provider || '').trim(),
    think: normalizeRewriteThink(migratedThink),
    model: String(parsed?.model || '').trim(),
    temperature: normalizeRewriteTemperature(parsed?.temperature ?? 0.1)
  }
}

async function writeSharedRewritePreferences(input = {}) {
  const payload = {
    provider: String(input?.provider || runtimeConfig?.rewrite?.provider || '').trim(),
    think: normalizeRewriteThink(input?.think || currentRewriteThink || runtimeConfig?.rewrite?.ollama?.think || 'off'),
    model: String(input?.model || currentRewriteModel || runtimeConfig?.rewrite?.ollama?.model || '').trim(),
    temperature: normalizeRewriteTemperature(input?.temperature ?? currentRewriteTemperature ?? runtimeConfig?.rewrite?.ollama?.temperature ?? 0.1)
  }
  await writeJsonFile(rewritePreferencesPath, payload)
  return payload
}

async function loadTraySettings() {
  if (hotkeyManagedByEnv()) {
    trayHotkey = String(process.env.DICTATION_TRAY_HOTKEY).trim()
  } else {
    trayHotkey = DEFAULT_HOTKEY
  }

  const parsed = await readJsonFile(traySettingsPath, {})
  rewriteEnabled = normalizeRewriteEnabled(runtimeConfig?.dictation?.rewriteEnabled)
  duckingEnabled = normalizeDuckingEnabled(runtimeConfig?.dictation?.duckingEnabled)
  duckingLevel = normalizeDuckingLevel(runtimeConfig?.dictation?.duckingLevel)
  if (!hotkeyManagedByEnv()) {
    trayHotkey = normalizeTrayHotkey(parsed?.hotkey)
  }
  if (parsed?.rewriteEnabled !== undefined) {
    rewriteEnabled = normalizeRewriteEnabled(parsed?.rewriteEnabled)
  }
  if (String(runtimeConfig?.rewrite?.provider || '').trim().toLowerCase() === 'none') {
    rewriteEnabled = false
  }
  if (parsed?.duckingEnabled !== undefined) {
    duckingEnabled = normalizeDuckingEnabled(parsed?.duckingEnabled)
  }
  if (parsed?.duckingLevel !== undefined) {
    duckingLevel = normalizeDuckingLevel(parsed?.duckingLevel)
  }
  preferredInputDeviceId = normalizeInputDeviceId(parsed?.inputDeviceId)
}

async function saveTraySettings() {
  await writeJsonFile(traySettingsPath, {
    hotkey: hotkeyManagedByEnv() ? undefined : trayHotkey,
    rewriteEnabled,
    duckingEnabled,
    duckingLevel,
    inputDeviceId: preferredInputDeviceId || undefined
  })
}

function buildFallbackIcon(size = 256) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0c1724"/>
          <stop offset="100%" stop-color="#173451"/>
        </linearGradient>
        <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#8df7d6"/>
          <stop offset="100%" stop-color="#49b9ff"/>
        </linearGradient>
      </defs>
      <rect x="12" y="12" width="232" height="232" rx="52" fill="url(#bg)"/>
      <rect x="82" y="46" width="92" height="118" rx="46" fill="url(#accent)"/>
      <rect x="70" y="152" width="116" height="16" rx="8" fill="url(#accent)"/>
      <rect x="116" y="166" width="24" height="34" rx="12" fill="url(#accent)"/>
      <path d="M74 114c0 30 24 54 54 54s54-24 54-54" fill="none" stroke="url(#accent)" stroke-width="16" stroke-linecap="round"/>
    </svg>
  `.trim()
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
}

function loadIconSvgSource() {
  try {
    return readFileSync(APP_ICON_SVG_PATH, 'utf8')
  } catch {
    return ''
  }
}

function buildTrayIconVariant(kind = 'ready', size = 64) {
  const palette = TRAY_ICON_PALETTES[kind] || TRAY_ICON_PALETTES.ready
  const sourceSvg = loadIconSvgSource()
  if (!sourceSvg) {
    return buildFallbackIcon(size)
  }

  const recoloredSvg = sourceSvg
    .replace(/#0dcdfc/gi, palette.accent)
    .replace(/#20a3f5/gi, palette.primary)
    .replace(/#3378ed/gi, palette.depth)
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(recoloredSvg).toString('base64')}`)
  return image.isEmpty()
    ? buildFallbackIcon(size)
    : image.resize({ width: size, height: size, quality: 'best' })
}

function trayIconState() {
  return voiceState.phase === 'idle' ? 'ready' : 'hot'
}

function loadIconAsset() {
  const iconPath = process.platform === 'win32' ? APP_ICON_ICO_PATH : APP_ICON_PNG_PATH
  const primaryIcon = nativeImage.createFromPath(iconPath)
  if (!primaryIcon.isEmpty()) {
    return primaryIcon
  }

  const fallbackIcon = nativeImage.createFromPath(APP_ICON_PNG_PATH)
  if (!fallbackIcon.isEmpty()) {
    return fallbackIcon
  }

  return null
}

function appIcon() {
  if (windowIcon && !windowIcon.isEmpty()) {
    return windowIcon
  }

  windowIcon = loadIconAsset() || buildFallbackIcon(256)
  return windowIcon
}

function currentTrayIcon() {
  const state = trayIconState()
  const cached = trayIcons.get(state)
  if (cached && !cached.isEmpty()) {
    return cached
  }

  const icon = buildTrayIconVariant(state, 64)
  trayIcons.set(state, icon)
  return icon
}

function configureSessionPermissions(targetSession) {
  if (!targetSession) {
    return
  }

  targetSession.setPermissionCheckHandler((_webContents, permission) => {
    return ALLOWED_PERMISSIONS.has(String(permission || '').trim().toLowerCase())
  })

  targetSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(String(permission || '').trim().toLowerCase()))
  })
}

function installPermissionHandlers() {
  configureSessionPermissions(session.defaultSession)
}

async function ensureVoiceWindow() {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    return voiceWindow
  }

  voiceWindow = new BrowserWindow({
    show: false,
    width: VOICE_OVERLAY_WIDTH,
    height: VOICE_OVERLAY_HEIGHT,
    icon: appIcon(),
    skipTaskbar: true,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false
    }
  })

  voiceWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      voiceWindow.hide()
    }
  })

  await voiceWindow.loadFile(path.join(__dirname, 'voice.html'))
  voiceWindow.setAlwaysOnTop(true, 'screen-saver')
  voiceWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  voiceWindow.setIgnoreMouseEvents(true, { forward: true })
  syncVoiceOverlay()
  syncAudioInputConfig(voiceWindow, { refresh: true })
  return voiceWindow
}

async function ensureInputSourceWindow() {
  if (inputSourceWindow && !inputSourceWindow.isDestroyed()) {
    return inputSourceWindow
  }

  inputSourceWindow = new BrowserWindow({
    show: false,
    width: INPUT_SOURCE_WINDOW_WIDTH,
    height: INPUT_SOURCE_WINDOW_HEIGHT,
    minWidth: INPUT_SOURCE_WINDOW_WIDTH,
    minHeight: INPUT_SOURCE_WINDOW_HEIGHT,
    autoHideMenuBar: true,
    backgroundColor: '#08131a',
    title: `${APP_NAME} Input Source`,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false
    }
  })

  inputSourceWindow.on('closed', () => {
    inputSourceWindow = null
  })

  await inputSourceWindow.loadFile(path.join(__dirname, 'input-source.html'))
  syncAudioInputConfig(inputSourceWindow, { refresh: true })
  return inputSourceWindow
}

async function openInputSourceWindow() {
  const window = await ensureInputSourceWindow()
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
  return window
}

async function ensureOnboardingWindow() {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    return onboardingWindow
  }

  onboardingWindow = new BrowserWindow({
    show: false,
    width: 520,
    height: 660,
    minWidth: 520,
    minHeight: 660,
    maxWidth: 520,
    maxHeight: 660,
    resizable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#08131a',
    title: `${APP_NAME} Quick Start`,
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'onboarding-preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      sandbox: false
    }
  })

  onboardingWindow.on('closed', () => {
    onboardingWindow = null
  })

  await onboardingWindow.loadFile(path.join(__dirname, 'onboarding.html'))
  return onboardingWindow
}

async function openOnboardingWindow({ markSeen = false } = {}) {
  const window = await ensureOnboardingWindow()
  if (markSeen && !onboardingState.seenAt) {
    onboardingState.seenAt = new Date().toISOString()
    await saveOnboardingState().catch(() => null)
    rebuildMenu()
  }
  if (window.isMinimized()) {
    window.restore()
  }
  window.show()
  window.focus()
  return window
}

async function maybeShowOnboarding() {
  if (!FORCE_ONBOARDING && onboardingState.seenAt) {
    return
  }
  await openOnboardingWindow({ markSeen: !onboardingState.seenAt }).catch((error) => {
    console.error(`[dictray] Failed to open onboarding: ${error?.message || error}`)
  })
}

function onboardingStatePayload() {
  const currentSpeechEffort = normalizeSpeechEffort(onboardingState?.choices?.speechEffort)
    || speechEffortForModel(runtimeConfig?.stt?.local?.model || sttPreferences.currentModel || 'base.en')
  return {
    sampleText: ONBOARDING_SAMPLE_TEXT,
    state: onboardingState,
    runtime: {
      sttProvider: String(speech?.label || latestHealth.stt?.providerLabel || runtimeConfig?.stt?.provider || '').trim(),
      rewriteProvider: String(rewriteProvider?.label || latestHealth.rewrite?.providerLabel || runtimeConfig?.rewrite?.provider || '').trim(),
      rewriteEnabled,
      speechEffort: currentSpeechEffort,
      hotkey: trayHotkey,
      hotkeyManagedByEnv: hotkeyManagedByEnv(),
      hotkeyPresets: HOTKEY_PRESETS
    }
  }
}

async function completeOnboarding(input = {}) {
  const measuredAt = new Date().toISOString()
  const profileName = normalizeProfileName(input?.profile?.name)
  const rewriteCleanup = Boolean(input?.choices?.rewriteCleanup)
  const speechEffort = normalizeSpeechEffort(input?.choices?.speechEffort)
    || speechEffortForModel(runtimeConfig?.stt?.local?.model || sttPreferences.currentModel || 'base.en')
  const pushToTalkHotkey = normalizeTrayHotkey(input?.choices?.pushToTalkHotkey || trayHotkey || DEFAULT_HOTKEY)
  const typingBenchmark = buildTypingBenchmark({
    ...input?.typingBenchmark,
    measuredAt
  })
  if (!typingBenchmark.elapsedMs) {
    throw new Error('Complete the typing benchmark before finishing Quick Start.')
  }
  if (!profileName) {
    throw new Error('Add your name before finishing Quick Start.')
  }

  onboardingState = normalizeOnboardingState({
    ...onboardingState,
    seenAt: onboardingState.seenAt || measuredAt,
    completedAt: measuredAt,
    profile: {
      ...onboardingState.profile,
      name: profileName
    },
    choices: {
      ...onboardingState.choices,
      rewriteCleanup,
      speechEffort,
      pushToTalkHotkey
    },
    typingBenchmark
  })

  runtimeConfig.stt.local.model = sttModelForSpeechEffort(onboardingState.choices.speechEffort)
  speech = createSttProvider({
    ...runtimeConfig.stt,
    rootDir: runtimeConfig.rootDir
  }, stateDir)
  sttReadyForDictation = false

  if (!hotkeyManagedByEnv()) {
    trayHotkey = onboardingState.choices.pushToTalkHotkey
    await registerHotkey()
  }

  if (rewriteCleanup && rewriteProviderId() === 'none') {
    runtimeConfig.rewrite.provider = 'ollama'
    rewriteProvider = createRewriteProvider(runtimeConfig.rewrite)
  }

  rewriteEnabled = rewriteCleanup && rewriteProviderId() !== 'none'
  await writeSharedRewritePreferences({
    provider: runtimeConfig.rewrite.provider,
    think: currentRewriteThink,
    model: currentRewriteModel,
    temperature: currentRewriteTemperature
  })
  await saveTraySettings()
  await saveOnboardingState()
  await scheduleSttWarmup({ notifyReady: false }).catch(() => null)
  await refreshRuntimeState(false)
  rebuildMenu()
  return onboardingStatePayload()
}

function updateVoiceState(patch = {}) {
  voiceState = {
    ...voiceState,
    ...patch
  }
  rebuildMenu()
  syncVoiceOverlay()
}

function clearVoiceState(error = '') {
  updateVoiceState({
    phase: 'idle',
    transcript: '',
    finalText: '',
    targetWindow: '',
    targetBounds: null,
    targetElementBounds: null,
    note: '',
    error: String(error || '')
  })
}

function phaseLabel() {
  switch (voiceState.phase) {
    case 'listening':
      return 'State: listening'
    case 'transcribing':
      return 'State: transcribing'
    case 'rewriting':
      return 'State: rewriting'
    case 'inserting':
      return 'State: inserting'
    case 'pending_insert':
      return 'State: waiting to insert'
    case 'processing':
      return 'State: processing'
    default:
      return 'State: idle'
  }
}

function runtimeLabel() {
  const device = String(sttPreferences.currentDevice || '').trim()
  const model = String(sttPreferences.currentModel || '').trim()
  const modelLabel = model
    ? sttModelMenuLabel(runtimeSttModelPreference(model) || model)
    : ''
  return [device ? sttDeviceLabel(device) : '', modelLabel].filter(Boolean).join(' / ') || 'Ready'
}

function healthValue(ok, up = 'ready', down = 'down') {
  return ok ? up : down
}

function sttDeviceLabel(value) {
  return value === STT_DEVICE_GPU ? 'GPU (CUDA)' : 'CPU'
}

function sttModelMenuLabel(value) {
  switch (String(value || '').trim().toLowerCase()) {
    case STT_MODEL_TINY:
      return 'Tiny (tiny.en)'
    case STT_MODEL_MIDDLE:
      return 'Middle (base.en)'
    case STT_MODEL_ADVANCED:
      return 'Advanced (small.en)'
    default:
      return String(value || 'Unknown')
  }
}

function rewriteProviderId() {
  return String(rewriteProvider?.id || runtimeConfig?.rewrite?.provider || 'none').trim() || 'none'
}

function rewriteProviderLabel() {
  return String(rewriteProvider?.label || latestHealth.rewrite?.providerLabel || rewriteProviderId()).trim() || TEXT_IMPROVEMENT_LABEL
}

function rewriteProviderMenuLabel(value = rewriteProviderId()) {
  switch (normalizeRewriteProviderId(value)) {
    case 'ollama':
      return 'Ollama'
    case 'none':
    default:
      return 'Off'
  }
}

function rewriteSupportsModelSelection() {
  return Boolean(rewriteProvider?.supportsModelSelection?.())
}

function rewriteStatusLabel() {
  if (rewriteProviderId() === 'none') {
    return 'disabled'
  }
  return currentRewriteModel || rewriteProviderLabel()
}

function rewriteThinkSetting() {
  return normalizeRewriteThink(currentRewriteThink || runtimeConfig?.rewrite?.ollama?.think || 'off')
}

function rebuildMenu() {
  if (!tray) {
    return
  }

  const targetLabel = voiceState.targetWindow || 'No active target'
  const noteLabel = voiceState.error
    ? `Error: ${compactText(voiceState.error, 110)}`
    : voiceState.note
      ? `Note: ${compactText(voiceState.note, 110)}`
      : 'Note: none'
  const greetingMenuLabel = greetingLabel()
  const dailyCharacterLabel = `Keys Saved Today: ${formatCount(currentDailyCharacterCount())}`
  const dailyTimeSavedLabel = compactText(timeSavedTrayLabel(), 110)
  const quickStartMenuLabel = onboardingCompleted() ? 'Open Quick Start' : 'Finish Quick Start'
  const historyMenu = outputHistory.entries.length > 0
    ? [{
        label: 'Click any entry to copy it',
        enabled: false
      }, {
        type: 'separator'
      }, ...outputHistory.entries.map((entry) => ({
        label: outputHistoryMenuLabel(entry),
        click: () => {
          clipboard.writeText(String(entry?.text || ''))
          showNotification(APP_NAME, 'Saved text copied to clipboard.')
        }
      }))]
    : [{
        label: 'No saved text yet',
        enabled: false
      }]

  const modelMenu = rewriteSupportsModelSelection()
    ? rewriteModels.length
      ? rewriteModels.map((model) => ({
        label: String(model?.name || '').trim() || 'unknown',
        type: 'radio',
        checked: String(model?.name || '').trim() === currentRewriteModel,
        click: () => {
          void switchRewriteModel(String(model?.name || '').trim())
        }
      }))
      : [{
          label: latestHealth.rewrite?.ok === false
            ? `Unavailable: ${compactText(latestHealth.rewrite?.error || `${rewriteProviderLabel()} is down`, 70)}`
            : `No ${rewriteProviderLabel()} models found`,
          enabled: false
        }]
    : [{
        label: rewriteProviderId() === 'none'
          ? 'Choose Text Improvement Provider first'
          : `Model selection unavailable for ${rewriteProviderLabel()}`,
        enabled: false
      }]

  const rewriteThinkMenu = [{
    label: `Current: ${rewriteThinkMenuLabel(currentRewriteThink)}`,
    enabled: false
  }, {
    label: 'Off',
    type: 'radio',
    checked: normalizeRewriteThink(currentRewriteThink) === 'off',
    click: () => {
      void updateRewriteThink('off')
    }
  }, {
    label: 'Default',
    type: 'radio',
    checked: normalizeRewriteThink(currentRewriteThink) === 'default',
    click: () => {
      void updateRewriteThink('default')
    }
  }, {
    label: 'On',
    type: 'radio',
    checked: normalizeRewriteThink(currentRewriteThink) === 'on',
    click: () => {
      void updateRewriteThink('on')
    }
  }]

  const rewriteTemperatureMenu = [{
    label: `Current: ${rewriteTemperatureLabel()}`,
    enabled: false
  }, ...REWRITE_TEMPERATURE_OPTIONS.map((value) => ({
    label: rewriteTemperatureLabel(value),
    type: 'radio',
    checked: normalizeRewriteTemperature(currentRewriteTemperature) === value,
    click: () => {
      void updateRewriteTemperature(value)
    }
  }))]

  const rewriteProviderMenu = [{
    label: `Current: ${rewriteProviderMenuLabel()}`,
    enabled: false
  }, {
    label: 'Off',
    type: 'radio',
    checked: rewriteProviderId() === 'none',
    click: () => {
      void updateRewriteProvider('none')
    }
  }, {
    label: 'Ollama',
    type: 'radio',
    checked: rewriteProviderId() === 'ollama',
    click: () => {
      void updateRewriteProvider('ollama')
    }
  }]

  const selectedInputDevice = selectedInputSource()
  const inputSourceMenu = [
    {
      label: `Current: ${inputSourceMenuLabel()}`,
      enabled: false
    },
    {
      label: 'Open Live Preview',
      click: () => {
        void openInputSourceWindow()
      }
    },
    { type: 'separator' },
    ...(preferredInputDeviceId && inputDeviceState.available.length && !selectedInputDevice
      ? [{
          label: 'Selected microphone is unavailable. Falling back to the system default when needed.',
          enabled: false
        }]
      : []),
    ...(inputDeviceState.error
      ? [{
          label: `Status: ${compactText(inputDeviceState.error, 72)}`,
          enabled: false
        }]
      : []),
    {
      label: 'System Default',
      type: 'radio',
      checked: !preferredInputDeviceId,
      click: () => {
        void updateInputSourcePreference('')
      }
    },
    ...(inputDeviceState.available.length
      ? inputDeviceState.available.map((device) => ({
          label: compactText(device.label, 56),
          type: 'radio',
          checked: preferredInputDeviceId === device.deviceId,
          click: () => {
            void updateInputSourcePreference(device.deviceId)
          }
        }))
      : [{
          label: inputDeviceState.permission === 'denied'
            ? 'Microphone access denied'
            : inputDeviceState.permission === 'granted'
              ? 'No microphones detected'
              : 'Start dictation once to grant microphone access',
          enabled: false
        }]),
    { type: 'separator' },
    {
      label: 'Refresh Inputs',
      click: () => {
        void refreshInputSources()
      }
    }
  ]

  const sttDeviceMenu = sttPreferences.supported
    ? sttPreferences.options.map((value) => ({
        label: sttDeviceLabel(value),
        type: 'radio',
        checked: sttPreferences.selectedDevice === value,
        click: () => {
          void updateSttPreferences({ sttDevice: value })
        }
      }))
    : [{
        label: 'Available only for the HTTP STT provider',
        enabled: false
      }]

  const sttModelMenu = sttPreferences.supported
    ? sttPreferences.modelOptions.map((value) => ({
        label: sttModelMenuLabel(value),
        type: 'radio',
        checked: sttPreferences.selectedModel === value,
        click: () => {
          void updateSttPreferences({ sttModel: value })
        }
      }))
    : [{
        label: 'Available only for the HTTP STT provider',
        enabled: false
      }]

  const duckingLevelMenu = DUCKING_LEVEL_OPTIONS.map((value) => ({
    label: `Duck To ${duckingPercentLabel(value)}`,
    type: 'radio',
    checked: duckingLevel === value,
    click: () => {
      void updateDuckingLevel(value)
    }
  }))

  const menu = Menu.buildFromTemplate([
    { label: greetingMenuLabel, enabled: false },
    { label: dailyTimeSavedLabel, enabled: false },
    { label: dailyCharacterLabel, enabled: false },
    { label: `Target: ${compactText(targetLabel, 90)}`, enabled: false },
    { label: `${SPEECH_TO_TEXT_LABEL}: ${healthValue(latestHealth.stt?.ok, runtimeLabel(), compactText(latestHealth.stt?.error || runtimeLabel(), 70))}`, enabled: false },
    { label: `${TEXT_IMPROVEMENT_LABEL}: ${healthValue(latestHealth.rewrite?.ok, rewriteStatusLabel(), compactText(latestHealth.rewrite?.error || rewriteStatusLabel(), 70))}`, enabled: false },
    {
      label: 'History',
      submenu: historyMenu
    },
    { label: noteLabel, enabled: false },
    { type: 'separator' },
    {
      label: voiceState.phase === 'listening'
        ? 'Stop Dictation'
        : voiceState.phase === 'pending_insert'
          ? 'Cancel Pending Insert'
          : 'Start Dictation',
      click: () => {
        void toggleDictationCapture()
      }
    },
    {
      label: 'Improve Text',
      type: 'checkbox',
      checked: rewriteEnabled,
      click: (item) => {
        void updateRewriteEnabled(Boolean(item.checked))
      }
    },
    {
      label: 'Text Improvement Provider',
      submenu: rewriteProviderMenu
    },
    {
      label: 'Output Ducking',
      submenu: [
        {
          label: duckingEnabled ? `Enabled (${duckingPercentLabel()})` : 'Disabled',
          enabled: false
        },
        {
          label: 'Enable Ducking',
          type: 'checkbox',
          checked: duckingEnabled,
          click: (item) => {
            void updateDuckingEnabled(Boolean(item.checked))
          }
        },
        { type: 'separator' },
        ...duckingLevelMenu
      ]
    },
    {
      label: 'Text Improvement Model',
      submenu: modelMenu
    },
    {
      label: 'Text Improvement Thinking',
      submenu: rewriteThinkMenu
    },
    {
      label: 'Text Improvement Temperature',
      submenu: rewriteTemperatureMenu
    },
    {
      label: 'Input Source',
      submenu: inputSourceMenu
    },
    {
      label: 'Speech to Text Device',
      submenu: sttDeviceMenu
    },
    {
      label: 'Speech to Text Model',
      submenu: sttModelMenu
    },
    {
      label: 'Shortcut',
      submenu: hotkeyManagedByEnv()
        ? [{
            label: `Managed by DICTATION_TRAY_HOTKEY: ${formatHotkey(trayHotkey)}`,
            enabled: false
          }]
        : HOTKEY_PRESETS.map((preset) => ({
            label: preset.label,
            type: 'radio',
            checked: trayHotkey === preset.value,
            click: () => {
              void updateTrayHotkey(preset.value)
            }
          }))
    },
    { type: 'separator' },
    {
      label: quickStartMenuLabel,
      click: () => {
        void openOnboardingWindow({ markSeen: true })
      }
    },
    {
      label: 'Open state folder',
      click: () => {
        void shell.openPath(stateDir)
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit()
    }
  ])

  tray.setImage(currentTrayIcon())
  tray.setContextMenu(menu)
  tray.setToolTip(`${APP_NAME} - ${phaseLabel().replace('State: ', '')}`)
}

async function listRewriteModels() {
  if (!rewriteProvider) {
    return {
      ok: false,
      supported: false,
      error: 'Rewrite provider is not ready.',
      models: []
    }
  }
  return rewriteProvider.listModels()
}

async function waitForSttHealthy(timeoutMs = 45000) {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < timeoutMs) {
    const health = await speech.checkSttHealth().catch(() => null)
    if (health?.ok) {
      return health
    }
    await sleep(1500)
  }
  return null
}

function scheduleSttWarmup({
  waitForHealthy = false,
  notifyReady = false
} = {}) {
  if (!sttWarmupInFlight) {
    sttReadyForDictation = false
    const pending = (async () => {
      try {
        if (!speech) {
          return { ok: false, skipped: true, reason: 'not_ready' }
        }
        if (waitForHealthy) {
          const health = await waitForSttHealthy().catch(() => null)
          if (!health?.ok) {
            return { ok: false, reason: 'stt_unhealthy' }
          }
        }
        const result = await speech.warmStt().catch(() => ({ ok: false, reason: 'warmup_failed' }))
        sttReadyForDictation = Boolean(result?.ok)
        if (!result?.ok) {
          logSttDiagnostic('warmup', latestHealth.stt)
        }
        return result
      } finally {
        if (sttWarmupInFlight === pending) {
          sttWarmupInFlight = null
        }
      }
    })()

    sttWarmupInFlight = pending
  }

  if (notifyReady && !sttReadyNotificationAttached) {
    sttReadyNotificationAttached = true
    void sttWarmupInFlight.finally(() => {
      if (sttReadyForDictation) {
        notifySttReady()
      }
      sttReadyNotificationAttached = false
    })
  }

  return sttWarmupInFlight
}

async function waitForPendingSttWarmup(signal = null) {
  const pending = sttWarmupInFlight
  if (!pending) {
    return null
  }
  if (!signal) {
    return pending
  }
  if (signal.aborted) {
    throw abortReasonAsError(signal.reason)
  }

  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(abortReasonAsError(signal.reason))
    }

    signal.addEventListener('abort', onAbort, { once: true })
    pending.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

async function duckSystemVolumeForPushToTalk(force = false) {
  if (process.platform !== 'win32' || !systemVolume || !duckingEnabled) {
    return
  }
  if (volumeDuckState && !force) {
    return
  }

  try {
    if (volumeDuckState && force) {
      await systemVolume.setState({
        level: duckingLevel,
        muted: false
      })
      return
    }

    const state = await systemVolume.getState()
    const currentLevel = clampUnitInterval(Number(state?.level))
    const currentMuted = Boolean(state?.muted)
    if (currentMuted || currentLevel <= duckingLevel) {
      return
    }

    volumeDuckState = {
      level: currentLevel,
      muted: currentMuted
    }
    await systemVolume.setState({
      level: duckingLevel,
      muted: false
    })
  } catch (error) {
    if (!force) {
      volumeDuckState = null
    }
    console.error(`[dictray] Failed to duck system volume: ${error?.message || error}`)
  }
}

async function restoreSystemVolumeAfterPushToTalk() {
  if (process.platform !== 'win32' || !systemVolume || !volumeDuckState) {
    return
  }

  const previous = volumeDuckState
  volumeDuckState = null
  try {
    await systemVolume.setState({
      level: previous.level,
      muted: previous.muted
    })
  } catch (error) {
    console.error(`[dictray] Failed to restore system volume: ${error?.message || error}`)
  }
}

function clearSttKeepWarmTimer() {
  if (sttKeepWarmTimer) {
    clearInterval(sttKeepWarmTimer)
    sttKeepWarmTimer = null
  }
}

async function runSttKeepWarmTick() {
  if (sttKeepWarmInFlight || !speech?.config?.enabled) {
    return
  }
  if (voiceState.phase !== 'idle' || activeSubmission || sttWarmupInFlight) {
    return
  }

  sttKeepWarmInFlight = true
  try {
    const health = await speech.checkSttHealth().catch(() => null)
    if (!health?.ok) {
      return
    }
    await speech.warmStt().catch(() => null)
  } finally {
    sttKeepWarmInFlight = false
  }
}

function startSttKeepWarmTimer() {
  clearSttKeepWarmTimer()

  const intervalMs = Math.max(0, Number(runtimeConfig?.speech?.stt?.keepWarmIntervalMs || 0))
  if (!intervalMs || !speech?.config?.enabled) {
    return
  }

  sttKeepWarmTimer = setInterval(() => {
    void runSttKeepWarmTick()
  }, intervalMs)
}

function shouldSkipBackgroundRuntimeRefresh() {
  if (!speech || speech.id !== 'local') {
    return false
  }
  return Boolean(
    activeSubmission
    || sttWarmupInFlight
    || sttKeepWarmInFlight
    || voiceState.phase !== 'idle'
  )
}

async function refreshRuntimeState(notify = false) {
  const [sttHealth, rewriteHealth, automationHealth, runtime, modelsPayload] = await Promise.all([
    speech.checkSttHealth(),
    rewriteProvider.checkHealth(),
    uiAutomation.checkHealth(),
    speech.getRuntime(),
    listRewriteModels()
  ])

  latestHealth = {
    stt: sttHealth,
    rewrite: rewriteHealth,
    automation: automationHealth
  }

  currentRewriteModel = String(currentRewriteModel || runtimeConfig.rewrite?.ollama?.model || '').trim()
  rewriteModels = Array.isArray(modelsPayload?.models) ? modelsPayload.models : []

  const currentDevice = runtime.supported
    ? runtimeSttDevicePreference(runtime.device)
    : sttHealth?.ok
      ? normalizeSttDevicePreference(sttHealth.device)
      : ''
  const currentModel = String(runtime.model || '').trim() || (sttHealth?.ok ? String(sttHealth.model || '').trim() : '')

  const supported = Boolean(runtime.supported && typeof speech?.supportsRuntimePreferences === 'function' && speech.supportsRuntimePreferences())
  const availableDevices = runtimeSttDeviceOptions(runtime.availableDevices)
  const storedPreferences = supported
    ? await readSharedSpeechPreferences().catch(() => ({ sttDevice: '', sttModel: '' }))
    : { sttDevice: '', sttModel: '' }

  sttPreferences = {
    supported,
    options: availableDevices,
    modelOptions: sttModelPreferenceOptions(),
    selectedDevice: storedPreferences.sttDevice || currentDevice || availableDevices[0] || '',
    selectedModel: storedPreferences.sttModel || runtimeSttModelPreference(currentModel) || STT_MODEL_MIDDLE,
    provider: String(sttHealth?.providerLabel || speech?.label || runtimeConfig?.stt?.provider || '').trim(),
    currentDevice,
    currentModel,
    error: String(runtime.error || sttHealth?.error || '').trim()
  }

  const sttHealthSnapshot = {
    ok: Boolean(sttHealth?.ok),
    error: String(sttHealth?.error || '').trim(),
    detail: String(sttHealth?.detail || '').trim(),
    pythonBin: String(sttHealth?.pythonBin || runtimeConfig?.stt?.local?.pythonBin || '').trim(),
    transcribeScript: String(sttHealth?.transcribeScript || runtimeConfig?.stt?.local?.transcribeScript || '').trim(),
    model: String(sttHealth?.model || runtimeConfig?.stt?.local?.model || '').trim(),
    modelDir: String(sttHealth?.modelDir || runtimeConfig?.stt?.local?.modelDir || '').trim(),
    device: String(sttHealth?.device || runtimeConfig?.stt?.local?.device || '').trim(),
    computeType: String(sttHealth?.computeType || runtimeConfig?.stt?.local?.computeType || '').trim()
  }
  const sttHealthSignature = JSON.stringify(sttHealthSnapshot)
  if (sttHealthSignature !== lastSttHealthLogSignature) {
    lastSttHealthLogSignature = sttHealthSignature
    void appendDiagnosticsLog('stt-health', sttHealthSnapshot)
  }

  if (!sttHealth?.ok) {
    logSttDiagnostic('health-check', sttHealth)
  }

  if (notify) {
    if (sttHealth.ok && (rewriteProviderId() === 'none' || rewriteHealth.ok)) {
      showNotification(APP_NAME, rewriteProviderId() === 'none' ? `${SPEECH_TO_TEXT_LABEL} is responding. ${TEXT_IMPROVEMENT_LABEL} is off.` : `${SPEECH_TO_TEXT_LABEL} and ${TEXT_IMPROVEMENT_LABEL.toLowerCase()} are responding.`)
    } else {
      const problems = [
        !sttHealth.ok ? `${SPEECH_TO_TEXT_LABEL}: ${compactText(sttHealth.error || 'down', 60)}` : '',
        rewriteProviderId() !== 'none' && !rewriteHealth.ok ? `${rewriteProviderLabel()}: ${compactText(rewriteHealth.error || 'down', 60)}` : ''
      ].filter(Boolean)
      showNotification(APP_NAME, problems.join(' | ') || 'Runtime health check failed.')
    }
  }

  rebuildMenu()
}

async function updateRewriteEnabled(value) {
  if (Boolean(value) && rewriteProviderId() === 'none') {
    rewriteEnabled = false
    await saveTraySettings()
    rebuildMenu()
    showNotification(APP_NAME, 'Choose Text Improvement Provider > Ollama before turning on Improve Text.')
    await refreshRuntimeState(false)
    return
  }

  rewriteEnabled = Boolean(value)
  await saveTraySettings()
  rebuildMenu()
  if (!rewriteEnabled) {
    showNotification(APP_NAME, `${TEXT_IMPROVEMENT_LABEL} is off. Raw speech text will be inserted.`)
    await refreshRuntimeState(false)
    return
  }

  const modelName = String(currentRewriteModel || runtimeConfig?.rewrite?.ollama?.model || '').trim()
  showNotification(APP_NAME, modelName ? `${TEXT_IMPROVEMENT_LABEL} is on. Warming ${modelName}.` : `${TEXT_IMPROVEMENT_LABEL} is on.`)
  try {
    const warmResult = await warmSelectedModel()
    if (warmResult?.ok === false || warmResult?.skipped) {
      showNotification(APP_NAME, rewriteProviderId() === 'none' ? `${TEXT_IMPROVEMENT_LABEL} is on, but no provider is configured.` : `${TEXT_IMPROVEMENT_LABEL} is on, but model warmup was skipped.`)
    } else {
      showNotification(APP_NAME, modelName ? `${modelName} is ready for text improvement.` : `${TEXT_IMPROVEMENT_LABEL} is ready.`)
    }
  } catch (error) {
    showNotification(APP_NAME, `${TEXT_IMPROVEMENT_LABEL} is on, but model warmup failed: ${compactText(error?.message || error, 96)}`)
  } finally {
    await refreshRuntimeState(false)
  }
}

async function updateRewriteProvider(value) {
  const providerId = normalizeRewriteProviderId(value)
  if (providerId === rewriteProviderId()) {
    return
  }

  runtimeConfig.rewrite.provider = providerId
  rewriteProvider = createRewriteProvider(runtimeConfig.rewrite)

  if (providerId === 'none') {
    rewriteEnabled = false
    rewriteModels = []
  }

  await writeSharedRewritePreferences({
    provider: providerId,
    think: currentRewriteThink,
    model: currentRewriteModel,
    temperature: currentRewriteTemperature
  })
  await saveTraySettings()
  rebuildMenu()
  await refreshRuntimeState(false)

  if (providerId === 'none') {
    showNotification(APP_NAME, `${TEXT_IMPROVEMENT_LABEL} is off.`)
    return
  }

  showNotification(APP_NAME, `${TEXT_IMPROVEMENT_LABEL} provider set to ${rewriteProviderMenuLabel(providerId)}. Turn on Improve Text when ready.`)
}

async function updateDuckingEnabled(value) {
  duckingEnabled = Boolean(value)
  await saveTraySettings()
  rebuildMenu()
  if (!duckingEnabled) {
    void restoreSystemVolumeAfterPushToTalk().catch(() => {})
    showNotification(APP_NAME, 'Output ducking disabled.')
    return
  }

  showNotification(APP_NAME, `Output ducking enabled. Target volume: ${duckingPercentLabel()}.`)
  if (voiceState.phase === 'listening') {
    await duckSystemVolumeForPushToTalk(Boolean(volumeDuckState)).catch(() => null)
  }
}

async function updateDuckingLevel(value) {
  duckingLevel = normalizeDuckingLevel(value)
  await saveTraySettings()
  rebuildMenu()
  if (!duckingEnabled) {
    showNotification(APP_NAME, `Output ducking target set to ${duckingPercentLabel()}. Enable ducking to apply it.`)
    return
  }

  showNotification(APP_NAME, `Output ducking set to ${duckingPercentLabel()} while recording.`)
  if (voiceState.phase === 'listening') {
    await duckSystemVolumeForPushToTalk(Boolean(volumeDuckState)).catch(() => null)
  }
}

async function updateTrayHotkey(value) {
  trayHotkey = normalizeTrayHotkey(value)
  await saveTraySettings()
  await registerHotkey()
  rebuildMenu()
  showNotification(APP_NAME, `Shortcut set to ${formatHotkey(trayHotkey)}.`)
}

async function updateRewriteThink(value) {
  const nextValue = normalizeRewriteThink(value)
  if (nextValue === normalizeRewriteThink(currentRewriteThink)) {
    return
  }

  currentRewriteThink = nextValue
  runtimeConfig.rewrite.ollama.think = nextValue
  runtimeConfig.ollama.think = nextValue
  await writeSharedRewritePreferences({
    provider: runtimeConfig.rewrite.provider,
    think: nextValue,
    model: currentRewriteModel,
    temperature: currentRewriteTemperature
  })
  rebuildMenu()
  showNotification(APP_NAME, `Text improvement thinking set to ${rewriteThinkMenuLabel(nextValue)}.`)
}

async function updateRewriteTemperature(value) {
  const nextValue = normalizeRewriteTemperature(value)
  if (nextValue === normalizeRewriteTemperature(currentRewriteTemperature)) {
    return
  }

  currentRewriteTemperature = nextValue
  runtimeConfig.rewrite.ollama.temperature = nextValue
  runtimeConfig.ollama.temperature = nextValue
  await writeSharedRewritePreferences({
    provider: runtimeConfig.rewrite.provider,
    think: currentRewriteThink,
    model: currentRewriteModel,
    temperature: nextValue
  })
  rebuildMenu()
  showNotification(APP_NAME, `Text improvement temperature set to ${rewriteTemperatureLabel(nextValue)}.`)
}

async function updateInputSourcePreference(value) {
  const nextDeviceId = normalizeInputDeviceId(value)
  if (nextDeviceId === preferredInputDeviceId) {
    syncAllAudioInputConfig({ refresh: true })
    rebuildMenu()
    return
  }

  preferredInputDeviceId = nextDeviceId
  await saveTraySettings()
  rebuildMenu()
  syncAllAudioInputConfig({ refresh: true })
  showNotification(APP_NAME, `Input source set to ${inputSourceMenuLabel()}.`)
}

async function refreshInputSources() {
  rebuildMenu()
  syncAllAudioInputConfig({ refresh: true })
}

async function updateSttPreferences(input = {}) {
  const requestedDevice = normalizeSttDevicePreference(input?.sttDevice)
  const requestedModel = normalizeSttModelPreference(input?.sttModel)
  if (!requestedDevice && !requestedModel) {
    return
  }

  if (!providerUsesHttpStt()) {
    showNotification(APP_NAME, `Live ${SPEECH_TO_TEXT_LABEL.toLowerCase()} switching is only supported for the HTTP STT provider, not ${runtimeConfig.stt.provider}.`)
    return
  }

  const stored = await readSharedSpeechPreferences()
  const nextSelectedDevice = requestedDevice || stored.sttDevice || sttPreferences.selectedDevice
  const nextSelectedModel = requestedModel || stored.sttModel || sttPreferences.selectedModel
  const requestedParts = [
    requestedDevice ? `device ${sttDeviceLabel(requestedDevice)}` : '',
    requestedModel ? `model ${sttModelMenuLabel(requestedModel)}` : ''
  ].filter(Boolean)

  sttPreferences = {
    ...sttPreferences,
    selectedDevice: nextSelectedDevice,
    selectedModel: nextSelectedModel,
    error: ''
  }
  rebuildMenu()

  if (requestedParts.length) {
    showNotification(APP_NAME, `Applying ${SPEECH_TO_TEXT_LABEL.toLowerCase()} ${requestedParts.join(' and ')}.`)
  }

  try {
    const runtimePatch = requestedDevice
      ? speechPreferenceRuntimePatch(requestedDevice)
      : {}
    if (requestedModel) {
      runtimePatch.model = sttModelNameForPreference(requestedModel)
    }

    const result = await speech.updateSttRuntime(runtimePatch)
    if (!result.ok) {
      showNotification(APP_NAME, `${SPEECH_TO_TEXT_LABEL} update failed: ${compactText(result.error || 'unknown error', 96)}`)
      await refreshRuntimeState(false)
      return
    }

    await writeSharedSpeechPreferences({
      sttDevice: nextSelectedDevice,
      sttModel: nextSelectedModel
    })
    sttReadyForDictation = false
    await waitForPendingSttWarmup().catch(() => null)
    const warmResult = await scheduleSttWarmup({
      waitForHealthy: true,
      notifyReady: false
    }).catch(() => ({ ok: false, reason: 'warmup_failed' }))
    await refreshRuntimeState(false)

    const appliedDevice = runtimeSttDevicePreference(result.device)
    const appliedModel = runtimeSttModelPreference(result.model)
    const appliedParts = [
      appliedDevice ? sttDeviceLabel(appliedDevice) : '',
      appliedModel ? sttModelMenuLabel(appliedModel) : String(result.model || '').trim()
    ].filter(Boolean)
    if (appliedParts.length) {
      showNotification(APP_NAME, `${SPEECH_TO_TEXT_LABEL} ready: ${appliedParts.join(' / ')}.`)
    }
    if (!warmResult?.ok) {
      showNotification(APP_NAME, `${SPEECH_TO_TEXT_LABEL} runtime changed, but warmup failed. The next dictation may be slower.`)
    }
  } catch (error) {
    showNotification(APP_NAME, `${SPEECH_TO_TEXT_LABEL} update failed: ${compactText(error?.message || error, 96)}`)
    await refreshRuntimeState(false)
  }
}

async function applySharedSpeechPreferencesOnStartup() {
  const stored = await readSharedSpeechPreferences()
  if ((!stored.sttDevice && !stored.sttModel) || !providerUsesHttpStt()) {
    return
  }

  const runtimePatch = stored.sttDevice
    ? speechPreferenceRuntimePatch(stored.sttDevice)
    : {}
  if (stored.sttModel) {
    runtimePatch.model = sttModelNameForPreference(stored.sttModel)
  }
  const currentRuntime = await speech.getSttRuntime().catch(() => null)
  if (currentRuntime?.ok) {
    const sameDevice = runtimePatch.device === undefined || String(currentRuntime.device || '').trim().toLowerCase() === String(runtimePatch.device || '').trim().toLowerCase()
    const sameComputeType = runtimePatch.computeType === undefined || String(currentRuntime.computeType || '').trim().toLowerCase() === String(runtimePatch.computeType || '').trim().toLowerCase()
    const sameModel = runtimePatch.model === undefined || String(currentRuntime.model || '').trim() === String(runtimePatch.model || '').trim()
    if (sameDevice && sameComputeType && sameModel) {
      return currentRuntime
    }
  }
  await speech.updateSttRuntime(runtimePatch).catch(() => null)
}

async function switchRewriteModel(modelName) {
  const name = String(modelName || '').trim()
  if (!name || name === currentRewriteModel) {
    return
  }

  currentRewriteModel = name
  runtimeConfig.rewrite.ollama.model = name
  runtimeConfig.ollama.model = name
  rewriteProvider = createRewriteProvider(runtimeConfig.rewrite)
  await writeSharedRewritePreferences({
    provider: runtimeConfig.rewrite.provider,
    think: currentRewriteThink,
    model: name,
    temperature: currentRewriteTemperature
  })
  rebuildMenu()

  if (!rewriteEnabled) {
    showNotification(APP_NAME, `Text improvement model set to ${name}. ${TEXT_IMPROVEMENT_LABEL} is currently off.`)
    return
  }

  showNotification(APP_NAME, `Switching to ${name} and warming it.`)
  try {
    await warmSelectedModel()
    showNotification(APP_NAME, `${name} is ready for text improvement.`)
  } catch (error) {
    showNotification(APP_NAME, `Model switch saved, but warmup failed: ${compactText(error?.message || error, 96)}`)
  } finally {
    await refreshRuntimeState(false)
  }
}

async function warmSelectedModel() {
  if (!rewriteEnabled) {
    return { ok: false, skipped: true, reason: 'rewrite_disabled' }
  }
  if (!rewriteProvider || rewriteProviderId() === 'none') {
    return { ok: false, skipped: true, reason: 'rewrite_provider_disabled' }
  }
  const modelName = String(currentRewriteModel || runtimeConfig?.rewrite?.ollama?.model || '').trim()
  if (!modelName) {
    return { ok: false, skipped: true, reason: 'missing_model' }
  }
  return rewriteProvider.warmModel(modelName)
}

async function ensureDictationCanStart() {
  if (sttReadyForDictation || !speech?.config?.enabled) {
    return true
  }

  if (!sttWarmupInFlight) {
    void scheduleSttWarmup({
      notifyReady: true
    }).catch(() => {})
  }

  if (latestHealth.stt?.ok === false && latestHealth.stt?.error) {
    logSttDiagnostic('dictation-blocked', latestHealth.stt)
    maybeNotifySttBlocked(`${SPEECH_TO_TEXT_LABEL} is not ready: ${compactText(latestHealth.stt.error, 160)}`)
    return false
  }

  maybeNotifySttBlocked(`Dictation is still starting. ${SPEECH_TO_TEXT_LABEL} is not ready yet. You will get a notification when it is ready.`)
  return false
}

function uniquePush(values, seen, value, limit) {
  const text = compactText(value, 90)
  if (!text) {
    return
  }
  const normalized = text.toLowerCase()
  if (seen.has(normalized)) {
    return
  }
  seen.add(normalized)
  values.push(text)
  if (values.length > limit) {
    values.length = limit
  }
}

function walkSnapshot(node, visitor) {
  if (!node || typeof node !== 'object') {
    return
  }
  visitor(node)
  const children = Array.isArray(node.children) ? node.children : []
  for (const child of children) {
    walkSnapshot(child, visitor)
  }
}

function findFocusedElement(node) {
  let found = null
  walkSnapshot(node, (current) => {
    if (!found && current?.hasKeyboardFocus) {
      found = current
    }
  })
  return found
}

function collectSnapshotSnippets(node, limit = 8) {
  const values = []
  const seen = new Set()
  walkSnapshot(node, (current) => {
    if (values.length >= limit) {
      return
    }
    uniquePush(values, seen, current?.name, limit)
    uniquePush(values, seen, current?.value, limit)
    uniquePush(values, seen, current?.text, limit)
  })
  return values.slice(0, limit)
}

function inferModeHint(windowContext) {
  const text = [
    windowContext?.processName,
    windowContext?.title,
    windowContext?.focusedElement?.controlType,
    windowContext?.focusedElement?.name,
    ...(windowContext?.snippets || [])
  ].join(' ').toLowerCase()

  if (/(outlook|gmail|mail|inbox|subject|compose|draft)/i.test(text)) {
    return 'email'
  }
  if (/(slack|teams|discord|telegram|whatsapp|chat|thread|message)/i.test(text)) {
    return 'chat'
  }
  if (/(cursor|code|visual studio|vscode|terminal|powershell|cmd|console|git)/i.test(text)) {
    return 'code'
  }
  if (/(search|find|omnibox|address bar)/i.test(text)) {
    return 'search'
  }
  if (/(form|input|textbox|textarea|edit)/i.test(text)) {
    return 'form'
  }
  return 'general'
}

function buildWindowPrompt(windowContext) {
  if (!windowContext) {
    return ''
  }

  const lines = []
  if (windowContext.processName) {
    lines.push(`App process: ${windowContext.processName}`)
  }
  if (windowContext.title) {
    lines.push(`Window title: ${windowContext.title}`)
  }
  lines.push(`Mode hint: ${windowContext.modeHint}`)
  if (windowContext.focusedElement) {
    const focused = windowContext.focusedElement
    const parts = [
      focused.controlType ? `type=${focused.controlType}` : '',
      focused.name ? `name=${focused.name}` : '',
      focused.value ? `value=${focused.value}` : '',
      focused.text ? `text=${focused.text}` : ''
    ].filter(Boolean)
    if (parts.length) {
      lines.push(`Focused element: ${parts.join(' | ')}`)
    }
  }
  if (windowContext.snippets?.length) {
    lines.push(`Visible text snippets: ${windowContext.snippets.join(' | ')}`)
  }
  return lines.join('\n')
}

function formatTargetWindow(windowContext) {
  if (!windowContext) {
    return ''
  }
  const title = compactText(windowContext.title, 54)
  const processName = compactText(windowContext.processName, 28)
  if (title && processName) {
    return `${title} (${processName})`
  }
  return title || processName || ''
}

async function captureFocusedWindowContext() {
  const windowsResult = await uiAutomation.listWindows({ limit: 32 })
  const focusedWindow = Array.isArray(windowsResult?.windows)
    ? windowsResult.windows.find((window) => window?.focused) || windowsResult.windows[0]
    : null

  if (!focusedWindow) {
    return null
  }

  const selector = focusedWindow?.hwnd
    ? { hwnd: String(focusedWindow.hwnd).trim() }
    : {
        processName: String(focusedWindow?.processName || '').trim(),
        titleContains: compactText(focusedWindow?.title || '', 120)
      }

  let snapshotResult = null
  try {
    snapshotResult = await uiAutomation.snapshot({
      window: selector,
      maxDepth: 2,
      maxNodes: 60,
      searchLimit: 160
    })
  } catch {
    snapshotResult = null
  }

  const target = snapshotResult?.target
  const focusedElement = findFocusedElement(target)
  const context = {
    selector,
    hwnd: String(focusedWindow?.hwnd || '').trim(),
    title: compactText(focusedWindow?.title || '', 180),
    processName: String(focusedWindow?.processName || '').trim(),
    className: String(focusedWindow?.className || '').trim(),
    windowBounds: normalizeOverlayBounds(focusedWindow?.bounds),
    focusedElement: focusedElement
      ? {
          name: compactText(focusedElement.name || '', 100),
          controlType: String(focusedElement.controlType || '').trim(),
          value: compactText(focusedElement.value || '', 120),
          text: compactText(focusedElement.text || '', 120),
          bounds: normalizeOverlayBounds(focusedElement.bounds)
        }
      : null,
    snippets: collectSnapshotSnippets(target, 8)
  }

  context.modeHint = inferModeHint(context)
  return context
}

async function getFocusedWindowSnapshot() {
  const windowsResult = await uiAutomation.listWindows({ limit: 32 })
  return Array.isArray(windowsResult?.windows)
    ? windowsResult.windows.find((window) => window?.focused) || windowsResult.windows[0] || null
    : null
}

function normalizeWindowToken(value) {
  return String(value || '').trim().toLowerCase()
}

function matchesCapturedWindow(windowContext, candidateWindow) {
  if (!windowContext || !candidateWindow) {
    return false
  }

  const targetHwnd = normalizeWindowToken(windowContext?.hwnd || windowContext?.selector?.hwnd)
  const currentHwnd = normalizeWindowToken(candidateWindow?.hwnd)
  if (targetHwnd && currentHwnd) {
    return targetHwnd === currentHwnd
  }

  const targetProcess = normalizeWindowToken(windowContext?.processName)
  const currentProcess = normalizeWindowToken(candidateWindow?.processName)
  if (targetProcess && currentProcess && targetProcess !== currentProcess) {
    return false
  }

  const targetClass = normalizeWindowToken(windowContext?.className)
  const currentClass = normalizeWindowToken(candidateWindow?.className)
  if (targetClass && currentClass && targetClass !== currentClass) {
    return false
  }

  const targetTitle = normalizeWindowToken(windowContext?.title)
  const currentTitle = normalizeWindowToken(candidateWindow?.title)
  if (targetTitle && currentTitle) {
    return currentTitle.includes(targetTitle) || targetTitle.includes(currentTitle)
  }

  return Boolean(targetProcess || targetClass)
}

async function waitForTargetWindowFocus(windowContext, submission) {
  if (!windowContext?.selector) {
    return null
  }

  let waitingShown = false
  while (true) {
    throwIfSubmissionCancelled(submission)

    let focusedWindow = null
    try {
      focusedWindow = await getFocusedWindowSnapshot()
    } catch {
      return null
    }

    if (!focusedWindow || matchesCapturedWindow(windowContext, focusedWindow)) {
      return focusedWindow
    }

    if (!waitingShown) {
      waitingShown = true
      updateVoiceState({
        phase: 'pending_insert',
        note: `Return to ${formatTargetWindow(windowContext) || 'the original window'} to insert.`,
        error: ''
      })
    }

    await sleep(TARGET_WINDOW_POLL_INTERVAL_MS)
  }
}

function unwrapModelText(value) {
  let text = String(value || '').trim()
  if (!text) {
    return ''
  }

  text = text.replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/, '').trim()
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`']
  ]
  for (const [start, end] of pairs) {
    if (text.startsWith(start) && text.endsWith(end) && text.length >= 2) {
      text = text.slice(1, -1).trim()
      break
    }
  }
  return text
}

async function rewriteTranscript(transcript, windowContext, options = {}) {
  if (!rewriteProvider || rewriteProviderId() === 'none') {
    return ''
  }
  const promptContext = buildWindowPrompt(windowContext)
  const payload = await rewriteProvider.requestChat({
    model: currentRewriteModel || runtimeConfig.rewrite.ollama.model,
    stream: false,
    think: rewriteThinkSetting(),
    messages: [
      {
        role: 'system',
        content: [
          'You rewrite raw local speech-to-text into the exact final text to insert into the current Windows app.',
          'Return only the final text.',
          'Keep the same language as the transcript.',
          'Treat the transcript as spoken draft text, not as final wording.',
          'Rewrite it into the message the speaker intended to type.',
          'Remove filler words, repetition, false starts, self-corrections, and other speech artifacts.',
          'Delete hesitation-only phrases completely instead of preserving or paraphrasing them.',
          'Common hesitation-only phrases include um, uh, er, ah, like, you know, I mean, sort of, kind of, basically, maybe, I guess, I do not know, and let me think when they do not add real meaning.',
          'Collapse repeated words and restarts such as can can, the the, or we should we should into one clean phrasing.',
          'If a word like maybe or I do not know expresses real uncertainty that matters to the message, keep the uncertainty but rewrite it naturally.',
          'Restructure sentences when needed so the result reads naturally and makes sense on first read.',
          'Use the app context only to improve wording, structure, tone, and app fit.',
          'Do not invent facts, commands, links, recipients, or code that the transcript did not support.',
          'You may add only minimal connector words needed to make the meaning clear.',
          'If the context looks like chat, email, form, or general prose, make the text natural, coherent, and ready to send or paste.',
          'If the context looks like search, keep it short.',
          'If the context looks like code or a terminal, do not generate code; only lightly normalize what was spoken.',
          'Prefer complete thoughts over transcript-like fragments.'
        ].join(' ')
      },
      {
        role: 'user',
        content: [
          `Transcript:\n${transcript}`,
          promptContext ? `\nFocused app context:\n${promptContext}` : '',
          '\nRewrite this into the final text that should be inserted.'
        ].join('\n')
      }
    ],
    options: {
      temperature: currentRewriteTemperature,
      num_predict: 220
    }
  }, {
    signal: options?.signal || null
  })

  return unwrapModelText(payload?.message?.content || '')
}

async function insertText(text, windowContext, options = {}) {
  const normalized = String(text || '').trim()
  if (!normalized) {
    return {
      ok: false,
      method: 'none',
      error: 'Final text was empty.',
      timingsMs: {
        waitTarget: 0,
        helper: 0,
        clipboard: 0
      }
    }
  }

  const waitTargetMs = 0

  try {
    const helperStartedAt = performance.now()
    const result = await uiAutomation.action({
      action: 'paste_text',
      window: windowContext?.selector || {},
      text: normalized
    }, {
      signal: options?.signal || null
    })
    const helperMs = Math.round(performance.now() - helperStartedAt)
    return {
      ok: true,
      method: 'paste_text',
      targetWindow: result?.window || null,
      timingsMs: {
        waitTarget: waitTargetMs,
        helper: helperMs,
        clipboard: 0,
        helperDetail: result?.timings || null
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    const clipboardStartedAt = performance.now()
    await appendDiagnosticsLog('insert-fallback', {
      error: String(error?.message || error).trim(),
      targetWindow: formatTargetWindow(windowContext),
      selector: windowContext?.selector || null,
      textLength: normalized.length
    })
    clipboard.writeText(normalized)
    const clipboardMs = Math.round(performance.now() - clipboardStartedAt)
    return {
      ok: false,
      method: 'clipboard',
      error: String(error?.message || error),
      copied: true,
      timingsMs: {
        waitTarget: waitTargetMs,
        helper: 0,
        clipboard: clipboardMs,
        helperDetail: null
      }
    }
  }
}

function logDictationTiming(payload) {
  const lines = [
    `[dictray] Timing (${String(payload?.outputMethod || 'none')})`,
    formatTimingLine('record', payload?.recordingMs, 5000, 12000),
    formatTimingLine('stt', payload?.sttMs, 250, 500),
    formatTimingLine('rewrite', payload?.rewriteMs, 400, 900),
    formatTimingLine('insert', payload?.insertMs, 250, 450),
    formatTimingLine('total', payload?.totalMs, 900, 1600)
  ]

  if (payload?.insertDetailMs) {
    lines.push('  insert breakdown:')
    lines.push(`  ${formatTimingLine('wait', payload.insertDetailMs.waitTarget, 100, 250).slice(2)}`)
    lines.push(`  ${formatTimingLine('helper', payload.insertDetailMs.helper, 250, 450).slice(2)}`)
    lines.push(`  ${formatTimingLine('clipboard', payload.insertDetailMs.clipboard, 40, 100).slice(2)}`)
    if (payload.insertDetailMs.helperDetail) {
      const helperDetail = payload.insertDetailMs.helperDetail
      lines.push('  helper breakdown:')
      lines.push(`  ${formatTimingLine('total', helperDetail.total, 250, 450).slice(2)}`)
      lines.push(`  ${formatTimingLine('window', helperDetail.windowResolve, 20, 60).slice(2)}`)
      lines.push(`  ${formatTimingLine('element', helperDetail.elementResolve, 20, 60).slice(2)}`)
      lines.push(`  ${formatTimingLine('focus', helperDetail.action?.focus || helperDetail.action?.focusWindow || 0, 40, 90).slice(2)}`)
      lines.push(`  ${formatTimingLine('clipboard set', helperDetail.action?.clipboardSet || 0, 30, 70).slice(2)}`)
      lines.push(`  ${formatTimingLine('paste', helperDetail.action?.paste || 0, 80, 140).slice(2)}`)
      lines.push(`  ${formatTimingLine('clipboard restore', helperDetail.action?.clipboardRestore || 0, 50, 100).slice(2)}`)
    }
  }

  if (payload?.note) {
    lines.push(`- note: ${compactText(payload.note, 100)}`)
  }

  console.log(lines.join('\n'))
}

async function processAudioSubmission(payload = {}) {
  if (activeSubmission && !activeSubmission.controller.signal.aborted) {
    return {
      ok: false,
      cancelled: true,
      reason: 'submission_in_flight'
    }
  }

  const submission = {
    id: ++nextSubmissionId,
    controller: new AbortController(),
    contextHandle: activeTurnContext
  }
  activeSubmission = submission
  const signal = submission.controller.signal
  const startedAt = performance.now()
  const recordingMs = Number.isFinite(payload?.recordingMs) ? Math.max(0, Math.round(Number(payload.recordingMs))) : 0
  const audioBytes = payload?.audioBytes instanceof Uint8Array
    ? payload.audioBytes
    : new Uint8Array(payload?.audioBytes || [])

  if (!audioBytes.length) {
    throw new Error('Recording was empty.')
  }

  await appendDiagnosticsLog('submission-start', {
    mimeType: String(payload?.mimeType || 'application/octet-stream').trim(),
    audioBytes: audioBytes.length,
    recordingMs,
    captureDevice: payload?.captureDevice || null
  })

  const contextPromise = submission.contextHandle?.promise || Promise.resolve(null)

  try {
    throwIfSubmissionCancelled(submission)
    updateVoiceState({
      phase: 'transcribing',
      transcript: '',
      finalText: '',
      note: '',
      error: ''
    })

    const sttStartedAt = performance.now()
    await waitForPendingSttWarmup(signal)
    throwIfSubmissionCancelled(submission)
    let transcribePayload
    try {
      transcribePayload = await speech.transcribeAudioBuffer(
        Buffer.from(audioBytes),
        payload?.mimeType || 'application/octet-stream'
      )
    } catch (error) {
      const currentHealth = await speech.checkSttHealth().catch(() => null)
      if (currentHealth) {
        latestHealth = {
          ...latestHealth,
          stt: currentHealth
        }
      }
      await appendDiagnosticsLog('stt-transcribe-error', {
        message: String(error?.message || error).trim(),
        detail: String(error?.detail || '').trim(),
        mimeType: String(payload?.mimeType || 'application/octet-stream').trim(),
        pythonBin: String(error?.pythonBin || runtimeConfig?.stt?.local?.pythonBin || '').trim(),
        transcribeScript: String(error?.transcribeScript || runtimeConfig?.stt?.local?.transcribeScript || '').trim(),
        model: String(error?.model || runtimeConfig?.stt?.local?.model || '').trim(),
        modelDir: String(error?.modelDir || runtimeConfig?.stt?.local?.modelDir || '').trim(),
        device: String(error?.device || runtimeConfig?.stt?.local?.device || '').trim(),
        computeType: String(error?.computeType || runtimeConfig?.stt?.local?.computeType || '').trim(),
        health: currentHealth || null
      })
      if (currentHealth && !currentHealth.ok) {
        logSttDiagnostic('transcribe', currentHealth, true)
      }
      throw error
    }
    throwIfSubmissionCancelled(submission)

    const sttMs = nowMs(sttStartedAt)
    const rawTranscript = String(transcribePayload?.transcript || '').trim()
    const transcript = normalizeSpeechTranscript(rawTranscript)
    if (!transcript) {
      const audioStats = transcribePayload?.audioStats || null
      const peakDb = Number(audioStats?.inputPeakDb)
      const rmsDb = Number(audioStats?.inputRmsDb)
      const lowSignal = (Number.isFinite(peakDb) && peakDb < -45) || (Number.isFinite(rmsDb) && rmsDb < -55)
      const message = lowSignal
        ? 'Speech to Text captured an extremely quiet signal. Check your microphone selection and Windows input volume.'
        : 'Speech to Text returned empty text. Hold the shortcut a bit longer and start speaking after the listening cue.'
      const debugSample = await saveFailedSubmissionSample('empty-transcript', audioBytes, payload?.mimeType, {
        recordingMs,
        rawTranscriptLength: rawTranscript.length,
        normalizedTranscriptLength: transcript.length,
        timingsMs: transcribePayload?.timingsMs || null,
        usedVadFallback: Boolean(transcribePayload?.usedVadFallback),
        provider: String(runtimeConfig?.stt?.provider || '').trim(),
        audioStats,
        captureDevice: payload?.captureDevice || null
      })
      await appendDiagnosticsLog('empty-transcript', {
        mimeType: String(payload?.mimeType || 'application/octet-stream').trim(),
        audioBytes: audioBytes.length,
        recordingMs,
        rawTranscriptLength: rawTranscript.length,
        normalizedTranscriptLength: transcript.length,
        timingsMs: transcribePayload?.timingsMs || null,
        usedVadFallback: Boolean(transcribePayload?.usedVadFallback),
        audioStats,
        captureDevice: payload?.captureDevice || null,
        debugSample: debugSample || null
      })
      clearVoiceState(message)
      showNotification(APP_NAME, message)
      return {
        ok: false,
        cancelled: true,
        reason: 'empty_transcript',
        error: message,
        earcon: 'cancel'
      }
    }

    const windowContext = await contextPromise.catch(() => null)
    throwIfSubmissionCancelled(submission)
    updateVoiceState({
      phase: rewriteEnabled ? 'rewriting' : 'inserting',
      transcript,
      finalText: '',
      targetWindow: formatTargetWindow(windowContext),
      note: '',
      error: ''
    })

    let finalText = transcript
    let rewriteMs = 0
    let note = ''

    if (rewriteEnabled) {
      const rewriteStartedAt = performance.now()
      try {
        const rewritten = await rewriteTranscript(transcript, windowContext, { signal })
        throwIfSubmissionCancelled(submission)
        rewriteMs = nowMs(rewriteStartedAt)
        if (rewritten) {
          finalText = rewritten
        }
      } catch (error) {
        if (isAbortError(error)) {
          throw error
        }
        rewriteMs = nowMs(rewriteStartedAt)
        note = `Rewrite failed, using the raw transcript instead: ${compactText(error?.message || error, 80)}`
      }
    }

    throwIfSubmissionCancelled(submission)
    const focusedWindowForInsert = await waitForTargetWindowFocus(windowContext, submission)
    throwIfSubmissionCancelled(submission)
    updateVoiceState({
      phase: 'inserting',
      transcript,
      finalText,
      targetWindow: formatTargetWindow(windowContext),
      targetBounds: normalizeOverlayBounds(focusedWindowForInsert?.bounds) || windowContext?.windowBounds || null,
      targetElementBounds: windowContext?.focusedElement?.bounds || null,
      note,
      error: ''
    })

    const insertStartedAt = performance.now()
    const insertResult = await insertText(finalText, windowContext, { signal })
    throwIfSubmissionCancelled(submission)
    const insertMs = nowMs(insertStartedAt)
    if (!insertResult.ok && insertResult.copied) {
      note = `Paste failed. Copied the final text to the clipboard instead. ${insertResult.error ? `Reason: ${compactText(insertResult.error, 80)}` : ''}`.trim()
      showNotification(APP_NAME, compactText(note, 180))
    }

    const totalMs = nowMs(startedAt)
    updateVoiceState({
      phase: 'idle',
      transcript,
      finalText,
      targetWindow: formatTargetWindow(windowContext),
      note,
      error: ''
    })
    await recordOutputHistory(finalText, {
      improved: rewriteEnabled && finalText !== transcript
    }).catch((error) => {
      console.error(`[dictray] Failed to record output history: ${error?.message || error}`)
    })
    await recordGeneratedCharacters(finalText).catch((error) => {
      console.error(`[dictray] Failed to record generated characters: ${error?.message || error}`)
    })

    logDictationTiming({
      recordingMs,
      sttMs: Number(transcribePayload?.timingsMs?.total || sttMs),
      rewriteMs,
      insertMs,
      totalMs,
      outputMethod: insertResult.method,
      insertDetailMs: insertResult.timingsMs || null,
      note
    })

    return {
      ok: true,
      transcript,
      finalText,
      outputMethod: insertResult.method,
      recordingMs,
      timingsMs: {
        normalize: Number(transcribePayload?.timingsMs?.normalize || 0),
        transcribe: Number(transcribePayload?.timingsMs?.transcribe || sttMs),
        stt: Number(transcribePayload?.timingsMs?.total || sttMs),
        rewrite: rewriteMs,
        insert: insertMs,
        insertDetail: insertResult.timingsMs || null,
        total: totalMs
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
      if (activeSubmission === submission) {
        clearVoiceState()
      }
      return {
        ok: false,
        cancelled: true,
        error: String(error?.message || 'Dictation was cancelled.')
      }
    }
    throw error
  } finally {
    if (activeSubmission === submission) {
      activeSubmission = null
    }
    if (activeTurnContext === submission.contextHandle) {
      activeTurnContext = null
    }
  }
}

function beginTurnContextCapture() {
  const contextHandle = {
    promise: captureFocusedWindowContext()
      .then((context) => {
        if (activeTurnContext === contextHandle) {
          updateVoiceState({
            targetWindow: formatTargetWindow(context),
            targetBounds: context?.windowBounds || null,
            targetElementBounds: context?.focusedElement?.bounds || null
          })
        }
        return context
      })
      .catch(() => null)
  }
  activeTurnContext = contextHandle
}

async function toggleDictationCapture() {
  if (voiceState.phase === 'listening') {
    await stopDictationCapture()
    return
  }
  if (voiceState.phase === 'pending_insert') {
    cancelActiveSubmission('Pending insertion was cancelled.')
    clearVoiceState()
    return
  }
  await startDictationCapture()
}

async function startDictationCapture() {
  if (voiceState.phase !== 'idle' || activeSubmission) {
    return
  }
  const ready = await ensureDictationCanStart()
  if (!ready) {
    return
  }

  cancelActiveSubmission()
  beginTurnContextCapture()

  const focusedWindow = await getFocusedWindowSnapshot().catch(() => null)
  const initialBounds = normalizeOverlayBounds(focusedWindow?.bounds)
  voiceOverlayFocusedBounds = initialBounds

  updateVoiceState({
    phase: 'processing',
    transcript: '',
    finalText: '',
    targetBounds: initialBounds,
    targetElementBounds: null,
    note: '',
    error: '',
    targetWindow: ''
  })

  const window = await ensureVoiceWindow()
  await duckSystemVolumeForPushToTalk()
  window.webContents.send('dictation:start-recording')
}

async function stopDictationCapture() {
  try {
    const window = await ensureVoiceWindow()
    window.webContents.send('dictation:stop-recording')
  } finally {
    void restoreSystemVolumeAfterPushToTalk().catch(() => {})
  }
}

function stopHotkeyBridge() {
  if (hotkeyBridgeRestartTimer) {
    clearTimeout(hotkeyBridgeRestartTimer)
    hotkeyBridgeRestartTimer = null
  }

  const bridge = hotkeyBridge
  hotkeyBridge = null
  if (!bridge || bridge.killed) {
    return
  }

  bridge.kill()
}

function registerPressOnlyHotkey() {
  globalShortcut.unregisterAll()
  const ok = globalShortcut.register(trayHotkey, () => {
    void toggleDictationCapture()
  })
  if (!ok) {
    showNotification(APP_NAME, `Failed to register hotkey ${formatHotkey(trayHotkey)}.`)
  }
}

function scheduleHotkeyBridgeRestart() {
  const now = Date.now()
  hotkeyBridgeRestartAtMs = hotkeyBridgeRestartAtMs.filter((value) => (now - value) < HOTKEY_BRIDGE_RESTART_WINDOW_MS)
  hotkeyBridgeRestartAtMs.push(now)

  if (hotkeyBridgeRestartAtMs.length > HOTKEY_BRIDGE_MAX_RESTARTS) {
    return false
  }

  if (hotkeyBridgeRestartTimer) {
    clearTimeout(hotkeyBridgeRestartTimer)
  }
  hotkeyBridgeRestartTimer = setTimeout(() => {
    hotkeyBridgeRestartTimer = null
    if (isQuitting) {
      return
    }
    console.warn('[dictray] Restarting hold-to-talk bridge.')
    startHotkeyBridge()
  }, HOTKEY_BRIDGE_RESTART_DELAY_MS)
  return true
}

function startHotkeyBridge() {
  stopHotkeyBridge()
  const bridge = spawn(HOTKEY_BRIDGE, [trayHotkey], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  hotkeyBridge = bridge

  const stdout = readline.createInterface({ input: bridge.stdout })
  stdout.on('line', (line) => {
    if (hotkeyBridge !== bridge) {
      return
    }
    const event = String(line || '').trim().toLowerCase()
    if (event === 'down') {
      void startDictationCapture()
      return
    }
    if (event === 'up') {
      void stopDictationCapture()
    }
  })

  const stderr = readline.createInterface({ input: bridge.stderr })
  stderr.on('line', (line) => {
    if (hotkeyBridge !== bridge) {
      return
    }
    const message = String(line || '').trim()
    if (message) {
      console.error(`[dictray] hotkey bridge: ${message}`)
    }
  })

  bridge.on('error', (error) => {
    if (hotkeyBridge !== bridge) {
      return
    }
    console.error('[dictray] Failed to start hotkey bridge:', error)
    stopHotkeyBridge()
    registerPressOnlyHotkey()
    showNotification(APP_NAME, 'Hold-to-talk bridge failed. Falling back to press-to-toggle.')
  })

  bridge.on('exit', (code) => {
    if (hotkeyBridge === bridge) {
      hotkeyBridge = null
    } else {
      return
    }
    if (isQuitting) {
      return
    }
    console.error(`[dictray] Hotkey bridge exited with code ${code ?? 0}.`)
    if (scheduleHotkeyBridgeRestart()) {
      return
    }
    registerPressOnlyHotkey()
    showNotification(APP_NAME, 'Hold-to-talk bridge stopped. Falling back to press-to-toggle.')
  })
}

async function registerHotkey() {
  globalShortcut.unregisterAll()
  if (process.platform === 'win32') {
    try {
      await access(HOTKEY_BRIDGE)
      startHotkeyBridge()
      return
    } catch {
      console.error(`[dictray] Missing Windows hotkey helper: ${HOTKEY_BRIDGE}`)
      showNotification(APP_NAME, 'Windows hotkey helper was not built. Falling back to press-to-toggle.')
    }
  }

  registerPressOnlyHotkey()
}

ipcMain.handle('dictation:submit-audio', async (_event, payload) => {
  try {
    return await processAudioSubmission(payload)
  } catch (error) {
    if (isAbortError(error)) {
      return {
        ok: false,
        cancelled: true,
        error: String(error?.message || 'Dictation was cancelled.')
      }
    }
    clearVoiceState(String(error?.message || error))
    showNotification(APP_NAME, compactText(error?.message || error, 180))
    return {
      ok: false,
      error: String(error?.message || error)
    }
  }
})

ipcMain.on('dictation:state', (_event, payload) => {
  updateVoiceState({
    phase: payload?.phase || voiceState.phase,
    error: '',
    note: voiceState.note
  })
})

ipcMain.on('dictation:input-devices', (_event, payload) => {
  const available = normalizeAvailableInputDevices(payload?.devices)
  const activeDeviceId = normalizeInputDeviceId(payload?.activeDeviceId)
  const activeLabel = compactText(
    String(payload?.activeLabel || available.find((device) => device.deviceId === activeDeviceId)?.label || '').trim(),
    64
  )

  inputDeviceState = {
    available,
    permission: normalizeInputPermission(payload?.permission),
    activeDeviceId,
    activeLabel,
    error: compactText(String(payload?.error || '').trim(), 120)
  }
  rebuildMenu()
})

ipcMain.handle('dictation:set-input-device', async (_event, payload) => {
  await updateInputSourcePreference(payload?.deviceId)
  return {
    ok: true,
    deviceId: preferredInputDeviceId
  }
})

ipcMain.on('dictation:error', (_event, payload) => {
  clearVoiceState(String(payload?.message || 'Unknown dictation error'))
  void restoreSystemVolumeAfterPushToTalk().catch(() => {})
  showNotification(APP_NAME, compactText(payload?.message || 'Unknown dictation error', 180))
})

ipcMain.handle('onboarding:get-state', async () => {
  return onboardingStatePayload()
})

ipcMain.handle('onboarding:complete', async (_event, payload) => {
  const result = await completeOnboarding(payload)
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close()
  }
  return result
})

ipcMain.on('onboarding:close', () => {
  if (onboardingWindow && !onboardingWindow.isDestroyed()) {
    onboardingWindow.close()
  }
})

async function createTray() {
  tray = new Tray(currentTrayIcon())
  tray.on('click', () => {
    void toggleDictationCapture()
  })
  rebuildMenu()
}

function applyStatePaths(config) {
  stateDir = config.memory.stateDir
  traySettingsPath = path.join(stateDir, 'dictation-tray-settings.json')
  speechPreferencesPath = path.join(stateDir, 'speech-preferences.json')
  rewritePreferencesPath = path.join(stateDir, 'rewrite-preferences.json')
  legacyRewritePreferencesPath = path.join(stateDir, 'ollama-preferences.json')
  dailyCharacterStatsPath = path.join(stateDir, 'dictation-tray-daily-character-stats.json')
  onboardingStatePath = path.join(stateDir, 'dictation-tray-onboarding.json')
  outputHistoryPath = path.join(stateDir, 'dictation-tray-output-history.json')
  diagnosticsLogPath = path.join(stateDir, 'dictation-tray-debug.log')
}

async function applyRuntimeConfig(nextConfig, { loadPersistentState = false } = {}) {
  runtimeConfig = nextConfig
  applyStatePaths(runtimeConfig)

  if (loadPersistentState) {
    await loadDailyCharacterStats()
    await loadOutputHistory()
  }

  const rewritePreferences = await readSharedRewritePreferences()
  runtimeConfig.rewrite.provider = normalizeRewriteProviderId(rewritePreferences.provider || runtimeConfig.rewrite.provider)
  currentRewriteThink = normalizeRewriteThink(rewritePreferences.think || runtimeConfig.rewrite.ollama.think || 'off')
  currentRewriteTemperature = normalizeRewriteTemperature(rewritePreferences.temperature ?? runtimeConfig.rewrite.ollama.temperature ?? 0.1)
  currentRewriteModel = String(rewritePreferences.model || runtimeConfig.rewrite.ollama.model || '').trim()
  runtimeConfig.rewrite.ollama.model = currentRewriteModel
  runtimeConfig.rewrite.ollama.think = currentRewriteThink
  runtimeConfig.rewrite.ollama.temperature = currentRewriteTemperature
  runtimeConfig.ollama.model = currentRewriteModel
  runtimeConfig.ollama.think = currentRewriteThink
  runtimeConfig.ollama.temperature = currentRewriteTemperature
  await loadOnboardingState()
  runtimeConfig.stt.local.model = sttModelForSpeechEffort(onboardingState?.choices?.speechEffort)
  if (!hotkeyManagedByEnv()) {
    trayHotkey = normalizeTrayHotkey(onboardingState?.choices?.pushToTalkHotkey || trayHotkey)
  }
  if (loadPersistentState) {
    await loadTraySettings()
  }

  speech = createSttProvider({
    ...runtimeConfig.stt,
    rootDir: runtimeConfig.rootDir
  }, stateDir)
  await applySharedSpeechPreferencesOnStartup().catch(() => null)
  rewriteProvider = createRewriteProvider(runtimeConfig.rewrite)
  void appendDiagnosticsLog('runtime-config', {
    sttProvider: runtimeConfig?.stt?.provider,
    pythonBin: runtimeConfig?.stt?.local?.pythonBin,
    daemonScript: runtimeConfig?.stt?.local?.daemonScript,
    transcribeScript: runtimeConfig?.stt?.local?.transcribeScript,
    model: runtimeConfig?.stt?.local?.model,
    modelDir: runtimeConfig?.stt?.local?.modelDir,
    bundledRuntimeDir: process.env.DICTATION_TRAY_BUNDLED_RUNTIME_DIR || '',
    stateDir
  })
}

async function reloadRuntimeConfig() {
  if (runtimeReloadInFlight) {
    return runtimeReloadInFlight
  }

  runtimeReloadInFlight = (async () => {
    await applyRuntimeConfig(await loadConfig(), { loadPersistentState: false })
    sttReadyForDictation = false
    sttReadyNotificationAttached = false
    clearSttKeepWarmTimer()
    startSttKeepWarmTimer()
    return runtimeConfig
  })().finally(() => {
    runtimeReloadInFlight = null
  })

  return runtimeReloadInFlight
}

async function bootstrap() {
  if (app.isPackaged && !String(process.env.DICTATION_TRAY_STATE_DIR || '').trim()) {
    process.env.DICTATION_TRAY_STATE_DIR = path.join(app.getPath('userData'), 'state')
  }
  await applyRuntimeConfig(await loadConfig(), { loadPersistentState: true })
  systemVolume = new SystemVolumeBridge()
  uiAutomation = new UiAutomationBridge()
}

app.on('before-quit', (event) => {
  isQuitting = true
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
  clearSttKeepWarmTimer()
  stopHotkeyBridge()
  globalShortcut.unregisterAll()
  void speech?.dispose?.().catch(() => null)

  if (!isRestoringVolumeForQuit && volumeDuckState) {
    event.preventDefault()
    isRestoringVolumeForQuit = true
    void restoreSystemVolumeAfterPushToTalk().catch(() => null).finally(() => {
      isRestoringVolumeForQuit = false
      app.quit()
    })
    return
  }

})

app.whenReady().then(async () => {
  installPermissionHandlers()
  await bootstrap()
  await createTray()
  await ensureVoiceWindow()
  await maybeShowOnboarding()
  await scheduleSttWarmup({ notifyReady: true }).catch(() => null)
  await refreshRuntimeState(false)
  await registerHotkey()

  refreshTimer = setInterval(() => {
    if (shouldSkipBackgroundRuntimeRefresh()) {
      return
    }
    void refreshRuntimeState(false)
  }, 15000)
  startSttKeepWarmTimer()

  if (rewriteEnabled) {
    void warmSelectedModel().catch(() => {})
  }
}).catch((error) => {
  console.error('[dictray] Failed to start:', error)
  app.quit()
})
