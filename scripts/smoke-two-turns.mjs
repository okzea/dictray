import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'
import { loadConfig } from '../src/config.mjs'
import { createSttProvider } from '../src/stt-provider.mjs'
import { resolveBundledHelperExecutable } from '../src/runtime-paths.mjs'

const execFileAsync = promisify(execFile)
const rootDir = process.cwd()
const stateDir = path.join(rootDir, 'local', 'state')
const DEFAULT_HOTKEY = 'CommandOrControl+Space'

function log(message) {
  console.log(`[smoke] ${message}`)
}

function buildSilentWav(durationSec = 0.25) {
  const sampleRate = 16000
  const numSamples = Math.round(sampleRate * durationSec)
  const dataSize = numSamples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  return buffer
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function readJson(filePath) {
  const raw = await readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function readCurrentHotkey() {
  try {
    const settings = await readJson(path.join(stateDir, 'dictation-tray-settings.json'))
    return String(settings?.hotkey || DEFAULT_HOTKEY).trim() || DEFAULT_HOTKEY
  } catch {
    return DEFAULT_HOTKEY
  }
}

function resolveKeyCode(token) {
  const trimmed = String(token || '').trim()
  if (trimmed.length === 1) {
    const upper = trimmed.toUpperCase()
    if ((upper >= 'A' && upper <= 'Z') || (upper >= '0' && upper <= '9')) {
      return upper.charCodeAt(0)
    }
  }

  const normalized = trimmed.toUpperCase()
  if (normalized.startsWith('F')) {
    const number = Number(normalized.slice(1))
    if (Number.isInteger(number) && number >= 1 && number <= 24) {
      return 0x6F + number
    }
  }

  const mapping = {
    SPACE: 0x20,
    TAB: 0x09,
    ENTER: 0x0D,
    RETURN: 0x0D,
    ESC: 0x1B,
    ESCAPE: 0x1B,
    BACKSPACE: 0x08,
    DELETE: 0x2E,
    DEL: 0x2E,
    INSERT: 0x2D,
    INS: 0x2D,
    HOME: 0x24,
    END: 0x23,
    PAGEUP: 0x21,
    PGUP: 0x21,
    PAGEDOWN: 0x22,
    PGDN: 0x22,
    UP: 0x26,
    DOWN: 0x28,
    LEFT: 0x25,
    RIGHT: 0x27
  }
  if (mapping[normalized]) {
    return mapping[normalized]
  }
  throw new Error(`Unsupported hotkey token for smoke test: ${trimmed}`)
}

function parseHotkey(hotkey) {
  let key = null
  const modifiers = []
  for (const token of String(hotkey || '').split('+').map((part) => part.trim()).filter(Boolean)) {
    const normalized = token.toLowerCase()
    if (normalized === 'ctrl' || normalized === 'control' || normalized === 'commandorcontrol' || normalized === 'cmdorctrl') {
      modifiers.push(0x11)
      continue
    }
    if (normalized === 'alt') {
      modifiers.push(0x12)
      continue
    }
    if (normalized === 'shift') {
      modifiers.push(0x10)
      continue
    }
    if (normalized === 'super' || normalized === 'meta' || normalized === 'win' || normalized === 'windows' || normalized === 'command') {
      modifiers.push(0x5B)
      continue
    }
    if (key !== null) {
      throw new Error(`Smoke hotkey parser expects exactly one non-modifier key: ${hotkey}`)
    }
    key = resolveKeyCode(token)
  }
  if (key === null) {
    throw new Error(`Smoke hotkey parser could not resolve a key from: ${hotkey}`)
  }
  return {
    modifiers,
    key
  }
}

async function accessIfExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function findLatestRuntimeHelper(name) {
  const runtimeHelpersDir = path.join(rootDir, '.runtime-helpers')
  try {
    const roots = await readdir(runtimeHelpersDir, { withFileTypes: true })
    const matches = []
    for (const rootEntry of roots) {
      if (!rootEntry.isDirectory()) {
        continue
      }
      const rootPath = path.join(runtimeHelpersDir, rootEntry.name)
      const children = await readdir(rootPath, { withFileTypes: true }).catch(() => [])
      for (const child of children) {
        if (!child.isDirectory()) {
          continue
        }
        const candidate = path.join(rootPath, child.name, name)
        if (await accessIfExists(candidate)) {
          const info = await stat(candidate)
          matches.push({
            filePath: candidate,
            mtimeMs: info.mtimeMs
          })
        }
      }
    }
    matches.sort((a, b) => b.mtimeMs - a.mtimeMs)
    return matches[0]?.filePath || ''
  } catch {
    return ''
  }
}

async function resolveHotkeyHelperPath() {
  const envPath = String(process.env.DICTATION_TRAY_HOTKEY_HELPER || '').trim()
  if (envPath && await accessIfExists(envPath)) {
    return envPath
  }

  const latestRuntime = await findLatestRuntimeHelper('WindowsHotkeyHook.exe')
  if (latestRuntime) {
    return latestRuntime
  }

  const bundled = resolveBundledHelperExecutable('windows-hotkey-hook', 'WindowsHotkeyHook.exe')
  if (bundled && await accessIfExists(bundled)) {
    return bundled
  }

  const releasePath = path.join(rootDir, 'scripts', 'windows-hotkey-hook', 'bin', 'Release', 'net10.0-windows', 'WindowsHotkeyHook.exe')
  if (await accessIfExists(releasePath)) {
    return releasePath
  }

  throw new Error('Windows hotkey helper was not found. Run pnpm start once or pnpm build:helpers first.')
}

async function sendHotkeySequence(hotkey, cycles = 2) {
  const definition = parseHotkey(hotkey)
  const modifiers = definition.modifiers.join(',')
  const script = `
$ErrorActionPreference = 'Stop'
$modifiers = @(${modifiers})
$key = ${definition.key}
$cycles = ${cycles}
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class DicTraySmokeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)]
  public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  public const int INPUT_KEYBOARD = 1;
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@
function Send-Key([int]$vk, [bool]$up) {
  $input = New-Object DicTraySmokeInput+INPUT
  $input.type = [DicTraySmokeInput]::INPUT_KEYBOARD
  $input.U.ki.wVk = [uint16]$vk
  $input.U.ki.wScan = 0
  $input.U.ki.dwFlags = $(if ($up) { [DicTraySmokeInput]::KEYEVENTF_KEYUP } else { 0 })
  $input.U.ki.time = 0
  $input.U.ki.dwExtraInfo = [IntPtr]::Zero
  [void][DicTraySmokeInput]::SendInput(1, @($input), [Runtime.InteropServices.Marshal]::SizeOf([type]'DicTraySmokeInput+INPUT'))
}
for ($i = 0; $i -lt $cycles; $i++) {
  foreach ($vk in $modifiers) {
    Send-Key $vk $false
    Start-Sleep -Milliseconds 25
  }
  Send-Key $key $false
  Start-Sleep -Milliseconds 90
  Send-Key $key $true
  for ($j = $modifiers.Count - 1; $j -ge 0; $j--) {
    Send-Key $modifiers[$j] $true
    Start-Sleep -Milliseconds 25
  }
  Start-Sleep -Milliseconds 140
}
`
  await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    timeout: 15000
  })
}

