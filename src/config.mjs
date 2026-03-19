import { readFile } from 'node:fs/promises'
import path from 'node:path'

const DEFAULTS = {
  memory: {
    stateDir: './local/state'
  },
  stt: {
    enabled: true,
    provider: 'local-http',
    timeoutMs: 120000,
    keepWarmIntervalMs: 900000,
    local: {
      pythonBin: 'python',
      ffmpegBin: 'ffmpeg',
      transcribeScript: '$HOME/.openclaw/tools/faster_whisper_cli.py'
    },
    wsl: {
      wslBin: 'wsl.exe',
      pythonBin: 'python',
      ffmpegBin: 'ffmpeg',
      transcribeScript: '$HOME/.openclaw/tools/faster_whisper_cli.py'
    },
    http: {
      baseUrl: 'http://127.0.0.1:4591',
      path: '/transcribe',
      healthPath: '/health',
      timeoutMs: 120000
    },
    docker: {
      enabled: true,
      autoStart: true,
      composeFile: './docker-compose.stt.yml'
    }
  },
  rewrite: {
    provider: 'ollama',
    ollama: {
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3-coder:30b',
      timeoutMs: 45000,
      keepAlive: '30m',
      think: 'default'
    }
  },
  dictation: {
    rewriteEnabled: true,
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
    case 'local-http':
    case 'local_http':
      return 'local-http'
    case 'local':
      return 'local'
    case 'wsl':
      return 'wsl'
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
  const normalized = normalizeSttProviderId(providerId)
  return normalized === 'local-http' ? 'http' : normalized
}

function normalizeOllamaConfig(input = {}, fallback = DEFAULTS.rewrite.ollama) {
  return {
    baseUrl: normalizeUrl(input?.baseUrl, fallback.baseUrl),
    model: String(input?.model || fallback.model).trim() || fallback.model,
    timeoutMs: clampTimeout(input?.timeoutMs ?? fallback.timeoutMs, fallback.timeoutMs),
    keepAlive: String(input?.keepAlive || fallback.keepAlive).trim() || fallback.keepAlive,
    think: String(input?.think || fallback.think).trim() || fallback.think
  }
}

export async function loadConfig(configPathArg) {
  const configPath = path.resolve(configPathArg || process.env.DICTATION_TRAY_CONFIG || './dictation-tray.config.json')
  const rootDir = path.dirname(configPath)
  const raw = await readFile(configPath, 'utf8')
  const parsed = JSON.parse(raw)
  const parsedSpeech = parsed?.speech || {}
  const parsedLegacyStt = parsedSpeech?.stt || {}
  const parsedStt = parsed?.stt || {}
  const parsedRewrite = parsed?.rewrite || {}

  const sttProvider = normalizeSttProviderId(parsedStt?.provider ?? parsedLegacyStt?.provider ?? DEFAULTS.stt.provider)
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
      pythonBin: String(parsedStt?.local?.pythonBin || parsedLegacyStt?.local?.pythonBin || DEFAULTS.stt.local.pythonBin),
      ffmpegBin: String(parsedStt?.local?.ffmpegBin || parsedLegacyStt?.local?.ffmpegBin || DEFAULTS.stt.local.ffmpegBin),
      transcribeScript: String(parsedStt?.local?.transcribeScript || parsedLegacyStt?.local?.transcribeScript || DEFAULTS.stt.local.transcribeScript)
    },
    wsl: {
      wslBin: String(parsedStt?.wsl?.wslBin || parsedLegacyStt?.wsl?.wslBin || DEFAULTS.stt.wsl.wslBin),
      pythonBin: String(parsedStt?.wsl?.pythonBin || parsedLegacyStt?.wsl?.pythonBin || DEFAULTS.stt.wsl.pythonBin),
      ffmpegBin: String(parsedStt?.wsl?.ffmpegBin || parsedLegacyStt?.wsl?.ffmpegBin || DEFAULTS.stt.wsl.ffmpegBin),
      transcribeScript: String(parsedStt?.wsl?.transcribeScript || parsedLegacyStt?.wsl?.transcribeScript || DEFAULTS.stt.wsl.transcribeScript)
    },
    http: mergeHttpProvider(parsedStt?.http || parsedLegacyStt?.http, DEFAULTS.stt.http),
    docker: {
      enabled: parsedStt?.docker?.enabled !== undefined
        ? Boolean(parsedStt.docker.enabled)
        : DEFAULTS.stt.docker.enabled,
      autoStart: parsedStt?.docker?.autoStart !== undefined
        ? Boolean(parsedStt.docker.autoStart)
        : parsed?.docker?.autoStartStt !== undefined
          ? Boolean(parsed.docker.autoStartStt)
          : DEFAULTS.stt.docker.autoStart,
      composeFile: resolvePathLike(rootDir, parsedStt?.docker?.composeFile || parsed?.docker?.composeFile || DEFAULTS.stt.docker.composeFile)
    }
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
      stateDir: path.resolve(rootDir, parsed?.memory?.stateDir || DEFAULTS.memory.stateDir)
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
        wsl: stt.wsl,
        http: stt.http
      }
    },
    docker: {
      autoStartStt: stt.docker.enabled && stt.docker.autoStart,
      composeFile: stt.docker.composeFile
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
      helperRoot: resolvePathLike(rootDir, './scripts')
    }
  }
}
