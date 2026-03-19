import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function nowMs(started) {
  return Math.round(performance.now() - started)
}

function buildSilentWav(durationSec = 0.1) {
  const sampleRate = 16000
  const numSamples = Math.round(sampleRate * durationSec)
  const dataSize = numSamples * 2 // 16-bit mono
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16) // chunk size
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buffer.writeUInt16LE(2, 32) // block align
  buffer.writeUInt16LE(16, 34) // bits per sample
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  // samples are zero (silence) by default from Buffer.alloc
  return buffer
}

function inputExtension(contentType) {
  switch (String(contentType || '').split(';', 1)[0].trim().toLowerCase()) {
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

function expandHome(value) {
  const home = os.homedir().replace(/\\/g, '/')
  const text = String(value || '')
  if (text.startsWith('$HOME/')) {
    return `${home}/${text.slice('$HOME/'.length)}`
  }
  if (text === '$HOME') {
    return home
  }
  if (text.startsWith('~/')) {
    return `${home}/${text.slice(2)}`
  }
  return text
}

function escapeShellArg(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`
}

function compactErrorText(value, limit = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`
}

function speechErrorText(error) {
  return [error?.message, error?.stderr, error?.stdout]
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .map((part) => String(part).trim())
    .join('\n')
}

function normalizeSpeechRuntimeError(kind, provider, error) {
  const raw = speechErrorText(error)
  const text = compactErrorText(raw, 240)
  const providerLabel = provider === 'wsl'
    ? 'WSL'
    : provider === 'http'
      ? 'HTTP'
      : 'Local'
  const kindLabel = kind === 'tts' ? 'TTS' : 'STT'
  const target = `${providerLabel} ${kindLabel}`

  if (/access is denied/i.test(raw)) {
    return `${target} is unavailable: access was denied.`
  }

  if (/ffmpeg/i.test(raw) && /(command not found|not recognized|enoent|no such file)/i.test(raw)) {
    return `${target} is unavailable: ffmpeg is not installed${provider === 'wsl' ? ' in WSL' : ''}.`
  }

  if (kind === 'stt' && /python/i.test(raw) && /(command not found|not recognized|enoent|no such file)/i.test(raw)) {
    return `${target} is unavailable: Python is not installed${provider === 'wsl' ? ' in WSL' : ''}.`
  }

  if (kind === 'stt' && /faster_whisper_cli\.py/i.test(raw) && /(can't open file|cannot open|no such file|not found)/i.test(raw)) {
    return `${target} is unavailable: faster-whisper CLI was not found${provider === 'wsl' ? ' in WSL' : ''}.`
  }

  if (kind === 'tts' && /piper/i.test(raw) && /(command not found|not recognized|enoent|no such file|not found)/i.test(raw)) {
    return `${target} is unavailable: Piper is not installed${provider === 'wsl' ? ' in WSL' : ''}.`
  }

  if (provider === 'http' && /fetch failed|econnrefused|timed out|abort/i.test(raw)) {
    return `${target} is unavailable: the speech service is not reachable.`
  }

  return text ? `${target} failed: ${text}` : `${target} failed.`
}

function withTimeout(timeoutMs, parentSignal = null) {
  const controller = new AbortController()
  let abortParent = null
  if (parentSignal) {
    abortParent = () => {
      controller.abort(parentSignal.reason)
    }
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason)
    } else {
      parentSignal.addEventListener('abort', abortParent, { once: true })
    }
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return {
    signal: controller.signal,
    clear() {
      clearTimeout(timer)
      if (abortParent && parentSignal) {
        parentSignal.removeEventListener('abort', abortParent)
      }
    }
  }
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|cancelled/i.test(String(error?.message || error || ''))
}

async function cleanupOldFiles(directory, keep = 24) {
  await mkdir(directory, { recursive: true })
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const fullPath = path.join(directory, entry.name)
        const stats = await stat(fullPath)
        return { fullPath, mtimeMs: stats.mtimeMs }
      })
  )

  for (const file of files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(keep)) {
    try {
      await unlink(file.fullPath)
    } catch {
      // ignore
    }
  }
}

