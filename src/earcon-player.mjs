import { spawn, spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const SAMPLE_RATE = 44100
const TARGET_PEAK = 0.82
const EARCON_CACHE_DIR = path.join(os.tmpdir(), 'dictray-earcons')
const EARCON_DEFINITIONS = {
  listen: {
    pulses: [
      { wave: 'sine', fromHz: 720, toHz: 1280, startMs: 0, durationMs: 120, level: 0.76 },
      { wave: 'triangle', fromHz: 1040, toHz: 1640, startMs: 30, durationMs: 110, level: 0.38 }
    ]
  },
  cancel: {
    pulses: [
      { wave: 'square', fromHz: 210, toHz: 168, startMs: 0, durationMs: 50, level: 0.42 },
      { wave: 'square', fromHz: 198, toHz: 158, startMs: 70, durationMs: 50, level: 0.42 },
      { wave: 'square', fromHz: 186, toHz: 148, startMs: 140, durationMs: 50, level: 0.42 },
      { wave: 'triangle', fromHz: 320, toHz: 220, startMs: 10, durationMs: 60, level: 0.30 },
      { wave: 'triangle', fromHz: 308, toHz: 212, startMs: 80, durationMs: 60, level: 0.30 },
      { wave: 'triangle', fromHz: 296, toHz: 204, startMs: 150, durationMs: 60, level: 0.30 }
    ]
  },
  submit: {
    pulses: [
      { wave: 'sine', fromHz: 500, toHz: 1120, startMs: 0, durationMs: 240, level: 0.68 },
      { wave: 'triangle', fromHz: 720, toHz: 1560, startMs: 45, durationMs: 220, level: 0.42 },
      { wave: 'square', fromHz: 1120, toHz: 2240, startMs: 95, durationMs: 180, level: 0.17 }
    ]
  }
}

const PLAYER_CANDIDATES = [
  {
    command: 'paplay',
    args: (filePath) => ['--client-name=DicTray', filePath]
  },
  {
    command: 'pw-play',
    args: (filePath) => [filePath]
  },
  {
    command: 'aplay',
    args: (filePath) => ['-q', filePath]
  },
  {
    command: 'canberra-gtk-play',
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
    resolvedPlayer = PLAYER_CANDIDATES.find((candidate) => commandAvailable(candidate.command)) || null
    return resolvedPlayer
  }

  async function play(kind) {
    const normalizedKind = normalizeKind(kind)
    if (!normalizedKind || process.platform !== 'linux') {
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

  return {
    play
  }
}
