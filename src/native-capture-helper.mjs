import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
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

const GST_BIN = String(process.env.DICTATION_TRAY_CAPTURE_GST_BIN || 'gst-launch-1.0').trim() || 'gst-launch-1.0'
const PACTL_BIN = String(process.env.DICTATION_TRAY_CAPTURE_PACTL_BIN || 'pactl').trim() || 'pactl'
const CAPTURE_SAMPLE_RATE = 16000
const CAPTURE_CHANNELS = 1
const PCM_BYTES_PER_SAMPLE = 2
const PCM_BYTES_PER_SECOND = CAPTURE_SAMPLE_RATE * CAPTURE_CHANNELS * PCM_BYTES_PER_SAMPLE
const MIN_RECORDING_MS = 650
const LEVEL_INTERVAL_NS = 100_000_000
const STOP_TAIL_GRACE_MS = 180
const STOP_SIGNAL_GRACE_MS = 1200
const CAPTURE_START_PRE_ROLL_MS = 700
const CAPTURE_SEGMENT_MAX_DURATION_NS = 1_000_000_000
const CAPTURE_MAX_SEGMENTS = 7200
const CAPTURE_SERVICE_READY_TIMEOUT_MS = 5000
const CAPTURE_CLIENT_NAME = 'DicTray Capture'
const PROBE_CLIENT_NAME = 'DicTray Echo Probe'
const PIPELINE_PROBE_NAME = 'dictray_probe'
const CHUNK_FILE_RE = /^chunk-(\d+)\.raw$/i

let preferredInputDeviceId = ''
let defaultSourceId = ''
let defaultSinkId = ''
let availableDevices = []
let monitorDeviceIds = new Set()
let captureService = null
let captureServiceStartPromise = null
let recordingState = null
let pendingServiceRestart = false
let shuttingDown = false
const pendingRequests = new Map()

function writeMessage(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n')
}

function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

function normalizeDeviceId(value) {
  return String(value || '').trim()
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

function normalizeDescription(value, fallback = '') {
  const text = String(value || '').trim()
  if (!text || text === '(null)') {
    return String(fallback || '').trim()
  }
  return text
}

function parseSampleSpecification(value) {
  const text = String(value || '').trim()
  const match = text.match(/(\d+)ch\s+(\d+)Hz/i)
  return {
    channelCount: match ? Number(match[1]) || 0 : 0,
    sampleRate: match ? Number(match[2]) || 0 : 0
  }
}

function dbToUnitInterval(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 0
  }
  const amplitude = 10 ** (numeric / 20)
  return clampUnitInterval(amplitude * 8)
}

function parseLevelLine(line) {
  const text = String(line || '').trim()
  if (!text.includes('(element): level')) {
    return null
  }
  const match = text.match(/rms=\(GValueArray\)<\s*([^\s,>]+)/i)
  if (!match) {
    return null
  }
  return dbToUnitInterval(match[1])
}

function isPipelinePlayingLine(line) {
  const text = String(line || '').trim()
  if (!text.includes('(state-changed)')) {
    return false
  }
  return /from element "pipeline[^"]*" \(state-changed\): .*new-state=\(GstState\)playing/i.test(text)
}

function reportEvent(type, payload = {}) {
  writeMessage(createCaptureEvent(type, payload))
}

function reportError(message) {
  reportEvent(CAPTURE_EVENT_ERROR, {
    message: String(message || 'Native capture helper failed.').trim() || 'Native capture helper failed.'
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
    level: clampUnitInterval(level)
  })
}

function msToBytes(durationMs) {
  const rawBytes = Math.max(0, Math.round((Math.max(0, Number(durationMs) || 0) / 1000) * PCM_BYTES_PER_SECOND))
  return rawBytes - (rawBytes % PCM_BYTES_PER_SAMPLE)
}

function bytesToMs(byteCount) {
  return Math.max(0, Math.round((Math.max(0, Number(byteCount) || 0) / PCM_BYTES_PER_SECOND) * 1000))
}

