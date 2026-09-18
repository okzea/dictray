// Per-user "start at login" support for Windows.
//
// Windows has no equivalent of the XDG autostart directory that
// linux-product-integration.mjs writes to. It has two native mechanisms, and
// this uses the scheduled task rather than the Run key:
//
//   HKCU\Software\Microsoft\Windows\CurrentVersion\Run  - read by Explorer
//   a logon-triggered scheduled task                    - run by the scheduler
//
// The Run key was tried first and silently did nothing across two sign-ins on a
// machine where Explorer started its other Run entries normally, leaving nothing
// behind to explain it. A scheduled task does not depend on Explorer, can be
// started on demand so the registration can be verified without signing out, and
// records every attempt with a result code, so a failure can be diagnosed rather
// than guessed at.
//
// The legacy Run value is removed whenever this is enabled or disabled, so an
// entry left by an older build cannot start a second copy.
//
// Everything goes through schtasks.exe and reg.exe with argument arrays, so no
// value is ever passed through a shell.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE_NAME = 'DicTray'
const TASK_NAME = 'DicTray'
// Sign-in is busy, and nothing here is urgent: let the desktop settle first.
const LOGON_DELAY = 'PT15S'

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
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

const runReg = (args) => runCommand('reg.exe', args)
const runSchtasks = (args) => runCommand('schtasks.exe', args)

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The executable and arguments the scheduler should run at sign-in.
 *
 * A packaged build starts through its DicTray.cmd launcher, which is the only
 * entry point that sets the packaging environment the tray expects. Its own
 * executable is the bundled node.exe, so running that alone would open a Node
 * prompt rather than the app. Running from a source checkout there is no
 * launcher, so the current interpreter is pointed at scripts/start.mjs, which is
 * what `pnpm start` does.
 */
export function windowsAutostartAction({ packaged = false, rootDir = '', execPath = '', packageHome = '' } = {}) {
  const binary = String(execPath || process.execPath || '').trim()
  const root = String(rootDir || '').trim()

  if (packaged) {
    // rootDir is <package>/resources/app when packaged.
    const home = String(packageHome || process.env.DICTRAY_HOME || '').trim()
      || (root ? path.resolve(root, '..', '..') : '')
    const launcher = home ? path.join(home, 'DicTray.cmd') : ''
    if (launcher && existsSync(launcher)) {
      return { command: launcher, args: [], workingDirectory: home }
    }
    // No launcher next to the app: fall back to the entry point it would run.
    if (!binary || !root) {
      return null
    }
    return { command: binary, args: [path.join(root, 'scripts', 'run-tray.mjs')], workingDirectory: root }
  }

  if (!binary || !root) {
    return null
  }
  return { command: binary, args: [path.join(root, 'scripts', 'start.mjs')], workingDirectory: root }
}

/**
 * Kept for callers that only want to show what would run.
 */
export function windowsAutostartCommand(options = {}) {
  const action = windowsAutostartAction(options)
  if (!action) {
    return ''
  }
  return [action.command, ...action.args].map((part) => `"${part}"`).join(' ')
}

function taskDefinition(action) {
  const user = `${process.env.USERDOMAIN || process.env.COMPUTERNAME || ''}\\${process.env.USERNAME || ''}`.replace(/^\\/, '')
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Starts DicTray when you sign in.</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    user.length > 1 ? `      <UserId>${escapeXml(user)}</UserId>` : '',
    `      <Delay>${LOGON_DELAY}</Delay>`,
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    user.length > 1 ? `      <UserId>${escapeXml(user)}</UserId>` : '',
    '      <LogonType>InteractiveToken</LogonType>',
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    // The tray runs for the whole session: it must not be stopped for being
    // long-running, for going on battery, or for the machine becoming idle.
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>false</AllowHardTerminate>',
    '    <StartWhenAvailable>false</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>true</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${escapeXml(action.command)}</Command>`,
    action.args.length
      ? `      <Arguments>${escapeXml(action.args.map((part) => `"${part}"`).join(' '))}</Arguments>`
      : '',
    action.workingDirectory
      ? `      <WorkingDirectory>${escapeXml(action.workingDirectory)}</WorkingDirectory>`
      : '',
    '    </Exec>',
    '  </Actions>',
    '</Task>'
  ].filter((line) => line !== '').join('\r\n')
}

export async function isWindowsAutostartEnabled() {
  if (process.platform !== 'win32') {
    return false
  }
  const result = await runSchtasks(['/Query', '/TN', TASK_NAME])
  // schtasks exits non-zero when the task is absent, which is not an error here.
  return result.ok
}

export async function readWindowsAutostartCommand() {
  if (process.platform !== 'win32') {
    return ''
  }
  const result = await runSchtasks(['/Query', '/TN', TASK_NAME, '/XML', 'ONE'])
  if (!result.ok) {
    return ''
  }
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(result.stdout)?.[1] || ''
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(result.stdout)?.[1] || ''
  const decode = (value) => value
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&')
    .trim()
  return [command ? `"${decode(command)}"` : '', decode(args)].filter(Boolean).join(' ')
}

async function removeLegacyRunValue() {
  await runReg(['delete', RUN_KEY, '/v', VALUE_NAME, '/f'])
}

export async function setWindowsAutostart(enabled, options = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, reason: 'unsupported_platform' }
  }

  if (!enabled) {
    await removeLegacyRunValue()
    const removed = await runSchtasks(['/Delete', '/TN', TASK_NAME, '/F'])
    // Deleting a task that is already gone is a success for our purposes.
    if (!removed.ok && !(await isWindowsAutostartEnabled())) {
      return { ok: true, enabled: false }
    }
    return removed.ok
      ? { ok: true, enabled: false }
      : { ok: false, reason: String(removed.stderr || 'schtasks delete failed').trim() }
  }

  const action = windowsAutostartAction(options)
  if (!action) {
    return { ok: false, reason: 'unresolved_command' }
  }

  // schtasks reads the definition from a file, and only accepts it as UTF-16.
  let directory = ''
  try {
    directory = await mkdtemp(path.join(os.tmpdir(), 'dictray-autostart-'))
    const definitionPath = path.join(directory, 'task.xml')
    await writeFile(definitionPath, Buffer.from(`﻿${taskDefinition(action)}`, 'utf16le'))
    const created = await runSchtasks(['/Create', '/TN', TASK_NAME, '/XML', definitionPath, '/F'])
    if (!created.ok) {
      return { ok: false, reason: String(created.stderr || created.stdout || 'schtasks create failed').trim() }
    }
  } catch (error) {
    return { ok: false, reason: String(error?.message || error) }
  } finally {
    if (directory) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
    }
  }

  await removeLegacyRunValue()
  return { ok: true, enabled: true, command: windowsAutostartCommand(options) }
}
