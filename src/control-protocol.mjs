// The control pipe protocol: lets another local app (Superview first) drive a
// dictation and get the text back instead of having it pasted.
//
// Transport-free on purpose. src/control-server.mjs moves lines between a pipe
// or socket and createControlService(); the tray supplies the capture backend.
// The wire format is documented in README.md under "Control pipe & CLI".
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const CONTROL_PROTOCOL_VERSION = 1
export const CONTROL_PIPE_ENV = 'DICTRAY_CONTROL_PIPE'
export const CONTROL_MAX_LINE_BYTES = 64 * 1024
export const CONTROL_REQUEST_TIMEOUT_MS = 10000
export const CONTROL_LISTEN_MAX_MS = 5 * 60 * 1000

export const CONTROL_CMD_CONFIG = 'config'
export const CONTROL_CMD_LISTEN = 'listen'
export const CONTROL_CMD_STOP = 'stop'
export const CONTROL_CMD_CANCEL = 'cancel'

export const CONTROL_ERROR_BUSY = 'busy'
export const CONTROL_ERROR_NOT_READY = 'not ready'

const COMMANDS = new Set([CONTROL_CMD_CONFIG, CONTROL_CMD_LISTEN, CONTROL_CMD_STOP, CONTROL_CMD_CANCEL])
const LISTEN_FLAGS = ['overlay', 'partials', 'levels']

// \\.\pipe\dictray-control-<username> on Windows, a socket in XDG_RUNTIME_DIR
// elsewhere. DICTRAY_CONTROL_PIPE replaces the whole name, so a dev instance
// can run beside the installed one.
export function resolveControlPipePath({
  env = process.env,
  platform = process.platform,
  username = ''
} = {}) {
  const override = String(env?.[CONTROL_PIPE_ENV] || '').trim()
  if (override) {
    return override
  }
  if (platform === 'win32') {
    const user = String(username || env?.USERNAME || safeUsername() || 'user').trim().toLowerCase()
    return `\\\\.\\pipe\\dictray-control-${user}`
  }
  const runtimeDir = String(env?.XDG_RUNTIME_DIR || '').trim()
  if (runtimeDir) {
    return path.join(runtimeDir, 'dictray-control.sock')
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : String(username || safeUsername() || 'user')
  return path.join(os.tmpdir(), `dictray-control-${uid}.sock`)
}

function safeUsername() {
  try {
    return os.userInfo().username
  } catch {
    return ''
  }
}

export function encodeControlMessage(payload) {
  return `${JSON.stringify(payload)}\n`
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// One request line in, either { ok: true, request } or { ok: false, error }.
export function parseControlRequest(line) {
  const text = String(line ?? '').trim()
  if (!text) {
    return { ok: false, error: 'empty request' }
  }
  if (Buffer.byteLength(text, 'utf8') > CONTROL_MAX_LINE_BYTES) {
    return { ok: false, error: 'request too large' }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'invalid JSON' }
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: 'request must be a JSON object' }
  }

  const cmd = typeof parsed.cmd === 'string' ? parsed.cmd.trim().toLowerCase() : ''
  if (!cmd) {
    return { ok: false, error: 'missing cmd' }
  }
  if (!COMMANDS.has(cmd)) {
    return { ok: false, error: `unknown cmd: ${compact(cmd)}` }
  }

  if (cmd === CONTROL_CMD_CONFIG) {
    return { ok: true, request: { cmd } }
  }

  if (cmd === CONTROL_CMD_LISTEN) {
    const request = { cmd, overlay: true, partials: true, levels: true, refine: null }
    for (const flag of LISTEN_FLAGS) {
      if (parsed[flag] === undefined || parsed[flag] === null) {
        continue
      }
      if (typeof parsed[flag] !== 'boolean') {
        return { ok: false, error: `${flag} must be a boolean` }
      }
      request[flag] = parsed[flag]
    }
    if (parsed.refine !== undefined && parsed.refine !== null) {
      if (typeof parsed.refine !== 'boolean') {
        return { ok: false, error: 'refine must be a boolean' }
      }
      request.refine = parsed.refine
    }
    return { ok: true, request }
  }

  const id = typeof parsed.id === 'string' ? parsed.id.trim() : ''
  if (!id) {
    return { ok: false, error: 'missing id' }
  }
  return { ok: true, request: { cmd, id } }
}

function compact(value, limit = 40) {
  const text = String(value || '')
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

function clampLevel(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) {
    return 0
  }
  return Math.round(Math.max(0, Math.min(1, number)) * 1000) / 1000
}

function outcomeEvent(outcome = {}) {
  switch (outcome?.type) {
    case 'final':
      return { event: 'final', text: String(outcome.text ?? '') }
    case 'cancelled':
      return { event: 'cancelled' }
    default:
      return { event: 'error', message: String(outcome?.message || 'dictation failed') }
  }
}

