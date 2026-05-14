import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveBundledHelperExecutable } from './runtime-paths.mjs'
import { LinuxSystemVolumeBridge } from './linux-system-volume.mjs'
import { MacosSystemVolumeBridge } from './macos-system-volume.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SYSTEM_VOLUME_HELPER = String(process.env.DICTATION_TRAY_VOLUME_HELPER || '').trim()
  || resolveBundledHelperExecutable('windows-system-volume', 'WindowsSystemVolume.exe')
  || path.join(
    __dirname,
    '..',
    'scripts',
    'windows-system-volume',
    'bin',
    'Release',
    'net10.0-windows',
    'WindowsSystemVolume.exe'
  )

export class SystemVolumeBridge {
  constructor() {
    this.helperAvailable = false
    this.warningShown = false
    this._linuxBridge = process.platform === 'linux' ? new LinuxSystemVolumeBridge() : null
    this._macosBridge = process.platform === 'darwin' ? new MacosSystemVolumeBridge() : null
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
        backend: 'core-audio'
      }
    }

    if (!await this.ensureHelper()) {
      return {
        ok: false,
        enabled: true,
        reason: 'missing_helper',
        backend: 'core-audio',
        helperPath: SYSTEM_VOLUME_HELPER,
        error: `Missing Windows system volume helper: ${SYSTEM_VOLUME_HELPER}`
      }
    }

    try {
      const result = await this.run('health')
      return {
        ...result,
        enabled: true,
        helperPath: SYSTEM_VOLUME_HELPER
      }
    } catch (error) {
      return {
        ok: false,
        enabled: true,
        backend: 'core-audio',
        helperPath: SYSTEM_VOLUME_HELPER,
        error: String(error?.message || error)
      }
    }
  }

  async getState() {
    if (this._linuxBridge) {
      return this._linuxBridge.getState()
    }
    if (this._macosBridge) {
      return this._macosBridge.getState()
    }
    await this.requireHelper()
    return this.run('state')
  }

  async setState(input = {}) {
    if (this._linuxBridge) {
      return this._linuxBridge.setState(input)
    }
    if (this._macosBridge) {
      return this._macosBridge.setState(input)
    }
    await this.requireHelper()
    return this.run('set', input)
  }

  async ensureHelper() {
    if (process.platform !== 'win32') {
      return false
    }

    if (this.helperAvailable) {
      return true
    }

    try {
      await access(SYSTEM_VOLUME_HELPER)
      this.helperAvailable = true
      return true
    } catch {
      if (!this.warningShown) {
        this.warningShown = true
        console.error(`[dictray] Missing Windows system volume helper: ${SYSTEM_VOLUME_HELPER}`)
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
      throw new Error('Windows system volume control is only available on Windows.')
    }

    if (!await this.ensureHelper()) {
      throw new Error(`Windows system volume helper is missing: ${SYSTEM_VOLUME_HELPER}`)
    }
  }

  run(command, payload = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(SYSTEM_VOLUME_HELPER, [
        String(command || 'health')
      ], {
        stdio: ['pipe', 'pipe', 'pipe'],
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
      child.stdin.on('error', reject)
      child.on('exit', (code) => {
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
          || `Windows system volume helper exited with code ${code ?? 1}`
        ))
      })

      if (payload && Object.keys(payload).length) {
        child.stdin.end(JSON.stringify(payload))
        return
      }

      child.stdin.end()
    })
  }
}