function buildWaveFromPcm(pcmBuffer) {
  const dataSize = pcmBuffer.length
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(CAPTURE_CHANNELS, 22)
  buffer.writeUInt32LE(CAPTURE_SAMPLE_RATE, 24)
  buffer.writeUInt32LE(PCM_BYTES_PER_SECOND, 28)
  buffer.writeUInt16LE(CAPTURE_CHANNELS * PCM_BYTES_PER_SAMPLE, 32)
  buffer.writeUInt16LE(PCM_BYTES_PER_SAMPLE * 8, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  pcmBuffer.copy(buffer, 44)
  return buffer
}

function currentSelectedDevice() {
  return availableDevices.find((device) => device.deviceId === preferredInputDeviceId)
    || availableDevices.find((device) => device.deviceId === defaultSourceId)
    || availableDevices[0]
    || null
}

function activeCaptureDevice() {
  return recordingState?.captureDevice || captureService?.captureDevice || currentSelectedDevice() || null
}

function reportInputDevices(error = '') {
  const activeDevice = activeCaptureDevice()
  reportEvent(CAPTURE_EVENT_INPUT_DEVICES, {
    devices: availableDevices.map((device) => ({
      deviceId: device.deviceId,
      groupId: device.groupId,
      label: device.label
    })),
    preferredDeviceId: preferredInputDeviceId,
    activeDeviceId: activeDevice?.deviceId || '',
    activeLabel: activeDevice?.label || '',
    permission: 'granted',
    error: String(error || '').trim()
  })
}

function resolveMonitorDeviceId() {
  const candidate = normalizeDeviceId(defaultSinkId) ? normalizeDeviceId(defaultSinkId) + '.monitor' : ''
  return candidate && monitorDeviceIds.has(candidate) ? candidate : ''
}

function buildCaptureDeviceMetadata(device, { monitorDeviceId = '' } = {}) {
  const spec = parseSampleSpecification(device?.sampleSpecification)
  return {
    label: String(device?.label || '').trim(),
    deviceId: normalizeDeviceId(device?.deviceId),
    groupId: String(device?.groupId || '').trim(),
    sampleRate: spec.sampleRate,
    channelCount: spec.channelCount,
    echoCancellation: Boolean(monitorDeviceId),
    noiseSuppression: true,
    autoGainControl: true
  }
}

function recentServiceError(state) {
  const lines = Array.isArray(state?.recentLines) ? state.recentLines.filter(Boolean) : []
  return lines.slice(-6).join(' ').trim()
}

function rememberServiceLine(state, line) {
  if (!state) {
    return
  }
  state.recentLines.push(String(line || '').trim())
  if (state.recentLines.length > 32) {
    state.recentLines.shift()
  }
}

function buildPipelineArgs(device, segmentPattern, { monitorDeviceId = '' } = {}) {
  const args = ['-m']

  if (monitorDeviceId) {
    args.push(
      'pulsesrc',
      'device=' + monitorDeviceId,
      'client-name=' + PROBE_CLIENT_NAME,
      'do-timestamp=true',
      '!', 'queue',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', 'audio/x-raw,format=S16LE,rate=' + CAPTURE_SAMPLE_RATE + ',channels=' + CAPTURE_CHANNELS,
      '!', 'webrtcechoprobe',
      'name=' + PIPELINE_PROBE_NAME,
      '!', 'fakesink',
      'sync=false',
      'async=false'
    )
  }

  args.push(
    'pulsesrc',
    'device=' + device.deviceId,
    'client-name=' + CAPTURE_CLIENT_NAME,
    'do-timestamp=true',
    '!', 'queue',
    '!', 'audioconvert',
    '!', 'audioresample',
    '!', 'audio/x-raw,format=S16LE,rate=' + CAPTURE_SAMPLE_RATE + ',channels=' + CAPTURE_CHANNELS,
    '!', 'webrtcdsp'
  )

  if (monitorDeviceId) {
    args.push('probe=' + PIPELINE_PROBE_NAME)
  }

  args.push(
    'echo-cancel=true',
    'noise-suppression=true',
    'gain-control=true',
    'high-pass-filter=true',
    '!', 'tee',
    'name=dictray_capture',
    'dictray_capture.',
    '!', 'queue',
    '!', 'level',
    'post-messages=true',
    'interval=' + LEVEL_INTERVAL_NS,
    '!', 'fakesink',
    'sync=false',
    'async=false',
    'dictray_capture.',
    '!', 'queue',
    '!', 'multifilesink',
    'location=' + segmentPattern,
    'next-file=max-duration',
    'max-file-duration=' + CAPTURE_SEGMENT_MAX_DURATION_NS,
    'max-files=' + CAPTURE_MAX_SEGMENTS,
    'post-messages=true',
    'sync=false'
  )

  return args
}

async function runJsonCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
    })

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(readJsonPayload(stdout, null))
        return
      }
      reject(new Error(stderr.trim() || command + ' exited with code ' + String(code ?? 1)))
    })
  })
}

