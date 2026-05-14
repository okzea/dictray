import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureBundledSttRuntime } from './stt-runtime-bootstrap.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const outputRoot = path.join(rootDir, 'build', 'bundled-runtime')

const helperProjects = [
  {
    name: 'windows-hotkey-hook',
    projectPath: path.join(rootDir, 'scripts', 'windows-hotkey-hook', 'WindowsHotkeyHook.csproj'),
    exeName: 'WindowsHotkeyHook.exe'
  },
  {
    name: 'windows-ui-automation',
    projectPath: path.join(rootDir, 'scripts', 'windows-ui-automation', 'WindowsUiAutomation.csproj'),
    exeName: 'WindowsUiAutomation.exe'
  },
  {
    name: 'windows-system-volume',
    projectPath: path.join(rootDir, 'scripts', 'windows-system-volume', 'WindowsSystemVolume.csproj'),
    exeName: 'WindowsSystemVolume.exe'
  },
  {
    name: 'windows-native-capture',
    projectPath: path.join(rootDir, 'scripts', 'windows-native-capture', 'WindowsNativeCapture.csproj'),
    exeName: 'WindowsNativeCapture.exe'
  },
  {
    name: 'windows-tray-host',
    projectPath: path.join(rootDir, 'scripts', 'windows-tray-host', 'WindowsTrayHost.csproj'),
    exeName: 'WindowsTrayHost.exe'
  }
]

const linuxCoreEntries = [
  { source: path.join(rootDir, 'src'), destination: 'src' },
  { source: path.join(rootDir, 'tray'), destination: 'tray' },
  { source: path.join(rootDir, 'assets'), destination: 'assets' },
  { source: path.join(rootDir, 'package.json'), destination: 'package.json' },
  { source: path.join(rootDir, 'dictation-tray.config.json'), destination: 'dictation-tray.config.json' }
]

function log(message) {
  console.log(`[bundle-runtime] ${message}`)
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

function dedupe(values) {
  return [...new Set(values.filter(Boolean))]
}

function hasCommand(command) {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'ignore', 'ignore']
  })
  return result.status === 0
}

function isSystemLibrary(filePath) {
  return filePath.startsWith('/lib/')
    || filePath.startsWith('/lib64/')
    || filePath.startsWith('/usr/lib/')
    || filePath.startsWith('/usr/lib64/')
}

function parseBundledLibraryPaths(lddOutput = '') {
  const matches = []
  for (const line of String(lddOutput || '').split(/\r?\n/)) {
    const match = line.match(/=>\s+(\/\S+)/)
    if (!match) {
      continue
    }

    const filePath = String(match[1] || '').trim()
    if (!filePath || isSystemLibrary(filePath)) {
      continue
    }
    matches.push(filePath)
  }
  return dedupe(matches)
}

async function stageLinuxHeadlessCore() {
  const coreRoot = path.join(outputRoot, 'linux-core')
  log(`Staging Linux headless core under ${coreRoot}.`)
  await mkdir(coreRoot, { recursive: true })

  for (const entry of linuxCoreEntries) {
    await cp(entry.source, path.join(coreRoot, entry.destination), {
      recursive: true,
      force: true,
      dereference: true
    })
  }

  await writeFile(path.join(coreRoot, 'manifest.json'), `${JSON.stringify({
    stagedAt: new Date().toISOString(),
    entrypoint: 'tray/main.mjs',
    source: 'prepare-bundled-runtime'
  }, null, 2)}\n`, 'utf8')
}

async function stageLinuxNodeRuntime() {
  const nodeRoot = path.join(outputRoot, 'node')
  const binDir = path.join(nodeRoot, 'bin')
  const libDir = path.join(nodeRoot, 'lib')
  await mkdir(binDir, { recursive: true })
  await mkdir(libDir, { recursive: true })

  if (process.platform !== 'linux') {
    await writeFile(path.join(nodeRoot, 'manifest.json'), `${JSON.stringify({
      stagedAt: new Date().toISOString(),
      platform: process.platform,
      skipped: true,
      reason: 'Linux-only Node runtime bundling is skipped on non-Linux hosts.'
    }, null, 2)}\n`, 'utf8')
    log('Skipping Linux Node runtime bundle on non-Linux host.')
    return
  }

  const nodeExec = path.resolve(process.execPath)
  log(`Bundling Linux Node runtime from ${nodeExec}.`)
  const ldd = spawnSync('ldd', [nodeExec], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (ldd.status !== 0) {
    throw new Error(`ldd ${nodeExec} failed: ${String(ldd.stderr || '').trim() || 'unknown error'}`)
  }

  const bundledLibraries = []
  for (const sourcePath of parseBundledLibraryPaths(ldd.stdout)) {
    const destinationPath = path.join(libDir, path.basename(sourcePath))
    await cp(sourcePath, destinationPath, {
      force: true,
      dereference: true
    })
    await chmod(destinationPath, 0o755).catch(() => null)
    bundledLibraries.push(path.basename(destinationPath))
  }

  const bundledNodePath = path.join(binDir, 'node')
  await cp(nodeExec, bundledNodePath, {
    force: true,
    dereference: true
  })
  await chmod(bundledNodePath, 0o755).catch(() => null)

  await writeFile(path.join(nodeRoot, 'manifest.json'), `${JSON.stringify({
    stagedAt: new Date().toISOString(),
    platform: process.platform,
    executable: 'bin/node',
    libraryDir: 'lib',
    bundledLibraries
  }, null, 2)}\n`, 'utf8')
}

async function publishHelper(project) {
  const outputDir = path.join(outputRoot, 'helpers', project.name)
  log(`Publishing ${project.name}.`)
  await mkdir(outputDir, { recursive: true })
  await run('dotnet', [
    'publish',
    project.projectPath,
    '-c',
    'Release',
    '-r',
    'win-x64',
    '--self-contained',
    'true',
    '-p:PublishSingleFile=true',
    '-p:EnableCompressionInSingleFile=true',
    '-p:DebugType=None',
    '-p:DebugSymbols=false',
    '-o',
    outputDir
  ])
  return path.join(outputDir, project.exeName)
}

async function main() {
  log(`Preparing bundled runtime under ${outputRoot}.`)
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })

  await stageLinuxHeadlessCore()
  await stageLinuxNodeRuntime()

  await ensureBundledSttRuntime({
    rootDir,
    outputRoot,
    logger: log,
    env: process.env
  })

  if (hasCommand('dotnet')) {
    for (const project of helperProjects) {
      await publishHelper(project)
    }
  } else {
    log('Skipping Windows helper publishing because dotnet is unavailable on this host.')
  }

  log('Bundled runtime is ready.')
}

main().catch((error) => {
  console.error(`[bundle-runtime] ${error?.message || error}`)
  process.exitCode = 1
})
