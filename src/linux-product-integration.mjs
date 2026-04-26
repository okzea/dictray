import { spawn } from 'node:child_process'
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const PRODUCT_STATE_VERSION = 1
const EXTENSION_UUID = 'dictray-gnome-panel@okzea'
const EXTENSION_SOURCE_DIRNAME = 'gnome-panel-extension'
const EXTENSION_ZIP_NAME = `${EXTENSION_UUID}.shell-extension.zip`
const AUTOSTART_DESKTOP_FILE = 'com.okzea.dictray.desktop'

function xdgConfigHome() {
  return String(process.env.XDG_CONFIG_HOME || '').trim() || path.join(os.homedir(), '.config')
}

function xdgDataHome() {
  return String(process.env.XDG_DATA_HOME || '').trim() || path.join(os.homedir(), '.local', 'share')
}

function dictrayConfigDir() {
  return path.join(xdgConfigHome(), 'dictray')
}

function gnomePanelDir() {
  return path.join(dictrayConfigDir(), 'gnome-panel')
}

function launcherManifestPath() {
  return path.join(gnomePanelDir(), 'launcher.json')
}

function productStatePath() {
  return path.join(dictrayConfigDir(), 'linux-product.json')
}

function extensionInstallDir() {
  return path.join(xdgDataHome(), 'gnome-shell', 'extensions', EXTENSION_UUID)
}

function autostartDesktopPath() {
  return path.join(xdgConfigHome(), 'autostart', AUTOSTART_DESKTOP_FILE)
}

function normalizeAbsolute(value) {
  const text = String(value || '').trim()
  return text ? path.resolve(text) : ''
}

function normalizeLauncherEnv(env = {}) {
  return env && typeof env === 'object'
    ? Object.fromEntries(
        Object.entries(env)
          .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
          .filter(([key, value]) => key && value)
      )
    : {}
}

function isNodeExecutable(executable) {
  const name = path.basename(String(executable || '').trim()).toLowerCase()
  return name === 'node' || name === 'node.exe'
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function readJsonFile(filePath, fallback = {}) {
  try {
    const payload = JSON.parse(await readFile(filePath, 'utf8'))
    return payload && typeof payload === 'object' ? payload : fallback
  } catch {
    return fallback
  }
}

async function writeJsonFile(filePath, payload) {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(payload), 'utf8')
}

function escapeDesktopExec(value) {
  return String(value || '').replace(/([\\\s"'`$])/g, '\\$1')
}

function run(command, args = [], options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      stdio: options.stdio || 'ignore',
      env: options.env || process.env,
      windowsHide: false
    })

    child.on('error', (error) => {
      resolve({
        ok: false,
        error
      })
    })

    child.on('exit', (code) => {
      resolve({
        ok: code === 0,
        code: code ?? 1
      })
    })
  })
}

