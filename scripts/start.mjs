import { mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { createSttProvider } from '../src/stt-provider.mjs'
import { ensureBundledSttRuntime } from './stt-runtime-bootstrap.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function log(message) {
  console.log(`[dictray-start] ${message}`)
}

function trayLaunchCommand() {
  return process.execPath
}

function localDotnetEnv() {
  const dotnetRoot = path.join(rootDir, '.dotnet-cli')
  if (!existsSync(path.join(dotnetRoot, 'dotnet.exe'))) {
    return {}
  }
  return {
    DOTNET_ROOT: dotnetRoot,
    PATH: `${dotnetRoot}${path.delimiter}${process.env.PATH || ''}`
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      stdio: options.stdio || 'inherit',
      env: options.env || process.env,
      windowsHide: false
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 1}`))
    })
  })
}

async function warmSttRuntime(sttProvider) {
  if (!sttProvider?.config?.enabled) {
    return
  }

  if (String(sttProvider?.id || sttProvider?.config?.stt?.provider || '').trim().toLowerCase() === 'local') {
    log('Skipping prelaunch STT warmup. The tray process warms and owns the managed local speech daemon.')
    return
  }

  log('Warming STT transcribe path.')
  const result = await sttProvider.warmStt().catch(() => ({ ok: false, reason: 'warmup_failed' }))
  if (result?.ok) {
    log('STT warmup complete.')
    return
  }

  log(`STT warmup skipped or failed${result?.reason ? `: ${result.reason}` : '.'}${result?.error ? ` ${result.error}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function configHome() {
  return String(process.env.XDG_CONFIG_HOME || '').trim() || path.join(os.homedir(), '.config')
}

function existingTrayLockPath() {
  if (process.platform === 'linux') {
    return path.join(configHome(), 'dictray', 'linux-headless.lock')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'DicTray', 'dictray.lock')
  }
  if (process.platform === 'win32') {
    const appData = String(process.env.APPDATA || '').trim() || path.join(os.homedir(), 'AppData', 'Roaming')
    return path.join(appData, 'DicTray', 'dictray.lock')
  }
  return ''
}

async function readExistingTrayPid() {
  const lockPath = existingTrayLockPath()
  if (!lockPath) {
    return 0
  }
  try {
    return Number.parseInt(String(await readFile(lockPath, 'utf8') || '').trim(), 10) || 0
  } catch {
    return 0
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

function commandLineReferencesTrayMain(value) {
  return String(value || '').replace(/\\/g, '/').includes('tray/main.mjs')
}

function readWindowsProcessCommand(pid) {
  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid) || 0}"`,
    'if ($p) { [Console]::Out.Write($p.CommandLine) }'
  ].join('; ')
  return readProcessOutput('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script])
}

async function isExistingTrayOwner(pid) {
  if (!isPidRunning(pid)) {
    return false
  }

  if (process.platform === 'linux') {
    try {
      const command = String(await readFile(`/proc/${pid}/cmdline`, 'utf8') || '')
        .split('\0')
        .map((part) => part.trim())
        .filter(Boolean)
      const executableName = path.basename(command[0] || '').toLowerCase()
      return executableName.includes('dictray') || command.some(commandLineReferencesTrayMain)
    } catch {
      return false
    }
  }

  if (process.platform === 'darwin') {
    const command = readProcessOutput('ps', ['-p', String(pid), '-o', 'comm='])
    if (path.basename(command).toLowerCase().includes('dictray')) {
      return true
    }
    return commandLineReferencesTrayMain(readProcessOutput('ps', ['-p', String(pid), '-o', 'args=']))
  }

  if (process.platform === 'win32') {
    return commandLineReferencesTrayMain(readWindowsProcessCommand(pid))
  }

  return false
}

async function waitForExistingTrayExit(previousPid, timeoutMs = 15000) {
  if (!isPidRunning(previousPid)) {
    return
  }

  const started = Date.now()
  while ((Date.now() - started) < timeoutMs) {
    const currentPid = await readExistingTrayPid()
    if (currentPid !== previousPid || !isPidRunning(previousPid)) {
      return
    }
    await sleep(250)
  }

  throw new Error(`Timed out waiting for existing tray process ${previousPid} to exit`)
}

async function checkSpeechHealthOnce(url, timeoutMs = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, Math.max(250, Number(timeoutMs) || 3000))

  try {
    const response = await fetch(url, {
      signal: controller.signal
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

async function waitForSpeechHealth(url, timeoutMs = 300000) {
  const started = Date.now()
  let lastError = 'unknown error'

  while (Date.now() - started < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - started)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, Math.max(250, Math.min(3000, remainingMs)))

    try {
      const response = await fetch(url, {
        signal: controller.signal
      })
      if (response.ok) {
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error?.name === 'AbortError' ? 'request timed out' : error?.message || String(error)
    } finally {
      clearTimeout(timer)
    }
    await sleep(Math.min(1500, Math.max(0, timeoutMs - (Date.now() - started))))
  }

  throw new Error(`Timed out waiting for ${url}: ${lastError}`)
}

async function ensureDockerStt(childEnv, healthUrl) {
  if (await checkSpeechHealthOnce(healthUrl, 1500)) {
    log('Existing HTTP STT service is already healthy.')
    return true
  }

  log('Ensuring no stale STT container is blocking the port.')
  await run('docker', ['rm', '-f', 'dictray-speech-stt'], { env: childEnv, stdio: 'ignore' }).catch(() => {})

  log('Starting Docker STT service.')
  await run('docker', ['compose', 'up', '-d', '--build'], { env: childEnv })
  log('Waiting for STT health endpoint.')
  await waitForSpeechHealth(healthUrl)
  log('Docker STT service is healthy.')
  return true
}

async function ensureManagedHttpStt(childEnv, healthUrl) {
  try {
    return await ensureDockerStt(childEnv, healthUrl)
  } catch (error) {
    log(`Managed Docker STT startup failed: ${error?.message || error}`)
    if (await checkSpeechHealthOnce(healthUrl, 1500)) {
      log('HTTP STT service became healthy after the Docker startup failure. Continuing.')
      return true
    }
    log('Continuing without managed STT startup. Start Docker Desktop or launch the configured HTTP STT service manually if dictation stays unavailable.')
    return false
  }
}

async function requestExistingTrayExit(childEnv) {
  log('Checking for an already running tray instance.')
  const existingPid = await readExistingTrayPid()
  const shouldWaitForExit = await isExistingTrayOwner(existingPid)
  await run(trayLaunchCommand(), ['tray/main.mjs', '--dictray-exit-existing'], {
    env: process.platform === 'linux'
      ? {
          ...childEnv,
          DICTATION_TRAY_LINUX_HEADLESS: '1'
        }
      : childEnv,
    stdio: 'ignore'
  }).catch(() => {})

  if (shouldWaitForExit) {
    await waitForExistingTrayExit(existingPid)
  }
}

function usesDefaultLocalSttBootstrapPath(config) {
  if (String(config?.stt?.provider || '').trim().toLowerCase() !== 'local') {
    return false
  }

  const pythonBin = String(config?.stt?.local?.pythonBin || '').trim().toLowerCase()
  const transcribeScript = path.resolve(String(config?.stt?.local?.transcribeScript || ''))
  const defaultTranscribeScript = path.resolve(path.join(config?.rootDir || rootDir, 'scripts', 'faster_whisper_cli.py'))
  const bundledTranscribeScript = config?.resolved?.bundledStt?.transcribeScript
    ? path.resolve(String(config.resolved.bundledStt.transcribeScript))
    : ''
  const modelDir = String(config?.stt?.local?.modelDir || '').trim()
  const usingBundledRuntime = Boolean(config?.resolved?.bundledStt)
    && transcribeScript === bundledTranscribeScript

  return usingBundledRuntime || (
    (!pythonBin || pythonBin === 'python' || pythonBin === 'python3')
    && transcribeScript === defaultTranscribeScript
    && !modelDir
  )
}

async function prepareStartupSttRuntime(config, childEnv) {
  if (!usesDefaultLocalSttBootstrapPath(config)) {
    return config
  }

  log('Ensuring bundled local STT runtime is available for development.')
  const runtime = await ensureBundledSttRuntime({
    rootDir,
    logger: (message) => log(message),
    env: childEnv
  })

  childEnv.DICTATION_TRAY_BUNDLED_RUNTIME_DIR = runtime.runtimeRoot
  process.env.DICTATION_TRAY_BUNDLED_RUNTIME_DIR = runtime.runtimeRoot
  return loadConfig()
}

async function main() {
  if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
    throw new Error('This branch supports Linux, macOS, and Windows.')
  }

  const dotnetHome = path.join(rootDir, '.dotnet-cli')
  await mkdir(dotnetHome, { recursive: true })

  const childEnv = {
    ...process.env,
    DOTNET_CLI_HOME: dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    ...(process.platform === 'win32' ? { DICTATION_TRAY_NODE_BIN: process.execPath, ...localDotnetEnv() } : {}),
    ...(process.platform === 'linux' ? { DICTATION_TRAY_LINUX_HEADLESS: '1' } : {})
  }

  let config = await loadConfig()

  if (String(config?.stt?.provider || '').trim().toLowerCase() === 'http') {
    const sttHttp = config?.stt?.http || {}
    const healthUrl = `${String(sttHttp.baseUrl || 'http://127.0.0.1:4593').replace(/\/+$/, '')}${String(sttHttp.healthPath || '/health')}`
    const httpReady = await ensureManagedHttpStt(childEnv, healthUrl)
    if (!httpReady) {
      log('Falling back to bundled local STT for this session.')
      childEnv.DICTATION_TRAY_STT_PROVIDER = 'local'
      process.env.DICTATION_TRAY_STT_PROVIDER = 'local'
      config = await loadConfig()
      config = await prepareStartupSttRuntime(config, childEnv)
    }
  } else {
    config = await prepareStartupSttRuntime(config, childEnv)
  }

  const sttProvider = createSttProvider({
    ...config.stt,
    rootDir: config.rootDir
  }, config.memory.stateDir)

  await requestExistingTrayExit(childEnv)
  await warmSttRuntime(sttProvider)

  log('Launching tray.')
  await run(trayLaunchCommand(), ['tray/main.mjs'], {
    env: {
      ...childEnv,
      DICTATION_TRAY_BUNDLED_RUNTIME_DIR: childEnv.DICTATION_TRAY_BUNDLED_RUNTIME_DIR || ''
    }
  })
}

main().catch((error) => {
  console.error(`[dictray-start] ${error?.message || error}`)
  process.exitCode = 1
})
