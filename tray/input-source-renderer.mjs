const ui = {
  status: document.getElementById('status'),
  list: document.getElementById('list')
}

const DEFAULT_ENTRY_ID = '__default__'
const INPUT_LEVEL_MULTIPLIER = 8
const INPUT_LEVEL_SMOOTHING = 0.22

let preferredInputDeviceId = ''
let previewEntries = []
let previewMonitors = new Map()
let audioContext = null
let frameHandle = 0
let refreshInFlight = null

function normalizeInputDeviceId(value) {
  return String(value || '').trim()
}

function entryKeyForDeviceId(deviceId) {
  return normalizeInputDeviceId(deviceId) || DEFAULT_ENTRY_ID
}

function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

function setStatus(message) {
  ui.status.textContent = String(message || '').trim()
}

function describeEntry(entry) {
  if (!entry) {
    return ''
  }
  if (entry.deviceId) {
    return 'Specific input'
  }
  return 'Uses the current Windows default microphone'
}

function selectedEntryKey() {
  return entryKeyForDeviceId(preferredInputDeviceId)
}

async function ensureAudioContext() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error('Audio preview is not available in this runtime.')
  }
  if (!audioContext) {
    audioContext = new AudioContextCtor()
  }
  if (audioContext.state === 'suspended') {
    await audioContext.resume().catch(() => {})
  }
  return audioContext
}

async function ensureMicrophonePermission() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone capture is not available in this runtime.')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: true
  })
  for (const track of stream.getTracks()) {
    try {
      track.stop()
    } catch {
      // ignore
    }
  }
}

