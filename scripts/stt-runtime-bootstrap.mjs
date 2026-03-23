import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT_DIR = path.resolve(__dirname, '..')

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
        relativePythonBin: path.join('Scripts', 'python.exe'),
        sourceType: 'explicit-runtime-dir'
      },
      ...fromExe.filter(Boolean).map((candidateRoot) => ({
        sourceRoot: candidateRoot,
        relativePythonBin: path.basename(candidateRoot).toLowerCase() === 'scripts'
          ? 'python.exe'
          : path.join('Scripts', 'python.exe'),
        sourceType: 'explicit-python-exe'
      })),
      {
        sourceRoot: autoPythonRoot,
        relativePythonBin: path.join('Scripts', 'python.exe'),
        sourceType: 'generated-runtime'
      },
      {
        sourceRoot: path.join(rootDir, '.venv'),
        relativePythonBin: path.join('Scripts', 'python.exe'),
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

      const standalonePython = path.join(candidate.sourceRoot, 'python.exe')
      if (await pathExists(standalonePython)) {
        return {
          ...candidate,
          relativePythonBin: 'python.exe'
        }
      }
    }
    return null
  }

  async function validatePythonRuntime(pythonRuntime) {
    const pythonExe = path.join(pythonRuntime.sourceRoot, pythonRuntime.relativePythonBin)
    log(`Validating bundled Python runtime at ${pythonExe}.`)
    try {
      await runCapture(pythonExe, [
        '-c',
        [
          'import faster_whisper',
          'print(faster_whisper.__file__)'
        ].join('; ')
      ], {
        cwd: rootDir,
        env
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
    const bootstrapPython = await resolveBootstrapPython()
    log(`Creating bundled STT runtime from ${bootstrapPython}.`)
    await rm(autoPythonRoot, { recursive: true, force: true })
    await run(bootstrapPython, ['-m', 'venv', autoPythonRoot], {
      cwd: rootDir,
      env
    })

    const pythonExe = path.join(autoPythonRoot, 'Scripts', 'python.exe')
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
      relativePythonBin: path.join('Scripts', 'python.exe'),
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
    const pythonExe = path.join(pythonRoot, 'Scripts', 'python.exe')
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
    } catch {
      return null
    }
  }

  async function resolveExistingPythonRuntime() {
    const pythonExe = path.join(outputRoot, 'stt', 'python', 'Scripts', 'python.exe')
    const modelDir = path.join(outputRoot, 'stt', 'models')
    if (!await pathExists(pythonExe)) {
      return null
    }

    try {
      await access(pythonExe)
      log('Reusing existing staged Python runtime.')
      return {
        runtimeRoot: outputRoot,
        pythonBin: pythonExe,
        modelDir: await pathExists(modelDir) ? modelDir : ''
      }
    } catch {
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