function toWslPath(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/')
  const match = normalized.match(/^([A-Za-z]):\/(.*)$/)
  if (match) {
    return `/mnt/${match[1].toLowerCase()}/${match[2]}`
  }
  return normalized
}

async function fetchJson(url, options, timeoutMs) {
  const timeout = withTimeout(timeoutMs, options?.signal || null)
  try {
    const response = await fetch(url, {
      ...options,
      signal: timeout.signal
    })
    const payload = await response.json().catch(() => ({}))
    return {
      ok: response.ok,
      status: response.status,
      payload
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new Error(`Request to ${url} failed: ${error?.message || error}`)
  } finally {
    timeout.clear()
  }
}

async function fetchBytes(url, options, timeoutMs) {
  const timeout = withTimeout(timeoutMs, options?.signal || null)
  try {
    const response = await fetch(url, {
      ...options,
      signal: timeout.signal
    })
    const bytes = Buffer.from(await response.arrayBuffer())
    return {
      ok: response.ok,
      status: response.status,
      bytes
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new Error(`Request to ${url} failed: ${error?.message || error}`)
  } finally {
    timeout.clear()
  }
}

async function fetchStream(url, options, timeoutMs) {
  const timeout = withTimeout(timeoutMs, options?.signal || null)
  try {
    return await fetch(url, {
      ...options,
      signal: timeout.signal
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }
    throw new Error(`Request to ${url} failed: ${error?.message || error}`)
  } finally {
    timeout.clear()
  }
}

export class SpeechTools {
  constructor(config, stateDir) {
    this.config = config
    this.audioDir = path.join(stateDir, 'audio')
    this.workDir = path.join(stateDir, 'voice-tmp')
    this._healthCache = null
    this._healthCacheAt = 0
  }

  /**
   * Send a tiny silent WAV through the STT pipeline to prime the active STT path and model.
   * Call as fire-and-forget during startup.
   */
  async warmStt() {
    if (!this.config.enabled) return { ok: false, reason: 'disabled' }
    try {
      const silentWav = buildSilentWav(0.1)
      await this.transcribeAudioBuffer(silentWav, 'audio/wav')
      return { ok: true }
    } catch {
      return { ok: false, reason: 'warmup_failed' }
    }
  }

  async checkHealthCached(ttlMs = 15000) {
    const now = Date.now()
    if (this._healthCache && (now - this._healthCacheAt) < ttlMs) {
      return this._healthCache
    }
    this._healthCache = await this.checkHealth()
    this._healthCacheAt = now
    return this._healthCache
  }

  async checkHealth() {
    if (!this.config.enabled) {
      return {
        ok: false,
        enabled: false
      }
    }

    const [stt, tts] = await Promise.all([
      this.checkSttHealth(),
      this.checkTtsHealth()
    ])

    return {
      ok: Boolean(stt.ok && tts.ok),
      enabled: true,
      stt,
      tts
    }
  }

  async checkSttHealth() {
    const stt = this.config.stt

    if (stt.provider === 'http') {
      try {
        const result = await fetchJson(
          `${stt.http.baseUrl}${stt.http.healthPath}`,
          { method: 'GET' },
          stt.http.timeoutMs
        )
        return {
          ok: Boolean(result.ok),
          provider: 'http',
          baseUrl: stt.http.baseUrl,
          status: result.status,
          device: String(result.payload?.device || '').trim(),
          computeType: String(result.payload?.computeType || '').trim(),
          model: String(result.payload?.model || '').trim()
        }
      } catch (error) {
        return {
          ok: false,
          provider: 'http',
          baseUrl: stt.http.baseUrl,
          error: String(error?.message || error)
        }
      }
    }

    if (stt.provider === 'local') {
      try {
        await access(expandHome(stt.local.transcribeScript))
        await execFileAsync(expandHome(stt.local.ffmpegBin), ['-version'], { timeout: 1500 })
        await execFileAsync(expandHome(stt.local.pythonBin), ['-c', 'import faster_whisper'], { timeout: 4000 })
        return {
          ok: true,
          provider: 'local',
          pythonBin: stt.local.pythonBin
        }
      } catch (error) {
        return {
          ok: false,
          provider: 'local',
          error: String(error?.message || error)
        }
      }
    }

    try {
      const { stdout } = await execFileAsync(
        stt.wsl.wslBin,
        [
          '-e',
          'bash',
          '-c',
          [
            `command -v ${escapeShellArg(stt.wsl.pythonBin)} >/dev/null`,
            `command -v ${escapeShellArg(stt.wsl.ffmpegBin)} >/dev/null`,
            `test -f ${escapeShellArg(stt.wsl.transcribeScript)}`,
            'printf ok'
          ].join(' && ')
        ],
        {
          timeout: 3000,
          maxBuffer: 1024 * 1024
        }
      )
      return {
        ok: String(stdout || '').trim() === 'ok',
        provider: 'wsl',
        wslBin: stt.wsl.wslBin
      }
    } catch (error) {
      return {
        ok: false,
        provider: 'wsl',
        wslBin: stt.wsl.wslBin,
        error: String(error?.message || error)
      }
    }
  }

  async checkTtsHealth() {
    const tts = this.config.tts

    if (tts.provider === 'http') {
      try {
        const result = await fetchJson(
          `${tts.http.baseUrl}${tts.http.healthPath}`,
          { method: 'GET' },
          tts.http.timeoutMs
        )
        return {
          ok: Boolean(result.ok),
          provider: 'http',
          baseUrl: tts.http.baseUrl,
          status: result.status,
          voice: tts.voice
        }
      } catch (error) {
        return {
          ok: false,
          provider: 'http',
          baseUrl: tts.http.baseUrl,
          voice: tts.voice,
          error: String(error?.message || error)
        }
      }
    }

    if (tts.provider === 'local') {
      try {
        const { stdout } = await execFileAsync(expandHome(tts.local.piperBin), ['--list-voices'], {
          timeout: 2000,
          maxBuffer: 1024 * 1024
        })
        return {
          ok: String(stdout || '').includes(tts.voice),
          provider: 'local',
          voice: tts.voice
        }
      } catch (error) {
        return {
          ok: false,
          provider: 'local',
          voice: tts.voice,
          error: String(error?.message || error)
        }
      }
    }

    try {
      const { stdout } = await execFileAsync(
        tts.wsl.wslBin,
        [
          '-e',
          'bash',
          '-c',
          [
            `command -v ${escapeShellArg(tts.wsl.ffmpegBin)} >/dev/null`,
            `test -x ${escapeShellArg(tts.wsl.piperBin)}`,
            'printf ok'
          ].join(' && ')
        ],
        {
          timeout: 3000,
          maxBuffer: 1024 * 1024
        }
      )
      return {
        ok: String(stdout || '').trim() === 'ok',
        provider: 'wsl',
        voice: tts.voice,
        wslBin: tts.wsl.wslBin
      }
    } catch (error) {
      return {
        ok: false,
        provider: 'wsl',
        voice: tts.voice,
        wslBin: tts.wsl.wslBin,
        error: String(error?.message || error)
      }
    }
  }

  async getSttRuntime() {
    const stt = this.config.stt
    if (stt.provider !== 'http') {
      return {
        ok: false,
        supported: false,
        provider: stt.provider
      }
    }

    try {
      const result = await fetchJson(
        `${stt.http.baseUrl}/runtime`,
        { method: 'GET' },
        stt.http.timeoutMs
      )
      return {
        ok: Boolean(result.ok),
        supported: true,
        provider: 'http',
        baseUrl: stt.http.baseUrl,
        device: String(result.payload?.device || '').trim(),
        availableDevices: Array.isArray(result.payload?.availableDevices)
          ? result.payload.availableDevices.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        computeType: String(result.payload?.computeType || '').trim(),
        model: String(result.payload?.model || '').trim()
      }
    } catch (error) {
      return {
        ok: false,
        supported: true,
        provider: 'http',
        baseUrl: stt.http.baseUrl,
        error: String(error?.message || error)
      }
    }
  }

  async updateSttRuntime(input = {}) {
    const stt = this.config.stt
    if (stt.provider !== 'http') {
      return {
        ok: false,
        supported: false,
        provider: stt.provider
      }
    }

    const payload = {}
    if (input.device !== undefined) {
      payload.device = String(input.device || '').trim()
    }
    if (input.computeType !== undefined) {
      payload.computeType = String(input.computeType || '').trim()
    }
    if (input.model !== undefined) {
      payload.model = String(input.model || '').trim()
    }

    try {
      const result = await fetchJson(
        `${stt.http.baseUrl}/runtime`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload)
        },
        stt.http.timeoutMs
      )
      if (!result.ok) {
        throw new Error(result.payload?.detail || result.payload?.error || `STT runtime update failed with ${result.status}`)
      }
      return {
        ok: true,
        supported: true,
        provider: 'http',
        baseUrl: stt.http.baseUrl,
        device: String(result.payload?.device || '').trim(),
        availableDevices: Array.isArray(result.payload?.availableDevices)
          ? result.payload.availableDevices.map((item) => String(item || '').trim()).filter(Boolean)
          : [],
        computeType: String(result.payload?.computeType || '').trim(),
        model: String(result.payload?.model || '').trim()
      }
    } catch (error) {
      return {
        ok: false,
        supported: true,
        provider: 'http',
        baseUrl: stt.http.baseUrl,
        error: String(error?.message || error)
      }
    }
  }

  async transcribeAudioBuffer(audioBuffer, contentType, options = {}) {
    const stt = this.config.stt
    if (stt.provider === 'http') {
      return this.transcribeViaHttp(audioBuffer, contentType, options)
    }

    const started = performance.now()
    await mkdir(this.workDir, { recursive: true })
    const tempDir = await mkdtemp(path.join(this.workDir, 'voice-turn-'))
    const rawPath = path.join(tempDir, `input${inputExtension(contentType)}`)
    const wavPath = path.join(tempDir, 'normalized.wav')

    try {
      await writeFile(rawPath, audioBuffer)
      if (stt.provider === 'local') {
        return await this.transcribeViaLocal(rawPath, wavPath, started)
      }
      return await this.transcribeViaWsl(rawPath, wavPath, started)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async transcribeViaLocal(rawPath, wavPath, started) {
    const stt = this.config.stt.local
    const normalizeStarted = performance.now()
    try {
      await execFileAsync(
        expandHome(stt.ffmpegBin),
        ['-v', 'error', '-y', '-i', rawPath, '-ac', '1', '-ar', '16000', wavPath],
        { timeout: 30000 }
      )
      const transcribeStarted = performance.now()
      const { stdout, stderr } = await execFileAsync(
        expandHome(stt.pythonBin),
        [expandHome(stt.transcribeScript), wavPath],
        {
          timeout: 120000,
          maxBuffer: 1024 * 1024
        }
      )
      const payload = JSON.parse(String(stdout || stderr || '{}'))
      return {
        transcript: String(payload.transcript || '').trim(),
        language: String(payload.language || 'en'),
        timingsMs: {
          normalize: nowMs(normalizeStarted),
          transcribe: nowMs(transcribeStarted),
          total: nowMs(started)
        }
      }
    } catch (error) {
      throw new Error(normalizeSpeechRuntimeError('stt', 'local', error))
    }
  }

  async transcribeViaWsl(rawPath, wavPath, started) {
    const stt = this.config.stt.wsl
    const normalizeStarted = performance.now()
    try {
      // Use -c (not -lc) to skip login shell overhead — saves 2-4 seconds
      const transcribeStarted = performance.now()
      const { stdout, stderr } = await execFileAsync(
        stt.wslBin,
        [
          '-e',
          'bash',
          '-c',
          `${escapeShellArg(stt.ffmpegBin)} -v error -y -i "$1" -ac 1 -ar 16000 "$2" && ${escapeShellArg(stt.pythonBin)} ${escapeShellArg(stt.transcribeScript)} "$2"`,
          'bash',
          toWslPath(rawPath),
          toWslPath(wavPath)
        ],
        {
          timeout: this.config.stt.timeoutMs,
          maxBuffer: 4 * 1024 * 1024
        }
      )
      const payload = JSON.parse(String(stdout || stderr || '{}'))
      return {
        transcript: String(payload.transcript || '').trim(),
        language: String(payload.language || 'en'),
        timingsMs: {
          normalize: nowMs(normalizeStarted),
          transcribe: nowMs(transcribeStarted),
          total: nowMs(started)
        }
      }
    } catch (error) {
      throw new Error(normalizeSpeechRuntimeError('stt', 'wsl', error))
    }
  }

  async transcribeViaHttp(audioBuffer, contentType, options = {}) {
    const stt = this.config.stt.http
    const started = performance.now()
    try {
      const result = await fetchJson(
        `${stt.baseUrl}${stt.path}`,
        {
          method: 'POST',
          headers: {
            'content-type': contentType || 'application/octet-stream'
          },
          signal: options?.signal || null,
          body: audioBuffer
        },
        stt.timeoutMs
      )
      if (!result.ok) {
        throw new Error(`STT request to ${stt.baseUrl}${stt.path} failed with ${result.status}: ${result.payload?.detail || result.payload?.error || 'unknown error'}`)
      }

      const payload = result.payload || {}
      return {
        transcript: String(payload.transcript || '').trim(),
        language: String(payload.language || 'en'),
        timingsMs: {
          normalize: Number(payload?.timingsMs?.normalize || 0),
          transcribe: Number(payload?.timingsMs?.transcribe || nowMs(started)),
          total: nowMs(started)
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      throw new Error(normalizeSpeechRuntimeError('stt', 'http', error))
    }
  }

  async synthesizeReplyAudio(replyText) {
    const text = String(replyText || '').trim()
    if (!text) {
      return null
    }

    if (this.config.tts.provider === 'http') {
      return this.synthesizeViaHttp(text)
    }

    await mkdir(this.audioDir, { recursive: true })
    const started = performance.now()
    const tempDir = await mkdtemp(path.join(this.audioDir, 'tts-'))
    const textPath = path.join(tempDir, 'reply.txt')
    const wavPath = path.join(tempDir, 'reply.wav')
    const fileName = `reply-${randomUUID()}.mp3`
    const fullPath = path.join(this.audioDir, fileName)

    try {
      await writeFile(textPath, `${text}\n`)
      if (this.config.tts.provider === 'local') {
        await this.synthesizeViaLocal(textPath, wavPath, fullPath)
      } else {
        await this.synthesizeViaWsl(textPath, wavPath, fullPath)
      }

      await cleanupOldFiles(this.audioDir, 48)
      return {
        fileName,
        fullPath,
        audioUrl: `/audio/${fileName}`,
        timingsMs: {
          tts: nowMs(started)
        }
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async synthesizeReplyAudioStream(replyText) {
    const text = String(replyText || '').trim()
    if (!text || this.config.tts.provider !== 'http') {
      return null
    }

    const tts = this.config.tts.http
    const started = performance.now()
    const response = await fetchStream(
      `${tts.baseUrl}${tts.streamPath}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          text,
          voice: this.config.tts.voice
        })
      },
      tts.timeoutMs
    )

    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`TTS stream request to ${tts.baseUrl}${tts.streamPath} failed with ${response.status}${detail ? `: ${detail}` : ''}`)
    }

    if (!response.body) {
      throw new Error(`TTS stream request to ${tts.baseUrl}${tts.streamPath} returned no body`)
    }

    return {
      body: response.body,
      mimeType: String(response.headers.get('content-type') || 'application/octet-stream').split(';', 1)[0].trim().toLowerCase(),
      sampleRate: Math.max(8000, Number(response.headers.get('x-audio-sample-rate') || '22050')),
      channels: Math.max(1, Number(response.headers.get('x-audio-channels') || '1')),
      sampleFormat: String(response.headers.get('x-audio-format') || 'pcm-s16le').trim().toLowerCase(),
      timingsMs: {
        tts: nowMs(started)
      }
    }
  }

  async synthesizeViaLocal(textPath, wavPath, fullPath) {
    const tts = this.config.tts
    try {
      await execFileAsync(
        expandHome(tts.local.piperBin),
        ['--voice', tts.voice, '--text-file', textPath, '--audio-format', 'wav', '--output', wavPath],
        {
          timeout: tts.timeoutMs,
          maxBuffer: 1024 * 1024
        }
      )
      await execFileAsync(
        expandHome(tts.local.ffmpegBin),
        ['-v', 'error', '-y', '-i', wavPath, '-codec:a', 'libmp3lame', '-q:a', '4', fullPath],
        { timeout: 30000 }
      )
    } catch (error) {
      throw new Error(normalizeSpeechRuntimeError('tts', 'local', error))
    }
  }

  async synthesizeViaWsl(textPath, wavPath, fullPath) {
    const tts = this.config.tts
    try {
      await execFileAsync(
        tts.wsl.wslBin,
        [
          '-e',
          'bash',
          '-c',
          `${escapeShellArg(tts.wsl.piperBin)} --voice "$1" --text-file "$2" --audio-format wav --output "$3" && ${escapeShellArg(tts.wsl.ffmpegBin)} -v error -y -i "$3" -codec:a libmp3lame -q:a 4 "$4"`,
          'bash',
          tts.voice,
          toWslPath(textPath),
          toWslPath(wavPath),
          toWslPath(fullPath)
        ],
        {
          timeout: tts.timeoutMs,
          maxBuffer: 4 * 1024 * 1024
        }
      )
    } catch (error) {
      throw new Error(normalizeSpeechRuntimeError('tts', 'wsl', error))
    }
  }

  async synthesizeViaHttp(text) {
    const tts = this.config.tts
    await mkdir(this.audioDir, { recursive: true })
    const started = performance.now()
    const fileName = `reply-${randomUUID()}.mp3`
    const fullPath = path.join(this.audioDir, fileName)
    try {
      const result = await fetchBytes(
        `${tts.http.baseUrl}${tts.http.path}`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify({
            text,
            voice: tts.voice,
            format: tts.format
          })
        },
        tts.http.timeoutMs
      )
      if (!result.ok) {
        throw new Error(`TTS request to ${tts.http.baseUrl}${tts.http.path} failed with ${result.status}`)
      }

      await writeFile(fullPath, result.bytes)
      await cleanupOldFiles(this.audioDir, 48)
      return {
        fileName,
        fullPath,
        audioUrl: `/audio/${fileName}`,
        timingsMs: {
          tts: nowMs(started)
        }
      }
    } catch (error) {
      throw new Error(normalizeSpeechRuntimeError('tts', 'http', error))
    }
  }

  async readAudioFile(fileName) {
    const fullPath = path.join(this.audioDir, path.basename(fileName))
    await access(fullPath)
    return readFile(fullPath)
  }
}
