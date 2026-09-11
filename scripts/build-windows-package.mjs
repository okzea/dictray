// Builds a portable Windows package: unzip anywhere and run DicTray.cmd.
//
//   node scripts/build-windows-package.mjs --dir       stage dist/DicTray-windows-x64
//   node scripts/build-windows-package.mjs --archive   also produce the .zip
//
// The bundled CUDA libraries are deliberately left out. They are roughly 2 GB,
// which alone exceeds the 2 GB GitHub release asset limit, and they are useless
// on machines without an NVIDIA GPU. `pnpm gpu:setup` installs them on demand.

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distRoot = path.join(rootDir, 'dist')
const bundleRuntimeScript = path.join(rootDir, 'scripts', 'prepare-bundled-runtime.mjs')
const bundledRuntimeRoot = path.join(rootDir, 'build', 'bundled-runtime')
const packageName = 'DicTray-windows-x64'

// Installed post-hoc by scripts/setup-gpu-acceleration.mjs.
const EXCLUDED_RUNTIME_DIRS = new Set(['nvidia'])

const HELPER_PROJECTS = [
  { dir: 'windows-hotkey-hook', csproj: 'WindowsHotkeyHook.csproj' },
  { dir: 'windows-ui-automation', csproj: 'WindowsUiAutomation.csproj' },
  { dir: 'windows-system-volume', csproj: 'WindowsSystemVolume.csproj' },
  { dir: 'windows-native-capture', csproj: 'WindowsNativeCapture.csproj' },
  { dir: 'windows-tray-host', csproj: 'WindowsTrayHost.csproj' },
  { dir: 'windows-voice-overlay', csproj: 'WindowsVoiceOverlay.csproj' }
]

function log(message) {
  console.log(`[windows-package] ${message}`)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      stdio: options.stdio || 'inherit',
      env: options.env || process.env,
      windowsHide: true
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

function parseArgs(argv = process.argv.slice(2)) {
  return {
    archive: argv.includes('--archive'),
    dirOnly: argv.includes('--dir'),
    skipRuntime: argv.includes('--skip-runtime')
  }
}

async function readPackageVersion() {
  const payload = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))
  return String(payload?.version || '0.1.0').trim() || '0.1.0'
}

// A .cmd rather than a shortcut: it needs no COM, survives being moved with the
// folder, and keeps the package a plain unzip-and-run directory.
function launcherScript() {
  return [
    '@echo off',
    'setlocal',
    'set "DICTRAY_HOME=%~dp0"',
    'set "DICTATION_TRAY_PACKAGED=1"',
    'set "DICTATION_TRAY_BUNDLED_RUNTIME_DIR=%DICTRAY_HOME%resources\\runtime"',
    'start "" /b "%DICTRAY_HOME%resources\\node\\node.exe" "%DICTRAY_HOME%resources\\app\\scripts\\run-tray.mjs" %*',
    'endlocal'
  ].join('\r\n') + '\r\n'
}

async function copyRuntimeWithoutCuda(source, destination) {
  await cp(source, destination, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (entry) => {
      const segments = path.relative(source, entry).split(path.sep)
      return !segments.some((segment) => EXCLUDED_RUNTIME_DIRS.has(segment))
    }
  })
}

async function stagePackage(outputDir, version, { skipRuntime = false } = {}) {
  const resourcesDir = path.join(outputDir, 'resources')
  const appDir = path.join(resourcesDir, 'app')

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(appDir, { recursive: true })

  if (skipRuntime) {
    log('Reusing the existing bundled runtime (--skip-runtime).')
  } else {
    log('Preparing bundled runtime.')
    await run(process.execPath, [bundleRuntimeScript])
  }

  log('Building Windows helpers.')
  for (const project of HELPER_PROJECTS) {
    await run('dotnet', ['build', path.join('scripts', project.dir, project.csproj), '-c', 'Release', '--nologo', '-v', 'q'])
  }

  log('Copying application sources.')
  for (const entry of ['src', 'tray', 'assets', 'package.json', 'dictation-tray.config.json']) {
    await cp(path.join(rootDir, entry), path.join(appDir, entry), { recursive: true, force: true, dereference: true })
  }
  await mkdir(path.join(appDir, 'scripts'), { recursive: true })
  for (const entry of ['run-tray.mjs', 'start.mjs', 'setup-gpu-acceleration.mjs', 'stt-runtime-bootstrap.mjs']) {
    await cp(path.join(rootDir, 'scripts', entry), path.join(appDir, 'scripts', entry), { force: true, dereference: true })
  }

  log('Copying bundled runtime (excluding CUDA libraries).')
  await copyRuntimeWithoutCuda(bundledRuntimeRoot, path.join(resourcesDir, 'runtime'))

  log('Copying Node runtime.')
  await mkdir(path.join(resourcesDir, 'node'), { recursive: true })
  await cp(process.execPath, path.join(resourcesDir, 'node', 'node.exe'), { force: true, dereference: true })

  await writeFile(path.join(outputDir, 'DicTray.cmd'), launcherScript(), 'utf8')
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
    version,
    builtAt: new Date().toISOString(),
    platform: 'win32',
    launcher: 'DicTray.cmd',
    resourcesDir: 'resources',
    gpuSupport: 'run "resources\\node\\node.exe resources\\app\\scripts\\setup-gpu-acceleration.mjs" to enable CUDA'
  }, null, 2)}
`, 'utf8')
}

async function createArchive(outputDir) {
  const archivePath = path.join(distRoot, `${packageName}.zip`)
  await rm(archivePath, { force: true })
  log(`Creating ${archivePath}.`)
  // Compress-Archive is present on every supported Windows host, so the build
  // needs no third-party archiver.
  await run('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    `Compress-Archive -Path '${outputDir}' -DestinationPath '${archivePath}' -CompressionLevel Optimal`
  ])
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('Windows packaging is only supported on Windows hosts.')
  }

  const args = parseArgs()
  const version = await readPackageVersion()
  const outputDir = path.join(distRoot, packageName)
  await mkdir(distRoot, { recursive: true })
  await stagePackage(outputDir, version, { skipRuntime: args.skipRuntime })

  if (!args.dirOnly || args.archive) {
    await createArchive(outputDir)
  }

  log(`Windows package ready at ${outputDir}.`)
}

main().catch((error) => {
  console.error(`[windows-package] ${error?.message || error}`)
  process.exitCode = 1
})
