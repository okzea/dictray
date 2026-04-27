import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectRoot } from './runtime-paths.mjs'

function xdgConfigHome() {
  return String(process.env.XDG_CONFIG_HOME || '').trim() || path.join(os.homedir(), '.config')
}

function xdgDataHome() {
  return String(process.env.XDG_DATA_HOME || '').trim() || path.join(os.homedir(), '.local', 'share')
}

function linuxHeadlessLockPath() {
  return path.join(xdgConfigHome(), 'dictray', 'linux-headless.lock')
}

function macosAppSupportHome() {
  return path.join(os.homedir(), 'Library', 'Application Support')
}

function macosConfigHome() {
  return path.join(macosAppSupportHome(), 'DicTray')
}

function macosHeadlessLockPath() {
  return path.join(macosConfigHome(), 'dictray.lock')
}

function normalizeBooleanEnv(name) {
  return /^(1|true|yes)$/i.test(String(process.env[name] || '').trim())
}

function readPackageVersion() {
  try {
    const payload = JSON.parse(readFileSync(path.join(projectRoot(), 'package.json'), 'utf8'))
    return String(payload?.version || '0.1.0').trim() || '0.1.0'
  } catch {
    return '0.1.0'
  }
}

function isWaylandSession() {
  return Boolean(process.env.WAYLAND_DISPLAY) || String(process.env.XDG_SESSION_TYPE || '').trim().toLowerCase() === 'wayland'
}

function spawnDetached(command, args = [], options = {}) {
  const child = spawn(command, args, {
    detached: true,
    stdio: options.stdio || 'ignore',
    env: options.env || process.env,
    windowsHide: true
  })
  child.once('error', () => {})
  child.unref()
  return child
}

function shellQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`
}

function commandAvailable(command) {
  return readProcessOutput('sh', [
    '-lc',
    `command -v ${shellQuote(command)} >/dev/null 2>&1 && printf yes`
  ]) === 'yes'
}

function ignoreSpawnAndStdinErrors(child) {
  child.once('error', () => {})
  if (child.stdin) {
    child.stdin.on('error', () => {})
  }
  return child
}

function writePidLock(lockPath) {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, `${process.pid}\n`, { encoding: 'utf8', flag: 'wx' })
    return true
  } catch {
    return false
  }
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readLockedPid() {
  const lockPath = linuxHeadlessLockPath()
  if (!existsSync(lockPath)) {
    return 0
  }
  try {
    return Number.parseInt(String(readFileSync(lockPath, 'utf8') || '').trim(), 10) || 0
  } catch {
    return 0
  }
}

function readLinuxProcessCommand(pid) {
  try {
    return String(readFileSync(`/proc/${pid}/cmdline`, 'utf8') || '')
      .split('\0')
      .map((part) => part.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

function isLinuxHeadlessLockOwner(pid) {
  if (pid === process.pid) {
    return true
  }
  if (process.platform !== 'linux') {
    return false
  }

  const command = readLinuxProcessCommand(pid)
  if (!command.length) {
    return false
  }

  const executableName = path.basename(command[0]).toLowerCase()
  if (executableName.includes('dictray')) {
    return true
  }

  return command.some((part) => {
    const normalized = String(part || '').replace(/\\/g, '/')
    return normalized === 'tray/main.mjs' || normalized.endsWith('/tray/main.mjs')
  })
}

function readProcessOutput(command, args = []) {
  try {
    const result = spawnSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true
    })
    return result.status === 0 ? String(result.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

function commandLineReferencesDictrayMain(value) {
  const normalized = String(value || '').replace(/\\/g, '/')
  return normalized.includes('tray/main.mjs')
}

function isMacosHeadlessLockOwner(pid) {
  if (pid === process.pid) {
    return true
  }
  if (process.platform !== 'darwin') {
    return false
  }

  const command = readProcessOutput('ps', ['-p', String(pid), '-o', 'comm='])
  if (path.basename(command).toLowerCase().includes('dictray')) {
    return true
  }

  const args = readProcessOutput('ps', ['-p', String(pid), '-o', 'args='])
  if (!args) {
    return false
  }
  return commandLineReferencesDictrayMain(args)
}

function notifyExistingHeadlessInstance(pid) {
  try {
    process.kill(pid, 'SIGUSR1')
  } catch {
    // ignore notification failures; the caller still rejects the second instance
  }
}

function acquireLinuxHeadlessLock({ requestExit = false } = {}) {
  const lockPath = linuxHeadlessLockPath()
  const existingPid = readLockedPid()
  const existingPidRunning = isPidRunning(existingPid)
  const existingLockOwner = existingPidRunning && isLinuxHeadlessLockOwner(existingPid)

  if (requestExit) {
    if (existingLockOwner) {
      try {
        process.kill(existingPid, 'SIGTERM')
      } catch {
        // ignore
      }
    }
    return false
  }

  if (existingLockOwner) {
    notifyExistingHeadlessInstance(existingPid)
    return false
  }

  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  } catch {
    // ignore stale lock cleanup failures
  }

  return writePidLock(lockPath)
}

function releaseLinuxHeadlessLock() {
  const lockPath = linuxHeadlessLockPath()
  const existingPid = readLockedPid()
  if (existingPid !== process.pid) {
    return
  }
  try {
    unlinkSync(lockPath)
  } catch {
    // ignore
  }
}

function readLockPid(lockPath) {
  if (!existsSync(lockPath)) {
    return 0
  }
  try {
    return Number.parseInt(String(readFileSync(lockPath, 'utf8') || '').trim(), 10) || 0
  } catch {
    return 0
  }
}

function acquirePidLock(lockPath, { requestExit = false, isLockOwner = () => false } = {}) {
  const existingPid = readLockPid(lockPath)
  const existingPidRunning = isPidRunning(existingPid)
  const existingLockOwner = existingPidRunning && isLockOwner(existingPid)

  if (requestExit) {
    if (existingLockOwner) {
      try {
        process.kill(existingPid, 'SIGTERM')
      } catch {
        // ignore
      }
    }
    return false
  }

  if (existingLockOwner) {
    notifyExistingHeadlessInstance(existingPid)
    return false
  }

  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  } catch {
    // ignore stale lock cleanup failures
  }

  return writePidLock(lockPath)
}

function releasePidLock(lockPath) {
  const existingPid = readLockPid(lockPath)
  if (existingPid !== process.pid) {
    return
  }
  try {
    unlinkSync(lockPath)
  } catch {
    // ignore
  }
}

function copyTextToLinuxClipboard(text) {
  const value = String(text || '')
  if (!value) {
    return
  }

  if (isWaylandSession()) {
    try {
      if (!commandAvailable('wl-copy')) {
        throw new Error('wl-copy is not available.')
      }
      const wlCopy = ignoreSpawnAndStdinErrors(spawn('wl-copy', [], {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true
      }))
      wlCopy.stdin.end(value)
      wlCopy.unref()
      return
    } catch {
      // ignore and fall through
    }
  }

  try {
    if (!commandAvailable('xclip')) {
      throw new Error('xclip is not available.')
    }
    const xclip = ignoreSpawnAndStdinErrors(spawn('xclip', ['-selection', 'clipboard'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    }))
    xclip.stdin.end(value)
    xclip.unref()
    return
  } catch {
    // ignore and fall through
  }

  try {
    const xsel = ignoreSpawnAndStdinErrors(spawn('xsel', ['--clipboard', '--input'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    }))
    xsel.stdin.end(value)
    xsel.unref()
  } catch {
    // ignore final clipboard fallback failure
  }
}

function copyTextToMacosClipboard(text) {
  const value = String(text || '')
  if (!value) {
    return
  }

  try {
    const child = ignoreSpawnAndStdinErrors(spawn('pbcopy', [], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    }))
    child.stdin.end(value)
    child.unref()
  } catch {
    // ignore clipboard fallback failure
  }
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

class HeadlessNotification {
  constructor({ title = '', body = '' } = {}) {
    this.title = String(title || '').trim() || 'DicTray'
    this.body = String(body || '').trim()
  }

  static isSupported() {
    return true
  }

  show() {
    try {
      spawnDetached('notify-send', [this.title, this.body || ''])
    } catch {
      // ignore notification failures
    }
  }
}

class MacosNotification {
  constructor({ title = '', body = '' } = {}) {
    this.title = String(title || '').trim() || 'DicTray'
    this.body = String(body || '').trim()
  }

  static isSupported() {
    return true
  }

  show() {
    try {
      spawnDetached('osascript', [
        '-e',
        `display notification ${appleScriptString(this.body || '')} with title ${appleScriptString(this.title)}`
      ])
    } catch {
      // ignore notification failures
    }
  }
}

class HeadlessTray extends EventEmitter {
  constructor() {
    super()
  }

  setImage() {}
  setContextMenu() {}
  setToolTip() {}
}

function linuxShortcutExpression(accelerator) {
  const parts = String(accelerator || '')
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
  if (parts.length < 2) {
    return ''
  }

  return parts.map((part) => {
    const normalized = part.toLowerCase()
    if (normalized === 'commandorcontrol'
      || normalized === 'command'
      || normalized === 'control'
      || normalized === 'ctrl') {
      return 'Control'
    }
    if (normalized === 'alt' || normalized === 'option') {
      return 'Alt'
    }
    if (normalized === 'shift') {
      return 'Shift'
    }
    if (normalized === 'space') {
      return 'space'
    }
    return part.length === 1 ? part.toLowerCase() : part
  }).join(' + ')
}

class HeadlessGlobalShortcut {
  constructor() {
    this._registrations = new Map()
    this._pollTimer = null
    this._bindingProcess = null
    this._stopping = false
    this._commandPath = path.join(xdgConfigHome(), 'dictray', `headless-shortcut-${process.pid}.command`)
    this._configPath = path.join(xdgConfigHome(), 'dictray', `headless-shortcut-${process.pid}.xbindkeysrc`)
  }

  register(accelerator, callback) {
    if (process.platform !== 'linux' || !commandAvailable('xbindkeys')) {
      return false
    }
    const shortcut = linuxShortcutExpression(accelerator)
    if (!shortcut) {
      return false
    }

    this._registrations.set(String(accelerator || ''), {
      shortcut,
      callback
    })
    return this._restart()
  }

  unregisterAll() {
    this._registrations.clear()
    this._stop()
  }

  _restart() {
    this._stop()
    if (!this._registrations.size) {
      return true
    }

    try {
      mkdirSync(path.dirname(this._commandPath), { recursive: true })
      const config = [...this._registrations.entries()].map(([accelerator, registration]) => [
        `"printf '%s\\n' ${shellQuote(accelerator)} > ${shellQuote(this._commandPath)}"`,
        `  ${registration.shortcut}`
      ].join('\n')).join('\n\n')
      writeFileSync(this._configPath, `${config}\n`, 'utf8')
    } catch {
      return false
    }

    try {
      this._stopping = false
      this._bindingProcess = spawn('xbindkeys', ['-n', '-f', this._configPath], {
        stdio: 'ignore',
        windowsHide: true
      })
      this._bindingProcess.once('error', () => {
        this._stop()
      })
      this._bindingProcess.once('exit', () => {
        if (!this._stopping) {
          this._bindingProcess = null
        }
      })
      this._startPolling()
      return true
    } catch {
      this._stop()
      return false
    }
  }

  _startPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
    }
    this._pollTimer = setInterval(() => {
      let accelerator = ''
      try {
        accelerator = String(readFileSync(this._commandPath, 'utf8') || '').trim()
        unlinkSync(this._commandPath)
      } catch {
        return
      }
      const callback = this._registrations.get(accelerator)?.callback
      if (callback) {
        callback()
      }
    }, 100)
    this._pollTimer.unref?.()
  }

  _stop() {
    this._stopping = true
    if (this._pollTimer) {
      clearInterval(this._pollTimer)
      this._pollTimer = null
    }
    if (this._bindingProcess && !this._bindingProcess.killed) {
      this._bindingProcess.kill()
    }
    this._bindingProcess = null
    try {
      unlinkSync(this._commandPath)
    } catch {
      // ignore missing command file
    }
    try {
      unlinkSync(this._configPath)
    } catch {
      // ignore missing config file
    }
  }
}

function emptyImage() {
  return {
    isEmpty() {
      return false
    },
    resize() {
      return this
    }
  }
}

function createHeadlessApp() {
  const emitter = new EventEmitter()
  let exitRequested = false

  const app = {
    isPackaged: normalizeBooleanEnv('DICTATION_TRAY_PACKAGED'),
    commandLine: {
      appendSwitch() {}
    },
    setAppUserModelId() {},
    requestSingleInstanceLock() {
      return acquireLinuxHeadlessLock({
        requestExit: process.argv.includes('--dictray-exit-existing')
      })
    },
    whenReady() {
      return Promise.resolve()
    },
    on(eventName, listener) {
      emitter.on(eventName, listener)
      return app
    },
    once(eventName, listener) {
      emitter.once(eventName, listener)
      return app
    },
    emit(eventName, ...args) {
      return emitter.emit(eventName, ...args)
    },
    quit() {
      if (exitRequested) {
        return
      }
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      }
      emitter.emit('before-quit', event)
      if (event.defaultPrevented) {
        return
      }
      exitRequested = true
      releaseLinuxHeadlessLock()
      setImmediate(() => {
        process.exit(0)
      })
    },
    getPath(name) {
      if (name === 'userData') {
        return path.join(xdgConfigHome(), 'DicTray')
      }
      return xdgDataHome()
    },
    getVersion() {
      return readPackageVersion()
    }
  }

  process.on('exit', () => {
    releaseLinuxHeadlessLock()
  })
  process.on('SIGTERM', () => {
    app.quit()
  })
  process.on('SIGINT', () => {
    app.quit()
  })
  process.on('SIGUSR1', () => {
    app.emit('second-instance', null, [])
  })

  return app
}

function createMacosHeadlessApp() {
  const emitter = new EventEmitter()
  const lockPath = macosHeadlessLockPath()
  let exitRequested = false

  const app = {
    isPackaged: normalizeBooleanEnv('DICTATION_TRAY_PACKAGED'),
    commandLine: {
      appendSwitch() {}
    },
    setAppUserModelId() {},
    requestSingleInstanceLock() {
      return acquirePidLock(lockPath, {
        requestExit: process.argv.includes('--dictray-exit-existing'),
        isLockOwner: isMacosHeadlessLockOwner
      })
    },
    whenReady() {
      return Promise.resolve()
    },
    on(eventName, listener) {
      emitter.on(eventName, listener)
      return app
    },
    once(eventName, listener) {
      emitter.once(eventName, listener)
      return app
    },
    emit(eventName, ...args) {
      return emitter.emit(eventName, ...args)
    },
    quit() {
      if (exitRequested) {
        return
      }
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        }
      }
      emitter.emit('before-quit', event)
      if (event.defaultPrevented) {
        return
      }
      exitRequested = true
      releasePidLock(lockPath)
      setImmediate(() => {
        process.exit(0)
      })
    },
    getPath(name) {
      if (name === 'userData') {
        return macosConfigHome()
      }
      return macosAppSupportHome()
    },
    getVersion() {
      return readPackageVersion()
    }
  }

  process.on('exit', () => {
    releasePidLock(lockPath)
  })
  process.on('SIGTERM', () => {
    app.quit()
  })
  process.on('SIGINT', () => {
    app.quit()
  })
  process.on('SIGUSR1', () => {
    app.emit('second-instance', null, [])
  })

  return app
}

export function isLinuxHeadlessHost() {
  return process.platform === 'linux'
}

export function isMacosHeadlessHost() {
  return process.platform === 'darwin'
}

function createHeadlessRuntime({
  app,
  clipboardWriter,
  NotificationClass,
  mode
}) {
  return {
    app,
    clipboard: {
      writeText(value) {
        clipboardWriter(value)
      }
    },
    globalShortcut: new HeadlessGlobalShortcut(),
    ipcMain: {
      handle() {},
      on() {}
    },
    Menu: {
      buildFromTemplate(template = []) {
        return template
      }
    },
    nativeImage: {
      createFromDataURL() {
        return emptyImage()
      },
      createFromPath() {
        return emptyImage()
      }
    },
    Notification: NotificationClass,
    screen: {
      getDisplayMatching() {
        return { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
      },
      getDisplayNearestPoint() {
        return { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
      },
      getPrimaryDisplay() {
        return { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }
      },
      getAllDisplays() {
        return [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }]
      },
      getCursorScreenPoint() {
        return { x: 0, y: 0 }
      }
    },
    session: {
      defaultSession: {
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {}
      }
    },
    shell: {
      openPath(targetPath) {
        if (process.platform === 'darwin') {
          try {
            spawnDetached('open', [String(targetPath || '')])
          } catch {
            // ignore
          }
        }
        return Promise.resolve('')
      }
    },
    Tray: HeadlessTray,
    headless: true,
    mode
  }
}

export async function loadHostRuntime() {
  if (isLinuxHeadlessHost()) {
    return createHeadlessRuntime({
      app: createHeadlessApp(),
      clipboardWriter: copyTextToLinuxClipboard,
      NotificationClass: HeadlessNotification,
      mode: 'linux-headless'
    })
  }

  if (isMacosHeadlessHost()) {
    return createHeadlessRuntime({
      app: createMacosHeadlessApp(),
      clipboardWriter: copyTextToMacosClipboard,
      NotificationClass: MacosNotification,
      mode: 'macos-headless'
    })
  }

  throw new Error('DicTray headless runtime currently supports Linux and macOS.')
}
