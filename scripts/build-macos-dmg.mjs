import { access, chmod, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ensureBundledSttRuntime } from './stt-runtime-bootstrap.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')
const distRoot = path.join(rootDir, 'dist')
const buildRoot = path.join(rootDir, 'build', 'macos')
const appName = 'DicTray'
const bundleIdentifier = 'com.okzea.dictray'
const archName = process.arch === 'arm64' ? 'arm64' : 'x64'
const packageName = `${appName}-macos-${archName}`

const appCoreEntries = [
  { source: path.join(rootDir, 'src'), destination: 'src' },
  { source: path.join(rootDir, 'tray'), destination: 'tray' },
  { source: path.join(rootDir, 'assets'), destination: 'assets' },
  { source: path.join(rootDir, 'scripts'), destination: 'scripts' },
  { source: path.join(rootDir, 'package.json'), destination: 'package.json' },
  { source: path.join(rootDir, 'dictation-tray.config.json'), destination: 'dictation-tray.config.json' },
  { source: path.join(rootDir, 'README.md'), destination: 'README.md' }
]

function log(message) {
  console.log(`[macos-package] ${message}`)
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

function runCapture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env || process.env,
      windowsHide: false
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      reject(new Error(stderr.trim() || stdout.trim() || `${command} ${args.join(' ')} exited with code ${code ?? 1}`))
    })
  })
}

function hasCommand(command) {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  return result.status === 0
}

function resolveCommand(command) {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  })
  if (result.status !== 0) {
    return ''
  }
  return String(result.stdout || '').split(/\r?\n/, 1)[0].trim()
}

async function pathExists(filePath) {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv = process.argv.slice(2)) {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    dirOnly: argv.includes('--dir'),
    dmg: argv.includes('--dmg') || argv.includes('--archive'),
    skipStt: argv.includes('--skip-stt')
  }
}

function printHelp() {
  console.log([
    'Usage: node scripts/build-macos-dmg.mjs [--dir|--dmg] [--skip-stt]',
    '',
    'Builds dist/DicTray-macos-<arch>/DicTray.app and, by default, a compressed DMG.',
    '',
    'ffmpeg source resolution order:',
    '  DICTATION_TRAY_BUNDLE_FFMPEG',
    '  DICTATION_TRAY_CAPTURE_FFMPEG_BIN',
    '  STT_FFMPEG_BIN',
    '  ffmpeg on PATH',
    '',
    'The builder vendors ffmpeg and non-system dylibs under Contents/Resources/runtime/ffmpeg.'
  ].join('\n'))
}

async function readPackageVersion() {
  const payload = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'))
  return String(payload?.version || '0.1.0').trim() || '0.1.0'
}

function plist(version) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>dictray</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleIdentifier}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${version}</string>
  <key>CFBundleVersion</key>
  <string>${version}</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>DicTray uses System Events to paste dictation into the focused app.</string>
  <key>NSMicrophoneUsageDescription</key>
  <string>DicTray records microphone audio for local speech-to-text dictation.</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
}

function launcherScript() {
  return `#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${'${BASH_SOURCE[0]}'}")" && pwd)"
CONTENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESOURCES_DIR="$CONTENTS_DIR/Resources"
RUNTIME_DIR="$RESOURCES_DIR/runtime"
NODE_BIN="$RUNTIME_DIR/node/bin/node"
FFMPEG_BIN="$RUNTIME_DIR/ffmpeg/bin/ffmpeg"
APP_CORE="$RUNTIME_DIR/app-core"

export DICTATION_TRAY_PACKAGED=1
export DICTATION_TRAY_RESOURCES_DIR="$RESOURCES_DIR"
export DICTATION_TRAY_BUNDLED_RUNTIME_DIR="$RUNTIME_DIR"
export DICTATION_TRAY_FFMPEG_BIN="$FFMPEG_BIN"
export DICTATION_TRAY_CAPTURE_FFMPEG_BIN="$FFMPEG_BIN"
export STT_FFMPEG_BIN="$FFMPEG_BIN"
export PATH="$RUNTIME_DIR/ffmpeg/bin:$RUNTIME_DIR/node/bin:$PATH"

exec "$NODE_BIN" "$APP_CORE/tray/main.mjs" "$@"
`
}

