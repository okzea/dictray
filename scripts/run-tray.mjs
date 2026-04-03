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

if (process.platform !== 'linux') {
  console.error('[dictray] This branch now supports Linux only.')
  process.exit(1)
}

spawnWithExit(process.execPath, ['tray/main.mjs', ...process.argv.slice(2)], {
  ...process.env,
  DICTATION_TRAY_LINUX_HEADLESS: '1'
})