async function refreshAudioDevices() {
  const [info, sources] = await Promise.all([
    runJsonCommand(PACTL_BIN, ['-f', 'json', 'info']),
    runJsonCommand(PACTL_BIN, ['-f', 'json', 'list', 'sources'])
  ])

  defaultSourceId = normalizeDeviceId(info?.default_source_name)
  defaultSinkId = normalizeDeviceId(info?.default_sink_name)

  const allSources = Array.isArray(sources) ? sources : []
  monitorDeviceIds = new Set(
    allSources
      .map((source) => normalizeDeviceId(source?.name))
      .filter((name) => name.endsWith('.monitor'))
  )

  availableDevices = allSources
    .filter((source) => !monitorDeviceIds.has(normalizeDeviceId(source?.name)))
    .map((source) => {
      const deviceId = normalizeDeviceId(source?.name)
      const properties = source?.properties || {}
      return {
        deviceId,
        groupId: String(properties['device.bus-id'] || properties['object.path'] || source?.index || '').trim(),
        label: normalizeDescription(source?.description, deviceId || 'Microphone'),
        state: String(source?.state || '').trim(),
        sampleSpecification: String(source?.sample_specification || '').trim()
      }
    })
}

async function syncInputDevices(error = '') {
  try {
    await refreshAudioDevices()
    reportInputDevices(error)
  } catch (refreshError) {
    reportInputDevices(String(refreshError?.message || refreshError || error || 'Unable to enumerate audio inputs.'))
  }
}

function clearPendingStopTimer(state = recordingState) {
  if (state?.pendingStopTimer) {
    clearTimeout(state.pendingStopTimer)
    state.pendingStopTimer = null
  }
}

function cleanupCaptureService(state) {
  if (state?.stdout) {
    try {
      state.stdout.close()
    } catch {
      // ignore
    }
  }
  if (state?.stderr) {
    try {
      state.stderr.close()
    } catch {
      // ignore
    }
  }
}

async function removeCaptureServiceFiles(state) {
  if (!state?.tempDir) {
    return
  }
  await rm(state.tempDir, { recursive: true, force: true }).catch(() => {})
}

function serviceReadyWithTimeout(service, timeoutMs = CAPTURE_SERVICE_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Native capture service did not become ready in time.'))
    }, timeoutMs)

    service.readyPromise
      .then(() => {
        clearTimeout(timer)
        resolve(service)
      })
      .catch((error) => {
        clearTimeout(timer)
        reject(error)
      })
  })
}

function markCaptureServiceReady(state) {
  if (!state || state.ready) {
    return false
  }
  state.ready = true
  state.readyAt = nowMs()
  state.resolveReady(state)
  return true
}

function captureServiceNeedsRestart(state) {
  if (!state) {
    return false
  }
  const selectedDevice = currentSelectedDevice()
  const nextDeviceId = normalizeDeviceId(selectedDevice?.deviceId)
  const nextMonitorDeviceId = resolveMonitorDeviceId()
  return nextDeviceId !== normalizeDeviceId(state.captureDevice?.deviceId)
    || nextMonitorDeviceId !== String(state.monitorDeviceId || '').trim()
}

async function handleCaptureServiceLine(state, line) {
  const text = String(line || '').trim()
  if (!text) {
    return
  }

  rememberServiceLine(state, text)
  const inputLevel = parseLevelLine(text)
  if (inputLevel !== null) {
    state.lastInputLevel = inputLevel
    markCaptureServiceReady(state)
    reportInputLevel(inputLevel)
    return
  }

  if (isPipelinePlayingLine(text)) {
    markCaptureServiceReady(state)
  }
}

