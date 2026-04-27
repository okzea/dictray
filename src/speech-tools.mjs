import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
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

function splitEnvPath(value) {
  return String(value || '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function dedupePaths(entries) {
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    const normalized = String(entry || '').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function resolveCudaLibraryDirs(env = process.env) {
  if (process.platform !== 'linux') {
    return []
  }

  const candidates = dedupePaths([
    ...splitEnvPath(env.DICTATION_TRAY_STT_LD_LIBRARY_PATH),
    ...splitEnvPath(env.DICTATION_TRAY_CUDA_LIB_DIR),
    '/usr/local/lib/ollama/cuda_v12',
    '/usr/local/cuda/lib64',
    '/usr/local/cuda-12/lib64',
    '/usr/local/cuda-12.8/lib64',
    '/opt/cuda/lib64'
  ])

  const resolved = []
  for (const directory of candidates) {
    const hasCuda12Runtime = await pathExists(path.join(directory, 'libcublas.so.12'))
      || await pathExists(path.join(directory, 'libcublasLt.so.12'))
      || await pathExists(path.join(directory, 'libcudart.so.12'))
    if (hasCuda12Runtime) {
      resolved.push(directory)
    }
  }
  return resolved
}

async function buildSpeechChildEnv(baseEnv = process.env) {
  const env = { ...baseEnv }
  const extraLibDirs = await resolveCudaLibraryDirs(env)
  if (!extraLibDirs.length) {
    return env
  }

  env.LD_LIBRARY_PATH = dedupePaths([
    ...extraLibDirs,
    ...splitEnvPath(env.LD_LIBRARY_PATH)
  ]).join(path.delimiter)
  return env
}

function pythonSpawnInvocation(pythonBin, args = []) {
  const command = expandHome(pythonBin)
  const commandArgs = args.map((arg) => String(arg))
  return {
    command,
    args: commandArgs
  }
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

function cudaRuntimeUnavailable(error) {
  const raw = speechErrorText(error)
  return /(cublas|cudnn|cublaslt).*?(not found|cannot be loaded|load failed)|cuda.*?(not found|cannot be loaded|load failed)/i.test(raw)
}

function explicitMissingScriptError(error, scriptName) {
  const stderr = String(error?.stderr || '').trim()
  const stdout = String(error?.stdout || '').trim()
  const message = String(error?.message || '').trim()
  const haystacks = [stderr, stdout, message].filter(Boolean)
  const escapedScriptName = String(scriptName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!escapedScriptName) {
    return false
  }

  const patterns = [
    new RegExp(`can't open file[^\\n\\r]*${escapedScriptName}`, 'i'),
    new RegExp(`cannot open[^\\n\\r]*${escapedScriptName}`, 'i'),
    new RegExp(`no such file[^\\n\\r]*${escapedScriptName}`, 'i'),
    new RegExp(`not found[^\\n\\r]*${escapedScriptName}`, 'i'),
    new RegExp(`${escapedScriptName}[^\\n\\r]*(can't open file|cannot open|no such file|not found)`, 'i')
  ]

  return haystacks.some((text) => patterns.some((pattern) => pattern.test(text)))
}

function localSttDiagnosticFields(stt = {}) {
  return {
    pythonBin: String(stt?.pythonBin || '').trim(),
    transcribeScript: String(stt?.transcribeScript || '').trim(),
    workerScript: String(stt?.workerScript || '').trim(),
    daemonScript: String(stt?.daemonScript || '').trim(),
    model: String(stt?.model || '').trim(),
    modelDir: String(stt?.modelDir || '').trim(),
    device: String(stt?.device || '').trim(),
    computeType: String(stt?.computeType || '').trim()
  }
}

class LocalSttWorkerClient {
  constructor(sttConfig = {}) {
    this.sttConfig = sttConfig
    this.child = null
    this.stdoutReader = null
    this.stderrReader = null
    this.pending = new Map()
    this.nextRequestId = 1
    this.stderrLines = []
    this.startPromise = null
    this.requestQueue = Promise.resolve()
  }

  workerScriptPath() {
    const configured = String(this.sttConfig?.workerScript || '').trim()
    if (configured) {
      return configured
    }
    const transcribeScript = String(this.sttConfig?.transcribeScript || '').trim()
    if (!transcribeScript) {
      return ''
    }
    return path.join(path.dirname(transcribeScript), 'faster_whisper_worker.py')
  }

  recordStderr(text) {
    const normalized = String(text || '').trim()
    if (!normalized) {
      return
    }
    this.stderrLines.push(normalized)
    if (this.stderrLines.length > 24) {
      this.stderrLines = this.stderrLines.slice(-24)
    }
  }

  stderrSnapshot() {
    return this.stderrLines.join('\n').trim()
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  reset() {
    if (this.stdoutReader) {
      this.stdoutReader.close()
      this.stdoutReader = null
    }
    if (this.stderrReader) {
      this.stderrReader.close()
      this.stderrReader = null
    }
    this.child = null
    this.startPromise = null
  }

  restart() {
    const child = this.child
    this.reset()
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // ignore worker kill failures
      }
    }
  }

  shouldRestartAfterError(error) {
    const text = speechErrorText(error)
    return /timed out while handling|worker write failed|worker exited|worker failed to start/i.test(text)
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) {
      return this.child
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = (async () => {
      const pythonBin = expandHome(this.sttConfig?.pythonBin)
      const workerScript = expandHome(this.workerScriptPath())
      await access(workerScript)
      const childEnv = await buildSpeechChildEnv(process.env)
      const invocation = pythonSpawnInvocation(pythonBin, [workerScript])

      this.stderrLines = []
      const child = spawn(invocation.command, invocation.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
        env: childEnv
      })

      child.on('error', (error) => {
        const detail = this.stderrSnapshot()
        const wrapped = new Error(`Speech to Text worker failed to start: ${error?.message || error}`)
        wrapped.detail = detail
        this.rejectPending(wrapped)
        this.reset()
      })

      child.on('exit', (code, signal) => {
        const detail = this.stderrSnapshot()
        const wrapped = new Error(`Speech to Text worker exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`)
        wrapped.detail = detail
        this.rejectPending(wrapped)
        this.reset()
      })

      this.stdoutReader = readline.createInterface({ input: child.stdout })
      this.stdoutReader.on('line', (line) => {
        let payload
        try {
          payload = JSON.parse(String(line || '').trim())
        } catch {
          this.recordStderr(`Invalid worker JSON: ${String(line || '').trim()}`)
          return
        }

        const id = Number(payload?.id || 0)
        if (!id || !this.pending.has(id)) {
          return
        }

        const pending = this.pending.get(id)
        this.pending.delete(id)
        clearTimeout(pending.timer)
        pending.resolve(payload)
      })

      this.stderrReader = readline.createInterface({ input: child.stderr })
      this.stderrReader.on('line', (line) => {
        this.recordStderr(line)
      })

      this.child = child
      return child
    })()

    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  async performRequest(action, payload = {}, timeoutMs = 120000) {
    const child = await this.ensureStarted()
    const id = this.nextRequestId++

    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const error = new Error(`Speech to Text worker timed out while handling ${action}.`)
        error.detail = this.stderrSnapshot()
        reject(error)
      }, Math.max(1000, Number(timeoutMs) || 120000))

      this.pending.set(id, {
        resolve,
        reject,
        timer
      })

      const message = JSON.stringify({
        id,
        action,
        ...payload
      })

      child.stdin.write(`${message}\n`, (error) => {
        if (!error) {
          return
        }
        this.pending.delete(id)
        clearTimeout(timer)
        const wrapped = new Error(`Speech to Text worker write failed: ${error?.message || error}`)
        wrapped.detail = this.stderrSnapshot()
        reject(wrapped)
      })
    })
  }

  async request(action, payload = {}, timeoutMs = 120000) {
    const run = async () => {
      try {
        return await this.performRequest(action, payload, timeoutMs)
      } catch (error) {
        if (!this.shouldRestartAfterError(error)) {
          throw error
        }
        this.restart()
        return await this.performRequest(action, payload, timeoutMs)
      }
    }
    const queued = this.requestQueue.then(run, run)
    this.requestQueue = queued.catch(() => {})
    return await queued
  }
}

