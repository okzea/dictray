import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeCaptureBackendId } from './capture-protocol.mjs'
import { projectRoot, resolveBundledSttConfig } from './runtime-paths.mjs'

const DEFAULTS = {
  memory: {
    stateDir: './local/state'
  },
  capture: {
    backend: 'native'
  },
  stt: {
    enabled: true,
    provider: 'local',
    timeoutMs: 120000,
    keepWarmIntervalMs: 900000,
    local: {
      pythonBin: 'python',
      ffmpegBin: 'ffmpeg',
      transcribeScript: './scripts/faster_whisper_cli.py',
      workerScript: './scripts/faster_whisper_worker.py',
      daemonScript: './scripts/faster_whisper_daemon.py',
      model: 'base.en',
      modelDir: '',
      device: 'auto',
      computeType: 'auto'
    },
    http: {
      baseUrl: 'http://127.0.0.1:4593',
      path: '/transcribe',
      healthPath: '/health',
      timeoutMs: 120000
    }
  },
  rewrite: {
    provider: 'none',
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3-coder:30b',
      timeoutMs: 45000,
      keepAlive: '30m',
      temperature: 0.1,
      think: 'default'
    }
  },
  dictation: {
    rewriteEnabled: false,
    duckingEnabled: true,
    duckingLevel: 0.3
  }
}

function clampTimeout(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.max(250, Math.floor(value))
}

function clampInterval(value, fallback) {
  if (value === 0 || value === '0') {
    return 0
  }
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.max(60000, Math.floor(value))
}

function clampRatio(value, fallback) {
  if (!Number.isFinite(value)) {
    return fallback
  }
  return Math.max(0, Math.min(1, Number(value)))
}

function normalizeUrl(value, fallback) {
  return String(value || fallback).replace(/\/+$/, '')
}

function resolvePathLike(rootDir, value) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }
  if (path.isAbsolute(text)) {
    return text
  }
  if (text.startsWith('.') || text.includes('/') || text.includes('\\')) {
    return path.resolve(rootDir, text)
  }
  return text
}

function preferBundledPython(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return !normalized || normalized === 'python' || normalized === 'python3'
}

function preferBundledTranscribeScript(value, fallback) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return true
  }
  return normalized === String(fallback || '').trim()
}

function preferBundledModelDir(value) {
  return !String(value || '').trim()
}

function mergeHttpProvider(parsed = {}, fallback) {
  return {
    baseUrl: normalizeUrl(parsed?.baseUrl, fallback.baseUrl),
    path: String(parsed?.path || fallback.path),
    healthPath: String(parsed?.healthPath || fallback.healthPath),
    timeoutMs: clampTimeout(parsed?.timeoutMs ?? fallback.timeoutMs, fallback.timeoutMs)
  }
}

export function normalizeSttProviderId(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) {
    return DEFAULTS.stt.provider
  }
  switch (normalized) {
    case 'http':
      return 'http'
    case 'local-http':
    case 'local_http':
    case 'local':
      return 'local'
    default:
      return normalized
  }
}

export function normalizeRewriteProviderId(value) {
  const normalized = String(value || '').trim().toLowerCase()
  if (!normalized) {
    return DEFAULTS.rewrite.provider
  }
  switch (normalized) {
    case 'none':
    case 'disabled':
    case 'off':
      return 'none'
    case 'ollama':
      return 'ollama'
    default:
      return normalized
  }
}

export function legacySttProviderId(providerId) {
  return normalizeSttProviderId(providerId)
}

function normalizeOllamaConfig(input = {}, fallback = DEFAULTS.rewrite.ollama) {
  return {
    baseUrl: normalizeUrl(input?.baseUrl, fallback.baseUrl),
    model: String(input?.model || fallback.model).trim() || fallback.model,
    timeoutMs: clampTimeout(input?.timeoutMs ?? fallback.timeoutMs, fallback.timeoutMs),
    keepAlive: String(input?.keepAlive || fallback.keepAlive).trim() || fallback.keepAlive,
    temperature: clampRatio(input?.temperature ?? fallback.temperature, fallback.temperature),
    think: String(input?.think || fallback.think).trim() || fallback.think
  }
}

