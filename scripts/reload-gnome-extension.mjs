import os from 'node:os'
import path from 'node:path'
import { cp, mkdir } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const uuid = 'dictray-gnome-panel@okzea'
const sourceDir = path.join(rootDir, 'gnome-panel-extension')
const xdgDataHome = String(process.env.XDG_DATA_HOME || '').trim() || path.join(os.homedir(), '.local', 'share')
const extensionsDir = path.join(xdgDataHome, 'gnome-shell', 'extensions')
const targetDir = path.join(extensionsDir, uuid)

function log(message) {
  console.log(`[dictray-gnome] ${message}`)
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      stdio: 'inherit',
      env: process.env,
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

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('GNOME extension reload is only supported on Linux.')
  }

  await mkdir(extensionsDir, { recursive: true })
  log(`Syncing extension into ${targetDir}`)
  await cp(sourceDir, targetDir, { recursive: true, force: true })

  const schemaDir = path.join(targetDir, 'schemas')
  log(`Compiling schemas in ${schemaDir}`)
  await run('glib-compile-schemas', [schemaDir])

  log(`Disabling ${uuid}`)
  await run('gnome-extensions', ['disable', uuid]).catch(() => {})

  log(`Enabling ${uuid}`)
  await run('gnome-extensions', ['enable', uuid])

  log('Extension reloaded.')
}

main().catch((error) => {
  console.error(`[dictray-gnome] ${error?.message || error}`)
  process.exitCode = 1
})