async function reserveLocalPort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? Number(address.port) : 0
      server.close((error) => {
        if (error) {
          reject(error)
          return
        }
        resolve(port)
      })
    })
  })
}

class LocalSttDaemonClient {
  constructor(sttConfig = {}) {
    this.sttConfig = sttConfig
    this.child = null
    this.stdoutReader = null
    this.stderrReader = null
    this.stderrLines = []
    this.startPromise = null
    this.baseUrl = ''
  }

  daemonScriptPath() {
    const configured = String(this.sttConfig?.daemonScript || '').trim()
    if (configured) {
      return configured
    }
    const transcribeScript = String(this.sttConfig?.transcribeScript || '').trim()
    if (!transcribeScript) {
      return ''
    }
    return path.join(path.dirname(transcribeScript), 'faster_whisper_daemon.py')
  }

  recordStderr(text) {
    const normalized = String(text || '').trim()
    if (!normalized) {
      return
    }
    this.stderrLines.push(normalized)
    if (this.stderrLines.length > 24) {
      this.stderrLines = this.stderrLines.slice(-24)
    }
  }

  stderrSnapshot() {
    return this.stderrLines.join('\n').trim()
  }

  reset() {
    if (this.stdoutReader) {
      this.stdoutReader.close()
      this.stdoutReader = null
    }
    if (this.stderrReader) {
      this.stderrReader.close()
      this.stderrReader = null
    }
    this.child = null
    this.startPromise = null
    this.baseUrl = ''
  }

