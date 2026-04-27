import { spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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

function readLinuxProcessCwd(pid) {
  try {
    return readlinkSync(`/proc/${pid}/cwd`)
  } catch {
    return ''
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

  const rootDir = projectRoot()
  const expectedMain = path.join(rootDir, 'tray', 'main.mjs')
  const cwd = readLinuxProcessCwd(pid)
  return command.some((part) => {
    const normalized = String(part || '').replace(/\\/g, '/')
    if (normalized !== 'tray/main.mjs' && !normalized.endsWith('/tray/main.mjs')) {
      return false
    }
    const resolved = path.isAbsolute(part)
      ? path.resolve(part)
      : cwd
        ? path.resolve(cwd, part)
        : ''
    return resolved === expectedMain
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

function readMacosProcessCwd(pid) {
  const output = readProcessOutput('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  const line = output.split('\n').find((entry) => entry.startsWith('n'))
  return line ? line.slice(1).trim() : ''
}

function isDictrayMainScriptArg(value, cwd = '') {
  const normalized = String(value || '').replace(/\\/g, '/')
  if (normalized !== 'tray/main.mjs' && !normalized.endsWith('/tray/main.mjs')) {
    return false
  }
  const expectedMain = path.join(projectRoot(), 'tray', 'main.mjs')
  const resolved = path.isAbsolute(value)
    ? path.resolve(value)
    : cwd
      ? path.resolve(cwd, value)
      : ''
  return resolved === expectedMain
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
  const cwd = readMacosProcessCwd(pid)
  return args.split(/\s+/).some((part) => isDictrayMainScriptArg(part, cwd))
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
