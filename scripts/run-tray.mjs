import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

function windowsTrayEnv() {
  const dotnetRoot = path.join(rootDir, '.dotnet-cli')
  const hasLocalDotnet = existsSync(path.join(dotnetRoot, 'dotnet.exe'))
  return {
    ...process.env,
    DICTATION_TRAY_NODE_BIN: process.execPath,
    ...(hasLocalDotnet
      ? {
          DOTNET_ROOT: dotnetRoot,
          PATH: `${dotnetRoot}${path.delimiter}${process.env.PATH || ''}`
        }
      : {})
  }
}

function spawnWithExit(command, args, env) {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env
  })

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
      return
    }
    process.exit(code ?? 0)
  })

  child.on('error', (error) => {
    console.error(`[dictray] Failed to start tray runtime: ${error?.message || error}`)
    process.exit(1)
  })
}

if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
  console.error('[dictray] This branch supports Linux, macOS, and Windows.')
  process.exit(1)
}

spawnWithExit(process.execPath, ['tray/main.mjs', ...process.argv.slice(2)], process.platform === 'linux'
  ? {
      ...process.env,
      DICTATION_TRAY_LINUX_HEADLESS: '1'
    }
  : process.platform === 'win32'
    ? windowsTrayEnv()
    : process.env)