  restart() {
    const child = this.child
    this.reset()
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        // ignore daemon kill failures
      }
    }
  }

  shouldRestartAfterError(error) {
    const text = speechErrorText(error)
    return /timed out|fetch failed|econnrefused|socket hang up|daemon exited|daemon failed to start|networkerror|terminated|aborted/i.test(text)
  }

  async waitUntilReachable(baseUrl, timeoutMs = 10000) {
    const startedAt = Date.now()
    while ((Date.now() - startedAt) < timeoutMs) {
      if (!this.child || this.child.killed) {
        const error = new Error('Speech to Text daemon exited before it became ready.')
        error.detail = this.stderrSnapshot()
        throw error
      }

      try {
        const timeout = withTimeout(1000)
        try {
          const response = await fetch(`${baseUrl}/health`, {
            method: 'GET',
            signal: timeout.signal
          })
          if (response) {
            return
          }
        } finally {
          timeout.clear()
        }
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 125))
      }
    }

    const error = new Error('Speech to Text daemon did not become reachable in time.')
    error.detail = this.stderrSnapshot()
    throw error
  }

  async ensureStarted() {
    if (this.child && !this.child.killed && this.baseUrl) {
      return this.baseUrl
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = (async () => {
      const pythonBin = expandHome(this.sttConfig?.pythonBin)
      const daemonScript = expandHome(this.daemonScriptPath())
      await access(daemonScript)

      const port = await reserveLocalPort()
      const baseUrl = `http://127.0.0.1:${port}`
      const ffmpegBin = expandHome(this.sttConfig?.ffmpegBin)
      const childEnv = await buildSpeechChildEnv({
        ...process.env,
        STT_FFMPEG_BIN: ffmpegBin || process.env.STT_FFMPEG_BIN || 'ffmpeg'
      })
      const invocation = pythonSpawnInvocation(pythonBin, [daemonScript, '--host', '127.0.0.1', '--port', String(port)])
      this.stderrLines = []
      const child = spawn(invocation.command, invocation.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
        env: childEnv
      })

      child.on('error', (error) => {
        this.recordStderr(`Speech to Text daemon failed to start: ${error?.message || error}`)
        this.reset()
      })

      child.on('exit', (code, signal) => {
        this.recordStderr(`Speech to Text daemon exited with code ${code ?? 'unknown'}${signal ? ` (signal ${signal})` : ''}.`)
        this.reset()
      })

      this.stdoutReader = readline.createInterface({ input: child.stdout })
      this.stdoutReader.on('line', (line) => {
        const normalized = String(line || '').trim()
        if (normalized) {
          this.recordStderr(`[stdout] ${normalized}`)
        }
      })

      this.stderrReader = readline.createInterface({ input: child.stderr })
      this.stderrReader.on('line', (line) => {
        this.recordStderr(line)
      })

      this.child = child
      this.baseUrl = baseUrl
      await this.waitUntilReachable(baseUrl)
      return baseUrl
    })()

    try {
      return await this.startPromise
    } catch (error) {
      this.restart()
      throw error
    } finally {
      this.startPromise = null
    }
  }

  async requestJson(pathname, options = {}, timeoutMs = 15000, retry = true) {
    try {
      const baseUrl = await this.ensureStarted()
      const result = await fetchJson(`${baseUrl}${pathname}`, options, timeoutMs)
      if (!result.ok) {
        const error = new Error(result.payload?.detail || result.payload?.error || `Speech to Text daemon request failed with ${result.status}`)
        error.detail = JSON.stringify(result.payload || {})
        throw error
      }
      return result.payload || {}
    } catch (error) {
      if (retry && this.shouldRestartAfterError(error)) {
        this.restart()
        return await this.requestJson(pathname, options, timeoutMs, false)
      }
      throw error
    }
  }

  async health(timeoutMs = 15000) {
    return await this.requestJson('/health', { method: 'GET' }, timeoutMs)
  }

  async warm(payload = {}, timeoutMs = 120000) {
    return await this.requestJson('/warm', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    }, timeoutMs)
  }

  async transcribe(audioBuffer, contentType, payload = {}, options = {}, retry = true) {
    try {
      const baseUrl = await this.ensureStarted()
      const result = await fetchJson(`${baseUrl}/transcribe`, {
        method: 'POST',
        headers: {
          'content-type': contentType || 'application/octet-stream',
          'x-stt-model': String(payload?.model || '').trim() || 'base.en',
          'x-stt-model-dir': String(payload?.modelDir || '').trim(),
          'x-stt-device': String(payload?.device || '').trim() || 'auto',
          'x-stt-compute-type': String(payload?.computeType || '').trim() || 'auto',
          'x-stt-initial-prompt': String(payload?.initialPrompt || '').trim()
        },
        signal: options?.signal || null,
        body: audioBuffer
      }, options?.timeoutMs || 120000)

      if (!result.ok) {
        const error = new Error(result.payload?.detail || result.payload?.error || `Speech to Text daemon transcribe failed with ${result.status}`)
        error.detail = JSON.stringify(result.payload || {})
        throw error
      }
      return result.payload || {}
    } catch (error) {
      if (isAbortError(error) && options?.signal?.aborted) {
        this.restart()
        throw error
      }
      if (retry && this.shouldRestartAfterError(error)) {
        this.restart()
        return await this.transcribe(audioBuffer, contentType, payload, options, false)
      }
      throw error
    }
  }

  async shutdown() {
    if (!this.child || !this.baseUrl) {
      this.restart()
      return
    }
    try {
      await fetchJson(`${this.baseUrl}/shutdown`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: '{}'
      }, 2000).catch(() => null)
    } finally {
      this.restart()
    }
  }
}

