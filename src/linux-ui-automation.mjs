import { execFile, spawn } from 'node:child_process'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const XDG_CONFIG_HOME = String(process.env.XDG_CONFIG_HOME || '').trim() || path.join(os.homedir(), '.config')
const GNOME_PANEL_DIR = path.join(XDG_CONFIG_HOME, 'dictray', 'gnome-panel')
const GNOME_PANEL_INPUT_PATH = path.join(GNOME_PANEL_DIR, 'input.json')
const GNOME_PANEL_FOCUSED_WINDOW_PATH = path.join(GNOME_PANEL_DIR, 'focused-window.json')

function detectSessionType() {
  const sessionType = String(process.env.XDG_SESSION_TYPE || '').toLowerCase()
  if (sessionType === 'x11') return 'x11'
  if (process.env.WAYLAND_DISPLAY) return 'wayland'
  if (sessionType === 'wayland') return 'wayland'
  return 'x11'
}

function isGnomeSession() {
  const currentDesktop = String(process.env.XDG_CURRENT_DESKTOP || '').toLowerCase()
  const sessionDesktop = String(process.env.DESKTOP_SESSION || '').toLowerCase()
  return currentDesktop.includes('gnome')
    || sessionDesktop.includes('gnome')
    || currentDesktop.includes('ubuntu')
    || currentDesktop.includes('pop')
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tryExec(cmd, args, timeoutMs = 5000) {
  try {
    const result = await execFileAsync(cmd, args, { timeout: timeoutMs })
    return { ok: true, stdout: result.stdout }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

function formatCommandFailure(result) {
  return result?.error || 'unknown error'
}

async function spawnClipboardProvider(cmd, args, options, text = null) {
  const child = spawn(cmd, args, options)

  if (child.stdin) {
    child.stdin.on('error', () => {})
  }

  const started = new Promise((resolve, reject) => {
    let settled = false
    let startupTimer = null
    const settle = (callback, value) => {
      if (settled) {
        return
      }
      settled = true
      if (startupTimer) {
        clearTimeout(startupTimer)
        startupTimer = null
      }
      callback(value)
    }

    child.once('spawn', () => {
      startupTimer = setTimeout(() => {
        settle(resolve)
      }, 120)
    })
    child.once('error', (error) => {
      settle(reject, new Error(`Failed to start ${cmd}: ${error?.message || error}`))
    })
    child.once('exit', (code, signal) => {
      if (settled) {
        return
      }
      if (code === 0) {
        settle(resolve)
        return
      }
      const reason = code === null ? `signal ${signal}` : `code ${code}`
      settle(reject, new Error(`${cmd} exited during startup with ${reason}`))
    })
  })

  if (child.stdin && text !== null) {
    child.stdin.end(text)
  }

  await started
  child.unref()
}

async function trySpawnClipboardProvider(cmd, args, options, text = null) {
  try {
    await spawnClipboardProvider(cmd, args, options, text)
    return { ok: true }
  } catch (error) {
    return { ok: false, error: String(error?.message || error) }
  }
}

async function copyTextToWaylandClipboard(text) {
  const providers = [
    { cmd: 'wl-copy', args: [] },
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] }
  ]
  const failures = []

  for (const provider of providers) {
    const result = await trySpawnClipboardProvider(provider.cmd, provider.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true
    }, text)
    if (result.ok) {
      return
    }
    failures.push(`${provider.cmd}: ${formatCommandFailure(result)}`)
  }

  throw new Error([
    'Failed to start a Wayland clipboard provider:',
    ...failures
  ].join(' '))
}

async function copyTextToX11Clipboard(text) {
  const providers = [
    { cmd: 'xclip', args: ['-selection', 'clipboard'] },
    { cmd: 'xsel', args: ['--clipboard', '--input'] }
  ]
  const failures = []

  for (const provider of providers) {
    const result = await trySpawnClipboardProvider(provider.cmd, provider.args, {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true
    }, text)
    if (result.ok) {
      return
    }
    failures.push(`${provider.cmd}: ${formatCommandFailure(result)}`)
  }

  throw new Error([
    'Failed to start an X11 clipboard provider:',
    ...failures
  ].join(' '))
}