export async function loadConfig(configPathArg) {
  const defaultConfigPath = path.join(projectRoot(), 'dictation-tray.config.json')
  const configPath = path.resolve(configPathArg || process.env.DICTATION_TRAY_CONFIG || defaultConfigPath)
  const rootDir = path.dirname(configPath)
  const raw = await readFile(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  const parsedSpeech = parsed?.speech || {}
  const parsedLegacyStt = parsedSpeech?.stt || {}
  const parsedStt = parsed?.stt || {}
  const parsedCapture = parsed?.capture || {}
  const parsedRewrite = parsed?.rewrite || {}
  const bundledStt = resolveBundledSttConfig()
  const envSttProvider = String(process.env.DICTATION_TRAY_STT_PROVIDER || '').trim()
  const envCaptureBackend = String(process.env.DICTATION_TRAY_CAPTURE_BACKEND || '').trim()
  const envFfmpegBin = String(process.env.DICTATION_TRAY_FFMPEG_BIN || process.env.STT_FFMPEG_BIN || '').trim()

  const sttProvider = normalizeSttProviderId(envSttProvider || parsedStt?.provider || parsedLegacyStt?.provider || DEFAULTS.stt.provider)
  const parsedLocalPythonBin = parsedStt?.local?.pythonBin ?? parsedLegacyStt?.local?.pythonBin
  const parsedLocalTranscribeScript = parsedStt?.local?.transcribeScript ?? parsedLegacyStt?.local?.transcribeScript
  const parsedLocalWorkerScript = parsedStt?.local?.workerScript ?? parsedLegacyStt?.local?.workerScript
  const parsedLocalDaemonScript = parsedStt?.local?.daemonScript ?? parsedLegacyStt?.local?.daemonScript
  const parsedLocalModelDir = parsedStt?.local?.modelDir ?? parsedLegacyStt?.local?.modelDir
  const stt = {
    enabled: parsedStt?.enabled !== undefined
      ? Boolean(parsedStt.enabled)
      : parsedSpeech?.enabled !== undefined
        ? Boolean(parsedSpeech.enabled)
        : DEFAULTS.stt.enabled,
    provider: sttProvider,
    timeoutMs: clampTimeout(parsedStt?.timeoutMs ?? parsedLegacyStt?.timeoutMs ?? DEFAULTS.stt.timeoutMs, DEFAULTS.stt.timeoutMs),
    keepWarmIntervalMs: clampInterval(
      parsedStt?.keepWarmIntervalMs ?? parsedLegacyStt?.keepWarmIntervalMs ?? DEFAULTS.stt.keepWarmIntervalMs,
      DEFAULTS.stt.keepWarmIntervalMs
    ),
    local: {
      pythonBin: bundledStt?.pythonBin && preferBundledPython(parsedLocalPythonBin)
        ? bundledStt.pythonBin
        : String(parsedLocalPythonBin || DEFAULTS.stt.local.pythonBin),
      ffmpegBin: String(envFfmpegBin || parsedStt?.local?.ffmpegBin || parsedLegacyStt?.local?.ffmpegBin || DEFAULTS.stt.local.ffmpegBin),
      transcribeScript: bundledStt?.transcribeScript && preferBundledTranscribeScript(parsedLocalTranscribeScript, DEFAULTS.stt.local.transcribeScript)
        ? bundledStt.transcribeScript
        : resolvePathLike(rootDir, parsedLocalTranscribeScript || DEFAULTS.stt.local.transcribeScript),
      workerScript: bundledStt?.workerScript && preferBundledTranscribeScript(parsedLocalWorkerScript, DEFAULTS.stt.local.workerScript)
        ? bundledStt.workerScript
        : resolvePathLike(rootDir, parsedLocalWorkerScript || DEFAULTS.stt.local.workerScript),
      daemonScript: bundledStt?.daemonScript && preferBundledTranscribeScript(parsedLocalDaemonScript, DEFAULTS.stt.local.daemonScript)
        ? bundledStt.daemonScript
        : resolvePathLike(rootDir, parsedLocalDaemonScript || DEFAULTS.stt.local.daemonScript),
      model: String(parsedStt?.local?.model || parsedLegacyStt?.local?.model || bundledStt?.model || DEFAULTS.stt.local.model).trim() || DEFAULTS.stt.local.model,
      modelDir: bundledStt?.modelDir && preferBundledModelDir(parsedLocalModelDir)
        ? bundledStt.modelDir
        : resolvePathLike(rootDir, parsedLocalModelDir || DEFAULTS.stt.local.modelDir),
      device: String(parsedStt?.local?.device || parsedLegacyStt?.local?.device || DEFAULTS.stt.local.device).trim() || DEFAULTS.stt.local.device,
      computeType: String(parsedStt?.local?.computeType || parsedLegacyStt?.local?.computeType || DEFAULTS.stt.local.computeType).trim() || DEFAULTS.stt.local.computeType
    },
    http: mergeHttpProvider(parsedStt?.http || parsedLegacyStt?.http, DEFAULTS.stt.http)
  }

  const rewriteProvider = normalizeRewriteProviderId(parsedRewrite?.provider ?? (parsed?.ollama ? 'ollama' : DEFAULTS.rewrite.provider))
  const rewrite = {
    provider: rewriteProvider,
    ollama: normalizeOllamaConfig(parsedRewrite?.ollama || parsed?.ollama, DEFAULTS.rewrite.ollama)
  }

  return {
    configPath,
    rootDir,
    memory: {
      stateDir: path.resolve(process.env.DICTATION_TRAY_STATE_DIR || parsed?.memory?.stateDir || DEFAULTS.memory.stateDir)
    },
    capture: {
      backend: normalizeCaptureBackendId(envCaptureBackend || parsedCapture?.backend || DEFAULTS.capture.backend)
    },
    stt,
    rewrite,
    // Legacy aliases kept so existing runtime helpers continue to work while the tray migrates.
    speech: {
      enabled: stt.enabled,
      stt: {
        provider: legacySttProviderId(stt.provider),
        timeoutMs: stt.timeoutMs,
        keepWarmIntervalMs: stt.keepWarmIntervalMs,
        local: stt.local,
        http: stt.http
      }
    },
    ollama: rewrite.ollama,
    dictation: {
      rewriteEnabled: parsed?.dictation?.rewriteEnabled !== undefined
        ? Boolean(parsed.dictation.rewriteEnabled)
        : DEFAULTS.dictation.rewriteEnabled,
      duckingEnabled: parsed?.dictation?.duckingEnabled !== undefined
        ? Boolean(parsed.dictation.duckingEnabled)
        : DEFAULTS.dictation.duckingEnabled,
      duckingLevel: clampRatio(parsed?.dictation?.duckingLevel ?? DEFAULTS.dictation.duckingLevel, DEFAULTS.dictation.duckingLevel)
    },
    resolved: {
      hotkeyEnv: String(process.env.DICTATION_TRAY_HOTKEY || '').trim(),
      helperRoot: resolvePathLike(rootDir, './scripts'),
      bundledStt
    }
  }
}
