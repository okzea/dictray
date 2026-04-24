import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MACOS_UI_HELPER = String(process.env.DICTATION_TRAY_MACOS_UI_HELPER || '').trim()
  || path.join(__dirname, '..', 'scripts', 'macos-ui-automation')

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function compact(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function runAppleScript(lines, timeoutMs = 5000) {
  const args = []
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    args.push('-e', String(line || ''))
  }
  const result = await execFileAsync('osascript', args, { timeout: timeoutMs })
  return String(result.stdout || '').trim()
}

async function runUiHelper(command, args = [], timeoutMs = 5000) {
  let result
  try {
    result = await execFileAsync(MACOS_UI_HELPER, [command, ...args.map((arg) => String(arg || ''))], {
      timeout: timeoutMs
    })
  } catch (error) {
    const stderr = compact(error?.stderr)
    throw new Error(stderr || String(error?.message || error))
  }
  const raw = String(result.stdout || '').trim()
  if (!raw) {
    return {}
  }
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

async function writeClipboardText(text) {
  await new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(stderr.trim() || `pbcopy exited with code ${code ?? 1}`))
    })
    child.stdin.end(String(text || ''))
  })
}

async function readClipboardText() {
  try {
    const result = await execFileAsync('pbpaste', [], { timeout: 2000 })
    return String(result.stdout || '')
  } catch {
    return ''
  }
}

async function focusTargetWindow(window = {}) {
  const processName = compact(window?.processName)
  const titleContains = compact(window?.titleContains || window?.title)
  if (!processName) {
    return {
      focused: false,
      durationMs: 0
    }
  }

  const startedAt = performance.now()
  await runAppleScript([
    'tell application "System Events"',
    `set targetName to ${appleScriptString(processName)}`,
    `set targetTitle to ${appleScriptString(titleContains)}`,
    'if not (exists application process targetName) then error "Target app is no longer running: " & targetName',
    'set targetProcess to first application process whose name is targetName',
    'set frontmost of targetProcess to true',
    'if targetTitle is not "" then',
    'repeat with candidateWindow in windows of targetProcess',
    'try',
    'if (name of candidateWindow as text) contains targetTitle then',
    'perform action "AXRaise" of candidateWindow',
    'exit repeat',
    'end if',
    'end try',
    'end repeat',
    'else if exists window 1 of targetProcess then',
    'perform action "AXRaise" of window 1 of targetProcess',
    'end if',
    'end tell'
  ])
  await delay(120)
  return {
    focused: true,
    durationMs: Math.round(performance.now() - startedAt)
  }
}

function parseFocusedWindow(stdout = '') {
  const lines = String(stdout || '').split(/\r?\n/)
  const appName = compact(lines[0])
  const title = compact(lines[1])
  const left = Number(lines[2])
  const top = Number(lines[3])
  const width = Number(lines[4])
  const height = Number(lines[5])
  const bounds = [left, top, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { left, top, width, height }
    : null

  if (!appName && !title) {
    return null
  }

  return {
    focused: true,
    hwnd: null,
    macosApplication: appName,
    title,
    processName: appName,
    bounds
  }
}

export class MacosUiAutomationBridge {
  async checkHealth() {
    try {
      const windows = await this.listWindows({ limit: 1 })
      return {
        ok: true,
        enabled: true,
        backend: 'macos-accessibility',
        windows: Array.isArray(windows?.windows) ? windows.windows.length : 0
      }
    } catch (error) {
      return {
        ok: false,
        enabled: true,
        backend: 'macos-accessibility',
        error: String(error?.message || error)
      }
    }
  }

  async listWindows() {
    const payload = await runUiHelper('focused')
    const focused = payload?.ok
      ? {
          focused: true,
          hwnd: null,
          macosApplication: compact(payload.macosApplication || payload.processName || ''),
          title: compact(payload.title || ''),
          processName: compact(payload.processName || payload.macosApplication || ''),
          bounds: payload?.bounds && Number(payload.bounds.width) > 0 && Number(payload.bounds.height) > 0
            ? {
                left: Number(payload.bounds.left),
                top: Number(payload.bounds.top),
                width: Number(payload.bounds.width),
                height: Number(payload.bounds.height)
              }
            : null
        }
      : null
    return {
      windows: focused ? [focused] : []
    }
  }

  async snapshot() {
    return { target: null }
  }

  async action(input = {}, options = {}) {
    const action = String(input?.action || '').trim()
    if (options?.signal?.aborted) {
      throw new Error('Operation was cancelled.')
    }

    if (action === 'paste_text') {
      const text = String(input?.text || '')
      const startedAt = performance.now()
      const previousClipboard = await readClipboardText()
      const targetProcess = compact(input?.window?.processName)
      const targetTitle = compact(input?.window?.titleContains || input?.window?.title)
      await writeClipboardText(text)
      const clipboardSet = Math.round(performance.now() - startedAt)
      await delay(80)
      const pasteStartedAt = performance.now()
      const focusResult = await runUiHelper('paste', [targetProcess, targetTitle])
      const paste = Math.round(performance.now() - pasteStartedAt)
      let clipboardRestore = 0
      let clipboardRestoreSuccess = true
      let clipboardRestoreError = ''
      if (previousClipboard !== text) {
        await delay(120)
        const restoreStartedAt = performance.now()
        try {
          await writeClipboardText(previousClipboard)
        } catch (error) {
          clipboardRestoreSuccess = false
          clipboardRestoreError = String(error?.message || error)
        }
        clipboardRestore = Math.round(performance.now() - restoreStartedAt)
      }
      return {
        ok: true,
        window: null,
        timings: {
          action: {
            focusWindow: focusResult.durationMs || 0,
            focusWindowSuccess: Boolean(focusResult.focused),
            focusWindowError: focusResult.error || '',
            clipboardSet,
            paste,
            clipboardRestore,
            clipboardRestoreSuccess,
            clipboardRestoreError
          }
        }
      }
    }

    if (action === 'send_keys') {
      const text = String(input?.text || '')
      if (text === '{ENTER}') {
        const targetProcess = compact(input?.window?.processName)
        const targetTitle = compact(input?.window?.titleContains || input?.window?.title)
        await runUiHelper('enter', [targetProcess, targetTitle])
      }
      return { ok: true }
    }

    return { ok: true }
  }
}