async function sendGnomeExtensionCommand(action) {
  const command = { action, requestedAt: Date.now() }
  try {
    await writeFile(GNOME_PANEL_INPUT_PATH, JSON.stringify(command), 'utf8')
  } catch {
    return false
  }
  // Give the extension time to poll and process the command (polls every 150ms)
  await delay(300)
  try {
    const pending = JSON.parse(await readFile(GNOME_PANEL_INPUT_PATH, 'utf8'))
    if (pending?.action === command.action && pending?.requestedAt === command.requestedAt) {
      await unlink(GNOME_PANEL_INPUT_PATH).catch(() => {})
      return false
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return true
    }
    return false
  }
  return true
}

async function pasteX11(windowId = null) {
  if (windowId) {
    const result = await tryExec('xdotool', ['key', '--window', windowId, '--clearmodifiers', 'ctrl+v'])
    if (result.ok) return
  }
  await execFileAsync('xdotool', ['key', '--clearmodifiers', 'ctrl+v'], { timeout: 5000 })
}

async function pasteWayland() {
  // On GNOME Wayland, delegate to the shell extension which uses Clutter
  // virtual keyboard — the only reliable way to send keystrokes to native
  // Wayland windows on GNOME.
  if (isGnomeSession()) {
    const gnomeResult = await sendGnomeExtensionCommand('send_ctrl_v')
    if (gnomeResult) {
      return
    }
  }

  // ydotool uses kernel uinput and works with any compositor
  // KEY_LEFTCTRL=29, KEY_V=47
  const ydotoolResult = await tryExec('ydotool', ['key', '29:1', '47:1', '47:0', '29:0'])
  if (ydotoolResult.ok) return

  // wtype works for wlroots-based compositors (Sway, Hyprland, etc.)
  const wtypeResult = await tryExec('wtype', ['-M', 'ctrl', 'v', '-m', 'ctrl'])
  if (wtypeResult.ok) return

  // xdotool works for XWayland apps when running in a mixed session
  const xdotoolResult = await tryExec('xdotool', ['key', '--clearmodifiers', 'ctrl+v'])
  if (xdotoolResult.ok) return

  throw new Error([
    'Failed to paste on Wayland with available backends:',
    `ydotool: ${formatCommandFailure(ydotoolResult)}`,
    `wtype: ${formatCommandFailure(wtypeResult)}`,
    `xdotool: ${formatCommandFailure(xdotoolResult)}`
  ].join(' '))
}

async function returnX11(windowId = null) {
  if (windowId) {
    const result = await tryExec('xdotool', ['key', '--window', windowId, '--clearmodifiers', 'Return'])
    if (result.ok) return
  }
  await execFileAsync('xdotool', ['key', '--clearmodifiers', 'Return'], { timeout: 5000 })
}

async function returnWayland() {
  if (isGnomeSession()) {
    const gnomeResult = await sendGnomeExtensionCommand('send_return')
    if (gnomeResult) {
      return
    }
  }

  // KEY_ENTER=28
  const ydotoolResult = await tryExec('ydotool', ['key', '28:1', '28:0'])
  if (ydotoolResult.ok) return

  const wtypeResult = await tryExec('wtype', ['-k', 'return'])
  if (wtypeResult.ok) return

  const xdotoolResult = await tryExec('xdotool', ['key', '--clearmodifiers', 'Return'])
  if (xdotoolResult.ok) return

  throw new Error([
    'Failed to send Return on Wayland with available backends:',
    `ydotool: ${formatCommandFailure(ydotoolResult)}`,
    `wtype: ${formatCommandFailure(wtypeResult)}`,
    `xdotool: ${formatCommandFailure(xdotoolResult)}`
  ].join(' '))
}

export class LinuxUiAutomationBridge {
  constructor() {
    this._sessionType = null
  }