function normalizeSpeechRuntimeError(kind, provider, error) {
  const raw = speechErrorText(error)
  const text = compactErrorText(raw, 240)
  const target = kind === 'tts'
    ? provider === 'http'
      ? 'Voice service'
      : 'Voice playback'
    : 'Speech to Text'

  if (/access is denied/i.test(raw)) {
    return `${target} is unavailable: access was denied.`
  }

  if (/ffmpeg/i.test(raw) && /(command not found|not recognized|enoent|no such file)/i.test(raw)) {
    return `${target} is unavailable: ffmpeg is not installed.`
  }

  if (kind === 'stt' && /python/i.test(raw) && /(command not found|not recognized|enoent|no such file)/i.test(raw)) {
    return `${target} is unavailable: Python is not installed.`
  }

  if (kind === 'stt' && explicitMissingScriptError(error, 'faster_whisper_cli.py')) {
    return `${target} is unavailable: faster-whisper CLI was not found.`
  }

  if (kind === 'tts' && /piper/i.test(raw) && /(command not found|not recognized|enoent|no such file|not found)/i.test(raw)) {
    return `${target} is unavailable: Piper is not installed.`
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
    this._localSttWorker = null
    this._localSttDaemon = null
    this._localSttQueue = Promise.resolve()
  }

  async runLocalSttTask(task) {
    const queued = this._localSttQueue.then(task, task)
    this._localSttQueue = queued.catch(() => {})
    return await queued
  }

  localSttWorker() {
    if (!this._localSttWorker) {
      this._localSttWorker = new LocalSttWorkerClient(this.config?.stt?.local || {})
    }
    return this._localSttWorker
  }

  localSttDaemon() {
    if (!this._localSttDaemon) {
      this._localSttDaemon = new LocalSttDaemonClient(this.config?.stt?.local || {})
    }
    return this._localSttDaemon
  }

  async dispose() {
    if (this._localSttDaemon) {
      await this._localSttDaemon.shutdown().catch(() => null)
      this._localSttDaemon = null
    }
    if (this._localSttWorker) {
      this._localSttWorker.restart()
      this._localSttWorker = null
    }
  }

  /**
   * Send a tiny silent WAV through the STT pipeline to prime the active STT path and model.
   * Call as fire-and-forget during startup.
   */
  async warmStt() {
    if (!this.config.enabled) return { ok: false, reason: 'disabled' }
    if (this.config?.stt?.provider === 'local') {
      try {
        return await this.runLocalSttTask(async () => {
          const stt = this.config.stt.local
          const payload = await this.localSttDaemon().warm({
            model: String(stt.model || '').trim() || 'base.en',
            modelDir: String(stt.modelDir || '').trim(),
            device: String(stt.device || '').trim() || 'auto',
            computeType: String(stt.computeType || '').trim() || 'auto',
            initialPrompt: String(stt.initialPrompt || '').trim()
          }, 120000)
          if (!payload?.ok) {
            return {
              ok: false,
              reason: 'stt_unhealthy',
              error: String(payload?.error || 'Speech to Text warmup failed.')
            }
          }
          this._healthCache = {
            ok: true,
            provider: 'local',
            ...localSttDiagnosticFields(stt),
            model: String(payload.model || stt.model || '').trim(),
            modelDir: String(payload.modelDir || stt.modelDir || '').trim(),
            device: String(payload.device || stt.device || '').trim(),
            computeType: String(payload.computeType || stt.computeType || '').trim(),
            error: ''
          }
          this._healthCacheAt = Date.now()
          return { ok: true }
        })
      } catch {
        const health = await this.runLocalSttTask(() => this.checkLocalSttHealth()).catch(() => null)
        return {
          ok: false,
          reason: health?.error ? 'stt_unhealthy' : 'warmup_failed',
          error: String(health?.error || '').trim()
        }
      }
    }

    try {
      const silentWav = buildSilentWav(0.1)
      await this.transcribeAudioBuffer(silentWav, 'audio/wav')
      return { ok: true }
    } catch {
      const health = await this.checkSttHealth().catch(() => null)
      return {
        ok: false,
        reason: health?.error ? 'stt_unhealthy' : 'warmup_failed',
        error: String(health?.error || '').trim()
      }
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
          error: String(error?.message || error),
          detail: speechErrorText(error)
        }
      }
    }

    if (stt.provider === 'local') {
      return await this.runLocalSttTask(() => this.checkLocalSttHealth())
    }

    return {
      ok: false,
      provider: String(stt.provider || 'unknown').trim() || 'unknown',
      error: `Unsupported speech provider: ${String(stt.provider || 'unknown').trim() || 'unknown'}`
    }
  }

  async checkTtsHealth() {
    const tts = this.config.tts
    if (!tts || tts.enabled === false) {
      return {
        ok: true,
        enabled: false,
        provider: 'none'
      }
    }

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

    return {
      ok: false,
      provider: String(tts.provider || 'unknown').trim() || 'unknown',
      voice: tts.voice,
      error: `Unsupported voice provider: ${String(tts.provider || 'unknown').trim() || 'unknown'}`
    }
  }

  _sttRuntimeBaseUrl() {
    const stt = this.config.stt
    if (stt.provider === 'http') {
      return { baseUrl: stt.http.baseUrl, timeoutMs: stt.http.timeoutMs }
    }
    if (stt.provider === 'local') {
      const daemon = this.localSttDaemon()
      return { baseUrl: daemon.baseUrl, timeoutMs: stt.http?.timeoutMs || 120000, daemon }
    }
    return null
  }

  async getSttRuntime() {
    const stt = this.config.stt
    const endpoint = this._sttRuntimeBaseUrl()
    if (!endpoint) {
      return {
        ok: false,
        supported: false,
        provider: stt.provider
      }
    }

    let baseUrl = endpoint.baseUrl
    if (!baseUrl && endpoint.daemon) {
      try {
        baseUrl = await endpoint.daemon.ensureStarted()
      } catch {
        return {
          ok: false,
          supported: true,
          provider: stt.provider,
          error: 'Speech to Text daemon is not running.'
        }
      }
    }

    if (!baseUrl) {
      return {
        ok: false,
        supported: true,
        provider: stt.provider,
        error: 'Speech to Text endpoint is not available.'
      }
    }

    try {
      const result = await fetchJson(
        `${baseUrl}/runtime`,
        { method: 'GET' },
        endpoint.timeoutMs
      )
      return {
        ok: Boolean(result.ok),
        supported: true,
        provider: stt.provider,
        baseUrl,
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
        provider: stt.provider,
        baseUrl,
        error: String(error?.message || error)
      }
    }
  }

  async updateSttRuntime(input = {}) {
    const stt = this.config.stt
    const endpoint = this._sttRuntimeBaseUrl()
    if (!endpoint) {
      return {
        ok: false,
        supported: false,
        provider: stt.provider
      }
    }

    let baseUrl = endpoint.baseUrl
    if (!baseUrl && endpoint.daemon) {
      try {
        baseUrl = await endpoint.daemon.ensureStarted()
      } catch {
        return {
          ok: false,
          supported: true,
          provider: stt.provider,
          error: 'Speech to Text daemon is not running.'
        }
      }
    }

    if (!baseUrl) {
      return {
        ok: false,
        supported: true,
        provider: stt.provider,
        error: 'Speech to Text endpoint is not available.'
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
        `${baseUrl}/runtime`,
        {
          method: 'PUT',
          headers: {
            'content-type': 'application/json'
          },
          body: JSON.stringify(payload)
        },
        endpoint.timeoutMs
      )
      if (!result.ok) {
        throw new Error(result.payload?.detail || result.payload?.error || `STT runtime update failed with ${result.status}`)
      }
      return {
        ok: true,
        supported: true,
        provider: stt.provider,
        baseUrl,
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
        provider: stt.provider,
        baseUrl,
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
    if (stt.provider !== 'local') {
      throw new Error(`Unsupported speech provider: ${String(stt.provider || 'unknown').trim() || 'unknown'}`)
    }
    return await this.runLocalSttTask(() => this.transcribeViaLocal(audioBuffer, contentType, started, options))
  }

  async checkLocalSttHealth() {
    const stt = this.config.stt
    const diagnostic = localSttDiagnosticFields(stt.local)
    try {
      await access(expandHome(stt.local.daemonScript || path.join(path.dirname(stt.local.transcribeScript || ''), 'faster_whisper_daemon.py')))
      const payload = await this.localSttDaemon().health(15000)
      return {
        ok: Boolean(payload.ok),
        provider: 'local',
        ...diagnostic,
        model: String(payload.model || stt.local.model || '').trim(),
        modelDir: String(payload.modelDir || stt.local.modelDir || '').trim(),
        device: String(payload.device || stt.local.device || '').trim(),
        computeType: String(payload.computeType || stt.local.computeType || '').trim(),
        error: String(payload.error || '').trim()
      }
    } catch (error) {
      const detail = speechErrorText(error)
      return {
        ok: false,
        provider: 'local',
        ...diagnostic,
        error: normalizeSpeechRuntimeError('stt', 'local', error),
        detail
      }
    }
  }

  async transcribeViaLocal(audioBuffer, contentType, started, options = {}) {
    const stt = this.config.stt.local
    const configuredTimeoutMs = Number(options?.timeoutMs ?? this.config?.stt?.timeoutMs)
    const timeoutMs = Number.isFinite(configuredTimeoutMs) && configuredTimeoutMs > 0
      ? configuredTimeoutMs
      : 120000
    try {
      const transcribeStarted = performance.now()
      const payload = await this.localSttDaemon().transcribe(audioBuffer, contentType, {
        model: String(stt.model || '').trim() || 'base.en',
        modelDir: String(stt.modelDir || '').trim(),
        device: String(stt.device || '').trim() || 'auto',
        computeType: String(stt.computeType || '').trim() || 'auto',
        initialPrompt: String(stt.initialPrompt || '').trim()
      }, {
        signal: options?.signal || null,
        timeoutMs
      })

      if (!payload?.ok) {
        throw new Error(String(payload?.error || 'Speech to Text transcription failed.'))
      }

      return {
        transcript: String(payload.transcript || '').trim(),
        language: String(payload.language || 'en'),
        usedVadFallback: Boolean(payload?.usedVadFallback),
        timingsMs: {
          normalize: 0,
          transcribe: nowMs(transcribeStarted),
          total: nowMs(started)
        }
      }
    } catch (error) {
      if (isAbortError(error)) {
        throw error
      }
      const wrapped = new Error(normalizeSpeechRuntimeError('stt', 'local', error))
      wrapped.detail = speechErrorText(error)
      wrapped.pythonBin = String(stt.pythonBin || '').trim()
      wrapped.daemonScript = String(stt.daemonScript || '').trim()
      wrapped.transcribeScript = String(stt.transcribeScript || '').trim()
      wrapped.model = String(stt.model || '').trim()
      wrapped.modelDir = String(stt.modelDir || '').trim()
      wrapped.device = String(stt.device || '').trim()
      wrapped.computeType = String(stt.computeType || '').trim()
      throw wrapped
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
        usedVadFallback: Boolean(payload?.usedVadFallback),
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
      const wrapped = new Error(normalizeSpeechRuntimeError('stt', 'http', error))
      wrapped.detail = speechErrorText(error)
      wrapped.baseUrl = String(stt.baseUrl || '').trim()
      throw wrapped
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
        throw new Error(`Unsupported voice provider: ${String(this.config.tts.provider || 'unknown').trim() || 'unknown'}`)
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
