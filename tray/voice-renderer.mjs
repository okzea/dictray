const supportedTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4'
]

const MIN_RECORDING_MS = 650
const RECORDING_TIMESLICE_MS = 250
const INPUT_LEVEL_MULTIPLIER = 8
const INPUT_LEVEL_SMOOTHING = 0.24

const overlayElements = {
  phaseChip: document.getElementById('phase-chip'),
  meta: document.getElementById('meta'),
  headline: document.getElementById('headline'),
  subline: document.getElementById('subline')
}

let mediaRecorder = null
let mediaStream = null
let mediaChunks = []
let isRecording = false
let recordingStartedAt = 0
let pendingStopTimer = null
let audioContext = null
let inputMeterContext = null
let inputMeterSource = null
let inputMeterAnalyser = null
let inputMeterData = null
let inputMeterFrame = 0
let smoothedInputLevel = 0
let overlayPhase = 'idle'
let preferredInputDeviceId = ''
let pendingRecorderRefresh = false

const EARCON_LEVELS = {
  listen: {
    master: 1.52,
    primary: 0.76,
    accent: 0.38
  },
  cancel: {
    master: 1.06,
    primary: 0.42,
    accent: 0.3
  },
  submit: {
    master: 1.72,
    primary: 0.68,
    accent: 0.42,
    tail: 0.17
  }
}

function buildOverlayCopy(payload = {}) {
  const phase = String(payload?.phase || 'idle').trim() || 'idle'
  const targetWindow = String(payload?.targetWindow || '').trim()
  const targetWindowName = simplifyTargetWindow(targetWindow)
  const message = String(payload?.error || payload?.note || '').trim()
  const meta = phase === 'pending_insert' ? 'Waiting' : 'DicTray'

  switch (phase) {
    case 'listening':
      return {
        phase,
        chip: 'Listening',
        meta,
        headline: 'Release when you are done',
        subline: targetWindowName || 'Current window'
      }
    case 'processing':
      return {
        phase,
        chip: 'Processing',
        meta,
        headline: 'Finishing capture',
        subline: targetWindowName || 'Current window'
      }
    case 'transcribing':
      return {
        phase,
        chip: 'Transcribing',
        meta,
        headline: 'Turning speech into text',
        subline: targetWindowName || message || 'Current window'
      }
    case 'rewriting':
      return {
        phase,
        chip: 'Improving',
        meta,
        headline: 'Cleaning up the draft',
        subline: targetWindowName || message || 'Current window'
      }
    case 'pending_insert':
      return {
        phase,
        chip: 'Ready',
        meta: 'Waiting',
        headline: targetWindowName ? `Return to ${targetWindowName}` : 'Return to the target window',
        subline: targetWindowName || message || 'The text will paste when that window is active.'
      }
    case 'inserting':
      return {
        phase,
        chip: 'Inserting',
        meta,
        headline: 'Sending text',
        subline: targetWindowName || 'Current window'
      }
    default:
      if (payload?.error) {
        return {
          phase,
          chip: 'Attention',
          meta,
          headline: 'Dictation needs attention',
          subline: message
        }
      }
      if (payload?.note) {
        return {
          phase,
          chip: 'Done',
          meta,
          headline: 'Dictation finished',
          subline: message
        }
      }
      return {
        phase,
        chip: 'Idle',
        meta: 'DicTray',
        headline: 'Ready',
        subline: 'Press the shortcut to start dictation.'
      }
  }
}

function simplifyTargetWindow(value) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  const match = text.match(/^(.*?)(?:\s+\([^()]+\))$/)
  return (match?.[1] || text).trim()
}

function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

function setOverlayInputLevel(value) {
  document.documentElement.style.setProperty('--listen-level', clampUnitInterval(value).toFixed(3))
}

function resetOverlayInputLevel() {
  smoothedInputLevel = 0
  setOverlayInputLevel(0)
}

