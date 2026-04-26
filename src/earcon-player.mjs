import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_RATE = 44100
const TARGET_PEAK = 0.36
const FFMPEG_BIN = String(process.env.DICTATION_TRAY_FFMPEG_BIN || process.env.STT_FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const EARCON_CACHE_DIR = path.join(os.tmpdir(), 'dictray-earcons')
const EARCON_ASSET_DIR = path.join(__dirname, '..', 'assets', 'earcons')
const EARCON_DEFINITIONS = {
  listen: {
    asset: 'listen.mp3',
    pulses: [
      { wave: 'sine', fromHz: 520, toHz: 650, startMs: 0, durationMs: 110, level: 0.62 },
      { wave: 'sine', fromHz: 650, toHz: 760, startMs: 46, durationMs: 120, level: 0.28 }
    ]
  },
  cancel: {
    pulses: [
      { wave: 'sine', fromHz: 360, toHz: 300, startMs: 0, durationMs: 115, level: 0.50 },
      { wave: 'sine', fromHz: 300, toHz: 240, startMs: 68, durationMs: 120, level: 0.38 }
    ]
  },
  submit: {
    asset: 'submit.mp3',
    pulses: [
      { wave: 'sine', fromHz: 640, toHz: 520, startMs: 0, durationMs: 130, level: 0.54 },
      { wave: 'sine', fromHz: 520, toHz: 390, startMs: 62, durationMs: 150, level: 0.34 }
    ]
  }
}

const PLAYER_CANDIDATES = [
  {
    command: 'afplay',
    platforms: ['darwin'],
    args: (filePath) => [filePath]
  },
  {
    command: 'paplay',
    platforms: ['linux'],
    args: (filePath) => ['--client-name=DicTray', filePath]
  },
  {
    command: 'pw-play',
    platforms: ['linux'],
    args: (filePath) => [filePath]
  },
  {
    command: 'aplay',
    platforms: ['linux'],
    args: (filePath) => ['-q', filePath]
  },
  {
    command: 'canberra-gtk-play',
    platforms: ['linux'],
    args: (filePath) => ['-f', filePath]
  }
]

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`
}

function commandAvailable(command) {
  if (!command) {
    return false
  }
  const result = spawnSync('sh', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: 'ignore',
    windowsHide: true
  })
  return result.status === 0
}

function normalizeKind(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(EARCON_DEFINITIONS, normalized) ? normalized : ''
}

function oscillate(wave, phase) {
  const cycle = phase - Math.floor(phase)
  switch (wave) {
    case 'square':
      return cycle < 0.5 ? 1 : -1
    case 'triangle':
      return 1 - 4 * Math.abs(cycle - 0.5)
    default:
      return Math.sin(2 * Math.PI * cycle)
  }
}

function chirpFrequency(fromHz, toHz, progress) {
  if (fromHz > 0 && toHz > 0) {
    return fromHz * ((toHz / fromHz) ** progress)
  }
  return fromHz + ((toHz - fromHz) * progress)
}

function pulseEnvelope(progress) {
  return Math.sin(Math.PI * Math.max(0, Math.min(1, progress))) ** 1.35
}

function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const length = samples.length
  const dataSize = length * 2
  const buffer = Buffer.allocUnsafe(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let index = 0; index < length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] || 0))
    buffer.writeInt16LE(Math.round(sample * 32767), 44 + (index * 2))
  }

  return buffer
}

function convertAudioToWav(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      inputPath,
      '-ar',
      String(SAMPLE_RATE),
      '-ac',
      '2',
      outputPath
    ], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code ?? 1}`))
    })
  })
}

