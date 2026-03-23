import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { resolveBundledHelperExecutable } from './runtime-paths.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
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
  }

  async checkHealth() {
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
    await this.requireHelper()
    return this.run('list-windows', input)
  }

  async snapshot(input = {}) {
    await this.requireHelper()
    return this.run('snapshot', input)
  }

  async action(input = {}, options = {}) {
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
        this.failPending(error)
        this.resetWorker()
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

      child.stdin.write('{"id":"startup","command":"health"}\n')
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
    this.pending.delete(id)
    if (pending.abortListener && pending.signal) {
      pending.signal.removeEventListener('abort', pending.abortListener)
    }

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

    return new Promise((resolve, reject) => {
      let abortListener = null
      if (signal) {
        if (signal.aborted) {
          reject(signal.reason instanceof Error ? signal.reason : createAbortError())
          return
        }
        abortListener = () => {
          this.pending.delete(id)
          reject(signal.reason instanceof Error ? signal.reason : createAbortError())
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }

      this.pending.set(id, {
        resolve,
        reject,
        signal,
        abortListener
      })

      try {
        child.stdin.write(`${JSON.stringify({
          id,
          command: String(command || 'health'),
          payload: payload && Object.keys(payload).length ? payload : undefined
        })}\n`)
      } catch (error) {
        this.pending.delete(id)
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener)
        }
        reject(error)
      }
    })
  }
}
