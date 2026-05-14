import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import {
  CAPTURE_COMMAND_CANCEL_RECORDING,
  CAPTURE_COMMAND_CONFIGURE,
  CAPTURE_COMMAND_SHUTDOWN,
  CAPTURE_COMMAND_START_RECORDING,
  CAPTURE_COMMAND_STOP_RECORDING,
  CAPTURE_COMMAND_TOGGLE_RECORDING,
  CAPTURE_EVENT_ERROR,
  CAPTURE_EVENT_INPUT_DEVICES,
  CAPTURE_EVENT_INPUT_LEVEL,
  CAPTURE_EVENT_READY,
  CAPTURE_EVENT_RECORDING_STATE,
  CAPTURE_MESSAGE_KIND_RESPONSE,
  CAPTURE_REQUEST_SUBMIT_AUDIO,
  createCaptureEvent,
  createCaptureRequest,
  createCaptureResponse,
  normalizeCaptureCommandType
} from './capture-protocol.mjs'

const FFMPEG_BIN = String(process.env.DICTATION_TRAY_CAPTURE_FFMPEG_BIN || process.env.STT_FFMPEG_BIN || 'ffmpeg').trim() || 'ffmpeg'
const CAPTURE_SAMPLE_RATE = 16000
const CAPTURE_CHANNELS = 1
const MIN_RECORDING_MS = 650
const STOP_TAIL_GRACE_MS = 180
const STOP_SIGNAL_GRACE_MS = 1800
const CAPTURE_STARTUP_GRACE_MS = 450

let preferredInputDeviceId = ''
let availableDevices = []
let recordingState = null
let shuttingDown = false
const pendingRequests = new Map()

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function nowMs() {
  return Date.now()
}

function createAbortError(message) {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function readJsonPayload(text, fallback = null) {
  try {
    return JSON.parse(String(text || '').trim())
  } catch {
    return fallback
  }
}

function normalizeDeviceId(value) {
  return String(value || '').trim()
}

function compact(value, fallback = '') {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim()
}

function reportEvent(type, payload = {}) {
  writeMessage(createCaptureEvent(type, payload))
}

function reportError(message) {
  reportEvent(CAPTURE_EVENT_ERROR, {
    message: compact(message, 'Native capture helper failed.')
  })
}

function reportRecordingState(phase, extra = {}) {
  reportEvent(CAPTURE_EVENT_RECORDING_STATE, {
    phase,
    ...extra
  })
}

function reportInputLevel(level) {
  reportEvent(CAPTURE_EVENT_INPUT_LEVEL, {
    level: Math.max(0, Math.min(1, Number(level) || 0))
  })
}

function currentSelectedDevice() {
  return availableDevices.find((device) => device.deviceId === preferredInputDeviceId)
    || availableDevices[0]
    || null
}

function reportInputDevices(error = '') {
  const activeDevice = currentSelectedDevice()
  const errorText = compact(error)
  const permission = /permission|not authorized|denied|privacy|tcc/i.test(errorText)
    ? 'denied'
    : availableDevices.length
      ? 'granted'
      : 'unknown'

  reportEvent(CAPTURE_EVENT_INPUT_DEVICES, {
    devices: availableDevices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label
    })),
    preferredDeviceId: preferredInputDeviceId,
    activeDeviceId: activeDevice?.deviceId || '',
    activeLabel: activeDevice?.label || '',
    permission,
    error: errorText
  })
}

