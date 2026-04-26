import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function runAppleScript(lines, timeoutMs = 5000) {
  const args = []
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    args.push('-e', String(line || ''))
  }
  const result = await execFileAsync('osascript', args, { timeout: timeoutMs })
  return String(result.stdout || '').trim()
}

function clampUnitInterval(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) {
    return 0
  }
  return Math.max(0, Math.min(1, numeric))
}

function parseBoolean(value) {
  return /^(true|yes|1)$/i.test(String(value || '').trim())
}

export class MacosSystemVolumeBridge {
  async checkHealth() {
    try {
      await this.getState()
      return {
        ok: true,
        enabled: true,
        backend: 'macos-core-audio'
      }
    } catch (error) {
      return {
        ok: false,
        enabled: false,
        backend: 'macos-core-audio',
        error: String(error?.message || error)
      }
    }
  }

  async getState() {
    const stdout = await runAppleScript([
      'set volumeSettings to get volume settings',
      'return (output volume of volumeSettings as text) & linefeed & (output muted of volumeSettings as text)'
    ])
    const [volumeLine = '0', mutedLine = 'false'] = stdout.split(/\r?\n/)
    return {
      level: clampUnitInterval((Number(volumeLine) || 0) / 100),
      muted: parseBoolean(mutedLine)
    }
  }

  async setState({ level, muted }) {
    const percent = Math.round(clampUnitInterval(level) * 100)
    await runAppleScript([
      `set volume output volume ${percent}`,
      muted ? 'set volume with output muted' : 'set volume without output muted'
    ])
  }
}