async function enumerateAudioInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => [])
  const results = [{
    id: DEFAULT_ENTRY_ID,
    deviceId: '',
    label: 'System Default',
    note: 'Windows default input'
  }]
  const seen = new Set()
  let unnamedIndex = 0

  for (const device of Array.isArray(devices) ? devices : []) {
    if (String(device?.kind || '').trim() !== 'audioinput') {
      continue
    }
    const deviceId = normalizeInputDeviceId(device?.deviceId)
    const groupId = String(device?.groupId || '').trim()
    const label = String(device?.label || '').trim() || `Microphone ${unnamedIndex + 1}`
    const key = deviceId || `${groupId}:${label}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    results.push({
      id: entryKeyForDeviceId(deviceId || `${groupId}:${label}`),
      deviceId,
      label,
      note: 'Specific input'
    })
    unnamedIndex += 1
  }

  return results
}

function audioConstraints(deviceId = '') {
  const audio = {
    channelCount: 1,
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false
  }
  if (deviceId) {
    audio.deviceId = { exact: deviceId }
  }
  return { audio }
}

function stopMonitor(monitor) {
  if (!monitor) {
    return
  }
  if (monitor.source) {
    try {
      monitor.source.disconnect()
    } catch {
      // ignore
    }
  }
  for (const track of monitor.stream?.getTracks?.() || []) {
    try {
      track.stop()
    } catch {
      // ignore
    }
  }
}

function clearMonitors() {
  for (const monitor of previewMonitors.values()) {
    stopMonitor(monitor)
  }
  previewMonitors.clear()
}

async function createMonitor(entry) {
  const context = await ensureAudioContext()
  const stream = await navigator.mediaDevices.getUserMedia(audioConstraints(entry.deviceId))
  const analyser = context.createAnalyser()
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.72

  const source = context.createMediaStreamSource(stream)
  source.connect(analyser)

  return {
    entryId: entry.id,
    stream,
    source,
    analyser,
    data: new Uint8Array(analyser.fftSize),
    level: 0,
    error: ''
  }
}

function renderEntries() {
  if (!previewEntries.length) {
    ui.list.innerHTML = '<div class="empty">No microphone inputs were found. Check Windows input devices and try reopening this preview.</div>'
    return
  }

  const selectedKey = selectedEntryKey()
  ui.list.innerHTML = previewEntries.map((entry) => {
    const monitor = previewMonitors.get(entry.id)
    const disabled = Boolean(monitor?.error)
    const status = monitor?.error
      ? monitor.error
      : entry.id === selectedKey
        ? 'Selected'
        : 'Click to use this input'
    return `
      <button class="source" type="button" data-entry-id="${entry.id}" data-selected="${entry.id === selectedKey}" data-disabled="${disabled}">
        <div class="topline">
          <div class="name">${entry.label}</div>
          <div class="meta">${entry.id === selectedKey ? 'Active' : 'Available'}</div>
        </div>
        <div class="note">${describeEntry(entry)}</div>
        <div class="meter"><div class="meter-fill" data-meter-for="${entry.id}"></div></div>
        <div class="row">
          <div class="hint">${status}</div>
          <div class="hint">${entry.note}</div>
        </div>
      </button>
    `
  }).join('')

  for (const button of ui.list.querySelectorAll('.source')) {
    button.addEventListener('click', async () => {
      if (button.dataset.disabled === 'true') {
        return
      }
      const entryId = String(button.dataset.entryId || '')
      const entry = previewEntries.find((item) => item.id === entryId)
      if (!entry) {
        return
      }
      preferredInputDeviceId = normalizeInputDeviceId(entry.deviceId)
      renderEntries()
      setStatus(`Input source set to ${entry.label}.`)
      await window.dictationTray.setInputSource(entry.deviceId).catch((error) => {
        setStatus(String(error?.message || error || 'Failed to set input source.'))
      })
    })
  }
}

function updateMeters() {
  for (const entry of previewEntries) {
    const meter = ui.list.querySelector(`[data-meter-for="${entry.id}"]`)
    if (!meter) {
      continue
    }
    const monitor = previewMonitors.get(entry.id)
    if (!monitor?.analyser || !monitor.data) {
      meter.style.width = '0%'
      continue
    }
    monitor.analyser.getByteTimeDomainData(monitor.data)
    let sumSquares = 0
    for (const value of monitor.data) {
      const sample = (value - 128) / 128
      sumSquares += sample * sample
    }
    const rms = Math.sqrt(sumSquares / monitor.data.length)
    const nextLevel = clampUnitInterval(rms * INPUT_LEVEL_MULTIPLIER)
    monitor.level += (nextLevel - monitor.level) * INPUT_LEVEL_SMOOTHING
    meter.style.width = `${Math.round(monitor.level * 100)}%`
  }
  frameHandle = requestAnimationFrame(updateMeters)
}

function startMeterLoop() {
  if (frameHandle) {
    return
  }
  frameHandle = requestAnimationFrame(updateMeters)
}

function stopMeterLoop() {
  if (frameHandle) {
    cancelAnimationFrame(frameHandle)
    frameHandle = 0
  }
}

async function refreshPreview() {
  if (refreshInFlight) {
    return refreshInFlight
  }

  refreshInFlight = (async () => {
    stopMeterLoop()
    clearMonitors()
    setStatus('Requesting microphone access and opening live previews...')

    try {
      await ensureMicrophonePermission()
      previewEntries = await enumerateAudioInputs()
      renderEntries()
      const opened = []
      for (const entry of previewEntries) {
        try {
          opened.push([entry.id, await createMonitor(entry)])
        } catch (error) {
          opened.push([entry.id, {
            entryId: entry.id,
            analyser: null,
            data: null,
            level: 0,
            error: String(error?.message || error || 'Preview unavailable')
          }])
        }
      }
      previewMonitors = new Map(opened)
      renderEntries()
      startMeterLoop()
      setStatus('Speak and watch the meters. Click any row to make it the active input source.')
    } catch (error) {
      previewEntries = []
      renderEntries()
      setStatus(String(error?.message || error || 'Unable to open microphone previews.'))
    }
  })().finally(() => {
    refreshInFlight = null
  })

  return refreshInFlight
}

window.dictationTray.onAudioInputConfig((payload) => {
  preferredInputDeviceId = normalizeInputDeviceId(payload?.preferredInputDeviceId)
  renderEntries()
  if (payload?.refresh) {
    void refreshPreview().catch(() => {})
  }
})

if (navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void refreshPreview().catch(() => {})
  })
}

window.addEventListener('beforeunload', () => {
  stopMeterLoop()
  clearMonitors()
})

void refreshPreview().catch((error) => {
  setStatus(String(error?.message || error || 'Unable to open microphone previews.'))
})
