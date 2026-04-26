import { existsSync } from 'node:fs'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { projectRoot } from './runtime-paths.mjs'

const GJS_BIN = String(process.env.DICTATION_TRAY_GJS_BIN || 'gjs').trim() || 'gjs'

function normalizeAbsolute(value) {
  const text = String(value || '').trim()
  return text ? path.resolve(text) : ''
}

function candidateRoots() {
  const explicitRoot = normalizeAbsolute(process.env.DICTATION_TRAY_LINUX_NATIVE_UI_DIR)
  const explicitResourcesRoot = normalizeAbsolute(process.env.DICTATION_TRAY_RESOURCES_DIR || process.env.DICTATION_TRAY_BUNDLED_RESOURCES_DIR)
  const resourcesRoot = normalizeAbsolute(process.resourcesPath)
  return [
    explicitRoot,
    explicitResourcesRoot ? path.join(explicitResourcesRoot, 'linux-native-ui') : '',
    resourcesRoot ? path.join(resourcesRoot, 'linux-native-ui') : '',
    path.join(projectRoot(), 'linux-native-ui')
  ].filter(Boolean)
}

export function resolveLinuxNativeUiPath(...segments) {
  const parts = segments.flat().filter(Boolean)
  if (!parts.length) {
    return ''
  }

  for (const root of candidateRoots()) {
    const candidate = path.join(root, ...parts)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return ''
}

export async function launchLinuxNativeUi(scriptName, { statePath = '', commandPath = '' } = {}) {
  const scriptPath = resolveLinuxNativeUiPath(scriptName)
  if (!scriptPath) {
    throw new Error(`Linux native UI script is missing: ${scriptName}`)
  }

  await access(scriptPath)

  const args = ['-m', scriptPath]
  if (statePath) {
    args.push('--state', statePath)
  }
  if (commandPath) {
    args.push('--command', commandPath)
  }

  const child = spawn(GJS_BIN, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore']
  })

  await new Promise((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', (error) => {
      reject(new Error(`Failed to start ${GJS_BIN}: ${error?.message || error}`))
    })
  })

  child.unref()

  return {
    scriptPath,
    statePath: String(statePath || '').trim(),
    commandPath: String(commandPath || '').trim()
  }
}