function runProcess(command, args = [], { timeoutMs = 5000, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(new Error(`${command} timed out.`))
    }, Math.max(250, Number(timeoutMs) || 5000))

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('exit', (code) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (code === 0 || allowFailure) {
        resolve({ code, stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code ?? 1}`))
    })
  })
}

function parseAvfoundationAudioDevices(output = '') {
  const devices = []
  const seen = new Set()
  let inAudioSection = false

  for (const line of String(output || '').split(/\r?\n/)) {
    if (/AVFoundation video devices:/i.test(line)) {
      inAudioSection = false
      continue
    }
    if (/AVFoundation audio devices:/i.test(line)) {
      inAudioSection = true
      continue
    }
    if (!inAudioSection) {
      continue
    }

    const match = line.match(/\[(\d+)]\s+(.+)$/)
    if (!match) {
      continue
    }

    const deviceId = normalizeDeviceId(match[1])
    const label = compact(match[2], `Microphone ${devices.length + 1}`)
    if (!deviceId || seen.has(deviceId)) {
      continue
    }
    seen.add(deviceId)
    devices.push({
      deviceId,
      groupId: deviceId,
      label
    })
  }

  return devices
}

async function refreshAudioDevices() {
  const result = await runProcess(FFMPEG_BIN, [
    '-hide_banner',
    '-f',
    'avfoundation',
    '-list_devices',
    'true',
    '-i',
    ''
  ], {
    allowFailure: true,
    timeoutMs: 8000
  })

  availableDevices = parseAvfoundationAudioDevices(`${result.stdout}\n${result.stderr}`)
}

async function syncInputDevices(error = '') {
  try {
    await refreshAudioDevices()
    reportInputDevices(error)
  } catch (refreshError) {
    availableDevices = []
    reportInputDevices(compact(refreshError?.message || refreshError || error || 'Unable to enumerate macOS audio inputs.'))
  }
}

function rememberLine(state, line) {
  if (!state) {
    return
  }
  const text = compact(line)
  if (!text) {
    return
  }
  state.recentLines.push(text)
  if (state.recentLines.length > 32) {
    state.recentLines.shift()
  }
}

function recentRecordingError(state) {
  const lines = Array.isArray(state?.recentLines) ? state.recentLines.filter(Boolean) : []
  return lines.slice(-8).join(' ').trim()
}

function buildCaptureDeviceMetadata(device) {
  return {
    label: compact(device?.label, 'Mac Microphone'),
    deviceId: normalizeDeviceId(device?.deviceId),
    groupId: compact(device?.groupId),
    sampleRate: CAPTURE_SAMPLE_RATE,
    channelCount: CAPTURE_CHANNELS,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
}

async function removeRecordingFiles(state) {
  if (!state?.tempDir) {
    return
  }
  await rm(state.tempDir, { recursive: true, force: true }).catch(() => {})
}

function clearPendingStopTimer(state = recordingState) {
  if (state?.pendingStopTimer) {
    clearTimeout(state.pendingStopTimer)
    state.pendingStopTimer = null
  }
}

function spawnFfmpegRecorder(device, outputPath) {
  return spawn(FFMPEG_BIN, [
    '-hide_banner',
    '-y',
    '-f',
    'avfoundation',
    '-i',
    `:${device.deviceId}`,
    '-vn',
    '-ac',
    String(CAPTURE_CHANNELS),
    '-ar',
    String(CAPTURE_SAMPLE_RATE),
    '-acodec',
    'pcm_s16le',
    outputPath
  ], {
    stdio: ['pipe', 'ignore', 'pipe'],
    windowsHide: true
  })
}

async function waitForRecorderStartup(state) {
  await new Promise((resolve) => setTimeout(resolve, CAPTURE_STARTUP_GRACE_MS))
  if (state.exited) {
    throw new Error(recentRecordingError(state) || 'macOS audio capture stopped immediately.')
  }
}

async function selectedDeviceForRecording() {
  if (!availableDevices.length || (preferredInputDeviceId && !availableDevices.some((device) => device.deviceId === preferredInputDeviceId))) {
    await refreshAudioDevices()
  }
  return currentSelectedDevice()
}

async function verifyRecorderStartup(state) {
  try {
    await waitForRecorderStartup(state)
  } catch (error) {
    if (recordingState !== state || state.stopping || state.cancelled || shuttingDown) {
      return
    }
    recordingState = null
    state.cancelled = true
    await stopRecorderProcess(state).catch(() => {})
    await removeRecordingFiles(state)
    reportInputLevel(0)
    reportRecordingState('idle')
    reportError(compact(error?.message || error || 'macOS audio capture stopped immediately.'))
    void syncInputDevices().catch(() => {})
  }
}

async function startRecording() {
  if (recordingState) {
    return
  }

  const selectedDevice = await selectedDeviceForRecording()
  if (!selectedDevice?.deviceId) {
    throw new Error('No macOS audio input is available for native capture.')
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dictray-macos-capture-'))
  const outputPath = path.join(tempDir, 'recording.wav')
  const captureDevice = buildCaptureDeviceMetadata(selectedDevice)
  const processHandle = spawnFfmpegRecorder(selectedDevice, outputPath)
  const state = {
    process: processHandle,
    stderr: readline.createInterface({ input: processHandle.stderr }),
    tempDir,
    outputPath,
    captureDevice,
    recentLines: [],
    startedAt: nowMs(),
    pendingStopTimer: null,
    stopping: false,
    finalizePromise: null,
    cancelled: false,
    exited: false,
    exitCode: null,
    exitSignal: '',
    exitPromise: null,
    resolveExit: null
  }

  state.exitPromise = new Promise((resolve) => {
    state.resolveExit = resolve
  })

  state.stderr.on('line', (line) => {
    rememberLine(state, line)
  })
  processHandle.on('error', (error) => {
    rememberLine(state, String(error?.message || error))
  })
  processHandle.on('exit', (code, signal) => {
    state.exited = true
    state.exitCode = code
    state.exitSignal = signal || ''
    try {
      state.stderr.close()
    } catch {
      // ignore
    }
    state.resolveExit?.()

    if (recordingState !== state || state.stopping || state.cancelled || shuttingDown) {
      return
    }

    recordingState = null
    reportInputLevel(0)
    reportRecordingState('idle')
    reportError(recentRecordingError(state) || 'macOS audio capture stopped unexpectedly.')
    void removeRecordingFiles(state).catch(() => {})
    void syncInputDevices().catch(() => {})
  })

  recordingState = state
  reportRecordingState('listening')
  reportInputLevel(0)
  reportInputDevices()
  void verifyRecorderStartup(state)
}

async function stopRecorderProcess(state) {
  if (!state?.process || state.exited) {
    return
  }

  const fallbackTimer = setTimeout(() => {
    if (state.process && !state.process.killed && !state.exited) {
      try {
        state.process.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }, STOP_SIGNAL_GRACE_MS)

  try {
    if (state.process.stdin && !state.process.stdin.destroyed) {
      state.process.stdin.write('q\n')
      state.process.stdin.end()
    } else {
      state.process.kill('SIGINT')
    }
    await state.exitPromise.catch(() => {})
  } finally {
    clearTimeout(fallbackTimer)
  }
}

async function sendAudioSubmission(audioBuffer, captureDevice, recordingMs) {
  if (!audioBuffer.length) {
    throw new Error('Native capture recorded an empty audio file.')
  }

  const response = await sendCoreRequest(CAPTURE_REQUEST_SUBMIT_AUDIO, {
    mimeType: 'audio/wav',
    audioBase64: audioBuffer.toString('base64'),
    recordingMs,
    captureDevice
  })

  return response?.payload || {
    ok: false,
    error: response?.error || 'Audio submission failed.'
  }
}

async function finalizeRecording(state) {
  try {
    if (state?.cancelled) {
      return
    }
    await stopRecorderProcess(state)
    if (state?.cancelled) {
      return
    }

    const fileStats = await stat(state.outputPath).catch(() => null)
    if (!fileStats?.size) {
      throw new Error(recentRecordingError(state) || 'macOS native capture recorded an empty audio file.')
    }

    const audioBuffer = await readFile(state.outputPath)
    const recordingMs = Math.max(0, nowMs() - state.startedAt)
    const result = await sendAudioSubmission(audioBuffer, state.captureDevice, recordingMs)
    if (!result?.ok && !result?.cancelled) {
      reportError(result?.error || 'Dictation failed.')
    }
    reportRecordingState('idle')
  } finally {
    reportInputLevel(0)
    if (recordingState === state) {
      recordingState = null
    }
    await removeRecordingFiles(state)
    reportInputDevices()
  }
}

async function beginRecordingStop() {
  const state = recordingState
  if (!state) {
    return null
  }
  if (state.finalizePromise) {
    return state
  }

  clearPendingStopTimer(state)
  state.stopping = true
  reportRecordingState('processing', {
    recordingMs: Math.max(0, nowMs() - state.startedAt)
  })
  reportInputLevel(0)
  state.finalizePromise = finalizeRecording(state).catch((error) => {
    reportRecordingState('idle')
    reportError(compact(error?.message || error || 'Native capture failed.'))
  })
  return state
}

async function stopRecording() {
  const state = recordingState
  if (!state || state.stopping) {
    return
  }

  const elapsedMs = nowMs() - state.startedAt
  const minimumRemainingMs = Math.max(0, MIN_RECORDING_MS - elapsedMs)
  const delayMs = Math.max(minimumRemainingMs, STOP_TAIL_GRACE_MS)
  if (delayMs > 0) {
    clearPendingStopTimer(state)
    state.pendingStopTimer = setTimeout(() => {
      void beginRecordingStop()
    }, delayMs)
    return
  }

  await beginRecordingStop()
}

async function cancelRecording() {
  const state = recordingState
  if (!state) {
    return false
  }

  clearPendingStopTimer(state)
  state.cancelled = true
  if (recordingState === state) {
    recordingState = null
  }
  await stopRecorderProcess(state).catch(() => {})
  await removeRecordingFiles(state)
  reportRecordingState('idle')
  reportInputLevel(0)
  reportInputDevices()
  return true
}

async function toggleRecording() {
  if (recordingState && !recordingState.stopping) {
    await stopRecording()
    return
  }
  await startRecording()
}

async function discardRecordingForShutdown() {
  if (!recordingState) {
    return
  }
  clearPendingStopTimer(recordingState)
  recordingState.cancelled = true
  const state = recordingState
  recordingState = null
  await stopRecorderProcess(state).catch(() => {})
  await removeRecordingFiles(state)
  reportInputLevel(0)
}

function sendCoreRequest(type, payload = {}) {
  const message = createCaptureRequest(type, payload)
  writeMessage(message)
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(message.id)
      reject(createAbortError('Timed out waiting for tray core response.'))
    }, 180000)

    pendingRequests.set(message.id, {
      resolve,
      reject,
      timeout
    })
  })
}

function handleCoreResponse(message = {}) {
  const requestId = String(message?.id || '').trim()
  const pending = pendingRequests.get(requestId)
  if (!pending) {
    return false
  }
  pendingRequests.delete(requestId)
  clearTimeout(pending.timeout)

  if (message?.ok) {
    pending.resolve(message)
  } else {
    pending.reject(new Error(String(message?.error || 'Core request failed.')))
  }
  return true
}

async function applyConfiguration(payload = {}) {
  preferredInputDeviceId = normalizeDeviceId(
    payload?.preferredInputDeviceId
      ?? payload?.selectedDeviceId
  )

  await syncInputDevices().catch((error) => {
    reportInputDevices(String(error?.message || error))
  })
}

function applyPreferredInputDevice(payload = {}) {
  if (payload?.preferredInputDeviceId === undefined && payload?.selectedDeviceId === undefined) {
    return
  }

  preferredInputDeviceId = normalizeDeviceId(
    payload?.preferredInputDeviceId
      ?? payload?.selectedDeviceId
  )
}

async function handleCommand(message = {}) {
  switch (normalizeCaptureCommandType(message?.type)) {
    case CAPTURE_COMMAND_CONFIGURE:
      await applyConfiguration(message?.payload || {})
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          backend: 'native',
          platform: 'darwin',
          preferredInputDeviceId
        }
      })
    case CAPTURE_COMMAND_START_RECORDING:
      try {
        applyPreferredInputDevice(message?.payload || {})
        await startRecording()
      } catch (error) {
        const errorMessage = compact(error?.message || error || 'Failed to start native capture.')
        reportRecordingState('idle')
        reportError(errorMessage)
        return createCaptureResponse(message?.id, {
          ok: false,
          error: errorMessage
        })
      }
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          started: true
        }
      })
    case CAPTURE_COMMAND_CANCEL_RECORDING:
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          cancelled: await cancelRecording().catch((error) => {
            reportError(compact(error?.message || error || 'Failed to cancel native capture.'))
            return false
          })
        }
      })
    case CAPTURE_COMMAND_STOP_RECORDING:
      await stopRecording().catch((error) => {
        reportError(compact(error?.message || error || 'Failed to stop native capture.'))
      })
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          stopping: Boolean(recordingState)
        }
      })
    case CAPTURE_COMMAND_TOGGLE_RECORDING:
      await toggleRecording().catch((error) => {
        reportError(compact(error?.message || error || 'Failed to toggle native capture.'))
      })
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          active: Boolean(recordingState && !recordingState.stopping)
        }
      })
    case CAPTURE_COMMAND_SHUTDOWN: {
      shuttingDown = true
      const discardedActiveRecording = Boolean(recordingState)
      await discardRecordingForShutdown().catch(() => {})
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          closed: true,
          discardedActiveRecording
        }
      })
    }
    default:
      return createCaptureResponse(message?.id, {
        ok: false,
        error: 'Unsupported native capture command.'
      })
  }
}

async function initializeHelper() {
  await syncInputDevices().catch((error) => {
    reportInputDevices(compact(error?.message || error || 'Unable to enumerate audio inputs.'))
  })
}

const stdin = readline.createInterface({ input: process.stdin })
let commandQueue = Promise.resolve()

async function handleStdinLine(line) {
  const message = readJsonPayload(line, null)
  if (!message || typeof message !== 'object') {
    reportError('Ignoring invalid native capture helper message.')
    return
  }

  if (String(message?.kind || '').trim().toLowerCase() === CAPTURE_MESSAGE_KIND_RESPONSE && handleCoreResponse(message)) {
    return
  }

  const response = await handleCommand(message).catch((error) => createCaptureResponse(message?.id, {
    ok: false,
    error: compact(error?.message || error || 'Native capture helper failed.')
  }))
  writeMessage(response)

  if (normalizeCaptureCommandType(message?.type) === CAPTURE_COMMAND_SHUTDOWN) {
    process.exit(0)
  }
}

stdin.on('line', (line) => {
  commandQueue = commandQueue
    .then(() => handleStdinLine(line))
    .catch((error) => {
      reportError(compact(error?.message || error || 'Native capture helper command failed.'))
    })
})

writeMessage(createCaptureEvent(CAPTURE_EVENT_READY, {
  backend: 'native',
  platform: 'darwin',
  helper: 'ffmpeg-avfoundation'
}))
void initializeHelper()
