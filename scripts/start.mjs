import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { createSttProvider } from '../src/stt-provider.mjs'
import { ensureBundledSttRuntime } from './stt-runtime-bootstrap.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function log(message) {
  console.log(`[dictray-start] ${message}`)
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
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error?.message || String(error)
    }
    await sleep(1500)
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
  await run(process.execPath, ['tray/main.mjs', '--dictray-exit-existing'], {
    env: process.platform === 'linux'
      ? {
          ...childEnv,
          DICTATION_TRAY_LINUX_HEADLESS: '1'
        }
      : childEnv,
    stdio: 'ignore'
  }).catch(() => {})

  await sleep(900)
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
  if (!['linux', 'darwin'].includes(process.platform)) {
    throw new Error('This branch supports Linux and macOS.')
  }

  const dotnetHome = path.join(rootDir, '.dotnet-cli')
  await mkdir(dotnetHome, { recursive: true })

  const childEnv = {
    ...process.env,
    DOTNET_CLI_HOME: dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
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
  await run(process.execPath, ['tray/main.mjs'], {
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
