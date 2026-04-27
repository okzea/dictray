import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set([
  '.git',
  'build',
  'dist',
  'local',
  'node_modules',
  '__pycache__'
])

function log(message) {
  console.log(`[check] ${message}`)
}

function hasCommand(command) {
  const result = spawnSync('which', [command], {
    stdio: ['ignore', 'ignore', 'ignore']
  })
  return result.status === 0
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      stdio: 'inherit',
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

async function collectCheckableScripts(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const result = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.codex-plugin') {
      continue
    }
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue
      }
      result.push(...await collectCheckableScripts(fullPath))
      continue
    }
    if (entry.isFile() && /\.(mjs|js)$/i.test(entry.name)) {
      result.push(fullPath)
    }
  }
  return result
}

async function main() {
  const scripts = await collectCheckableScripts(rootDir)
  for (const scriptPath of scripts.sort()) {
    await run(process.execPath, ['--check', scriptPath])
  }
  log(`Checked ${scripts.length} JavaScript files.`)

  if (process.platform === 'darwin' && hasCommand('swiftc')) {
    await run('swiftc', ['-typecheck', path.join(rootDir, 'scripts', 'macos-hotkey-hook.swift')])
    await run('swiftc', ['-typecheck', path.join(rootDir, 'scripts', 'macos-menu-bar.swift')])
    await run('swiftc', ['-typecheck', path.join(rootDir, 'scripts', 'macos-onboarding.swift')])
    await run('swiftc', ['-typecheck', path.join(rootDir, 'scripts', 'macos-voice-overlay.swift')])
    await run('swiftc', ['-typecheck', path.join(rootDir, 'scripts', 'macos-ui-automation.swift')])
    log('Checked macOS Swift helpers.')
  }

  if (process.platform === 'linux' && hasCommand('gjs')) {
    await run('gjs', ['-m', path.join(rootDir, 'linux-native-ui', 'input-source.mjs'), '--self-test'])
    await run('gjs', ['-m', path.join(rootDir, 'linux-native-ui', 'onboarding.mjs'), '--self-test'])
    log('Checked Linux native UI helpers.')
  }
}

main().catch((error) => {
  console.error(`[check] ${error?.message || error}`)
  process.exitCode = 1
})
