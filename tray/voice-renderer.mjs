const supportedTypes = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4'
]

const MIN_RECORDING_MS = 650

let mediaRecorder = null
let mediaStream = null
let mediaChunks = []
let isRecording = false
let recordingStartedAt = 0
let pendingStopTimer = null
let audioContext = null

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
  filter.frequency.setValueAtTime(isListen ? 1550 : isCancel ? 980 : 1250, start)
  filter.Q.setValueAtTime(isListen ? 2.8 : isCancel ? 2.4 : 3.2, start)

  compressor.threshold.setValueAtTime(-18, start)
  compressor.knee.setValueAtTime(16, start)
  compressor.ratio.setValueAtTime(3, start)
  compressor.attack.setValueAtTime(0.003, start)
  compressor.release.setValueAtTime(0.1, start)

  master.gain.setValueAtTime(0.0001, start)
  master.gain.exponentialRampToValueAtTime(isListen ? 1.24 : isCancel ? 0.7 : 1.4, start + 0.018)
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
    pulse('sine', 720, 1280, start, 0.12, 0.64)
    pulse('triangle', 1040, 1640, start + 0.03, 0.11, 0.3, 6)
    await sleep(130)
    return
  }

  if (isCancel) {
    pulse('sine', 840, 620, start, 0.11, 0.28)
    pulse('triangle', 720, 520, start + 0.035, 0.13, 0.16, -4)
    await sleep(180)
    return
  }

  pulse('sine', 500, 1120, start, 0.24, 0.58)
  pulse('triangle', 720, 1560, start + 0.045, 0.22, 0.34, 8)
  pulse('square', 1120, 2240, start + 0.095, 0.18, 0.14, -4)
  await sleep(260)
}

async function ensureRecorder() {
  if (mediaRecorder) {
    return
  }

  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const mimeType = supportedTypes.find((value) => MediaRecorder.isTypeSupported(value)) || ''
  mediaRecorder = mimeType ? new MediaRecorder(mediaStream, { mimeType }) : new MediaRecorder(mediaStream)
  mediaRecorder.addEventListener('dataavailable', (event) => {
    if (event.data && event.data.size > 0) {
      mediaChunks.push(event.data)
    }
  })
  mediaRecorder.addEventListener('stop', async () => {
    const blobType = mediaRecorder.mimeType || 'audio/webm'
    const blob = new Blob(mediaChunks, { type: blobType })
    const recordingMs = recordingStartedAt ? nowMs(recordingStartedAt) : 0
    mediaChunks = []
    recordingStartedAt = 0
    clearPendingStopTimer()

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
        recordingMs
      })
      if (payload?.cancelled) {
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
    }
  })
}

async function prewarmRecorderIfPermitted() {
  if (mediaRecorder || !navigator.permissions?.query) {
    return
  }

  try {
    const permission = await navigator.permissions.query({ name: 'microphone' })
    if (permission.state === 'granted') {
      await ensureRecorder()
    }
  } catch {
    // Ignore prewarm failures.
  }
}

async function startRecording() {
  if (isRecording) {
    return
  }

  await ensureRecorder()
  mediaChunks = []
  recordingStartedAt = performance.now()
  clearPendingStopTimer()
  mediaRecorder.start(250)
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

reportState('idle')
void prewarmRecorderIfPermitted()
