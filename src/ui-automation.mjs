import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UI_AUTOMATION_HELPER = String(process.env.DICTATION_TRAY_UI_AUTOMATION_HELPER || '').trim() || path.join(
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
    return new Promise((resolve, reject) => {
      const signal = options?.signal || null
      const child = spawn(UI_AUTOMATION_HELPER, [
        String(command || 'health')
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      let stdout = ''
      let stderr = ''
      let settled = false
      let abortListener = null
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk || '')
      })
      child.stderr.on('data', (chunk) => {
        stderr += String(chunk || '')
      })
      child.on('error', (error) => {
        settled = true
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener)
        }
        reject(error)
      })
      child.on('exit', (code) => {
        settled = true
        if (abortListener && signal) {
          signal.removeEventListener('abort', abortListener)
        }
        let parsed = null
        if (stdout.trim()) {
          try {
            parsed = JSON.parse(stdout)
          } catch {
            parsed = null
          }
        }

        if (code === 0) {
          resolve(parsed || { ok: true })
          return
        }

        reject(new Error(
          parsed?.error
          || stderr.trim()
          || `Windows UI automation helper exited with code ${code ?? 1}`
        ))
      })

      if (signal) {
        if (signal.aborted) {
          try {
            child.kill()
          } catch {
            // ignore
          }
          reject(signal.reason instanceof Error ? signal.reason : createAbortError())
          return
        }

        abortListener = () => {
          if (settled) {
            return
          }
          settled = true
          try {
            child.kill()
          } catch {
            // ignore
          }
          reject(signal.reason instanceof Error ? signal.reason : createAbortError())
        }
        signal.addEventListener('abort', abortListener, { once: true })
      }

      if (payload && Object.keys(payload).length) {
        child.stdin.end(JSON.stringify(payload))
        return
      }

      child.stdin.end()
    })
  }
}
