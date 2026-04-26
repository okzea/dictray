import { spawn } from 'node:child_process'
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
  child.unref()
  return child
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

function acquireLinuxHeadlessLock({ requestExit = false } = {}) {
  const lockPath = linuxHeadlessLockPath()
  const existingPid = readLockedPid()

  if (requestExit) {
    if (isPidRunning(existingPid)) {
      try {
        process.kill(existingPid, 'SIGTERM')
      } catch {
        // ignore
      }
    }
    return false
  }

  if (isPidRunning(existingPid)) {
    return false
  }

  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  } catch {
    // ignore stale lock cleanup failures
  }

  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8')
    return true
  } catch {
    return false
  }
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

function acquirePidLock(lockPath, { requestExit = false } = {}) {
  const existingPid = readLockPid(lockPath)

  if (requestExit) {
    if (isPidRunning(existingPid)) {
      try {
        process.kill(existingPid, 'SIGTERM')
      } catch {
        // ignore
      }
    }
    return false
  }

  if (isPidRunning(existingPid)) {
    return false
  }

  try {
    if (existsSync(lockPath)) {
      unlinkSync(lockPath)
    }
  } catch {
    // ignore stale lock cleanup failures
  }

  try {
    mkdirSync(path.dirname(lockPath), { recursive: true })
    writeFileSync(lockPath, `${process.pid}\n`, 'utf8')
    return true
  } catch {
    return false
  }
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
      spawnDetached('wl-copy', ['--', value])
      return
    } catch {
      // ignore and fall through
    }
  }

  try {
    const xclip = spawn('xclip', ['-selection', 'clipboard'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    })
    xclip.stdin.end(value)
    xclip.unref()
    return
  } catch {
    // ignore and fall through
  }

  try {
    const xsel = spawn('xsel', ['--clipboard', '--input'], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    })
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
    const child = spawn('pbcopy', [], {
      stdio: ['pipe', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    })
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
    globalShortcut: {
      register() {
        return true
      },
      unregisterAll() {}
    },
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
