#!/usr/bin/env node

// Detects the local GPU and installs the CUDA runtime libraries that CTranslate2
// needs for GPU transcription, into the bundled STT Python environment.
//
//   node scripts/setup-gpu-acceleration.mjs           detect, install, verify
//   node scripts/setup-gpu-acceleration.mjs --check    report only, change nothing
//
// Nothing is installed system-wide: the CUDA libraries land in the bundled
// runtime's site-packages, so removing build/ removes them too.

import { spawn } from 'node:child_process'
import { access, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const configPath = path.join(rootDir, 'dictation-tray.config.json')

// CTranslate2 4.x links against the CUDA 12 runtime and cuDNN 9.
const CUDA_PACKAGES = ['nvidia-cublas-cu12', 'nvidia-cudnn-cu12']

const checkOnly = process.argv.includes('--check')

function log(message) {
  console.log(`[gpu-setup] ${message}`)
}

function run(command, args, { capture = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    if (capture) {
      child.stdout.on('data', (chunk) => { stdout += String(chunk) })
      child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    }
    child.on('error', (error) => resolve({ ok: false, code: 1, stdout, stderr: String(error?.message || error) }))
    child.on('exit', (code) => resolve({ ok: code === 0, code: code ?? 1, stdout, stderr }))
  })
}

function pythonExeName() {
  return process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3')
}

// The active runtime under build/bundled-runtime is re-copied from
// build/.bundled-python on every launch, so anything installed only into the
// copy is wiped on the next start. Install into both.
function bundledPythonPath() {
  return path.join(rootDir, 'build', 'bundled-runtime', 'stt', 'python', pythonExeName())
}

function sourcePythonPath() {
  return path.join(rootDir, 'build', '.bundled-python', pythonExeName())
}

async function existingPythons() {
  const candidates = [sourcePythonPath(), bundledPythonPath()]
  const found = []
  for (const candidate of candidates) {
    try {
      await access(candidate)
      found.push(candidate)
    } catch {
      // not present — skip
    }
  }
  return found
}

async function detectGpu() {
  const result = await run('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'], { capture: true })
  if (!result.ok) {
    return { vendor: 'none' }
  }
  const [name = '', driver = ''] = String(result.stdout || '').trim().split('\n')[0].split(',').map((v) => v.trim())
  return name ? { vendor: 'nvidia', name, driver } : { vendor: 'none' }
}

async function probeCuda(pythonBin) {
  // Mirrors _register_bundled_cuda_libraries() in faster_whisper_daemon.py:
  // CTranslate2 finds cuBLAS/cuDNN via PATH, not os.add_dll_directory.
  const script = [
    'import json, os, sysconfig',
    'if os.name == "nt":',
    '    _root = os.path.join(sysconfig.get_paths().get("purelib") or "", "nvidia")',
    '    _dirs = []',
    '    if os.path.isdir(_root):',
    '        for _entry in sorted(os.listdir(_root)):',
    '            _bin = os.path.join(_root, _entry, "bin")',
    '            if os.path.isdir(_bin):',
    '                _dirs.append(_bin)',
    '    if _dirs:',
    '        os.environ["PATH"] = os.pathsep.join(_dirs + [os.environ.get("PATH", "")])',
    'out = {"cudaDevices": 0, "inference": False, "error": ""}',
    'try:',
    '    import ctranslate2',
    '    out["cudaDevices"] = ctranslate2.get_cuda_device_count()',
    'except Exception as error:',
    '    out["error"] = str(error)',
    'if out["cudaDevices"] > 0:',
    '    try:',
    '        import numpy as np',
    '        from faster_whisper import WhisperModel',
    '        model = WhisperModel("tiny.en", device="cuda", compute_type="float16")',
    '        list(model.transcribe(np.zeros(16000, dtype="float32"))[0])',
    '        out["inference"] = True',
    '    except Exception as error:',
    '        out["error"] = str(error)',
    'print(json.dumps(out))'
  ].join('\n')

  const result = await run(pythonBin, ['-c', script], { capture: true })
  const line = String(result.stdout || '').trim().split('\n').filter(Boolean).pop()
  try {
    return JSON.parse(line)
  } catch {
    return { cudaDevices: 0, inference: false, error: String(result.stderr || 'probe failed').trim() }
  }
}

async function setConfigDevice(device, computeType) {
  let raw
  try {
    raw = await readFile(configPath, 'utf8')
  } catch {
    log('Config file not found; leaving device selection unchanged.')
    return false
  }
  const config = JSON.parse(raw)
  config.stt = config.stt || {}
  config.stt.local = config.stt.local || {}
  if (config.stt.local.device === device && config.stt.local.computeType === computeType) {
    return false
  }
  config.stt.local.device = device
  config.stt.local.computeType = computeType
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return true
}

async function main() {
  const pythonBin = bundledPythonPath()
  try {
    await access(pythonBin)
  } catch {
    log('Bundled STT runtime is missing. Run `pnpm start` once to prepare it, then retry.')
    process.exitCode = 1
    return
  }

  log(`Platform: ${process.platform} ${process.arch}`)

  const gpu = await detectGpu()
  if (gpu.vendor !== 'nvidia') {
    log('No NVIDIA GPU detected. GPU acceleration is only supported on NVIDIA hardware; staying on CPU.')
    if (!checkOnly) {
      await setConfigDevice('cpu', 'int8')
    }
    return
  }
  log(`GPU: ${gpu.name} (driver ${gpu.driver})`)

  if (process.platform === 'darwin') {
    log('macOS has no CUDA support; staying on CPU.')
    return
  }

  let probe = await probeCuda(pythonBin)
  log(`CUDA devices visible to CTranslate2: ${probe.cudaDevices}`)

  if (probe.inference) {
    log('CUDA inference already works. No install needed.')
  } else {
    if (checkOnly) {
      log(`CUDA inference unavailable: ${probe.error || 'unknown error'}`)
      log(`Would install: ${CUDA_PACKAGES.join(', ')}`)
      return
    }

    const targets = await existingPythons()
    log(`Installing CUDA runtime libraries: ${CUDA_PACKAGES.join(', ')}`)
    log(`This downloads roughly 1.3 GB per runtime (${targets.length} target(s)) and may take a few minutes.`)
    for (const target of targets) {
      log(`  -> ${path.relative(rootDir, target)}`)
      const install = await run(target, ['-m', 'pip', 'install', '--no-input', ...CUDA_PACKAGES])
      if (!install.ok) {
        log('Install failed. Staying on CPU.')
        await setConfigDevice('cpu', 'int8')
        process.exitCode = 1
        return
      }
    }

    probe = await probeCuda(pythonBin)
    if (!probe.inference) {
      log(`CUDA still unavailable after install: ${probe.error || 'unknown error'}`)
      log('Staying on CPU so dictation keeps working.')
      await setConfigDevice('cpu', 'int8')
      process.exitCode = 1
      return
    }
    log('CUDA inference verified.')
  }

  const changed = await setConfigDevice('auto', 'auto')
  log(changed
    ? 'Config set to device "auto" — DicTray will use the GPU.'
    : 'Config already set to device "auto".')
  log('Restart DicTray to pick up the change.')
}

main().catch((error) => {
  log(`Unexpected failure: ${error?.message || error}`)
  process.exitCode = 1
})