async function smokeHotkeyBridge() {
  const hotkey = await readCurrentHotkey()
  const helperPath = await resolveHotkeyHelperPath()
  log(`Checking hold-to-talk helper with ${hotkey}.`)

  const child = spawn(helperPath, [hotkey], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })

  const events = []
  const stderrLines = []
  let exitInfo = null

  const stdout = readline.createInterface({ input: child.stdout })
  stdout.on('line', (line) => {
    const event = String(line || '').trim().toLowerCase()
    if (event) {
      events.push(event)
    }
  })

  const stderr = readline.createInterface({ input: child.stderr })
  stderr.on('line', (line) => {
    const text = String(line || '').trim()
    if (text) {
      stderrLines.push(text)
    }
  })

  child.on('exit', (code, signal) => {
    exitInfo = { code, signal }
  })

  try {
    await sleep(300)
    await sendHotkeySequence(hotkey, 2)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (events.length >= 4) {
        break
      }
      if (exitInfo) {
        break
      }
      await sleep(50)
    }

    const expected = ['down', 'up', 'down', 'up']
    const actual = events.slice(0, 4)
    if (expected.some((value, index) => actual[index] !== value)) {
      throw new Error(`Hotkey helper did not emit two full cycles. Expected ${expected.join(', ')} but got ${events.join(', ') || 'nothing'}. ${stderrLines.join(' | ')}`.trim())
    }
    if (exitInfo) {
      throw new Error(`Hotkey helper exited during smoke test with code ${exitInfo.code ?? 'unknown'}${exitInfo.signal ? ` (${exitInfo.signal})` : ''}. ${stderrLines.join(' | ')}`.trim())
    }

    log('Hold-to-talk helper passed two cycles.')
  } finally {
    if (!child.killed) {
      child.kill()
    }
    stdout.close()
    stderr.close()
  }
}

async function smokeSpeechToText() {
  log('Checking Speech to Text across two sequential turns.')
  const config = await loadConfig()
  const provider = createSttProvider(config.stt, stateDir)
  const audio = buildSilentWav(0.25)

  try {
    const warm = await provider.warmStt()
    if (!warm?.ok) {
      throw new Error(String(warm?.error || warm?.reason || 'Speech to Text warmup failed.'))
    }

    for (let index = 1; index <= 2; index += 1) {
      const started = Date.now()
      const result = await provider.transcribeAudioBuffer(audio, 'audio/wav')
      log(`Speech turn ${index} completed in ${Date.now() - started}ms (${Number(result?.timingsMs?.total || 0)}ms provider time).`)
    }
  } finally {
    await provider.dispose?.().catch(() => null)
  }

  log('Speech to Text passed two sequential turns.')
}

async function main() {
  const failures = []

  try {
    await smokeHotkeyBridge()
  } catch (error) {
    failures.push(`Hotkey bridge: ${String(error?.message || error)}`)
  }

  try {
    await smokeSpeechToText()
  } catch (error) {
    failures.push(`Speech to Text: ${String(error?.message || error)}`)
  }

  if (failures.length) {
    for (const failure of failures) {
      console.error(`[smoke] ${failure}`)
    }
    process.exitCode = 1
    return
  }

  log('Two-turn smoke test passed.')
}

await main()
