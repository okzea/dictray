import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function tryExec(cmd, args) {
  try {
    const result = await execFileAsync(cmd, args, { timeout: 5000 })
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

// wpctl get-volume @DEFAULT_AUDIO_SINK@
// Output: "Volume: 0.75" or "Volume: 0.75 [MUTED]"
function parseWpctlVolume(stdout) {
  const match = String(stdout || '').match(/Volume:\s*([\d.]+)(\s*\[MUTED\])?/)
  if (!match) return null
  return {
    level: parseFloat(match[1]),
    muted: Boolean(match[2] && match[2].trim())
  }
}

// pactl get-sink-volume @DEFAULT_SINK@
// Output: "Volume: front-left: 49152 /  75% / -8.00 dB, ..."
function parsePactlPercent(stdout) {
  const match = String(stdout || '').match(/\/\s*(\d+)%/)
  if (!match) return null
  return parseInt(match[1], 10) / 100
}

export class LinuxSystemVolumeBridge {
  constructor() {
    this._backend = null
  }

  async detectBackend() {
    if (this._backend) return this._backend

    const wpctlResult = await tryExec('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'])
    if (wpctlResult.ok && parseWpctlVolume(wpctlResult.stdout) !== null) {
      this._backend = 'wpctl'
      return 'wpctl'
    }

    const pactlResult = await tryExec('pactl', ['get-sink-volume', '@DEFAULT_SINK@'])
    if (pactlResult.ok) {
      this._backend = 'pactl'
      return 'pactl'
    }

    this._backend = 'none'
    return 'none'
  }

  async checkHealth() {
    const backend = await this.detectBackend()
    return {
      ok: backend !== 'none',
      enabled: backend !== 'none',
      backend: backend === 'none' ? 'linux-audio' : backend
    }
  }

  async getState() {
    const backend = await this.detectBackend()

    if (backend === 'wpctl') {
      const result = await execFileAsync('wpctl', ['get-volume', '@DEFAULT_AUDIO_SINK@'], { timeout: 5000 })
      const state = parseWpctlVolume(result.stdout)
      if (!state) throw new Error('Failed to parse wpctl volume output')
      return state
    }

    if (backend === 'pactl') {
      const volResult = await execFileAsync('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeout: 5000 })
      const level = parsePactlPercent(volResult.stdout)
      if (level === null) throw new Error('Failed to parse pactl volume output')

      const muteResult = await tryExec('pactl', ['get-sink-mute', '@DEFAULT_SINK@'])
      const muted = muteResult.ok && /:\s*yes\b/i.test(muteResult.stdout)

      return { level, muted }
    }

    throw new Error('No supported Linux audio backend found (tried wpctl, pactl)')
  }

  async setState({ level, muted }) {
    const backend = await this.detectBackend()

    if (backend === 'wpctl') {
      const levelStr = String(Math.round(level * 100) / 100)
      await execFileAsync('wpctl', ['set-volume', '@DEFAULT_AUDIO_SINK@', levelStr], { timeout: 5000 })
      await execFileAsync('wpctl', ['set-mute', '@DEFAULT_AUDIO_SINK@', muted ? '1' : '0'], { timeout: 5000 })
      return
    }

    if (backend === 'pactl') {
      const pct = `${Math.round(level * 100)}%`
      await execFileAsync('pactl', ['set-sink-volume', '@DEFAULT_SINK@', pct], { timeout: 5000 })
      await execFileAsync('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0'], { timeout: 5000 })
      return
    }

    throw new Error('No supported Linux audio backend found (tried wpctl, pactl)')
  }
}