async function stageAppCore(appCoreDir) {
  await mkdir(appCoreDir, { recursive: true })
  for (const entry of appCoreEntries) {
    await cp(entry.source, path.join(appCoreDir, entry.destination), {
      recursive: true,
      force: true,
      dereference: true
    })
  }
}

function resolveNodeSource() {
  const explicit = String(process.env.DICTATION_TRAY_NODE_BIN || '').trim()
  if (explicit) {
    return path.resolve(explicit)
  }
  return path.resolve(process.execPath)
}

async function stageNodeRuntime(runtimeDir) {
  const sourceNode = resolveNodeSource()
  const nodeRoot = path.join(runtimeDir, 'node')
  const nodeBinDir = path.join(runtimeDir, 'node', 'bin')
  const nodeLibDir = path.join(runtimeDir, 'node', 'lib')
  const targetNode = path.join(nodeBinDir, 'node')
  const copied = new Map()

  log(`Bundling Node runtime from ${sourceNode}.`)
  await mkdir(nodeBinDir, { recursive: true })
  await mkdir(nodeLibDir, { recursive: true })
  await cp(sourceNode, targetNode, { force: true, dereference: true })
  await chmod(targetNode, 0o755)

  const deps = parseOtoolDependencies((await runCapture('otool', ['-L', targetNode])).stdout)
  for (const dep of deps) {
    if (isSystemDylib(dep)) {
      continue
    }
    const depSource = resolveDependencyPath(dep, path.dirname(sourceNode), path.dirname(sourceNode))
    if (!depSource || !await pathExists(depSource)) {
      log(`Skipping unresolved Node dependency ${dep}.`)
      continue
    }
    const stagedDep = await stageDylibDependency({
      sourcePath: depSource,
      libDir: nodeLibDir,
      executableDir: path.dirname(sourceNode),
      copied
    })
    await changeInstallName(targetNode, dep, `@executable_path/../lib/${path.basename(stagedDep)}`)
  }

  log('Applying ad-hoc signatures to bundled Node.')
  for (const libraryPath of [...copied.values()].sort((a, b) => a.localeCompare(b))) {
    await signAdHoc(libraryPath)
  }
  await signAdHoc(targetNode)

  await writeFile(path.join(runtimeDir, 'node', 'manifest.json'), `${JSON.stringify({
    stagedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    executable: 'bin/node',
    source: sourceNode,
    bundledLibraries: [...copied.values()].map((filePath) => path.basename(filePath)).sort()
  }, null, 2)}\n`, 'utf8')
}

function resolveFfmpegSource() {
  const explicit = [
    process.env.DICTATION_TRAY_BUNDLE_FFMPEG,
    process.env.DICTATION_TRAY_CAPTURE_FFMPEG_BIN,
    process.env.STT_FFMPEG_BIN
  ].map((value) => String(value || '').trim()).find(Boolean)
  if (explicit) {
    return path.resolve(explicit)
  }
  return resolveCommand('ffmpeg')
}

