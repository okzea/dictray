import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
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
  session,
  shell,
  Tray
} from 'electron'
import { loadConfig } from '../src/config.mjs'
import { createRewriteProvider } from '../src/rewrite-provider.mjs'
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
const HOTKEY_BRIDGE = String(process.env.DICTATION_TRAY_HOTKEY_HELPER || '').trim() || path.join(__dirname, '..', 'scripts', 'windows-hotkey-hook', 'bin', 'Release', 'net10.0-windows', 'WindowsHotkeyHook.exe')
const ALLOWED_PERMISSIONS = new Set(['media', 'microphone'])
const STT_DEVICE_CPU = 'cpu'
const STT_DEVICE_GPU = 'gpu'
const STT_MODEL_TINY = 'tiny'
const STT_MODEL_MIDDLE = 'middle'
const STT_MODEL_ADVANCED = 'advanced'
const DAILY_CHARACTER_STATS_RETENTION_DAYS = 7
const ONBOARDING_SAMPLE_TEXT = 'hello, my name is Denim.'

let runtimeConfig = null
let speech = null
let rewriteProvider = null
let systemVolume = null
let uiAutomation = null
let stateDir = ''
let traySettingsPath = ''
let rewritePreferencesPath = ''
let dailyCharacterStatsPath = ''
let onboardingStatePath = ''
let tray = null
let voiceWindow = null
let onboardingWindow = null
let trayIcons = new Map()
let windowIcon = null
let hotkeyBridge = null
let refreshTimer = null
let sttKeepWarmTimer = null
let isQuitting = false
let isRestoringVolumeForQuit = false
let trayHotkey = DEFAULT_HOTKEY
let rewriteEnabled = true
let duckingEnabled = true
let duckingLevel = 0.3
let currentRewriteModel = ''
let currentRewriteThink = 'default'
let rewriteModels = []
let latestHealth = {
  stt: null,
  rewrite: null,
  automation: null
}
let sttPreferences = {
  currentDevice: '',
  currentModel: '',
  provider: '',
  error: ''
}
let voiceState = {
  phase: 'idle',
  transcript: '',
  finalText: '',
  targetWindow: '',
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
let volumeDuckState = null
let dailyCharacterStats = {
  days: {}
}
let onboardingState = {
  version: 1,
  seenAt: '',
  completedAt: '',
  profile: {
    name: ''
  },
  choices: {
    localStt: true,
    externalProviders: false,
    rewriteCleanup: true
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
if (!singleInstance) {
  app.quit()
}

app.on('second-instance', () => {
  rebuildMenu()
})

function compactText(value, limit = 88) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`
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

function runtimeSttModelPreference(value) {
  return normalizeSttModelPreference(value) || ''
}

function normalizeRewriteEnabled(value) {
  return value === undefined ? true : Boolean(value)
}

function nowMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function showNotification(title, body) {
  if (!Notification.isSupported()) {
    return
  }
  new Notification({
    title,
    body,
    icon: appIcon()
  }).show()
}

function sttRuntimeNotificationLabel() {
  const provider = String(runtimeConfig?.speech?.stt?.provider || '').trim()
  const device = sttPreferences.currentDevice || ''
  const model = String(sttPreferences.currentModel || '').trim()
  const modelLabel = model
    ? sttModelMenuLabel(runtimeSttModelPreference(model) || model)
    : ''
  return [
    provider ? provider.toUpperCase() : '',
    device ? sttDeviceLabel(device) : '',
    modelLabel
  ].filter(Boolean).join(' / ')
}

function notifySttReady() {
  const label = sttRuntimeNotificationLabel()
  showNotification(APP_NAME, label ? `STT is ready: ${label}.` : 'STT is ready for dictation.')
}

function maybeNotifySttBlocked(message, minIntervalMs = 4000) {
  const now = Date.now()
  if ((now - lastSttBlockedNotificationAt) < minIntervalMs) {
    return
  }
  lastSttBlockedNotificationAt = now
  showNotification(APP_NAME, message)
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
  const currentProvider = String(runtimeConfig?.stt?.provider || '').trim().toLowerCase()
  const defaultLocalStt = currentProvider === 'local'
  return {
    version: 1,
    seenAt: String(source?.seenAt || '').trim(),
    completedAt: String(source?.completedAt || '').trim(),
    profile: {
      name: normalizeProfileName(source?.profile?.name)
    },
    choices: {
      localStt: source?.choices?.localStt !== undefined
        ? Boolean(source.choices.localStt)
        : source?.choices?.managedDockerStt !== undefined
          ? !Boolean(source.choices.managedDockerStt)
          : defaultLocalStt,
      externalProviders: source?.choices?.externalProviders !== undefined ? Boolean(source.choices.externalProviders) : false,
      rewriteCleanup: source?.choices?.rewriteCleanup !== undefined ? Boolean(source.choices.rewriteCleanup) : rewriteEnabled
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

async function loadDailyCharacterStats() {
  dailyCharacterStats = normalizeDailyCharacterStats(await readJsonFile(dailyCharacterStatsPath, {}))
}

async function saveDailyCharacterStats() {
  dailyCharacterStats = normalizeDailyCharacterStats(dailyCharacterStats)
  await writeJsonFile(dailyCharacterStatsPath, dailyCharacterStats)
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

async function readSharedRewritePreferences() {
  const parsed = await readJsonFile(rewritePreferencesPath, {})
  return {
    provider: String(parsed?.provider || '').trim(),
    think: String(parsed?.think || '').trim(),
    model: String(parsed?.model || '').trim()
  }
}

async function writeSharedRewritePreferences(input = {}) {
  const payload = {
    provider: String(input?.provider || runtimeConfig?.rewrite?.provider || '').trim(),
    think: String(input?.think || currentRewriteThink || runtimeConfig?.rewrite?.ollama?.think || 'default').trim() || 'default',
    model: String(input?.model || currentRewriteModel || runtimeConfig?.rewrite?.ollama?.model || '').trim()
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
  if (parsed?.duckingEnabled !== undefined) {
    duckingEnabled = normalizeDuckingEnabled(parsed?.duckingEnabled)
  }
  if (parsed?.duckingLevel !== undefined) {
    duckingLevel = normalizeDuckingLevel(parsed?.duckingLevel)
  }
}

async function saveTraySettings() {
  await writeJsonFile(traySettingsPath, {
    hotkey: hotkeyManagedByEnv() ? undefined : trayHotkey,
    rewriteEnabled,
    duckingEnabled,
    duckingLevel
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
    width: 320,
    height: 180,
    icon: appIcon(),
    skipTaskbar: true,
    frame: false,
    transparent: true,
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
  return voiceWindow
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
  if (onboardingState.seenAt) {
    return
  }
  await openOnboardingWindow({ markSeen: true }).catch((error) => {
    console.error(`[dictray] Failed to open onboarding: ${error?.message || error}`)
  })
}

function onboardingStatePayload() {
  return {
    sampleText: ONBOARDING_SAMPLE_TEXT,
    state: onboardingState,
    runtime: {
      sttProvider: String(speech?.label || latestHealth.stt?.providerLabel || runtimeConfig?.stt?.provider || '').trim(),
      rewriteProvider: String(rewriteProvider?.label || latestHealth.rewrite?.providerLabel || runtimeConfig?.rewrite?.provider || '').trim(),
      rewriteEnabled
    }
  }
}

async function completeOnboarding(input = {}) {
  const measuredAt = new Date().toISOString()
  const profileName = normalizeProfileName(input?.profile?.name)
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
      ...input?.choices
    },
    typingBenchmark
  })

  rewriteEnabled = Boolean(onboardingState.choices.rewriteCleanup)
  await saveTraySettings()
  await saveOnboardingState()
  rebuildMenu()
  return onboardingStatePayload()
}

function updateVoiceState(patch = {}) {
  voiceState = {
    ...voiceState,
    ...patch
  }
  rebuildMenu()
}

function clearVoiceState(error = '') {
  updateVoiceState({
    phase: 'idle',
    transcript: '',
    finalText: '',
    targetWindow: '',
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
    case 'processing':
      return 'State: processing'
    default:
      return 'State: idle'
  }
}

function runtimeLabel() {
  const provider = String(sttPreferences.provider || runtimeConfig?.stt?.provider || 'unknown').trim()
  const device = String(sttPreferences.currentDevice || '').trim()
  const model = String(sttPreferences.currentModel || '').trim()
  return `${provider}${device ? `/${sttDeviceLabel(device)}` : ''}${model ? `/${model}` : ''}`
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
  return String(rewriteProvider?.label || latestHealth.rewrite?.providerLabel || rewriteProviderId()).trim() || 'Rewrite'
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
  return String(currentRewriteThink || runtimeConfig?.rewrite?.ollama?.think || 'default').trim() || 'default'
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
          ? 'Rewrite provider disabled'
          : `Model selection unavailable for ${rewriteProviderLabel()}`,
        enabled: false
      }]

  const sttDeviceMenu = [{
    label: sttPreferences.currentDevice ? sttDeviceLabel(sttPreferences.currentDevice) : 'Unknown',
    enabled: false
  }, {
    label: 'Change in config and restart',
    enabled: false
  }]

  const sttModelMenu = [{
    label: sttPreferences.currentModel
      ? sttModelMenuLabel(runtimeSttModelPreference(sttPreferences.currentModel) || sttPreferences.currentModel)
      : 'Unknown',
    enabled: false
  }, {
    label: 'Change in config and restart',
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
    { label: phaseLabel(), enabled: false },
    { label: `Target: ${compactText(targetLabel, 90)}`, enabled: false },
    { label: `STT: ${healthValue(latestHealth.stt?.ok, runtimeLabel(), compactText(latestHealth.stt?.error || runtimeLabel(), 70))}`, enabled: false },
    { label: `Rewrite: ${healthValue(latestHealth.rewrite?.ok, rewriteStatusLabel(), compactText(latestHealth.rewrite?.error || rewriteStatusLabel(), 70))}`, enabled: false },
    { label: voiceState.transcript ? `Last transcript: ${compactText(voiceState.transcript, 110)}` : 'Last transcript: none', enabled: false },
    { label: voiceState.finalText ? `Last text: ${compactText(voiceState.finalText, 110)}` : 'Last text: none', enabled: false },
    { label: noteLabel, enabled: false },
    { type: 'separator' },
    {
      label: voiceState.phase === 'listening' ? 'Stop Dictation' : 'Start Dictation',
      click: () => {
        void toggleDictationCapture()
      }
    },
    {
      label: 'Rewrite Transcript',
      type: 'checkbox',
      checked: rewriteEnabled,
      click: (item) => {
        void updateRewriteEnabled(Boolean(item.checked))
      }
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
      label: 'Rewrite Model',
      submenu: modelMenu
    },
    {
      label: 'STT Device',
      submenu: sttDeviceMenu
    },
    {
      label: 'STT Model',
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
      label: 'Refresh Health',
      click: () => {
        void refreshRuntimeState(true)
      }
    },
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

  sttPreferences = {
    provider: String(sttHealth?.providerLabel || speech?.label || runtimeConfig?.stt?.provider || '').trim(),
    currentDevice,
    currentModel,
    error: String(runtime.error || sttHealth?.error || '').trim()
  }

  if (notify) {
    if (sttHealth.ok && (rewriteProviderId() === 'none' || rewriteHealth.ok)) {
      showNotification(APP_NAME, rewriteProviderId() === 'none' ? 'STT is responding. Rewrite is disabled.' : `STT and ${rewriteProviderLabel()} are responding.`)
    } else {
      const problems = [
        !sttHealth.ok ? `STT: ${compactText(sttHealth.error || 'down', 60)}` : '',
        rewriteProviderId() !== 'none' && !rewriteHealth.ok ? `${rewriteProviderLabel()}: ${compactText(rewriteHealth.error || 'down', 60)}` : ''
      ].filter(Boolean)
      showNotification(APP_NAME, problems.join(' | ') || 'Runtime health check failed.')
    }
  }

  rebuildMenu()
}

async function updateRewriteEnabled(value) {
  rewriteEnabled = Boolean(value)
  await saveTraySettings()
  rebuildMenu()
  if (!rewriteEnabled) {
    showNotification(APP_NAME, 'Rewrite disabled. Raw transcript will be inserted.')
    await refreshRuntimeState(false)
    return
  }

  const modelName = String(currentRewriteModel || runtimeConfig?.rewrite?.ollama?.model || '').trim()
  showNotification(APP_NAME, modelName ? `Rewrite enabled. Warming ${modelName}.` : 'Rewrite enabled.')
  try {
    const warmResult = await warmSelectedModel()
    if (warmResult?.ok === false || warmResult?.skipped) {
      showNotification(APP_NAME, rewriteProviderId() === 'none' ? 'Rewrite enabled, but no rewrite provider is configured.' : 'Rewrite enabled, but model warmup was skipped.')
    } else {
      showNotification(APP_NAME, modelName ? `${modelName} is ready for dictation cleanup.` : 'Rewrite is ready.')
    }
  } catch (error) {
    showNotification(APP_NAME, `Rewrite enabled, but model warmup failed: ${compactText(error?.message || error, 96)}`)
  } finally {
    await refreshRuntimeState(false)
  }
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
    model: name
  })
  rebuildMenu()

  if (!rewriteEnabled) {
    showNotification(APP_NAME, `Rewrite model set to ${name}. Rewrite is currently disabled.`)
    return
  }

  showNotification(APP_NAME, `Switching to ${name} and warming it.`)
  try {
    await warmSelectedModel()
    showNotification(APP_NAME, `${name} is ready for dictation cleanup.`)
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

  maybeNotifySttBlocked('Dictation is still starting. STT is not ready yet. You will get a notification when it is ready.')
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
    focusedElement: focusedElement
      ? {
          name: compactText(focusedElement.name || '', 100),
          controlType: String(focusedElement.controlType || '').trim(),
          value: compactText(focusedElement.value || '', 120),
          text: compactText(focusedElement.text || '', 120)
        }
      : null,
    snippets: collectSnapshotSnippets(target, 8)
  }

  context.modeHint = inferModeHint(context)
  return context
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
      temperature: 0.1,
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
      error: 'Final text was empty.'
    }
  }

  try {
    const result = await uiAutomation.action({
      action: 'paste_text',
      window: windowContext?.selector || {},
      text: normalized
    }, {
      signal: options?.signal || null
    })
    return {
      ok: true,
      method: 'paste_text',
      targetWindow: result?.window || null
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    clipboard.writeText(normalized)
    return {
      ok: false,
      method: 'clipboard',
      error: String(error?.message || error),
      copied: true
    }
  }
}

function logDictationTiming(payload) {
  const parts = [
    `record=${Number(payload?.recordingMs || 0)}ms`,
    `stt=${Number(payload?.sttMs || 0)}ms`,
    `rewrite=${Number(payload?.rewriteMs || 0)}ms`,
    `insert=${Number(payload?.insertMs || 0)}ms`,
    `total=${Number(payload?.totalMs || 0)}ms`,
    `output=${String(payload?.outputMethod || 'none')}`
  ]
  if (payload?.note) {
    parts.push(`note=${compactText(payload.note, 100)}`)
  }
  console.log(`[dictray] Timing: ${parts.join(' | ')}`)
}

async function processAudioSubmission(payload = {}) {
  const previousSubmission = activeSubmission
  if (previousSubmission && !previousSubmission.controller.signal.aborted) {
    previousSubmission.controller.abort(createAbortError('Dictation was superseded by a new push-to-talk turn.'))
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
    const transcribePayload = await speech.transcribeAudioBuffer(
      Buffer.from(audioBytes),
      payload?.mimeType || 'application/octet-stream',
      { signal }
    )
    throwIfSubmissionCancelled(submission)

    const sttMs = nowMs(sttStartedAt)
    const rawTranscript = String(transcribePayload?.transcript || '').trim()
    const transcript = normalizeSpeechTranscript(rawTranscript)
    if (!transcript) {
      clearVoiceState()
      return {
        ok: false,
        cancelled: true,
        reason: 'empty_transcript',
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
    updateVoiceState({
      phase: 'inserting',
      transcript,
      finalText,
      targetWindow: formatTargetWindow(windowContext),
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
        total: totalMs
      }
    }
  } catch (error) {
    if (isAbortError(error)) {
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
            targetWindow: formatTargetWindow(context)
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
  await startDictationCapture()
}

async function startDictationCapture() {
  const ready = await ensureDictationCanStart()
  if (!ready) {
    return
  }
  cancelActiveSubmission()
  beginTurnContextCapture()
  updateVoiceState({
    phase: 'processing',
    transcript: '',
    finalText: '',
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
  if (!hotkeyBridge || hotkeyBridge.killed) {
    hotkeyBridge = null
    return
  }

  hotkeyBridge.kill()
  hotkeyBridge = null
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

function startHotkeyBridge() {
  stopHotkeyBridge()
  hotkeyBridge = spawn(HOTKEY_BRIDGE, [trayHotkey], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const stdout = readline.createInterface({ input: hotkeyBridge.stdout })
  stdout.on('line', (line) => {
    const event = String(line || '').trim().toLowerCase()
    if (event === 'down') {
      void startDictationCapture()
      return
    }
    if (event === 'up') {
      void stopDictationCapture()
    }
  })

  const stderr = readline.createInterface({ input: hotkeyBridge.stderr })
  stderr.on('line', (line) => {
    const message = String(line || '').trim()
    if (message) {
      console.error(`[dictray] hotkey bridge: ${message}`)
    }
  })

  hotkeyBridge.on('error', (error) => {
    console.error('[dictray] Failed to start hotkey bridge:', error)
    stopHotkeyBridge()
    registerPressOnlyHotkey()
    showNotification(APP_NAME, 'Hold-to-talk bridge failed. Falling back to press-to-toggle.')
  })

  hotkeyBridge.on('exit', (code) => {
    hotkeyBridge = null
    if (isQuitting) {
      return
    }
    console.error(`[dictray] Hotkey bridge exited with code ${code ?? 0}.`)
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

async function bootstrap() {
  runtimeConfig = await loadConfig()
  stateDir = runtimeConfig.memory.stateDir
  traySettingsPath = path.join(stateDir, 'dictation-tray-settings.json')
  rewritePreferencesPath = path.join(stateDir, 'ollama-preferences.json')
  dailyCharacterStatsPath = path.join(stateDir, 'dictation-tray-daily-character-stats.json')
  onboardingStatePath = path.join(stateDir, 'dictation-tray-onboarding.json')

  await loadTraySettings()
  await loadDailyCharacterStats()
  await loadOnboardingState()

  const rewritePreferences = await readSharedRewritePreferences()
  currentRewriteThink = String(rewritePreferences.think || runtimeConfig.rewrite.ollama.think || 'default').trim() || 'default'
  currentRewriteModel = String(rewritePreferences.model || runtimeConfig.rewrite.ollama.model || '').trim()
  runtimeConfig.rewrite.ollama.model = currentRewriteModel
  runtimeConfig.rewrite.ollama.think = currentRewriteThink
  runtimeConfig.ollama.model = currentRewriteModel
  runtimeConfig.ollama.think = currentRewriteThink

  speech = createSttProvider({
    ...runtimeConfig.stt,
    rootDir: runtimeConfig.rootDir
  }, stateDir)
  rewriteProvider = createRewriteProvider(runtimeConfig.rewrite)
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
  void scheduleSttWarmup({ notifyReady: true }).catch(() => {})
  await refreshRuntimeState(false)
  await registerHotkey()

  refreshTimer = setInterval(() => {
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
