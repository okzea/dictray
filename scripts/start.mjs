import { access, mkdir } from 'node:fs/promises'
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

function runtimeHelperRoot() {
  return path.join(rootDir, '.runtime-helpers', 'dev')
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

function electronBinaryPath() {
  return process.platform === 'win32'
    ? path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(rootDir, 'node_modules', '.bin', 'electron')
}

function electronCliPath() {
  return path.join(rootDir, 'node_modules', 'electron', 'cli.js')
}

async function ensureElectronRuntime(childEnv) {
  const electronBin = electronBinaryPath()
  try {
    await access(electronBin)
    return electronBin
  } catch {
    // Fall through to bootstrap the missing Electron dist payload.
  }

  const installScript = path.join(rootDir, 'node_modules', 'electron', 'install.js')
  await access(installScript)

  log('Electron runtime is missing. Installing Electron dist payload.')
  try {
    await run(process.execPath, [installScript], {
      env: {
        ...childEnv,
        electron_config_cache: path.join(rootDir, '.electron-cache')
      }
    })
  } catch (error) {
    throw new Error(
      [
        'Electron runtime installation failed.',
        String(error?.message || error),
        'If pnpm keeps blocking Electron postinstall, run "pnpm approve-builds" and allow electron, then reinstall.'
      ].join(' ')
    )
  }

  await access(electronBin)
  return electronBin
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

  // Remove any stale container to avoid port conflicts
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
  const electronCli = electronCliPath()
  await access(electronCli)

  log('Checking for an already running tray instance.')
  await run(process.execPath, [electronCli, 'tray/main.mjs', '--dictray-exit-existing'], {
    env: {
      ...childEnv,
      ELECTRON_ENABLE_LOGGING: '1'
    }
  })

  await sleep(900)
}

async function buildDotnetHelper(projectPath, outputDir, childEnv) {
  await mkdir(outputDir, { recursive: true })
  await run('dotnet', ['build', projectPath, '-c', 'Release', `-p:OutDir=${outputDir}`], {
    env: childEnv
  })
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
  const dotnetHome = path.join(rootDir, '.dotnet-cli')
  await mkdir(dotnetHome, { recursive: true })

  const childEnv = {
    ...process.env,
    DOTNET_CLI_HOME: dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1'
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
  await ensureElectronRuntime(childEnv)
  await requestExistingTrayExit(childEnv)

  const helperRoot = runtimeHelperRoot()
  const hotkeyHelperDir = path.join(helperRoot, 'windows-hotkey-hook')
  const uiAutomationHelperDir = path.join(helperRoot, 'windows-ui-automation')
  const volumeHelperDir = path.join(helperRoot, 'windows-system-volume')
  const hotkeyHelperPath = path.join(hotkeyHelperDir, 'WindowsHotkeyHook.exe')
  const uiAutomationHelperPath = path.join(uiAutomationHelperDir, 'WindowsUiAutomation.exe')
  const volumeHelperPath = path.join(volumeHelperDir, 'WindowsSystemVolume.exe')

  log('Building Windows hotkey helper.')
  await buildDotnetHelper('scripts/windows-hotkey-hook/WindowsHotkeyHook.csproj', hotkeyHelperDir, childEnv)

  log('Building Windows UI automation helper.')
  await buildDotnetHelper('scripts/windows-ui-automation/WindowsUiAutomation.csproj', uiAutomationHelperDir, childEnv)

  log('Building Windows system volume helper.')
  await buildDotnetHelper('scripts/windows-system-volume/WindowsSystemVolume.csproj', volumeHelperDir, childEnv)

  await warmSttRuntime(sttProvider)

  const electronCli = electronCliPath()
  log('Launching tray.')
  await run(process.execPath, [electronCli, 'tray/main.mjs'], {
    env: {
      ...childEnv,
      ELECTRON_ENABLE_LOGGING: '1',
      DICTATION_TRAY_BUNDLED_RUNTIME_DIR: childEnv.DICTATION_TRAY_BUNDLED_RUNTIME_DIR || '',
      DICTATION_TRAY_HOTKEY_HELPER: hotkeyHelperPath,
      DICTATION_TRAY_UI_AUTOMATION_HELPER: uiAutomationHelperPath,
      DICTATION_TRAY_VOLUME_HELPER: volumeHelperPath
    }
  })
}

main().catch((error) => {
  console.error(`[dictray-start] ${error?.message || error}`)
  process.exitCode = 1
})
