import { access, cp, lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..')

const IS_WIN = process.platform === 'win32'
// Python venv executable paths differ between Windows and Unix
const VENV_BIN_DIR = IS_WIN ? 'Scripts' : 'bin'
const VENV_PYTHON_NAME = IS_WIN ? 'python.exe' : 'python3'
const VENV_PYTHON_REL = path.join(VENV_BIN_DIR, VENV_PYTHON_NAME)
const STANDALONE_PYTHON_RELEASE = '20260414'
const STANDALONE_PYTHON_VERSION = '3.10.20'

function createLogger(logger) {
  if (typeof logger === 'function') {
    return logger
  }
  return () => {}
}

function normalizeAbsolute(input) {
  const text = String(input || '').trim()
  return text ? path.resolve(text) : ''
}

function dedupe(values) {
  const seen = new Set()
  const result = []
  for (const value of values) {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || DEFAULT_ROOT_DIR,
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

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || DEFAULT_ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env || process.env,
      windowsHide: false
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} ${args.join(' ')} exited with code ${code ?? 1}`))
    })
  })
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function findExternalSymlinks(rootDir) {
  const badLinks = []
  const root = path.resolve(rootDir)

  async function visit(entryPath) {
    const stats = await lstat(entryPath)
    if (stats.isSymbolicLink()) {
      const target = await readlink(entryPath)
      const resolvedTarget = path.resolve(path.dirname(entryPath), target)
      if (path.isAbsolute(target) || !isPathInside(root, resolvedTarget)) {
        badLinks.push({
          link: entryPath,
          target
        })
      }
      return
    }

    if (!stats.isDirectory()) {
      return
    }

    const entries = await readdir(entryPath)
    await Promise.all(entries.map((entry) => visit(path.join(entryPath, entry))))
  }

  if (await pathExists(root)) {
    await visit(root)
  }
  return badLinks
}

async function assertPortableRuntime(rootDir) {
  const badLinks = await findExternalSymlinks(rootDir)
  if (badLinks.length > 0) {
    const summary = badLinks
      .slice(0, 4)
      .map((item) => `${path.relative(rootDir, item.link)} -> ${item.target}`)
      .join('; ')
    const error = new Error(`Bundled Python runtime contains non-portable symlinks: ${summary}`)
    error.code = 'NON_PORTABLE_PYTHON_RUNTIME'
    throw error
  }
}

async function prunePythonBytecode(rootDir) {
  async function visit(entryPath) {
    const stats = await lstat(entryPath)
    if (stats.isSymbolicLink()) {
      return
    }
    if (stats.isDirectory()) {
      if (path.basename(entryPath) === '__pycache__') {
        await rm(entryPath, { recursive: true, force: true })
        return
      }
      const entries = await readdir(entryPath)
      await Promise.all(entries.map((entry) => visit(path.join(entryPath, entry))))
      return
    }
    if (entryPath.endsWith('.pyc') || entryPath.endsWith('.pyo')) {
      await rm(entryPath, { force: true })
    }
  }

  if (await pathExists(rootDir)) {
    await visit(rootDir)
  }
}

async function rewritePythonEntrypointShebangs(pythonRoot) {
  const binDir = path.join(pythonRoot, VENV_BIN_DIR)
  if (!await pathExists(binDir)) {
    return
  }

  const entries = await readdir(binDir)
  await Promise.all(entries.map(async (entry) => {
    const filePath = path.join(binDir, entry)
    const stats = await lstat(filePath)
    if (!stats.isFile()) {
      return
    }

    let raw = ''
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return
    }
    if (!raw.startsWith('#!')) {
      return
    }
    const firstNewline = raw.indexOf('\n')
    const shebang = firstNewline === -1 ? raw : raw.slice(0, firstNewline)
    if (!/python/i.test(shebang)) {
      return
    }
    const body = firstNewline === -1 ? '' : raw.slice(firstNewline + 1)
    await writeFile(filePath, `#!/usr/bin/env python3\n${body}`, 'utf8')
  }))
}

