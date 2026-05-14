import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')

function normalizeAbsolute(input) {
  const text = String(input || '').trim()
  return text ? path.resolve(text) : ''
}

function dedupe(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const normalized = normalizeAbsolute(value)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

export function projectRoot() {
  return PROJECT_ROOT
}

export function bundledRuntimeRoots() {
  const explicitRuntimeRoot = normalizeAbsolute(process.env.DICTATION_TRAY_BUNDLED_RUNTIME_DIR)
  const explicitResourcesRoot = normalizeAbsolute(process.env.DICTATION_TRAY_RESOURCES_DIR || process.env.DICTATION_TRAY_BUNDLED_RESOURCES_DIR)
  const processResourcesRoot = normalizeAbsolute(process.resourcesPath)

  return dedupe([
    explicitRuntimeRoot,
    explicitResourcesRoot ? path.join(explicitResourcesRoot, 'runtime') : '',
    processResourcesRoot ? path.join(processResourcesRoot, 'runtime') : '',
    path.join(PROJECT_ROOT, 'build', 'bundled-runtime'),
    path.join(PROJECT_ROOT, '.bundle-runtime')
  ])
}

export function resolveBundledRuntimeAsset(...segments) {
  const relativeSegments = segments.flat().filter(Boolean)
  if (!relativeSegments.length) {
    return ''
  }

  for (const root of bundledRuntimeRoots()) {
    const candidate = path.join(root, ...relativeSegments)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return ''
}

function readJsonFileSync(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function resolveManifestPath(runtimeRoot, value, fallback = '') {
  const text = String(value || fallback || '').trim()
  if (!text) {
    return ''
  }
  return path.isAbsolute(text)
    ? text
    : path.join(runtimeRoot, ...text.split(/[\\/]+/).filter(Boolean))
}

export function resolveBundledSttConfig() {
  for (const runtimeRoot of bundledRuntimeRoots()) {
    const manifestPath = path.join(runtimeRoot, 'stt', 'manifest.json')
    if (!existsSync(manifestPath)) {
      continue
    }

    const manifest = readJsonFileSync(manifestPath)
    if (!manifest || typeof manifest !== 'object') {
      continue
    }

    const defaultPythonBin = process.platform === 'win32'
      ? 'stt/python/Scripts/python.exe'
      : 'stt/python/bin/python3'
    const pythonBin = resolveManifestPath(runtimeRoot, manifest.pythonBin, defaultPythonBin)
    const transcribeScript = resolveManifestPath(runtimeRoot, manifest.transcribeScript, 'stt/scripts/faster_whisper_cli.py')
    const workerScript = resolveManifestPath(runtimeRoot, manifest.workerScript, 'stt/scripts/faster_whisper_worker.py')
    const daemonScript = resolveManifestPath(runtimeRoot, manifest.daemonScript, 'stt/scripts/faster_whisper_daemon.py')
    const modelDir = resolveManifestPath(runtimeRoot, manifest.modelDir, '')

    if (!pythonBin || !transcribeScript || !workerScript || !daemonScript || !existsSync(pythonBin) || !existsSync(transcribeScript) || !existsSync(workerScript) || !existsSync(daemonScript)) {
      continue
    }

    return {
      rootDir: runtimeRoot,
      manifestPath,
      pythonBin,
      transcribeScript,
      workerScript,
      daemonScript,
      model: String(manifest.model || '').trim(),
      modelDir: modelDir && existsSync(modelDir) ? modelDir : '',
      source: String(manifest.source || 'bundled-runtime').trim() || 'bundled-runtime'
    }
  }

  return null
}

export function resolveBundledHelperExecutable(helperDirName, exeName) {
  return resolveBundledRuntimeAsset('helpers', helperDirName, exeName)
}