function renderVoiceOverlay(payload = {}) {
  const phase = String(payload?.phase || 'idle').trim() || 'idle'
  const copy = buildOverlayCopy(payload)

  overlayPhase = phase
  document.body.dataset.phase = phase
  document.body.dataset.visible = payload?.visible ? 'true' : 'false'
  document.body.dataset.error = payload?.error ? 'true' : 'false'
  overlayElements.phaseChip.textContent = copy.chip
  overlayElements.meta.textContent = copy.meta
  overlayElements.headline.textContent = copy.headline
  overlayElements.subline.textContent = copy.subline

  if (phase !== 'listening') {
    resetOverlayInputLevel()
  }
}

function nowMs(startedAt) {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function clearPendingStopTimer() {
  if (pendingStopTimer) {
    clearTimeout(pendingStopTimer)
    pendingStopTimer = null
  }
}

function reportState(phase, extra = {}) {
  window.dictationTray.reportState({
    phase,
    ...extra
  })
}

function reportError(message) {
  window.dictationTray.reportError({
    message: String(message || 'Unknown dictation error')
  })
}

function normalizeInputDeviceId(value) {
  return String(value || '').trim()
}

function fallbackInputLabel(index) {
  return `Microphone ${index + 1}`
}

function captureDeviceMetadata() {
  const track = mediaStream?.getAudioTracks?.()[0] || null
  if (!track) {
    return null
  }
  const settings = typeof track.getSettings === 'function' ? track.getSettings() : {}
  return {
    label: String(track.label || '').trim(),
    deviceId: normalizeInputDeviceId(settings?.deviceId),
    groupId: String(settings?.groupId || '').trim(),
    sampleRate: Number(settings?.sampleRate || 0) || 0,
    channelCount: Number(settings?.channelCount || 0) || 0,
    echoCancellation: Boolean(settings?.echoCancellation),
    noiseSuppression: Boolean(settings?.noiseSuppression),
    autoGainControl: Boolean(settings?.autoGainControl)
  }
}

async function microphonePermissionState() {
  if (!navigator.permissions?.query) {
    return 'unknown'
  }
  try {
    const permission = await navigator.permissions.query({ name: 'microphone' })
    return String(permission?.state || 'unknown').trim() || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function enumerateAudioInputs() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return []
  }

  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const results = []
  const seen = new Set()
  let unnamedIndex = 0

  for (const device of Array.isArray(devices) ? devices : []) {
    if (String(device?.kind || '').trim() !== 'audioinput') {
      continue
    }
    const deviceId = normalizeInputDeviceId(device?.deviceId)
    const groupId = String(device?.groupId || '').trim()
    const label = String(device?.label || '').trim() || fallbackInputLabel(unnamedIndex++)
    const key = deviceId || `${groupId}:${label}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push({
      deviceId,
      groupId,
      label
    })
  }

  return results
}

async function reportInputDevices(extra = {}) {
  const capture = captureDeviceMetadata()
  const devices = await enumerateAudioInputs().catch(() => [])
  const activeDeviceId = normalizeInputDeviceId(capture?.deviceId)
  const activeLabel = String(
    capture?.label
      || devices.find((device) => device.deviceId === activeDeviceId)?.label
      || ''
  ).trim()

  window.dictationTray.reportInputDevices({
    devices,
    preferredDeviceId: preferredInputDeviceId,
    activeDeviceId,
    activeLabel,
    permission: await microphonePermissionState(),
    error: String(extra?.error || '').trim()
  })
}

function audioConstraints(deviceId = preferredInputDeviceId) {
  const audio = {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  }
  const selectedDeviceId = normalizeInputDeviceId(deviceId)
  if (selectedDeviceId) {
    audio.deviceId = { exact: selectedDeviceId }
  }
  return { audio }
}

function stopInputMeterLoop() {
  if (inputMeterFrame) {
    cancelAnimationFrame(inputMeterFrame)
    inputMeterFrame = 0
  }
}

function teardownInputMeter() {
  stopInputMeterLoop()
  if (inputMeterSource) {
    try {
      inputMeterSource.disconnect()
    } catch {
      // ignore source disconnect failures
    }
    inputMeterSource = null
  }
  inputMeterAnalyser = null
  inputMeterData = null
  resetOverlayInputLevel()
}

function updateInputMeterLevel() {
  if (!inputMeterAnalyser || !inputMeterData) {
    return
  }

  inputMeterAnalyser.getByteTimeDomainData(inputMeterData)
  let sumSquares = 0
  for (const value of inputMeterData) {
    const sample = (value - 128) / 128
    sumSquares += sample * sample
  }
  const rms = Math.sqrt(sumSquares / inputMeterData.length)
  const nextLevel = clampUnitInterval(rms * INPUT_LEVEL_MULTIPLIER)
  smoothedInputLevel += (nextLevel - smoothedInputLevel) * INPUT_LEVEL_SMOOTHING
  setOverlayInputLevel(overlayPhase === 'listening' ? smoothedInputLevel : 0)
}

function ensureInputMeterLoop() {
  if (inputMeterFrame) {
    return
  }

  const tick = () => {
    updateInputMeterLevel()
    inputMeterFrame = requestAnimationFrame(tick)
  }

  tick()
}

async function ensureInputMeter() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor || !mediaStream) {
    return
  }

  if (!inputMeterContext) {
    inputMeterContext = new AudioContextCtor()
  }
  if (inputMeterContext.state === 'suspended') {
    await inputMeterContext.resume().catch(() => {})
  }

  teardownInputMeter()
  inputMeterAnalyser = inputMeterContext.createAnalyser()
  inputMeterAnalyser.fftSize = 256
  inputMeterAnalyser.smoothingTimeConstant = 0.72
  inputMeterData = new Uint8Array(inputMeterAnalyser.fftSize)
  inputMeterSource = inputMeterContext.createMediaStreamSource(mediaStream)
  inputMeterSource.connect(inputMeterAnalyser)
  ensureInputMeterLoop()
}

function stopMediaStreamTracks() {
  if (!mediaStream) {
    return
  }
  for (const track of mediaStream.getTracks()) {
    try {
      track.stop()
    } catch {
      // ignore track shutdown failures
    }
  }
}

async function teardownRecorder() {
  if (isRecording) {
    return
  }
  clearPendingStopTimer()
  teardownInputMeter()
  stopMediaStreamTracks()
  mediaRecorder = null
  mediaStream = null
  mediaChunks = []
  recordingStartedAt = 0
}

async function openMediaStreamForSelection() {
  const selectedDeviceId = normalizeInputDeviceId(preferredInputDeviceId)
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not available in this runtime.')
  }

  if (!selectedDeviceId) {
    return {
      stream: await navigator.mediaDevices.getUserMedia(audioConstraints('')),
      warning: ''
    }
  }

  try {
    return {
      stream: await navigator.mediaDevices.getUserMedia(audioConstraints(selectedDeviceId)),
      warning: ''
    }
  } catch (error) {
    return {
      stream: await navigator.mediaDevices.getUserMedia(audioConstraints('')),
      warning: `Preferred microphone is unavailable. Using the system default instead.`
    }
  }
}

async function ensureRecorder() {
  if (mediaRecorder) {
    await reportInputDevices()
    return
  }

  const result = await openMediaStreamForSelection()
  mediaStream = result.stream
  await ensureInputMeter()

  const mimeType = supportedTypes.find((value) => MediaRecorder.isTypeSupported(value)) || ''
  mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream)
  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) {
      mediaChunks.push(event.data)
    }
  })
  mediaRecorder.addEventListener('stop', async () => {
    const blobType = mediaRecorder?.mimeType || 'audio/webm'
    const blob = new Blob(mediaChunks, { type: blobType })
    const recordingMs = recordingStartedAt ? nowMs(recordingStartedAt) : 0
    mediaChunks = []
    recordingStartedAt = 0
    clearPendingStopTimer()
    resetOverlayInputLevel()

    if (!blob.size) {
      reportState('idle')
      reportError('Recording was empty. Hold the shortcut a bit longer and speak after pressing it.')
      return
    }

    try {
      reportState('processing', {
        recordingMs
      })
      const arrayBuffer = await blob.arrayBuffer()
      const payload = await window.dictationTray.submitAudio({
        mimeType: blob.type || 'application/octet-stream',
        audioBytes: new Uint8Array(arrayBuffer),
        recordingMs,
        captureDevice: captureDeviceMetadata()
      })
      if (payload?.cancelled) {
        reportState('idle')
        if (payload?.earcon === 'cancel') {
          void playEarcon('cancel').catch(() => {})
        }
        return
      }
      if (!payload?.ok) {
        throw new Error(payload?.error || 'Dictation failed.')
      }
      reportState('idle')
    } catch (error) {
      reportState('idle')
      reportError(error?.message || error)
    } finally {
      if (pendingRecorderRefresh && !isRecording) {
        pendingRecorderRefresh = false
        await teardownRecorder()
        await ensureRecorder().catch(async (error) => {
          await reportInputDevices({ error: String(error?.message || error) })
        })
      } else {
        await reportInputDevices().catch(() => {})
      }
    }
  })

  await reportInputDevices({ error: result.warning }).catch(() => {})
}

async function prewarmRecorderIfPermitted() {
  if (mediaRecorder || !navigator.permissions?.query) {
    await reportInputDevices().catch(() => {})
    return
  }

  try {
    const permission = await navigator.permissions.query({ name: 'microphone' })
    if (permission.state === 'granted') {
      await ensureRecorder()
      return
    }
  } catch {
    // Ignore prewarm failures.
  }

  await reportInputDevices().catch(() => {})
}

async function applyAudioInputConfig(payload = {}) {
  const nextPreferredDeviceId = normalizeInputDeviceId(
    payload?.preferredInputDeviceId ?? payload?.selectedDeviceId
  )
  const changed = nextPreferredDeviceId !== preferredInputDeviceId
  preferredInputDeviceId = nextPreferredDeviceId

  if (changed) {
    if (isRecording) {
      pendingRecorderRefresh = true
    } else if (mediaRecorder) {
      await teardownRecorder()
      await ensureRecorder().catch(async (error) => {
        await reportInputDevices({ error: String(error?.message || error) })
      })
      return
    }
  }

  if (payload?.refresh) {
    if (isRecording) {
      pendingRecorderRefresh = true
      await reportInputDevices().catch(() => {})
      return
    }

    if (mediaRecorder) {
      await teardownRecorder()
      await ensureRecorder().catch(async (error) => {
        await reportInputDevices({ error: String(error?.message || error) })
      })
      return
    }

    await prewarmRecorderIfPermitted()
    return
  }

  await reportInputDevices().catch(() => {})
}

async function playEarcon(kind) {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) {
    return
  }

  if (!audioContext) {
    audioContext = new AudioContextCtor()
  }
  await audioContext.resume()

  const start = audioContext.currentTime
  const master = audioContext.createGain()
  const filter = audioContext.createBiquadFilter()
  const compressor = audioContext.createDynamicsCompressor()
  const isListen = kind === 'listen'
  const isCancel = kind === 'cancel'

  filter.type = 'bandpass'
  filter.frequency.setValueAtTime(isListen ? 1550 : isCancel ? 720 : 1250, start)
  filter.Q.setValueAtTime(isListen ? 2.8 : isCancel ? 1.9 : 3.2, start)

  compressor.threshold.setValueAtTime(-18, start)
  compressor.knee.setValueAtTime(16, start)
  compressor.ratio.setValueAtTime(3, start)
  compressor.attack.setValueAtTime(0.003, start)
  compressor.release.setValueAtTime(0.1, start)

  master.gain.setValueAtTime(0.0001, start)
  master.gain.exponentialRampToValueAtTime(
    isListen ? EARCON_LEVELS.listen.master : isCancel ? EARCON_LEVELS.cancel.master : EARCON_LEVELS.submit.master,
    start + 0.018
  )
  master.gain.exponentialRampToValueAtTime(0.0001, start + (isListen ? 0.16 : isCancel ? 0.22 : 0.45))
  master.connect(filter)
  filter.connect(compressor)
  compressor.connect(audioContext.destination)

  function pulse(type, fromHz, toHz, when, duration, level, detune = 0) {
    const oscillator = audioContext.createOscillator()
    const gain = audioContext.createGain()
    oscillator.type = type
    oscillator.detune.setValueAtTime(detune, when)
    oscillator.frequency.setValueAtTime(fromHz, when)
    oscillator.frequency.exponentialRampToValueAtTime(toHz, when + duration)
    gain.gain.setValueAtTime(0.0001, when)
    gain.gain.exponentialRampToValueAtTime(level, when + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration)
    oscillator.connect(gain)
    gain.connect(master)
    oscillator.start(when)
    oscillator.stop(when + duration + 0.02)
  }

  if (isListen) {
    pulse('sine', 720, 1280, start, 0.12, EARCON_LEVELS.listen.primary)
    pulse('triangle', 1040, 1640, start + 0.03, 0.11, EARCON_LEVELS.listen.accent, 6)
    await sleep(130)
    return
  }

  if (isCancel) {
    pulse('square', 210, 168, start, 0.05, EARCON_LEVELS.cancel.primary)
    pulse('square', 198, 158, start + 0.07, 0.05, EARCON_LEVELS.cancel.primary)
    pulse('square', 186, 148, start + 0.14, 0.05, EARCON_LEVELS.cancel.primary)
    pulse('triangle', 320, 220, start + 0.01, 0.06, EARCON_LEVELS.cancel.accent, -6)
    pulse('triangle', 308, 212, start + 0.08, 0.06, EARCON_LEVELS.cancel.accent, -6)
    pulse('triangle', 296, 204, start + 0.15, 0.06, EARCON_LEVELS.cancel.accent, -6)
    await sleep(220)
    return
  }

  pulse('sine', 500, 1120, start, 0.24, EARCON_LEVELS.submit.primary)
  pulse('triangle', 720, 1560, start + 0.045, 0.22, EARCON_LEVELS.submit.accent, 8)
  pulse('square', 1120, 2240, start + 0.095, 0.18, EARCON_LEVELS.submit.tail, -4)
  await sleep(260)
}

async function startRecording() {
  if (isRecording) {
    return
  }

  await ensureRecorder()
  if (inputMeterContext?.state === 'suspended') {
    await inputMeterContext.resume().catch(() => {})
  }
  mediaChunks = []
  recordingStartedAt = performance.now()
  clearPendingStopTimer()
  resetOverlayInputLevel()
  mediaRecorder.start(RECORDING_TIMESLICE_MS)
  isRecording = true
  reportState('listening')
  void playEarcon('listen').catch(() => {})
}

function finishStopRecording() {
  if (!mediaRecorder || !isRecording) {
    return
  }

  isRecording = false
  reportState('processing', {
    recordingMs: recordingStartedAt ? nowMs(recordingStartedAt) : 0
  })
  resetOverlayInputLevel()
  mediaRecorder.stop()
  void playEarcon('submit').catch(() => {})
}

function stopRecording() {
  if (!mediaRecorder || !isRecording) {
    return
  }

  const elapsedMs = recordingStartedAt ? performance.now() - recordingStartedAt : MIN_RECORDING_MS
  const remainingMs = Math.max(0, MIN_RECORDING_MS - elapsedMs)
  if (remainingMs > 0) {
    clearPendingStopTimer()
    pendingStopTimer = setTimeout(() => {
      finishStopRecording()
    }, remainingMs)
    return
  }

  finishStopRecording()
}

async function toggleRecording() {
  if (isRecording) {
    stopRecording()
    return
  }

  await startRecording()
}

window.dictationTray.onToggleRecording(() => {
  toggleRecording().catch((error) => reportError(error?.message || error))
})

window.dictationTray.onStartRecording(() => {
  startRecording().catch((error) => reportError(error?.message || error))
})

window.dictationTray.onStopRecording(() => {
  stopRecording()
})

window.dictationTray.onPlayEarcon((payload) => {
  const kind = String(payload?.kind || '').trim()
  if (!kind) {
    return
  }
  void playEarcon(kind).catch(() => {})
})

window.dictationTray.onVoiceState((payload) => {
  renderVoiceOverlay(payload)
})

window.dictationTray.onAudioInputConfig((payload) => {
  applyAudioInputConfig(payload).catch((error) => reportError(error?.message || error))
})

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    applyAudioInputConfig({
      preferredInputDeviceId,
      refresh: true
    }).catch(() => {})
  })
}

renderVoiceOverlay({
  visible: false,
  phase: 'idle',
  note: '',
  error: '',
  targetWindow: ''
})

void reportInputDevices().catch(() => {})
void prewarmRecorderIfPermitted()