async function sanitizePythonRuntime(rootDir) {
  await rewritePythonEntrypointShebangs(rootDir)
  await prunePythonBytecode(rootDir)
}

export async function ensureBundledSttRuntime(options = {}) {
  const rootDir = options.rootDir || DEFAULT_ROOT_DIR
  const outputRoot = options.outputRoot || path.join(rootDir, 'build', 'bundled-runtime')
  const autoPythonRoot = options.autoPythonRoot || path.join(rootDir, 'build', '.bundled-python')
  const requirementsPath = options.requirementsPath || path.join(rootDir, 'scripts', 'bundled-stt-requirements.txt')
  const logger = createLogger(options.logger)
  const env = options.env || process.env
  const sttRoot = path.join(outputRoot, 'stt')

  function log(message) {
    logger(message)
  }

  function standalonePythonTriplet() {
    if (process.platform !== 'darwin') {
      return ''
    }
    if (process.arch === 'arm64') {
      return 'aarch64-apple-darwin'
    }
    if (process.arch === 'x64') {
      return 'x86_64-apple-darwin'
    }
    return ''
  }

  function standalonePythonUrl() {
    const explicit = String(env.DICTATION_TRAY_STANDALONE_PYTHON_URL || '').trim()
    if (explicit) {
      return explicit
    }
    const triplet = standalonePythonTriplet()
    if (!triplet) {
      return ''
    }
    const version = String(env.DICTATION_TRAY_STANDALONE_PYTHON_VERSION || STANDALONE_PYTHON_VERSION).trim() || STANDALONE_PYTHON_VERSION
    const release = String(env.DICTATION_TRAY_STANDALONE_PYTHON_RELEASE || STANDALONE_PYTHON_RELEASE).trim() || STANDALONE_PYTHON_RELEASE
    return `https://github.com/astral-sh/python-build-standalone/releases/download/${release}/cpython-${version}+${release}-${triplet}-install_only.tar.gz`
  }

  async function downloadStandalonePythonArchive(url) {
    const downloadsDir = path.join(rootDir, 'build', 'downloads')
    await mkdir(downloadsDir, { recursive: true })
    const archivePath = path.join(downloadsDir, path.basename(new URL(url).pathname))
    if (await pathExists(archivePath)) {
      return archivePath
    }
    log(`Downloading standalone Python runtime from ${url}.`)
    await run('curl', ['-L', '--fail', '--show-error', '--output', archivePath, url], {
      cwd: rootDir,
      env
    })
    return archivePath
  }

  async function createStandalonePythonRuntime() {
    const url = standalonePythonUrl()
    if (!url) {
      return null
    }

    const archivePath = await downloadStandalonePythonArchive(url)
    const extractRoot = path.join(rootDir, 'build', '.standalone-python-extract')
    await rm(extractRoot, { recursive: true, force: true })
    await mkdir(extractRoot, { recursive: true })
    log('Extracting standalone Python runtime.')
    await run('tar', ['-xzf', archivePath, '-C', extractRoot], {
      cwd: rootDir,
      env
    })

    const installRootCandidates = [
      path.join(extractRoot, 'python', 'install'),
      path.join(extractRoot, 'python')
    ]
    const installRoot = installRootCandidates.find((candidate) => existsSync(path.join(candidate, VENV_PYTHON_REL))) || ''
    if (!installRoot) {
      throw new Error(`Standalone Python archive did not contain ${VENV_PYTHON_REL}.`)
    }

    await rm(autoPythonRoot, { recursive: true, force: true })
    await cp(installRoot, autoPythonRoot, {
      recursive: true,
      force: true,
      dereference: true
    })
    await rm(extractRoot, { recursive: true, force: true })
    await assertPortableRuntime(autoPythonRoot)

    const pythonExe = path.join(autoPythonRoot, VENV_PYTHON_REL)
    log('Installing bundled STT Python dependencies.')
    await run(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      cwd: rootDir,
      env
    })
    await run(pythonExe, ['-m', 'pip', 'install', '-r', requirementsPath], {
      cwd: rootDir,
      env
    })

    return {
      sourceRoot: autoPythonRoot,
      relativePythonBin: VENV_PYTHON_REL,
      sourceType: 'standalone-python'
    }
  }

  function pythonRuntimeCandidates() {
    const explicitRuntimeDir = normalizeAbsolute(env.DICTATION_TRAY_BUNDLED_PYTHON_DIR)
    const explicitPythonExe = normalizeAbsolute(env.DICTATION_TRAY_BUNDLED_PYTHON)
    const fromExe = explicitPythonExe
      ? [
          path.dirname(explicitPythonExe),
          path.basename(path.dirname(explicitPythonExe)).toLowerCase() === 'scripts'
            ? path.dirname(path.dirname(explicitPythonExe))
            : ''
        ]
      : []

    return [
      explicitRuntimeDir && {
        sourceRoot: explicitRuntimeDir,
        relativePythonBin: VENV_PYTHON_REL,
        sourceType: 'explicit-runtime-dir'
      },
      ...fromExe.filter(Boolean).map((candidateRoot) => ({
        sourceRoot: candidateRoot,
        relativePythonBin: path.basename(candidateRoot).toLowerCase() === VENV_BIN_DIR.toLowerCase()
          ? VENV_PYTHON_NAME
          : VENV_PYTHON_REL,
        sourceType: 'explicit-python-exe'
      })),
      {
        sourceRoot: autoPythonRoot,
        relativePythonBin: VENV_PYTHON_REL,
        sourceType: 'generated-runtime'
      },
      {
        sourceRoot: path.join(rootDir, '.venv'),
        relativePythonBin: VENV_PYTHON_REL,
        sourceType: 'repo-venv'
      }
    ].filter(Boolean)
  }

  async function detectExistingPythonRuntime() {
    for (const candidate of pythonRuntimeCandidates()) {
      const primaryPython = path.join(candidate.sourceRoot, candidate.relativePythonBin)
      if (await pathExists(primaryPython)) {
        return candidate
      }

      const standalonePython = path.join(candidate.sourceRoot, VENV_PYTHON_NAME)
      if (await pathExists(standalonePython)) {
        return {
          ...candidate,
          relativePythonBin: VENV_PYTHON_NAME
        }
      }
    }
    return null
  }

  async function validatePythonRuntime(pythonRuntime) {
    const pythonExe = path.join(pythonRuntime.sourceRoot, pythonRuntime.relativePythonBin)
    log(`Validating bundled Python runtime at ${pythonExe}.`)
    await assertPortableRuntime(pythonRuntime.sourceRoot)
    try {
      await runCapture(pythonExe, [
        '-c',
        [
          'import faster_whisper',
          'print(faster_whisper.__file__)'
        ].join('; ')
      ], {
        cwd: rootDir,
        env: {
          ...env,
          PYTHONDONTWRITEBYTECODE: '1'
        }
      })
    } catch {
      throw new Error(
        [
          `Bundled Python runtime is missing faster-whisper: ${pythonExe}.`,
          'Install faster-whisper into that runtime before packaging DicTray.'
        ].join(' ')
      )
    }
  }

  function bootstrapPythonCandidates() {
    return dedupe([
      String(env.DICTATION_TRAY_BUNDLED_PYTHON_BOOTSTRAP || '').trim(),
      'python',
      process.platform === 'win32' ? 'py' : 'python3'
    ])
  }

  async function resolveBootstrapPython() {
    for (const candidate of bootstrapPythonCandidates()) {
      try {
        await runCapture(candidate, ['--version'], {
          cwd: rootDir,
          env
        })
        return candidate
      } catch {
        continue
      }
    }

    throw new Error(
      [
        'Unable to find a bootstrap Python interpreter for the bundled STT runtime.',
        'Install Python and make it available on PATH, or set DICTATION_TRAY_BUNDLED_PYTHON_BOOTSTRAP to a Python executable path.'
      ].join(' ')
    )
  }

  async function createAutoPythonRuntime() {
    const standalonePython = await createStandalonePythonRuntime()
    if (standalonePython) {
      return standalonePython
    }

    const bootstrapPython = await resolveBootstrapPython()
    log(`Creating bundled STT runtime from ${bootstrapPython}.`)
    await rm(autoPythonRoot, { recursive: true, force: true })
    await run(bootstrapPython, ['-m', 'venv', autoPythonRoot], {
      cwd: rootDir,
      env
    })

    const pythonExe = path.join(autoPythonRoot, VENV_PYTHON_REL)
    log('Installing bundled STT Python dependencies.')
    await run(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      cwd: rootDir,
      env
    })
    await run(pythonExe, ['-m', 'pip', 'install', '-r', requirementsPath], {
      cwd: rootDir,
      env
    })
    await sanitizePythonRuntime(autoPythonRoot)
    await assertPortableRuntime(autoPythonRoot)

    return {
      sourceRoot: autoPythonRoot,
      relativePythonBin: VENV_PYTHON_REL,
      sourceType: 'generated-runtime'
    }
  }

  async function installBundledPythonDependencies(pythonRuntime) {
    const pythonExe = path.join(pythonRuntime.sourceRoot, pythonRuntime.relativePythonBin)
    log(`Installing bundled STT Python dependencies into ${pythonExe}.`)
    await run(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip', 'setuptools', 'wheel'], {
      cwd: rootDir,
      env
    })
    await run(pythonExe, ['-m', 'pip', 'install', '-r', requirementsPath], {
      cwd: rootDir,
      env
    })
  }

  async function stagePythonRuntime() {
    let pythonRuntime = await detectExistingPythonRuntime()

    if (!pythonRuntime) {
      pythonRuntime = await createAutoPythonRuntime()
    } else {
      try {
        await validatePythonRuntime(pythonRuntime)
      } catch (error) {
        if (pythonRuntime.sourceType === 'repo-venv') {
          log('Repo .venv is missing faster-whisper. Building a dedicated bundled runtime instead.')
          pythonRuntime = await createAutoPythonRuntime()
        } else if (error?.code === 'NON_PORTABLE_PYTHON_RUNTIME' && pythonRuntime.sourceType === 'generated-runtime') {
          log('Existing generated STT runtime is not portable. Rebuilding it.')
          pythonRuntime = await createAutoPythonRuntime()
        } else if (pythonRuntime.sourceType === 'generated-runtime') {
          log('Existing bundled STT runtime is incomplete. Repairing it in place.')
          await installBundledPythonDependencies(pythonRuntime)
        } else {
          throw error
        }
      }
    }

    await validatePythonRuntime(pythonRuntime)
    const targetRoot = path.join(outputRoot, 'stt', 'python')
    log(`Copying Python runtime from ${pythonRuntime.sourceRoot}.`)
    await cp(pythonRuntime.sourceRoot, targetRoot, {
      recursive: true,
      force: true
    })
    await sanitizePythonRuntime(targetRoot)
    await assertPortableRuntime(targetRoot)
    await validatePythonRuntime({
      sourceRoot: targetRoot,
      relativePythonBin: pythonRuntime.relativePythonBin,
      sourceType: 'staged-runtime'
    })
    return {
      targetRoot,
      relativePythonBin: path.join('stt', 'python', pythonRuntime.relativePythonBin)
    }
  }

  async function stageSttScripts() {
    const targetDir = path.join(outputRoot, 'stt', 'scripts')
    await mkdir(targetDir, { recursive: true })
    const scripts = [
      'faster_whisper_cli.py',
      'faster_whisper_worker.py',
      'faster_whisper_daemon.py'
    ]

    for (const scriptName of scripts) {
      await cp(path.join(rootDir, 'scripts', scriptName), path.join(targetDir, scriptName), { force: true })
    }

    return {
      transcribeScript: path.join('stt', 'scripts', 'faster_whisper_cli.py'),
      workerScript: path.join('stt', 'scripts', 'faster_whisper_worker.py'),
      daemonScript: path.join('stt', 'scripts', 'faster_whisper_daemon.py')
    }
  }

  async function stageModelDirectory() {
    const sourceDir = normalizeAbsolute(env.DICTATION_TRAY_BUNDLED_STT_MODEL_DIR)
    if (!sourceDir || !await pathExists(sourceDir)) {
      return ''
    }

    const targetDir = path.join(outputRoot, 'stt', 'models')
    log(`Copying STT model cache from ${sourceDir}.`)
    await cp(sourceDir, targetDir, {
      recursive: true,
      force: true
    })
    return path.join('stt', 'models')
  }

  async function resolveExistingStagedRuntime() {
    const manifestPath = path.join(outputRoot, 'stt', 'manifest.json')
    const pythonRoot = path.join(outputRoot, 'stt', 'python')
    const pythonExe = path.join(pythonRoot, VENV_PYTHON_REL)
    const transcribeScript = path.join(outputRoot, 'stt', 'scripts', 'faster_whisper_cli.py')
    const workerScript = path.join(outputRoot, 'stt', 'scripts', 'faster_whisper_worker.py')
    const daemonScript = path.join(outputRoot, 'stt', 'scripts', 'faster_whisper_daemon.py')
    const modelDir = path.join(outputRoot, 'stt', 'models')

    if (!await pathExists(manifestPath) || !await pathExists(pythonExe) || !await pathExists(transcribeScript) || !await pathExists(workerScript)) {
      return null
    }

    try {
      await access(pythonExe)
      await access(transcribeScript)
      await access(workerScript)
      await validatePythonRuntime({
        sourceRoot: pythonRoot,
        relativePythonBin: VENV_PYTHON_REL,
        sourceType: 'staged-runtime'
      })
      log('Reusing existing staged STT runtime.')
      return {
        runtimeRoot: outputRoot,
        manifestPath,
        pythonBin: pythonExe,
        transcribeScript,
        workerScript,
        daemonScript,
        modelDir: await pathExists(modelDir) ? modelDir : ''
      }
    } catch (error) {
      log(`Ignoring existing staged STT runtime: ${error?.message || error}`)
      return null
    }
  }

  async function resolveExistingPythonRuntime() {
    const pythonExe = path.join(outputRoot, 'stt', 'python', VENV_PYTHON_REL)
    const modelDir = path.join(outputRoot, 'stt', 'models')
    if (!await pathExists(pythonExe)) {
      return null
    }

    try {
      await access(pythonExe)
      await validatePythonRuntime({
        sourceRoot: path.dirname(path.dirname(pythonExe)),
        relativePythonBin: VENV_PYTHON_REL,
        sourceType: 'staged-python-runtime'
      })
      log('Reusing existing staged Python runtime.')
      return {
        runtimeRoot: outputRoot,
        pythonBin: pythonExe,
        modelDir: await pathExists(modelDir) ? modelDir : ''
      }
    } catch (error) {
      log(`Ignoring existing staged Python runtime: ${error?.message || error}`)
      return null
    }
  }

  async function repairBundledPythonRuntimeMetadata(targetPythonBin) {
    const targetRoot = path.dirname(path.dirname(targetPythonBin))
    const sourcePyvenv = path.join(autoPythonRoot, 'pyvenv.cfg')
    const targetPyvenv = path.join(targetRoot, 'pyvenv.cfg')
    if (!await pathExists(targetPyvenv) && await pathExists(sourcePyvenv)) {
      await cp(sourcePyvenv, targetPyvenv, { force: true })
    }
  }

  async function writeManifest(payload) {
    const manifestPath = path.join(outputRoot, 'stt', 'manifest.json')
    await mkdir(path.dirname(manifestPath), { recursive: true })
    await writeFile(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return manifestPath
  }

  await mkdir(outputRoot, { recursive: true })
  const existingRuntime = await resolveExistingStagedRuntime()
  if (existingRuntime) {
    await repairBundledPythonRuntimeMetadata(existingRuntime.pythonBin)
    await sanitizePythonRuntime(path.join(outputRoot, 'stt', 'python'))
    await validatePythonRuntime({
      sourceRoot: path.join(outputRoot, 'stt', 'python'),
      relativePythonBin: VENV_PYTHON_REL,
      sourceType: 'staged-runtime'
    })
    const stagedScripts = await stageSttScripts()
    const manifestPath = await writeManifest({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: 'stt-runtime-bootstrap',
      pythonBin: path.relative(outputRoot, existingRuntime.pythonBin),
      transcribeScript: stagedScripts.transcribeScript,
      workerScript: stagedScripts.workerScript,
      daemonScript: stagedScripts.daemonScript,
      model: String(env.DICTATION_TRAY_BUNDLED_STT_MODEL || 'base.en').trim() || 'base.en',
      modelDir: existingRuntime.modelDir ? path.relative(outputRoot, existingRuntime.modelDir) : ''
    })
    return {
      ...existingRuntime,
      manifestPath,
      transcribeScript: path.join(outputRoot, stagedScripts.transcribeScript),
      workerScript: path.join(outputRoot, stagedScripts.workerScript),
      daemonScript: path.join(outputRoot, stagedScripts.daemonScript)
    }
  }

  const existingPythonRuntime = await resolveExistingPythonRuntime()
  if (existingPythonRuntime) {
    await repairBundledPythonRuntimeMetadata(existingPythonRuntime.pythonBin)
    await sanitizePythonRuntime(path.join(outputRoot, 'stt', 'python'))
    await validatePythonRuntime({
      sourceRoot: path.join(outputRoot, 'stt', 'python'),
      relativePythonBin: VENV_PYTHON_REL,
      sourceType: 'staged-python-runtime'
    })
    const stagedScripts = await stageSttScripts()
    const modelDir = await stageModelDirectory()
    const resolvedModelDir = modelDir ? path.join(outputRoot, modelDir) : existingPythonRuntime.modelDir
    const manifestPath = await writeManifest({
      version: 1,
      generatedAt: new Date().toISOString(),
      source: 'stt-runtime-bootstrap',
      pythonBin: path.relative(outputRoot, existingPythonRuntime.pythonBin),
      transcribeScript: stagedScripts.transcribeScript,
      workerScript: stagedScripts.workerScript,
      daemonScript: stagedScripts.daemonScript,
      model: String(env.DICTATION_TRAY_BUNDLED_STT_MODEL || 'base.en').trim() || 'base.en',
      modelDir: resolvedModelDir ? path.relative(outputRoot, resolvedModelDir) : ''
    })
    return {
      ...existingPythonRuntime,
      manifestPath,
      transcribeScript: path.join(outputRoot, stagedScripts.transcribeScript),
      workerScript: path.join(outputRoot, stagedScripts.workerScript),
      daemonScript: path.join(outputRoot, stagedScripts.daemonScript),
      modelDir: resolvedModelDir
    }
  }
  await rm(sttRoot, { recursive: true, force: true })

  const pythonRuntime = await stagePythonRuntime()
  const stagedScripts = await stageSttScripts()
  const modelDir = await stageModelDirectory()
  const manifestPath = await writeManifest({
    version: 1,
    generatedAt: new Date().toISOString(),
    source: 'stt-runtime-bootstrap',
    pythonBin: pythonRuntime.relativePythonBin,
    transcribeScript: stagedScripts.transcribeScript,
    workerScript: stagedScripts.workerScript,
    daemonScript: stagedScripts.daemonScript,
    model: String(env.DICTATION_TRAY_BUNDLED_STT_MODEL || 'base.en').trim() || 'base.en',
    modelDir
  })

  return {
    runtimeRoot: outputRoot,
    manifestPath,
    pythonBin: path.join(outputRoot, pythonRuntime.relativePythonBin),
    transcribeScript: path.join(outputRoot, stagedScripts.transcribeScript),
    workerScript: path.join(outputRoot, stagedScripts.workerScript),
    daemonScript: path.join(outputRoot, stagedScripts.daemonScript),
    modelDir: modelDir ? path.join(outputRoot, modelDir) : ''
  }
}
