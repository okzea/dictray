export const CAPTURE_BACKEND_NATIVE = 'native'

export const CAPTURE_MESSAGE_KIND_COMMAND = 'command'
export const CAPTURE_MESSAGE_KIND_EVENT = 'event'
export const CAPTURE_MESSAGE_KIND_REQUEST = 'request'
export const CAPTURE_MESSAGE_KIND_RESPONSE = 'response'

export const CAPTURE_COMMAND_CONFIGURE = 'configure'
export const CAPTURE_COMMAND_CANCEL_RECORDING = 'cancel-recording'
export const CAPTURE_COMMAND_START_RECORDING = 'start-recording'
export const CAPTURE_COMMAND_STOP_RECORDING = 'stop-recording'
export const CAPTURE_COMMAND_TOGGLE_RECORDING = 'toggle-recording'
export const CAPTURE_COMMAND_SHUTDOWN = 'shutdown'

export const CAPTURE_EVENT_READY = 'ready'
export const CAPTURE_EVENT_RECORDING_STATE = 'recording-state'
export const CAPTURE_EVENT_INPUT_LEVEL = 'input-level'
export const CAPTURE_EVENT_INPUT_DEVICES = 'input-devices'
export const CAPTURE_EVENT_ERROR = 'error'

export const CAPTURE_REQUEST_SUBMIT_AUDIO = 'submit-audio'

const VALID_CAPTURE_BACKENDS = new Set([
  CAPTURE_BACKEND_NATIVE
])

const VALID_CAPTURE_COMMANDS = new Set([
  CAPTURE_COMMAND_CONFIGURE,
  CAPTURE_COMMAND_CANCEL_RECORDING,
  CAPTURE_COMMAND_START_RECORDING,
  CAPTURE_COMMAND_STOP_RECORDING,
  CAPTURE_COMMAND_TOGGLE_RECORDING,
  CAPTURE_COMMAND_SHUTDOWN
])

const VALID_CAPTURE_EVENTS = new Set([
  CAPTURE_EVENT_READY,
  CAPTURE_EVENT_RECORDING_STATE,
  CAPTURE_EVENT_INPUT_LEVEL,
  CAPTURE_EVENT_INPUT_DEVICES,
  CAPTURE_EVENT_ERROR
])

const VALID_CAPTURE_REQUESTS = new Set([
  CAPTURE_REQUEST_SUBMIT_AUDIO
])

let nextCaptureMessageSequence = 0

function nextCaptureMessageId() {
  nextCaptureMessageSequence += 1
  const runtimePid = typeof process !== 'undefined' && Number.isFinite(process?.pid)
    ? process.pid
    : 'runtime'
  return `capture-${runtimePid}-${Date.now().toString(36)}-${nextCaptureMessageSequence.toString(36)}`
}

function normalizeCaptureType(value, validValues, fallback = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (validValues.has(normalized)) {
    return normalized
  }
  return fallback
}

export function normalizeCaptureBackendId(value) {
  const normalized = String(value || '').trim().toLowerCase()
  switch (normalized) {
    case 'native':
    case 'linux-native':
    case 'linux_native':
      return CAPTURE_BACKEND_NATIVE
    case 'chromium':
    case 'renderer':
      return CAPTURE_BACKEND_NATIVE
    default:
      return VALID_CAPTURE_BACKENDS.has(normalized)
        ? normalized
        : CAPTURE_BACKEND_NATIVE
  }
}

export function normalizeCaptureCommandType(value) {
  return normalizeCaptureType(value, VALID_CAPTURE_COMMANDS)
}

export function normalizeCaptureEventType(value) {
  return normalizeCaptureType(value, VALID_CAPTURE_EVENTS)
}

export function normalizeCaptureRequestType(value) {
  return normalizeCaptureType(value, VALID_CAPTURE_REQUESTS)
}

export function createCaptureCommand(type, payload = {}, id = nextCaptureMessageId()) {
  return {
    kind: CAPTURE_MESSAGE_KIND_COMMAND,
    id,
    type: normalizeCaptureCommandType(type),
    payload: payload && typeof payload === 'object' ? payload : {}
  }
}

export function createCaptureEvent(type, payload = {}) {
  return {
    kind: CAPTURE_MESSAGE_KIND_EVENT,
    type: normalizeCaptureEventType(type),
    payload: payload && typeof payload === 'object' ? payload : {}
  }
}

export function createCaptureRequest(type, payload = {}, id = nextCaptureMessageId()) {
  return {
    kind: CAPTURE_MESSAGE_KIND_REQUEST,
    id,
    type: normalizeCaptureRequestType(type),
    payload: payload && typeof payload === 'object' ? payload : {}
  }
}

export function createCaptureResponse(id, { ok = true, payload = {}, error = '' } = {}) {
  return {
    kind: CAPTURE_MESSAGE_KIND_RESPONSE,
    id: String(id || '').trim(),
    ok: Boolean(ok),
    payload: payload && typeof payload === 'object' ? payload : {},
    error: String(error || '').trim()
  }
}
