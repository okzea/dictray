import { spawn } from 'node:child_process'

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

if (!['linux', 'darwin'].includes(process.platform)) {
  console.error('[dictray] This branch supports Linux and macOS.')
  process.exit(1)
}

spawnWithExit(process.execPath, ['tray/main.mjs', ...process.argv.slice(2)], process.platform === 'linux'
  ? {
      ...process.env,
      DICTATION_TRAY_LINUX_HEADLESS: '1'
    }
  : process.env)