function renderEarcon(kind) {
  const definition = EARCON_DEFINITIONS[kind]
  if (!definition) {
    throw new Error(`Unsupported earcon: ${kind}`)
  }

  const durationMs = definition.pulses.reduce((maxDuration, pulse) => {
    return Math.max(maxDuration, Number(pulse.startMs || 0) + Number(pulse.durationMs || 0))
  }, 0) + 60
  const totalSamples = Math.max(1, Math.ceil((durationMs / 1000) * SAMPLE_RATE))
  const mix = new Float32Array(totalSamples)

  for (const pulse of definition.pulses) {
    const startIndex = Math.max(0, Math.floor((Number(pulse.startMs || 0) / 1000) * SAMPLE_RATE))
    const pulseSamples = Math.max(1, Math.ceil((Number(pulse.durationMs || 0) / 1000) * SAMPLE_RATE))
    let phase = 0

    for (let sampleIndex = 0; sampleIndex < pulseSamples; sampleIndex += 1) {
      const targetIndex = startIndex + sampleIndex
      if (targetIndex >= totalSamples) {
        break
      }
      const progress = sampleIndex / pulseSamples
      const frequency = chirpFrequency(Number(pulse.fromHz || 0), Number(pulse.toHz || 0), progress)
      phase += frequency / SAMPLE_RATE
      mix[targetIndex] += oscillate(String(pulse.wave || 'sine').trim().toLowerCase(), phase)
        * Number(pulse.level || 0)
        * pulseEnvelope(progress)
    }
  }

  let peak = 0
  for (const sample of mix) {
    peak = Math.max(peak, Math.abs(sample))
  }
  const scale = peak > 0 ? TARGET_PEAK / peak : 1
  for (let index = 0; index < mix.length; index += 1) {
    mix[index] *= scale
  }

  return encodeWav(mix)
}

export function createEarconPlayer({ logger = null } = {}) {
  const log = typeof logger === 'function' ? logger : () => {}
  const cachedFiles = new Map()
  const lastPlayedAt = new Map()
  let resolvedPlayer = undefined

  async function ensureEarconFile(kind) {
    if (cachedFiles.has(kind)) {
      return cachedFiles.get(kind)
    }
    const definition = EARCON_DEFINITIONS[kind]
    const assetPath = definition?.asset ? path.join(EARCON_ASSET_DIR, definition.asset) : ''
    if (assetPath && existsSync(assetPath)) {
      if (process.platform === 'darwin') {
        cachedFiles.set(kind, assetPath)
        return assetPath
      }
      await mkdir(EARCON_CACHE_DIR, { recursive: true })
      const convertedPath = path.join(EARCON_CACHE_DIR, `${kind}-asset.wav`)
      try {
        await convertAudioToWav(assetPath, convertedPath)
        cachedFiles.set(kind, convertedPath)
        return convertedPath
      } catch (error) {
        log(`[dictray] Failed to convert earcon asset ${path.basename(assetPath)}: ${String(error?.message || error)}`)
      }
    }
    await mkdir(EARCON_CACHE_DIR, { recursive: true })
    const filePath = path.join(EARCON_CACHE_DIR, `${kind}.wav`)
    await writeFile(filePath, renderEarcon(kind))
    cachedFiles.set(kind, filePath)
    return filePath
  }

  function resolvePlayer() {
    if (resolvedPlayer !== undefined) {
      return resolvedPlayer
    }
    resolvedPlayer = PLAYER_CANDIDATES.find((candidate) => {
      return (!Array.isArray(candidate.platforms) || candidate.platforms.includes(process.platform))
        && commandAvailable(candidate.command)
    }) || null
    return resolvedPlayer
  }

  async function play(kind) {
    const normalizedKind = normalizeKind(kind)
    if (!normalizedKind || !['linux', 'darwin'].includes(process.platform)) {
      return { ok: false, skipped: true, reason: 'unsupported' }
    }

    const player = resolvePlayer()
    if (!player) {
      return { ok: false, skipped: true, reason: 'missing_player' }
    }

    const now = Date.now()
    const previousAt = Number(lastPlayedAt.get(normalizedKind) || 0)
    if ((now - previousAt) < 120) {
      return { ok: false, skipped: true, reason: 'cooldown' }
    }
    lastPlayedAt.set(normalizedKind, now)

    const filePath = await ensureEarconFile(normalizedKind)
    try {
      const child = spawn(player.command, player.args(filePath), {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.once('error', (error) => {
        log(`[dictray] Earcon playback failed: ${String(error?.message || error)}`)
      })
      child.unref()
      return {
        ok: true,
        kind: normalizedKind,
        player: player.command,
        filePath
      }
    } catch (error) {
      log(`[dictray] Earcon playback failed: ${String(error?.message || error)}`)
      return {
        ok: false,
        error: String(error?.message || error)
      }
    }
  }

  async function prepare(kinds = Object.keys(EARCON_DEFINITIONS)) {
    resolvePlayer()
    const normalizedKinds = [...new Set(kinds.map(normalizeKind).filter(Boolean))]
    for (const kind of normalizedKinds) {
      await ensureEarconFile(kind)
    }
    return {
      ok: true,
      kinds: normalizedKinds
    }
  }

  return {
    prepare,
    play
  }
}