function handleCaptureServiceExit(state, code, signal) {
  state.exitCode = code
  state.exitSignal = signal
  state.resolveExit()

  if (captureService !== state) {
    return
  }

  captureService = null
  cleanupCaptureService(state)
  if (state.stopping || shuttingDown) {
    void removeCaptureServiceFiles(state).catch(() => {})
    return
  }

  state.rejectReady(new Error(recentServiceError(state) || 'Native capture service stopped unexpectedly.'))
  reportInputLevel(0)

  if (recordingState) {
    clearPendingStopTimer(recordingState)
    recordingState = null
    reportRecordingState('idle')
  }

  void removeCaptureServiceFiles(state).catch(() => {})
  reportError(recentServiceError(state) || 'Native capture service stopped unexpectedly.')
  void syncInputDevices().catch(() => {})
}

async function stopCaptureService(state = captureService) {
  if (!state) {
    return
  }
  if (state.stopping) {
    await state.exitPromise.catch(() => {})
    return
  }

  state.stopping = true
  if (captureService === state) {
    captureService = null
  }

  const fallbackSignalTimer = setTimeout(() => {
    if (state.process && !state.process.killed) {
      try {
        state.process.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
  }, STOP_SIGNAL_GRACE_MS)

  try {
    if (state.process && !state.process.killed) {
      try {
        state.process.kill('SIGINT')
      } catch {
        // ignore
      }
    }
    await state.exitPromise.catch(() => {})
  } finally {
    clearTimeout(fallbackSignalTimer)
    cleanupCaptureService(state)
    await removeCaptureServiceFiles(state)
  }
}

async function startCaptureService() {
  await refreshAudioDevices()
  const selectedDevice = currentSelectedDevice()
  if (!selectedDevice?.deviceId) {
    throw new Error('No Linux audio input is available for native capture.')
  }

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'dictray-native-capture-'))
  const segmentPattern = path.join(tempDir, 'chunk-%06d.raw')
  const monitorDeviceId = resolveMonitorDeviceId()
  const captureDevice = buildCaptureDeviceMetadata(selectedDevice, { monitorDeviceId })
  const args = buildPipelineArgs(selectedDevice, segmentPattern, { monitorDeviceId })
  const processHandle = spawn(GST_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const state = {
    process: processHandle,
    stdout: readline.createInterface({ input: processHandle.stdout }),
    stderr: readline.createInterface({ input: processHandle.stderr }),
    tempDir,
    segmentPattern,
    monitorDeviceId,
    captureDevice,
    recentLines: [],
    lastInputLevel: 0,
    ready: false,
    readyAt: 0,
    stopping: false,
    exitPromise: null,
    resolveExit: null,
    readyPromise: null,
    resolveReady: null,
    rejectReady: null,
    exitCode: null,
    exitSignal: ''
  }

  state.exitPromise = new Promise((resolve) => {
    state.resolveExit = resolve
  })
  state.readyPromise = new Promise((resolve, reject) => {
    state.resolveReady = resolve
    state.rejectReady = reject
  })

  state.stdout.on('line', (line) => {
    void handleCaptureServiceLine(state, line)
  })
  state.stderr.on('line', (line) => {
    void handleCaptureServiceLine(state, line)
  })
  processHandle.on('error', (error) => {
    rememberServiceLine(state, String(error?.message || error))
  })
  processHandle.on('exit', (code, signal) => {
    handleCaptureServiceExit(state, code, signal)
  })

  captureService = state
  await serviceReadyWithTimeout(state)
  reportInputDevices()
  return state
}

async function ensureCaptureServiceStarted() {
  if (captureService && !captureServiceNeedsRestart(captureService)) {
    await serviceReadyWithTimeout(captureService)
    return captureService
  }

  if (captureService && captureServiceNeedsRestart(captureService)) {
    if (recordingState) {
      pendingServiceRestart = true
      await serviceReadyWithTimeout(captureService)
      return captureService
    }
    await stopCaptureService(captureService)
  }

  if (captureServiceStartPromise) {
    return captureServiceStartPromise
  }

  captureServiceStartPromise = startCaptureService()
    .finally(() => {
      captureServiceStartPromise = null
    })

  return captureServiceStartPromise
}

async function snapshotCaptureSegments(state) {
  if (!state?.tempDir) {
    return {
      totalBytes: 0,
      segments: []
    }
  }

  const entries = await readdir(state.tempDir, { withFileTypes: true }).catch(() => [])
  const segments = []

  for (const entry of entries) {
    if (!entry?.isFile?.()) {
      continue
    }
    const match = entry.name.match(CHUNK_FILE_RE)
    if (!match) {
      continue
    }
    const fullPath = path.join(state.tempDir, entry.name)
    const stats = await stat(fullPath).catch(() => null)
    const size = Number(stats?.size || 0)
    if (!Number.isFinite(size) || size <= 0) {
      continue
    }
    segments.push({
      index: Number(match[1]) || 0,
      path: fullPath,
      size
    })
  }

  segments.sort((left, right) => left.index - right.index)
  let totalBytes = 0
  for (const segment of segments) {
    segment.startByte = totalBytes
    totalBytes += segment.size
    segment.endByte = totalBytes
  }

  return {
    totalBytes,
    segments
  }
}

function resolveSnapshotPosition(snapshot, byteOffset) {
  const targetByte = Math.max(0, Math.min(Number(byteOffset) || 0, snapshot.totalBytes))
  if (!snapshot?.segments?.length) {
    return {
      targetByte,
      segmentIndex: null,
      segmentByteOffset: 0
    }
  }

  for (const segment of snapshot.segments) {
    if (targetByte < segment.endByte) {
      return {
        targetByte,
        segmentIndex: segment.index,
        segmentByteOffset: Math.max(0, targetByte - segment.startByte)
      }
    }
  }

  const lastSegment = snapshot.segments[snapshot.segments.length - 1]
  return {
    targetByte,
    segmentIndex: lastSegment.index,
    segmentByteOffset: lastSegment.size
  }
}

async function buildRecordingBuffer(snapshot, startMarker, endByteOffset) {
  const endByte = Math.max(0, Math.min(Number(endByteOffset) || 0, snapshot.totalBytes))
  if (!Number.isFinite(endByte) || endByte <= 0 || !snapshot?.segments?.length) {
    return Buffer.alloc(0)
  }

  let startSegmentIndex = Number(startMarker?.segmentIndex)
  let startSegmentByteOffset = Math.max(0, Number(startMarker?.segmentByteOffset) || 0)
  if (!Number.isFinite(startSegmentIndex)) {
    const fallback = resolveSnapshotPosition(snapshot, startMarker?.byteOffset)
    startSegmentIndex = Number(fallback.segmentIndex)
    startSegmentByteOffset = fallback.segmentByteOffset
  }

  if (!Number.isFinite(startSegmentIndex)) {
    return Buffer.alloc(0)
  }

  const parts = []
  for (const segment of snapshot.segments) {
    if (segment.index < startSegmentIndex) {
      continue
    }
    if (segment.startByte >= endByte) {
      break
    }

    const fileBuffer = await readFile(segment.path)
    const segmentStart = segment.index === startSegmentIndex
      ? Math.min(segment.size, startSegmentByteOffset)
      : 0
    const segmentEnd = Math.min(segment.size, endByte - segment.startByte)
    if (segmentEnd > segmentStart) {
      parts.push(fileBuffer.subarray(segmentStart, segmentEnd))
    }
  }

  return Buffer.concat(parts)
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
    const service = await ensureCaptureServiceStarted()
    if (state?.cancelled) {
      return
    }
    const snapshot = await snapshotCaptureSegments(service)
    const endByteOffset = snapshot.totalBytes
    const pcmBuffer = await buildRecordingBuffer(snapshot, state.startMarker, endByteOffset)
    if (state?.cancelled) {
      return
    }
    const audioBuffer = buildWaveFromPcm(pcmBuffer)
    const recordingMs = Math.max(
      Math.max(0, nowMs() - state.startedAt),
      bytesToMs(Math.max(0, pcmBuffer.length))
    )
    if (state?.cancelled) {
      return
    }
    const result = await sendAudioSubmission(audioBuffer, state.captureDevice || service.captureDevice, recordingMs)
    if (state?.cancelled) {
      return
    }
    if (!result?.ok && !result?.cancelled) {
      reportError(result?.error || 'Dictation failed.')
    }
    reportRecordingState('idle')
  } finally {
    reportInputLevel(0)
    if (recordingState === state) {
      recordingState = null
    }
    reportInputDevices()
    if (pendingServiceRestart) {
      pendingServiceRestart = false
      await ensureCaptureServiceStarted().catch((error) => {
        reportError(String(error?.message || error || 'Failed to restart native capture service.'))
      })
    }
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
    reportError(String(error?.message || error || 'Native capture failed.'))
  })
  return state
}

