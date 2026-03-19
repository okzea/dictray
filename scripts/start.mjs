import { access, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../src/config.mjs'
import { createSttProvider } from '../src/stt-provider.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function log(message) {
  console.log(`[dictray-start] ${message}`)
}

function runtimeHelperRoot() {
  return path.join(rootDir, '.runtime-helpers', `${Date.now()}-${process.pid}`)
}

function providerUsesHttpStt(config) {
  return String(config?.stt?.provider || '').trim().toLowerCase() === 'local-http'
}

function dockerAutoStartEnabled(config) {
  return providerUsesHttpStt(config) && Boolean(config?.stt?.docker?.enabled && config?.stt?.docker?.autoStart)
}

function isPortAllocatedError(error) {
  const message = String(error?.message || error || '')
  return /port is already allocated|bind .* failed/i.test(message)
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

async function waitForSttHealthy(speech, timeoutMs = 60000) {
  const startedAt = Date.now()
  while ((Date.now() - startedAt) < timeoutMs) {
    const health = await speech.checkSttHealth().catch(() => null)
    if (health?.ok) {
      return health
    }
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
  return null
}

async function ensureHttpSttReady(sttProvider, config) {
  const baseUrl = String(config?.stt?.http?.baseUrl || '').trim()

  log('Checking STT health.')
  const existingHealth = await sttProvider.checkSttHealth().catch(() => null)
  if (existingHealth?.ok) {
    log(`Reusing existing STT service${baseUrl ? ` at ${baseUrl}` : ''}.`)
    return {
      started: false
    }
  }

  log('Starting managed STT service.')

  try {
    await sttProvider.startLocalService({ build: false })
  } catch (error) {
    if (!isPortAllocatedError(error)) {
      throw error
    }

    const conflictedHealth = await sttProvider.checkSttHealth().catch(() => null)
    if (!conflictedHealth?.ok) {
      throw error
    }

    log(`Port is already busy, but STT is healthy${baseUrl ? ` at ${baseUrl}` : ''}. Reusing it.`)
    return {
      started: false
    }
  }

  log('Waiting for STT health.')
  const health = await waitForSttHealthy(sttProvider)
  if (!health?.ok) {
    throw new Error('Managed STT service did not become healthy in time.')
  }

  log(`STT is ready${baseUrl ? ` at ${baseUrl}` : ''}.`)
  return {
    started: true
  }
}

async function warmSttRuntime(sttProvider) {
  if (!sttProvider?.config?.enabled) {
    return
  }

  log('Warming STT transcribe path.')
  const result = await sttProvider.warmStt().catch(() => ({ ok: false, reason: 'warmup_failed' }))
  if (result?.ok) {
    log('STT warmup complete.')
    return
  }

  log(`STT warmup skipped or failed${result?.reason ? `: ${result.reason}` : '.'}`)
}

function electronBinaryPath() {
  return process.platform === 'win32'
    ? path.join(rootDir, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(rootDir, 'node_modules', '.bin', 'electron')
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

async function buildDotnetHelper(projectPath, outputDir, childEnv) {
  await mkdir(outputDir, { recursive: true })
  await run('dotnet', ['build', projectPath, '-c', 'Release', `-p:OutDir=${outputDir}`], {
    env: childEnv
  })
}

async function main() {
  const config = await loadConfig()
  const sttProvider = createSttProvider({
    ...config.stt,
    rootDir: config.rootDir
  }, config.memory.stateDir)
  const dotnetHome = path.join(rootDir, '.dotnet-cli')
  await mkdir(dotnetHome, { recursive: true })
  const helperRoot = runtimeHelperRoot()
  const hotkeyHelperDir = path.join(helperRoot, 'windows-hotkey-hook')
  const uiAutomationHelperDir = path.join(helperRoot, 'windows-ui-automation')
  const volumeHelperDir = path.join(helperRoot, 'windows-system-volume')
  const hotkeyHelperPath = path.join(hotkeyHelperDir, 'WindowsHotkeyHook.exe')
  const uiAutomationHelperPath = path.join(uiAutomationHelperDir, 'WindowsUiAutomation.exe')
  const volumeHelperPath = path.join(volumeHelperDir, 'WindowsSystemVolume.exe')

  const childEnv = {
    ...process.env,
    DOTNET_CLI_HOME: dotnetHome,
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1'
  }

  log('Building Windows hotkey helper.')
  await buildDotnetHelper('scripts/windows-hotkey-hook/WindowsHotkeyHook.csproj', hotkeyHelperDir, childEnv)

  log('Building Windows UI automation helper.')
  await buildDotnetHelper('scripts/windows-ui-automation/WindowsUiAutomation.csproj', uiAutomationHelperDir, childEnv)

  log('Building Windows system volume helper.')
  await buildDotnetHelper('scripts/windows-system-volume/WindowsSystemVolume.csproj', volumeHelperDir, childEnv)

  let dockerStartedByStartScript = false
  if (dockerAutoStartEnabled(config)) {
    const dockerStatus = await ensureHttpSttReady(sttProvider, config)
    dockerStartedByStartScript = Boolean(dockerStatus?.started)
  }
  await warmSttRuntime(sttProvider)

  const electronBin = await ensureElectronRuntime(childEnv)
  log('Launching tray.')
  await run(electronBin, ['tray/main.mjs'], {
    env: {
      ...childEnv,
      DICTATION_TRAY_HOTKEY_HELPER: hotkeyHelperPath,
      DICTATION_TRAY_UI_AUTOMATION_HELPER: uiAutomationHelperPath,
      DICTATION_TRAY_VOLUME_HELPER: volumeHelperPath,
      DICTATION_TRAY_STARTED_DOCKER: dockerStartedByStartScript ? '1' : ''
    }
  })
}

main().catch((error) => {
  console.error(`[dictray-start] ${error?.message || error}`)
  process.exitCode = 1
})