// backend:
//   getConfig() -> { hotkey, mode, promptHotkey, ready }
//   startListen({ id, overlay, refine, onLevel, onPartial }) -> Promise<{
//     stop(): Promise, cancel(): Promise,
//     result: Promise<{ type: 'final', text } | { type: 'cancelled' } | { type: 'error', message }>
//   }>   rejects with Error('busy') / Error('not ready') / anything else
//
// openConnection({ send(obj), close() }) returns { receive(chunk), disconnected() }
// for one client connection. One request per connection.
export function createControlService({
  backend,
  logger = () => {},
  requestTimeoutMs = CONTROL_REQUEST_TIMEOUT_MS,
  listenMaxMs = CONTROL_LISTEN_MAX_MS,
  createId = randomUUID
} = {}) {
  if (!backend || typeof backend.getConfig !== 'function' || typeof backend.startListen !== 'function') {
    throw new Error('createControlService needs a backend with getConfig() and startListen().')
  }

  const listens = new Map()
  let listenStarting = false

  function openConnection(transport) {
    let buffer = ''
    let handled = false
    let closed = false
    let onDisconnect = null

    const timeout = requestTimeoutMs > 0
      ? setTimeout(() => {
          if (!handled) {
            handled = true
            reply({ ok: false, error: 'request timeout' })
            close()
          }
        }, requestTimeoutMs)
      : null
    timeout?.unref?.()

    function reply(payload) {
      if (closed) {
        return
      }
      try {
        transport.send(payload)
      } catch (error) {
        logger(`send failed: ${error?.message || error}`)
      }
    }

    function close() {
      if (closed) {
        return
      }
      closed = true
      if (timeout) {
        clearTimeout(timeout)
      }
      try {
        transport.close()
      } catch {
        // ignore
      }
    }

    function fail(error) {
      reply({ ok: false, error })
      close()
    }

    async function handle(line) {
      const parsed = parseControlRequest(line)
      if (!parsed.ok) {
        logger(`rejected request: ${parsed.error}`)
        fail(parsed.error)
        return
      }
      const { request } = parsed
      logger(`request: ${request.cmd}`)

      switch (request.cmd) {
        case CONTROL_CMD_CONFIG: {
          let config
          try {
            config = backend.getConfig() || {}
          } catch (error) {
            fail(String(error?.message || error || 'config unavailable'))
            return
          }
          reply({
            ok: true,
            version: CONTROL_PROTOCOL_VERSION,
            hotkey: String(config.hotkey || ''),
            mode: config.mode === 'hold' ? 'hold' : 'toggle',
            promptHotkey: String(config.promptHotkey || ''),
            ready: Boolean(config.ready)
          })
          close()
          return
        }
        case CONTROL_CMD_STOP:
        case CONTROL_CMD_CANCEL: {
          const listen = listens.get(request.id)
          if (!listen) {
            fail('unknown id')
            return
          }
          try {
            if (request.cmd === CONTROL_CMD_STOP) {
              await listen.handle.stop()
            } else {
              await listen.handle.cancel()
            }
          } catch (error) {
            fail(String(error?.message || error || `${request.cmd} failed`))
            return
          }
          reply({ ok: true })
          close()
          return
        }
        case CONTROL_CMD_LISTEN:
          await handleListen(request)
          return
        default:
          fail('unknown cmd')
      }
    }

    async function handleListen(request) {
      if (listenStarting || listens.size > 0) {
        reply({ event: 'error', message: CONTROL_ERROR_BUSY })
        close()
        return
      }

      const id = createId()
      let started = false
      let handle = null
      listenStarting = true
      try {
        handle = await backend.startListen({
          id,
          overlay: request.overlay,
          refine: request.refine,
          onLevel: request.levels
            ? (value) => {
                if (started) {
                  reply({ event: 'level', value: clampLevel(value) })
                }
              }
            : null,
          onPartial: request.partials
            ? (text) => {
                if (started) {
                  reply({ event: 'partial', text: String(text ?? '') })
                }
              }
            : null
        })
      } catch (error) {
        reply({ event: 'error', message: String(error?.message || error || 'failed to start') })
        close()
        return
      } finally {
        listenStarting = false
      }

      const entry = { id, handle, maxTimer: null }
      listens.set(id, entry)
      started = true
      reply({ event: 'started', id })
      logger(`listen started: ${id}`)

      if (listenMaxMs > 0) {
        entry.maxTimer = setTimeout(() => {
          logger(`listen ${id} hit the ${Math.round(listenMaxMs / 1000)} s limit; stopping`)
          void Promise.resolve(handle.stop()).catch(() => {})
        }, listenMaxMs)
        entry.maxTimer.unref?.()
      }

      onDisconnect = () => {
        if (listens.get(id) === entry) {
          logger(`listen ${id}: client disconnected; cancelling`)
          void Promise.resolve(handle.cancel()).catch(() => {})
        }
      }
      if (closed) {
        onDisconnect()
      }

      let outcome
      try {
        outcome = await handle.result
      } catch (error) {
        outcome = { type: 'error', message: String(error?.message || error || 'dictation failed') }
      }
      if (entry.maxTimer) {
        clearTimeout(entry.maxTimer)
      }
      listens.delete(id)
      started = false
      const event = outcomeEvent(outcome)
      logger(`listen ${id} finished: ${event.event}`)
      reply(event)
      close()
    }

    return {
      receive(chunk) {
        if (handled || closed) {
          return
        }
        buffer += String(chunk ?? '')
        const newline = buffer.indexOf('\n')
        if (newline < 0) {
          if (Buffer.byteLength(buffer, 'utf8') > CONTROL_MAX_LINE_BYTES) {
            handled = true
            fail('request too large')
          }
          return
        }
        handled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        const line = buffer.slice(0, newline)
        buffer = ''
        void handle(line).catch((error) => {
          logger(`request failed: ${error?.message || error}`)
          fail('internal error')
        })
      },
      disconnected() {
        // A listen that already finished is gone from the map, so this only
        // cancels a capture whose client left early.
        closed = true
        handled = true
        if (timeout) {
          clearTimeout(timeout)
        }
        onDisconnect?.()
      }
    }
  }

  return {
    openConnection,
    activeListenIds() {
      return [...listens.keys()]
    }
  }
}
