import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  CAPTURE_BACKEND_NATIVE,
  CAPTURE_COMMAND_CANCEL_RECORDING,
  CAPTURE_COMMAND_CONFIGURE,
  CAPTURE_COMMAND_SHUTDOWN,
  CAPTURE_COMMAND_START_RECORDING,
  CAPTURE_COMMAND_STOP_RECORDING,
  CAPTURE_COMMAND_TOGGLE_RECORDING,
  CAPTURE_MESSAGE_KIND_EVENT,
  CAPTURE_MESSAGE_KIND_REQUEST,
  CAPTURE_MESSAGE_KIND_RESPONSE,
  createCaptureCommand,
  createCaptureResponse,
  normalizeCaptureBackendId
} from './capture-protocol.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_NATIVE_CAPTURE_HELPER = path.join(__dirname, 'native-capture-helper.mjs')
const NATIVE_CAPTURE_HELPER = String(process.env.DICTATION_TRAY_NATIVE_CAPTURE_HELPER || '').trim() || DEFAULT_NATIVE_CAPTURE_HELPER

function errorMessage(error, fallback = 'Native capture helper failed.') {
  return String(error?.message || error || fallback).trim() || fallback
}

class NativeCaptureBridge {
  constructor({ onEvent, onRequest, logger }) {
    this.backendId = CAPTURE_BACKEND_NATIVE
    this.onEvent = typeof onEvent === 'function' ? onEvent : () => {}
    this.onRequest = typeof onRequest === 'function'
      ? onRequest
      : async (message = {}) => createCaptureResponse(message?.id, {
          ok: false,
          error: 'Capture request handler is not available.'
        })
    this.logger = typeof logger === 'function' ? logger : () => {}
    this.worker = null
    this.workerStdout = null
    this.pending = new Map()
    this.startPromise = null
  }

  attachWindow() {}

  async configure(payload = {}) {
    return this.runCommand(CAPTURE_COMMAND_CONFIGURE, payload)
  }

  async startRecording() {
    return this.runCommand(CAPTURE_COMMAND_START_RECORDING)
  }

  async cancelRecording() {
    return this.runCommand(CAPTURE_COMMAND_CANCEL_RECORDING)
  }

  async stopRecording() {
    return this.runCommand(CAPTURE_COMMAND_STOP_RECORDING)
  }

  async toggleRecording() {
    return this.runCommand(CAPTURE_COMMAND_TOGGLE_RECORDING)
  }

  async dispose() {
    const worker = this.worker
    if (!worker || worker.killed) {
      this.resetWorker()
      return
    }

    try {
      await this.runCommand(CAPTURE_COMMAND_SHUTDOWN)
    } catch {
      // Ignore shutdown failures. The worker is about to be terminated anyway.
    }

    try {
      worker.kill()
    } catch {
      // ignore kill failures
    }
    this.failPending(new Error('Native capture helper was closed.'))
    this.resetWorker()
  }

  async ensureWorker() {
    if (this.worker && !this.worker.killed) {
      return this.worker
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = new Promise(async (resolve, reject) => {
      try {
        await access(NATIVE_CAPTURE_HELPER)
      } catch {
        reject(new Error(`Native capture helper is missing: ${NATIVE_CAPTURE_HELPER}`))
        return
      }

      const child = spawn(process.execPath, [NATIVE_CAPTURE_HELPER], {
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      let settled = false
      let stderr = ''

      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '')
      })

      child.on('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
        this.failPending(error)
        this.resetWorker()
      })

      child.on('exit', (code) => {
        const failure = new Error(stderr.trim() || `Native capture helper exited with code ${code ?? 1}`)
        if (!settled) {
          settled = true
          reject(failure)
        }
        this.failPending(failure)
        this.resetWorker()
      })

      const stdout = readline.createInterface({ input: child.stdout })
      stdout.on('line', (line) => {
        if (!settled) {
          settled = true
          this.worker = child
          this.workerStdout = stdout
          resolve(child)
        }
        void this.handleWorkerLine(line)
      })

      setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            child.kill()
          } catch {
            // ignore
          }
          reject(new Error('Timed out starting native capture helper.'))
        }
      }, 3000)
    }).finally(() => {
      this.startPromise = null
    })

    return this.startPromise
  }

  resetWorker() {
    this.worker = null
    if (this.workerStdout) {
      try {
        this.workerStdout.close()
      } catch {
        // ignore
      }
      this.workerStdout = null
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  async handleWorkerLine(line) {
    let message = null
    try {
      message = JSON.parse(String(line || '').trim())
    } catch {
      this.logger(`[dictray] Ignoring invalid native capture helper message: ${line}`)
      return
    }

    const kind = String(message?.kind || '').trim().toLowerCase()
    if (kind === CAPTURE_MESSAGE_KIND_RESPONSE) {
      const requestId = String(message?.id || '').trim()
      const pending = this.pending.get(requestId)
      if (!pending) {
        return
      }
      this.pending.delete(requestId)
      if (message?.ok) {
        pending.resolve(message?.payload || {})
      } else {
        pending.reject(new Error(String(message?.error || 'Native capture helper command failed.')))
      }
      return
    }

    if (kind === CAPTURE_MESSAGE_KIND_EVENT) {
      await this.onEvent(message)
      return
    }

    if (kind === CAPTURE_MESSAGE_KIND_REQUEST) {
      const response = await this.onRequest(message).catch((error) => createCaptureResponse(message?.id, {
        ok: false,
        error: errorMessage(error)
      }))
      this.writeMessage(response)
    }
  }

  async runCommand(type, payload = {}) {
    await this.ensureWorker()

    return new Promise((resolve, reject) => {
      const message = createCaptureCommand(type, payload)
      this.pending.set(message.id, {
        resolve,
        reject
      })

      try {
        this.writeMessage(message)
      } catch (error) {
        this.pending.delete(message.id)
        reject(error)
      }
    })
  }

  writeMessage(payload) {
    if (!this.worker || this.worker.killed || !this.worker.stdin) {
      throw new Error('Native capture helper is not running.')
    }
    this.worker.stdin.write(`${JSON.stringify(payload)}\n`)
  }
}

export function createCaptureBridge({ backendId, onEvent, onRequest, logger } = {}) {
  if (normalizeCaptureBackendId(backendId) !== CAPTURE_BACKEND_NATIVE) {
    logger?.('[dictray] Legacy capture backend is no longer available. Using native capture helper.')
  }
  return new NativeCaptureBridge({ onEvent, onRequest, logger })
}
