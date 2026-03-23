import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
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
  }
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

  await ensureBundledSttRuntime({
    rootDir,
    outputRoot,
    logger: log,
    env: process.env
  })

  for (const project of helperProjects) {
    await publishHelper(project)
  }

  log('Bundled runtime is ready.')
}

main().catch((error) => {
  console.error(`[bundle-runtime] ${error?.message || error}`)
  process.exitCode = 1
})