function parseOtoolDependencies(output = '') {
  const deps = []
  for (const line of String(output || '').split(/\r?\n/).slice(1)) {
    const match = line.match(/^\s+(.+?)\s+\(/)
    if (match?.[1]) {
      deps.push(match[1].trim())
    }
  }
  return deps
}

function isSystemDylib(dep) {
  return dep.startsWith('/usr/lib/')
    || dep.startsWith('/System/Library/')
}

function resolveDependencyPath(dep, loaderDir, executableDir) {
  if (path.isAbsolute(dep)) {
    return dep
  }
  if (dep.startsWith('@loader_path/')) {
    return path.resolve(loaderDir, dep.slice('@loader_path/'.length))
  }
  if (dep.startsWith('@executable_path/')) {
    return path.resolve(executableDir, dep.slice('@executable_path/'.length))
  }
  if (dep.startsWith('@rpath/')) {
    const suffix = dep.slice('@rpath/'.length)
    const candidates = [
      path.join(loaderDir, suffix),
      path.join(loaderDir, '..', 'lib', suffix),
      path.join(loaderDir, '..', 'libexec', 'lib', suffix),
      path.join(executableDir, suffix),
      path.join(executableDir, '..', 'lib', suffix),
      path.join(executableDir, '..', 'libexec', 'lib', suffix),
      path.join('/opt/homebrew/lib', suffix),
      path.join('/usr/local/lib', suffix)
    ]
    return candidates.find((candidate) => spawnSync('test', ['-f', candidate]).status === 0) || ''
  }
  return ''
}

async function changeInstallName(binaryPath, oldName, newName) {
  await run('install_name_tool', ['-change', oldName, newName, binaryPath], { stdio: 'ignore' })
}

async function signAdHoc(binaryPath) {
  if (!hasCommand('codesign')) {
    throw new Error('codesign is required to re-sign bundled macOS binaries after load-path rewrites.')
  }
  await run('codesign', ['--force', '--sign', '-', binaryPath], { stdio: 'ignore' })
}

async function stageDylibDependency({
  sourcePath,
  libDir,
  executableDir,
  copied
}) {
  const resolvedSource = path.resolve(sourcePath)
  const existing = copied.get(resolvedSource)
  if (existing) {
    return existing
  }

  const targetPath = path.join(libDir, path.basename(resolvedSource))
  copied.set(resolvedSource, targetPath)
  await mkdir(libDir, { recursive: true })
  await cp(resolvedSource, targetPath, { force: true, dereference: true })
  await chmod(targetPath, 0o755).catch(() => null)

  const installId = `@loader_path/${path.basename(targetPath)}`
  await run('install_name_tool', ['-id', installId, targetPath], { stdio: 'ignore' }).catch(() => null)

  const deps = parseOtoolDependencies((await runCapture('otool', ['-L', targetPath])).stdout)
  for (const dep of deps) {
    if (isSystemDylib(dep)) {
      continue
    }
    const depSource = resolveDependencyPath(dep, path.dirname(resolvedSource), executableDir)
    if (!depSource || !await pathExists(depSource)) {
      log(`Skipping unresolved dylib dependency ${dep} from ${path.basename(targetPath)}.`)
      continue
    }
    const stagedDep = await stageDylibDependency({
      sourcePath: depSource,
      libDir,
      executableDir,
      copied
    })
    await changeInstallName(targetPath, dep, `@loader_path/${path.basename(stagedDep)}`)
  }

  return targetPath
}

async function signFfmpegRuntime(targetFfmpeg, copiedLibraries) {
  log('Applying ad-hoc signatures to bundled ffmpeg.')
  const libraries = [...copiedLibraries].sort((a, b) => a.localeCompare(b))
  for (const libraryPath of libraries) {
    await signAdHoc(libraryPath)
  }
  await signAdHoc(targetFfmpeg)
}

async function validateFfmpegRuntime(targetFfmpeg) {
  const { stdout, stderr } = await runCapture(targetFfmpeg, ['-version'])
  const output = `${stdout}\n${stderr}`
  if (!output.includes('ffmpeg version')) {
    throw new Error(`Bundled ffmpeg did not report its version: ${targetFfmpeg}`)
  }
}

async function stageFfmpegRuntime(runtimeDir) {
  const sourceFfmpeg = resolveFfmpegSource()
  if (!sourceFfmpeg || !await pathExists(sourceFfmpeg)) {
    throw new Error(
      [
        'ffmpeg is required to build the macOS DMG because the app vendors it into the bundle.',
        'Install it with `brew install ffmpeg`, or set DICTATION_TRAY_BUNDLE_FFMPEG to an ffmpeg binary.'
      ].join(' ')
    )
  }
  if (!hasCommand('otool') || !hasCommand('install_name_tool')) {
    throw new Error('macOS packaging needs otool and install_name_tool from Xcode Command Line Tools.')
  }

  const ffmpegRoot = path.join(runtimeDir, 'ffmpeg')
  const binDir = path.join(ffmpegRoot, 'bin')
  const libDir = path.join(ffmpegRoot, 'lib')
  const targetFfmpeg = path.join(binDir, 'ffmpeg')
  const copied = new Map()

  log(`Bundling ffmpeg from ${sourceFfmpeg}.`)
  await mkdir(binDir, { recursive: true })
  await mkdir(libDir, { recursive: true })
  await cp(sourceFfmpeg, targetFfmpeg, { force: true, dereference: true })
  await chmod(targetFfmpeg, 0o755)

  const deps = parseOtoolDependencies((await runCapture('otool', ['-L', targetFfmpeg])).stdout)
  for (const dep of deps) {
    if (isSystemDylib(dep)) {
      continue
    }
    const depSource = resolveDependencyPath(dep, path.dirname(sourceFfmpeg), binDir)
    if (!depSource || !await pathExists(depSource)) {
      log(`Skipping unresolved ffmpeg dependency ${dep}.`)
      continue
    }
    const stagedDep = await stageDylibDependency({
      sourcePath: depSource,
      libDir,
      executableDir: binDir,
      copied
    })
    await changeInstallName(targetFfmpeg, dep, `@executable_path/../lib/${path.basename(stagedDep)}`)
  }

  await signFfmpegRuntime(targetFfmpeg, copied.values())
  await validateFfmpegRuntime(targetFfmpeg)

  await writeFile(path.join(ffmpegRoot, 'manifest.json'), `${JSON.stringify({
    stagedAt: new Date().toISOString(),
    executable: 'bin/ffmpeg',
    source: sourceFfmpeg,
    bundledLibraries: [...copied.values()].map((filePath) => path.basename(filePath)).sort()
  }, null, 2)}\n`, 'utf8')
}

async function compileSwiftHelpers(appCoreDir) {
  if (!hasCommand('swiftc')) {
    throw new Error('macOS packaging needs swiftc from Xcode Command Line Tools.')
  }

  const scriptsDir = path.join(appCoreDir, 'scripts')
  const helpers = [
    {
      source: path.join(rootDir, 'scripts', 'macos-hotkey-hook.swift'),
      output: path.join(scriptsDir, 'macos-hotkey-hook')
    },
    {
      source: path.join(rootDir, 'scripts', 'macos-menu-bar.swift'),
      output: path.join(scriptsDir, 'macos-menu-bar')
    },
    {
      source: path.join(rootDir, 'scripts', 'macos-onboarding.swift'),
      output: path.join(scriptsDir, 'macos-onboarding')
    },
    {
      source: path.join(rootDir, 'scripts', 'macos-voice-overlay.swift'),
      output: path.join(scriptsDir, 'macos-voice-overlay')
    },
    {
      source: path.join(rootDir, 'scripts', 'macos-ui-automation.swift'),
      output: path.join(scriptsDir, 'macos-ui-automation')
    }
  ]

  for (const helper of helpers) {
    log(`Compiling ${path.basename(helper.output)}.`)
    await run('swiftc', [helper.source, '-O', '-o', helper.output])
    await chmod(helper.output, 0o755)
  }
}

async function stageSttRuntime(runtimeDir, { skipStt = false } = {}) {
  if (skipStt) {
    log('Skipping bundled STT runtime because --skip-stt was provided.')
    return
  }

  await ensureBundledSttRuntime({
    rootDir,
    outputRoot: runtimeDir,
    logger: log,
    env: {
      ...process.env,
      STT_FFMPEG_BIN: path.join(runtimeDir, 'ffmpeg', 'bin', 'ffmpeg')
    }
  })
}

async function writeLauncher(appPath, version) {
  const contentsDir = path.join(appPath, 'Contents')
  const macosDir = path.join(contentsDir, 'MacOS')
  await mkdir(macosDir, { recursive: true })
  await writeFile(path.join(contentsDir, 'Info.plist'), plist(version), 'utf8')
  await writeFile(path.join(macosDir, 'dictray'), launcherScript(), 'utf8')
  await chmod(path.join(macosDir, 'dictray'), 0o755)
}

async function stageAppBundle(outputDir, version, args) {
  const appPath = path.join(outputDir, `${appName}.app`)
  const resourcesDir = path.join(appPath, 'Contents', 'Resources')
  const runtimeDir = path.join(resourcesDir, 'runtime')
  const appCoreDir = path.join(runtimeDir, 'app-core')

  await rm(outputDir, { recursive: true, force: true })
  await mkdir(resourcesDir, { recursive: true })
  await writeLauncher(appPath, version)

  log('Copying app core.')
  await stageAppCore(appCoreDir)
  await compileSwiftHelpers(appCoreDir)
  await stageNodeRuntime(runtimeDir)
  await stageFfmpegRuntime(runtimeDir)
  await stageSttRuntime(runtimeDir, args)

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify({
    version,
    builtAt: new Date().toISOString(),
    platform: 'darwin',
    arch: process.arch,
    app: `${appName}.app`,
    includes: {
      node: true,
      ffmpeg: true,
      sttRuntime: !args.skipStt,
      swiftHelpers: true
    }
  }, null, 2)}\n`, 'utf8')

  return appPath
}

async function maybeCodesign(appPath) {
  if (!hasCommand('codesign')) {
    return
  }

  const executableCandidates = [
    path.join(appPath, 'Contents', 'MacOS', 'dictray'),
    path.join(appPath, 'Contents', 'Resources', 'runtime', 'node', 'bin', 'node'),
    path.join(appPath, 'Contents', 'Resources', 'runtime', 'app-core', 'scripts', 'macos-hotkey-hook'),
    path.join(appPath, 'Contents', 'Resources', 'runtime', 'app-core', 'scripts', 'macos-menu-bar'),
    path.join(appPath, 'Contents', 'Resources', 'runtime', 'app-core', 'scripts', 'macos-onboarding'),
    path.join(appPath, 'Contents', 'Resources', 'runtime', 'app-core', 'scripts', 'macos-voice-overlay'),
    path.join(appPath, 'Contents', 'Resources', 'runtime', 'app-core', 'scripts', 'macos-ui-automation')
  ]

  log('Applying ad-hoc signatures to app executables.')
  for (const candidate of executableCandidates) {
    if (!await pathExists(candidate)) {
      continue
    }
    await run('codesign', ['--force', '--sign', '-', candidate], { stdio: 'ignore' }).catch((error) => {
      log(`Ad-hoc codesign skipped for ${path.basename(candidate)}: ${error?.message || error}`)
    })
  }
}

async function createDmg(outputDir, version) {
  if (!hasCommand('hdiutil')) {
    throw new Error('hdiutil is required to create a DMG.')
  }

  const dmgRoot = path.join(buildRoot, 'dmg-root')
  const rawDmgPath = path.join(buildRoot, `${packageName}-${version}.raw.dmg`)
  const dmgPath = path.join(distRoot, `${packageName}-${version}.dmg`)
  await rm(dmgRoot, { recursive: true, force: true })
  await mkdir(dmgRoot, { recursive: true })
  await cp(path.join(outputDir, `${appName}.app`), path.join(dmgRoot, `${appName}.app`), {
    recursive: true,
    force: true,
    dereference: true
  })
  await symlink('/Applications', path.join(dmgRoot, 'Applications')).catch(() => null)
  await rm(rawDmgPath, { force: true })
  await rm(dmgPath, { force: true })

  log(`Creating raw image ${rawDmgPath}.`)
  await run('hdiutil', [
    'makehybrid',
    '-hfs',
    '-hfs-volume-name',
    appName,
    '-o',
    rawDmgPath,
    dmgRoot
  ])

  log(`Compressing ${dmgPath}.`)
  await run('hdiutil', [
    'convert',
    rawDmgPath,
    '-format',
    'UDZO',
    '-o',
    dmgPath
  ])
  await rm(rawDmgPath, { force: true })
  return dmgPath
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('macOS DMG packaging is only supported on macOS hosts.')
  }

  const args = parseArgs()
  if (args.help) {
    printHelp()
    return
  }

  const version = await readPackageVersion()
  const outputDir = path.join(distRoot, packageName)
  await mkdir(distRoot, { recursive: true })
  await rm(buildRoot, { recursive: true, force: true })

  const appPath = await stageAppBundle(outputDir, version, args)
  await maybeCodesign(appPath)

  if (!args.dirOnly || args.dmg) {
    const dmgPath = await createDmg(outputDir, version)
    log(`DMG ready at ${dmgPath}.`)
  }

  log(`macOS app bundle ready at ${appPath}.`)
}

main().catch((error) => {
  console.error(`[macos-package] ${error?.message || error}`)
  process.exitCode = 1
})
