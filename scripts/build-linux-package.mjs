import { chmod, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distRoot = path.join(rootDir, 'dist')
const bundleRuntimeScript = path.join(rootDir, 'scripts', 'prepare-bundled-runtime.mjs')
const bundledRuntimeRoot = path.join(rootDir, 'build', 'bundled-runtime')
const packageName = 'DicTray-linux-x64'

function log(message) {
  console.log(`[linux-package] ${message}`)
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

function parseArgs(argv = process.argv.slice(2)) {
  return {
    archive: argv.includes('--archive'),
    dirOnly: argv.includes('--dir')
  }
}

async function readPackageVersion() {
  const payload = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))
  return String(payload?.version || '0.1.0').trim() || '0.1.0'
}

function launcherScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
SOURCE="${'${BASH_SOURCE[0]}'}"
while [[ -L "$SOURCE" ]]; do
  SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
  TARGET="$(readlink "$SOURCE")"
  if [[ "$TARGET" == /* ]]; then
    SOURCE="$TARGET"
  else
    SOURCE="$SCRIPT_DIR/$TARGET"
  fi
done
SCRIPT_DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
export DICTATION_TRAY_LINUX_HEADLESS=1
export DICTATION_TRAY_PACKAGED=1
export DICTATION_TRAY_RESOURCES_DIR="$APP_ROOT/resources"
if [[ -d "$APP_ROOT/resources/runtime/node/lib" ]]; then
  if [[ -n "${'${LD_LIBRARY_PATH:-}'}" ]]; then
    export LD_LIBRARY_PATH="$APP_ROOT/resources/runtime/node/lib:$LD_LIBRARY_PATH"
  else
    export LD_LIBRARY_PATH="$APP_ROOT/resources/runtime/node/lib"
  fi
fi
exec "$APP_ROOT/resources/runtime/node/bin/node" "$APP_ROOT/resources/runtime/linux-core/tray/main.mjs" "$@"
`
}

function desktopEntry() {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=DicTray
Comment=Local dictation tray for GNOME Linux
Exec=dictray
Icon=dictray
Terminal=false
Categories=Utility;AudioVideo;
`
}

async function stagePackage(outputDir, version) {
  const resourcesDir = path.join(outputDir, 'resources')
  const binDir = path.join(outputDir, 'bin')
  const shareDir = path.join(outputDir, 'share', 'applications')

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(resourcesDir, { recursive: true })
  await mkdir(binDir, { recursive: true })
  await mkdir(shareDir, { recursive: true })

  log('Preparing bundled runtime.')
  await run(process.execPath, [bundleRuntimeScript])

  log('Copying packaged resources.')
  await cp(path.join(rootDir, 'gnome-panel-extension'), path.join(resourcesDir, 'gnome-panel-extension'), { recursive: true, force: true, dereference: true })
  await cp(path.join(rootDir, 'linux-native-ui'), path.join(resourcesDir, 'linux-native-ui'), { recursive: true, force: true, dereference: true })
  await cp(bundledRuntimeRoot, path.join(resourcesDir, 'runtime'), { recursive: true, force: true, dereference: true })

  await writeFile(path.join(binDir, 'dictray'), launcherScript(), 'utf8')
  await chmod(path.join(binDir, 'dictray'), 0o755)
  await writeFile(path.join(shareDir, 'com.okzea.dictray.desktop'), desktopEntry(), 'utf8')
  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
    version,
    builtAt: new Date().toISOString(),
    platform: 'linux',
    launcher: 'bin/dictray',
    resourcesDir: 'resources'
  }, null, 2)}
`, 'utf8')
}

async function createArchive(outputDir) {
  const archivePath = path.join(distRoot, `${packageName}.tar.gz`)
  await rm(archivePath, { force: true })
  log(`Creating ${archivePath}.`)
  await run('tar', ['-czf', archivePath, '-C', distRoot, path.basename(outputDir)])
}

async function main() {
  if (process.platform !== 'linux') {
    throw new Error('Linux packaging is only supported on Linux hosts.')
  }

  const args = parseArgs()
  const version = await readPackageVersion()
  const outputDir = path.join(distRoot, packageName)
  await mkdir(distRoot, { recursive: true })
  await stagePackage(outputDir, version)

  if (!args.dirOnly || args.archive) {
    await createArchive(outputDir)
  }

  log(`Linux package ready at ${outputDir}.`)
}

main().catch((error) => {
  console.error(`[linux-package] ${error?.message || error}`)
  process.exitCode = 1
})
