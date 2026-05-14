import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolveBundledHelperExecutable } from './runtime-paths.mjs'
import { LinuxUiAutomationBridge } from './linux-ui-automation.mjs'
import { MacosUiAutomationBridge } from './macos-ui-automation.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_AUTOMATION_REQUEST_TIMEOUT_MS = 15000
const UI_AUTOMATION_HELPER = String(process.env.DICTATION_TRAY_UI_AUTOMATION_HELPER || '').trim()
  || resolveBundledHelperExecutable('windows-ui-automation', 'WindowsUiAutomation.exe')
  || path.join(
    __dirname,
    '..',
    'scripts',
    'windows-ui-automation',
    'bin',
    'Release',
    'net10.0-windows',
    'WindowsUiAutomation.exe'
  )

function createAbortError(message = 'Operation was cancelled.') {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export class UiAutomationBridge {
  constructor() {
    this.helperAvailable = false
    this.warningShown = false
    this.worker = null
    this.workerStdout = null
    this.pending = new Map()
    this.nextRequestId = 0
    this.startPromise = null
    this._linuxBridge = process.platform === 'linux' ? new LinuxUiAutomationBridge() : null
    this._macosBridge = process.platform === 'darwin' ? new MacosUiAutomationBridge() : null
  }

  async checkHealth() {
    if (this._linuxBridge) {
      return this._linuxBridge.checkHealth()
    }
    if (this._macosBridge) {
      return this._macosBridge.checkHealth()
    }
    if (process.platform !== 'win32') {
      return {
        ok: false,
        enabled: false,
        reason: 'unsupported',
        backend: 'uia'
      }
    }

    if (!await this.ensureHelper()) {
      return {
        ok: false,
        enabled: true,
        reason: 'missing_helper',
        backend: 'uia',
        helperPath: UI_AUTOMATION_HELPER,
        error: `Missing Windows UI automation helper: ${UI_AUTOMATION_HELPER}`
      }
    }

    try {
      const result = await this.run('health')
      return {
        ...result,
        enabled: true,
        helperPath: UI_AUTOMATION_HELPER
      }
    } catch (error) {
      return {
        ok: false,
        enabled: true,
        backend: 'uia',
        helperPath: UI_AUTOMATION_HELPER,
        error: String(error?.message || error)
      }
    }
  }

  async listWindows(input = {}) {
    if (this._linuxBridge) {
      return this._linuxBridge.listWindows(input)
    }
    if (this._macosBridge) {
      return this._macosBridge.listWindows(input)
    }
    await this.requireHelper()
    return this.run('list-windows', input)
  }

  async snapshot(input = {}) {
    if (this._linuxBridge) {
      return this._linuxBridge.snapshot(input)
    }
    if (this._macosBridge) {
      return this._macosBridge.snapshot(input)
    }
    await this.requireHelper()
    return this.run('snapshot', input)
  }

  async action(input = {}, options = {}) {
    if (this._linuxBridge) {
      return this._linuxBridge.action(input, options)
    }
    if (this._macosBridge) {
      return this._macosBridge.action(input, options)
    }
    await this.requireHelper()
    return this.run('action', input, options)
  }

  async ensureHelper() {
    if (process.platform !== 'win32') {
      return false
    }

    if (this.helperAvailable) {
      return true
    }

    try {
      await access(UI_AUTOMATION_HELPER)
      this.helperAvailable = true
      return true
    } catch {
      if (!this.warningShown) {
        this.warningShown = true
        console.error(`[dictray] Missing Windows UI automation helper: ${UI_AUTOMATION_HELPER}`)
      }
      return false
    }
  }

  async requireHelper() {
    if (this._linuxBridge) {
      return
    }
    if (this._macosBridge) {
      return
    }
    if (process.platform !== 'win32') {
      throw new Error('Windows UI automation is only available on Windows.')
    }

    if (!await this.ensureHelper()) {
      throw new Error(`Windows UI automation helper is missing: ${UI_AUTOMATION_HELPER}`)
    }
  }

  run(command, payload = {}, options = {}) {
    return this.runPersistent(command, payload, options)
  }

  async ensureWorker() {
    if (this.worker && !this.worker.killed) {
      return this.worker
    }
    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = new Promise((resolve, reject) => {
      const child = spawn(UI_AUTOMATION_HELPER, ['serve'], {
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
        this.handleWorkerPipeError(error, child)
      })

      child.stdin.on('error', (error) => {
        if (!settled) {
          settled = true
          reject(error)
        }
        this.handleWorkerPipeError(error, child)
      })

      child.on('exit', (code) => {
        const error = new Error(stderr.trim() || `Windows UI automation helper exited with code ${code ?? 1}`)
        if (!settled) {
          settled = true
          reject(error)
        }
        this.failPending(error)
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
        this.handleWorkerLine(line)
      })

      setTimeout(() => {
        if (!settled) {
          settled = true
          try {
            child.kill()
          } catch {
            // ignore
          }
          reject(new Error('Timed out starting Windows UI automation helper.'))
        }
      }, 3000)

      child.stdin.write('{"id":"startup","command":"health"}\n', (error) => {
        if (!error) {
          return
        }
        if (!settled) {
          settled = true
          reject(error)
        }
        this.handleWorkerPipeError(error, child)
      })
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

  handleWorkerPipeError(error, worker = this.worker) {
    const failure = error instanceof Error
      ? error
      : new Error(String(error?.message || error || 'Windows UI automation helper pipe failed.'))
    if (worker && this.worker !== worker) {
      return
    }
    this.failPending(failure)
    this.resetWorker()
  }

  failPending(error) {
    for (const [id, pending] of Array.from(this.pending.entries())) {
      this.clearPending(id, pending)
      pending.reject(error)
    }
  }

  clearPending(id, pending = this.pending.get(id)) {
    this.pending.delete(id)
    if (!pending) {
      return
    }
    if (pending.timer) {
      clearTimeout(pending.timer)
    }
    if (pending.abortListener && pending.signal) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }
  }

  handleWorkerLine(line) {
    let response = null
    try {
      response = JSON.parse(String(line || '').trim())
    } catch {
      return
    }

    const id = String(response?.id || '').trim()
    if (!id || id === 'startup') {
      return
    }

    const pending = this.pending.get(id)
    if (!pending) {
      return
    }
    this.clearPending(id, pending)

    const payload = response?.payload || {}
    if (response?.ok === false || payload?.ok === false) {
      pending.reject(new Error(response?.error || payload?.error || 'Windows UI automation request failed.'))
      return
    }
    pending.resolve(payload)
  }

  async runPersistent(command, payload = {}, options = {}) {
    const signal = options?.signal || null
    const child = await this.ensureWorker()
    const id = `uia-${++this.nextRequestId}`
    const requestTimeoutMs = Number(options?.timeoutMs) > 0
      ? Number(options.timeoutMs)
      : UI_AUTOMATION_REQUEST_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      let abortListener = null
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : createAbortError())
          return
        }
        abortListener = () => {
          this.clearPending(id)
          reject(signal.reason instanceof Error ? signal.reason : createAbortError())
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }

      if (!child.stdin || child.stdin.destroyed || !child.stdin.writable) {
        reject(new Error('Windows UI automation helper pipe is not writable.'))
        return
      }

      const timer = setTimeout(() => {
        this.clearPending(id)
        reject(new Error(`Timed out waiting for Windows UI automation ${String(command || 'health')} response.`))
      }, requestTimeoutMs)

      this.pending.set(id, {
        resolve,
        reject,
        signal,
        abortListener,
        timer
      })

      try {
        child.stdin.write(`${JSON.stringify({
          id,
          command: String(command || 'health'),
          payload: payload && Object.keys(payload).length ? payload : undefined
        })}\n`, (error) => {
          if (error) {
            this.handleWorkerPipeError(error, child)
          }
        })
      } catch (error) {
        this.clearPending(id)
        reject(error)
      }
    })
  }
}