  get sessionType() {
    if (!this._sessionType) {
      this._sessionType = detectSessionType()
    }
    return this._sessionType
  }

  async checkHealth() {
    return {
      ok: true,
      enabled: true,
      backend: 'linux',
      sessionType: this.sessionType
    }
  }

  async listWindows(input = {}) {
    if (this.sessionType !== 'x11') {
      return { windows: await this._listWindowsWayland() }
    }

    const idResult = await tryExec('xdotool', ['getactivewindow'])
    if (!idResult.ok) {
      return { windows: [] }
    }

    const windowId = idResult.stdout.trim()
    if (!windowId) {
      return { windows: [] }
    }

    let title = ''
    const nameResult = await tryExec('xdotool', ['getwindowname', windowId])
    if (nameResult.ok) {
      title = nameResult.stdout.trim()
    }

    let bounds = null
    const geomResult = await tryExec('xdotool', ['getwindowgeometry', '--shell', windowId])
    if (geomResult.ok) {
      const vars = {}
      for (const line of geomResult.stdout.split('\n')) {
        const match = line.match(/^(\w+)=(\d+)$/)
        if (match) vars[match[1]] = Number(match[2])
      }
      if (Number.isFinite(vars.X) && Number.isFinite(vars.Y)
        && Number.isFinite(vars.WIDTH) && Number.isFinite(vars.HEIGHT)
        && vars.WIDTH > 0 && vars.HEIGHT > 0) {
        bounds = { left: vars.X, top: vars.Y, width: vars.WIDTH, height: vars.HEIGHT }
      }
    }

    return {
      windows: [{
        focused: true,
        linuxWindowId: windowId,
        title,
        hwnd: null,
        processName: '',
        bounds
      }]
    }
  }

  async _listWindowsWayland() {
    if (!isGnomeSession()) {
      return []
    }

    try {
      const raw = await readFile(GNOME_PANEL_FOCUSED_WINDOW_PATH, 'utf8')
      const data = JSON.parse(raw)
      if (!data || typeof data !== 'object') return []

      const left = Number(data.left)
      const top = Number(data.top)
      const width = Number(data.width)
      const height = Number(data.height)
      if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
        return []
      }

      // Ignore stale data (older than 2 seconds)
      if (data.updatedAt && (Date.now() - data.updatedAt) > 2000) {
        return []
      }

      return [{
        focused: true,
        linuxWindowId: null,
        title: String(data.title || ''),
        hwnd: null,
        processName: '',
        bounds: { left, top, width, height }
      }]
    } catch {
      return []
    }
  }

  async snapshot(input = {}) {
    return { target: null }
  }

  async action(input = {}, options = {}) {
    const action = String(input?.action || '')
    const windowId = input?.window?.linuxWindowId || null

    if (action === 'paste_text') {
      const text = String(input?.text || '')

      // Brief delay to let any transient focus changes from the hotkey settle
      await delay(80)

      if (this.sessionType === 'wayland') {
        // Clipboard handoff on Wayland needs an active provider process
        // serial (causes "No serial found for selection"). Use wl-copy instead.
        // Provider processes must stay alive to serve clipboard content, so spawn
        // them detached. They exit automatically when another app takes the clipboard.
        await copyTextToWaylandClipboard(text)
        await delay(50)
        await pasteWayland()
      } else {
        // Clipboard providers stay alive to serve clipboard content, so spawn
        // them detached. They exit automatically when another app takes the clipboard.
        await copyTextToX11Clipboard(text)
        await delay(50)
        await pasteX11(windowId)
      }

      return {
        ok: true,
        window: null,
        timings: { action: { clipboardRestoreSuccess: true } }
      }
    }

    if (action === 'send_keys') {
      const text = String(input?.text || '')
      if (text === '{ENTER}') {
        if (this.sessionType === 'wayland') {
          await returnWayland()
        } else {
          await returnX11(windowId)
        }
      }
      return { ok: true }
    }

    return { ok: true }
  }
}