async function discardRecordingForShutdown() {
  if (!recordingState) {
    return
  }
  clearPendingStopTimer(recordingState)
  recordingState.cancelled = true
  recordingState = null
  reportInputLevel(0)
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
  reportRecordingState('idle')
  reportInputLevel(0)
  reportInputDevices()
  return true
}

async function startRecording() {
  if (recordingState) {
    return
  }

  const service = await ensureCaptureServiceStarted()
  const snapshot = await snapshotCaptureSegments(service)
  const preRollBytes = msToBytes(CAPTURE_START_PRE_ROLL_MS)
  const startMarker = resolveSnapshotPosition(
    snapshot,
    Math.max(0, snapshot.totalBytes - preRollBytes)
  )

  recordingState = {
    startedAt: nowMs(),
    startMarker,
    pendingStopTimer: null,
    stopping: false,
    finalizePromise: null,
    cancelled: false,
    captureDevice: service.captureDevice
  }

  reportRecordingState('listening')
  reportInputLevel(service.lastInputLevel || 0)
  reportInputDevices()
}

async function stopRecording() {
  const state = recordingState
  if (!state) {
    return
  }
  if (state.stopping) {
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

async function toggleRecording() {
  if (recordingState && !recordingState.stopping) {
    await stopRecording()
    return
  }

  await startRecording()
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

  if (!captureService) {
    void ensureCaptureServiceStarted().catch((error) => {
      reportError(String(error?.message || error || 'Failed to start native capture service.'))
    })
    return
  }

  if (!captureServiceNeedsRestart(captureService)) {
    return
  }

  if (recordingState) {
    pendingServiceRestart = true
    return
  }

  pendingServiceRestart = false
  await stopCaptureService(captureService)
  await ensureCaptureServiceStarted()
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
          preferredInputDeviceId
        }
      })
    case CAPTURE_COMMAND_START_RECORDING:
      try {
        applyPreferredInputDevice(message?.payload || {})
        await startRecording()
      } catch (error) {
        const errorMessage = String(error?.message || error || 'Failed to start native capture.')
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
            reportError(String(error?.message || error || 'Failed to cancel native capture.'))
            return false
          })
        }
      })
    case CAPTURE_COMMAND_STOP_RECORDING:
      await stopRecording().catch((error) => {
        reportError(String(error?.message || error || 'Failed to stop native capture.'))
      })
      return createCaptureResponse(message?.id, {
        ok: true,
        payload: {
          stopping: Boolean(recordingState)
        }
      })
    case CAPTURE_COMMAND_TOGGLE_RECORDING:
      await toggleRecording().catch((error) => {
        reportError(String(error?.message || error || 'Failed to toggle native capture.'))
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
      await stopCaptureService(captureService).catch(() => {})
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
    reportInputDevices(String(error?.message || error || 'Unable to enumerate audio inputs.'))
  })
  await ensureCaptureServiceStarted().catch((error) => {
    reportError(String(error?.message || error || 'Failed to start native capture service.'))
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
    error: String(error?.message || error || 'Native capture helper failed.')
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
      reportError(String(error?.message || error || 'Native capture helper command failed.'))
    })
})

writeMessage(createCaptureEvent(CAPTURE_EVENT_READY, {
  backend: 'native',
  helper: 'gstreamer-segmented'
}))
void initializeHelper()