function buildAutostartDesktopEntry(launcher) {
  const envPairs = launcher?.env && typeof launcher.env === 'object'
    ? Object.entries(launcher.env)
      .map(([key, value]) => [String(key || '').trim(), String(value ?? '').trim()])
      .filter(([key, value]) => key && value)
      .map(([key, value]) => `${key}=${value}`)
    : []

  const execParts = envPairs.length
    ? ['/usr/bin/env', ...envPairs, launcher.executable, ...(Array.isArray(launcher.args) ? launcher.args : [])]
    : [launcher.executable, ...(Array.isArray(launcher.args) ? launcher.args : [])]

  const execLine = execParts
    .filter((value) => String(value || '').trim())
    .map((value) => escapeDesktopExec(value))
    .join(' ')

  const tryExec = escapeDesktopExec(String(launcher.executable || '').trim())

  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=DicTray',
    'Comment=Start DicTray and warm speech-to-text at login',
    `Exec=${execLine}`,
    `TryExec=${tryExec}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true'
  ].join('\n') + '\n'
}

async function syncExtensionFiles(sourceDir, targetDir) {
  await mkdir(path.dirname(targetDir), { recursive: true })
  await cp(sourceDir, targetDir, {
    recursive: true,
    force: true,
    filter: (sourcePath) => path.basename(sourcePath) !== EXTENSION_ZIP_NAME
  })
}

async function compileExtensionSchemas(targetDir) {
  const schemaDir = path.join(targetDir, 'schemas')
  if (!await pathExists(schemaDir)) {
    return
  }
  await run('glib-compile-schemas', [schemaDir], { cwd: targetDir })
}

export function buildLinuxLauncherManifest({
  packaged = false,
  rootDir = '',
  execPath = process.execPath,
  appImagePath = '',
  mainEntryPath = '',
  env = {}
} = {}) {
  const executable = normalizeAbsolute(packaged ? (appImagePath || execPath) : execPath)
  const normalizedEnv = normalizeLauncherEnv(env)
  const args = mainEntryPath && (!packaged || isNodeExecutable(executable))
    ? [normalizeAbsolute(mainEntryPath)].filter(Boolean)
    : []
  const cwd = packaged
    ? path.dirname(executable)
    : normalizeAbsolute(rootDir)

  return {
    version: 1,
    app: 'DicTray',
    packaged: Boolean(packaged),
    executable,
    args,
    cwd,
    env: normalizedEnv,
    updatedAt: Date.now()
  }
}

export async function ensureLinuxProductSetup({
  packaged = false,
  appVersion = '',
  rootDir = '',
  resourcesPath = '',
  launcher = {},
  sessionIsGnome = false,
  logger = null
} = {}) {
  const log = typeof logger === 'function'
    ? logger
    : () => {}

  const normalizedVersion = String(appVersion || '').trim()
  const state = await readJsonFile(productStatePath(), {})
  const nextState = {
    version: PRODUCT_STATE_VERSION,
    extensionManaged: Boolean(state?.extensionManaged),
    extensionInstalledVersion: String(state?.extensionInstalledVersion || '').trim(),
    autostartManaged: Boolean(state?.autostartManaged),
    autostartVersion: String(state?.autostartVersion || '').trim()
  }

  try {
    await writeJsonFile(launcherManifestPath(), launcher)
  } catch (error) {
    log(`Failed to write GNOME launcher manifest: ${error?.message || error}`)
  }

  if (!packaged) {
    return
  }

  const autostartPath = autostartDesktopPath()
  try {
    const autostartExists = await pathExists(autostartPath)
    const desktopEntry = buildAutostartDesktopEntry(launcher)

    if (!autostartExists && !nextState.autostartManaged) {
      await mkdir(path.dirname(autostartPath), { recursive: true })
      await writeFile(autostartPath, desktopEntry, 'utf8')
      nextState.autostartManaged = true
      nextState.autostartVersion = normalizedVersion || nextState.autostartVersion
      log(`Configured autostart in ${autostartPath}`)
    } else if (autostartExists) {
      const current = await readFile(autostartPath, 'utf8').catch(() => '')
      if (current !== desktopEntry) {
        await writeFile(autostartPath, desktopEntry, 'utf8')
      }
      nextState.autostartVersion = normalizedVersion || nextState.autostartVersion
    }
  } catch (error) {
    log(`Failed to configure autostart: ${error?.message || error}`)
  }

  if (sessionIsGnome) {
    const sourceDir = normalizeAbsolute(path.join(resourcesPath || rootDir, EXTENSION_SOURCE_DIRNAME))
    const targetDir = extensionInstallDir()

    try {
      const sourceExists = await pathExists(sourceDir)
      const targetExists = await pathExists(targetDir)

      if (!sourceExists) {
        log(`GNOME extension payload not found: ${sourceDir}`)
      } else {
        await syncExtensionFiles(sourceDir, targetDir)
        await compileExtensionSchemas(targetDir)

        const adoptingExistingInstall = targetExists && !nextState.extensionManaged
        const shouldEnableSyncedInstall = !targetExists
        const shouldReloadManagedInstall = targetExists
          && nextState.extensionManaged
          && normalizedVersion
          && normalizedVersion !== nextState.extensionInstalledVersion

        if (shouldReloadManagedInstall) {
          await run('gnome-extensions', ['disable', EXTENSION_UUID], { cwd: targetDir }).catch(() => {})
          const enableResult = await run('gnome-extensions', ['enable', EXTENSION_UUID], { cwd: targetDir })
          if (!enableResult.ok) {
            log(`Failed to reload GNOME extension ${EXTENSION_UUID}`)
          }
        } else if (shouldEnableSyncedInstall) {
          const enableResult = await run('gnome-extensions', ['enable', EXTENSION_UUID], { cwd: targetDir })
          if (!enableResult.ok) {
            log(`Failed to enable GNOME extension ${EXTENSION_UUID}`)
          }
        } else if (adoptingExistingInstall) {
          log(`Adopted existing GNOME extension install in ${targetDir}`)
        }

        nextState.extensionManaged = true
        nextState.extensionInstalledVersion = normalizedVersion || nextState.extensionInstalledVersion
      }
    } catch (error) {
      log(`Failed to sync GNOME extension: ${error?.message || error}`)
    }
  }

  try {
    await writeJsonFile(productStatePath(), nextState)
  } catch (error) {
    log(`Failed to persist Linux product state: ${error?.message || error}`)
  }
}
