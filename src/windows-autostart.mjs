// Per-user "start at login" support for Windows.
//
// Windows has no equivalent of the XDG autostart directory that
// linux-product-integration.mjs writes to. The native mechanism is the per-user
// Run key, which the shell reads at sign-in:
//
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run
//
// The registry value is the whole state: there is nothing to keep in sync, and a
// user who removes the entry through Task Manager's Startup tab simply has it
// disabled. Everything goes through reg.exe with argument arrays, so no value is
// ever passed through a shell.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'DicTray'

function runReg(args) {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (error) => resolve({ ok: false, stdout, stderr: String(error?.message || error) }))
    child.on('exit', (code) => resolve({ ok: code === 0, stdout, stderr }))
  })
}

/**
 * Explorer runs a Run-key command with a visible window, and everything we can
 * launch here is a console program: registered directly, node.exe would put a
 * console window on screen for the whole session, and closing that window would
 * take the tray with it. Handing off through `start "" /b` is what the packaged
 * DicTray.cmd launcher already does.
 */
function detachedCommand(parts) {
  return `cmd.exe /c start "" /b ${parts.map((part) => `"${part}"`).join(' ')}`
}

/**
 * The command the shell should run at sign-in.
 *
 * A packaged build starts through its DicTray.cmd launcher, which is the only
 * entry point that sets the packaging environment the tray expects. Its own
 * executable is the bundled node.exe, so registering that alone would open a
 * Node prompt rather than the app. Running from a source checkout there is no
 * launcher, so the current interpreter is pointed at scripts/start.mjs, which is
 * what `pnpm start` does.
 */
export function windowsAutostartCommand({ packaged = false, rootDir = '', execPath = '', packageHome = '' } = {}) {
  const binary = String(execPath || process.execPath || '').trim()
  const root = String(rootDir || '').trim()

  if (packaged) {
    // rootDir is <package>/resources/app when packaged.
    const home = String(packageHome || process.env.DICTRAY_HOME || '').trim()
      || (root ? path.resolve(root, '..', '..') : '')
    const launcher = home ? path.join(home, 'DicTray.cmd') : ''
    if (launcher && existsSync(launcher)) {
      return detachedCommand([launcher])
    }
    // No launcher next to the app: fall back to the entry point it would run.
    return binary && root ? detachedCommand([binary, path.join(root, 'scripts', 'run-tray.mjs')]) : ''
  }

  if (!binary || !root) {
    return ''
  }
  return detachedCommand([binary, path.join(root, 'scripts', 'start.mjs')])
}

export async function isWindowsAutostartEnabled() {
  if (process.platform !== 'win32') {
    return false
  }
  const result = await runReg(['query', RUN_KEY, '/v', VALUE_NAME])
  // reg.exe exits non-zero when the value is absent, which is not an error here.
  return result.ok && result.stdout.includes(VALUE_NAME)
}

export async function readWindowsAutostartCommand() {
  if (process.platform !== 'win32') {
    return ''
  }
  const result = await runReg(['query', RUN_KEY, '/v', VALUE_NAME])
  if (!result.ok) {
    return ''
  }
  // "    DicTray    REG_SZ    <command>"
  const line = result.stdout.split(/\r?\n/).find((entry) => entry.includes(VALUE_NAME)) || ''
  const marker = 'REG_SZ'
  const index = line.indexOf(marker)
  return index === -1 ? '' : line.slice(index + marker.length).trim()
}

export async function setWindowsAutostart(enabled, { packaged = false, rootDir = '', execPath = '' } = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported_platform' }
  }

  if (!enabled) {
    const removed = await runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
    // Deleting a value that is already gone is a success for our purposes.
    if (!removed.ok && !(await isWindowsAutostartEnabled())) {
      return { ok: true, enabled: false }
    }
    return removed.ok
      ? { ok: true, enabled: false }
      : { ok: false, reason: String(removed.stderr || 'reg delete failed').trim() }
  }

  const command = windowsAutostartCommand({ packaged, rootDir, execPath })
  if (!command) {
    return { ok: false, reason: 'unresolved_command' }
  }

  const added = await runReg(['add', RUN_KEY, '/v', VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'])
  return added.ok
    ? { ok: true, enabled: true, command }
    : { ok: false, reason: String(added.stderr || 'reg add failed').trim() }
}
