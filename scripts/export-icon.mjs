import { mkdir, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

function usage() {
  console.error('Usage: node scripts/export-icon.mjs <input.svg> <output.png> <output.ico>')
}

function createIco(entries) {
  const iconEntries = entries.map(({ size, png }) => ({
    size,
    png: Buffer.from(png)
  }))
  const headerSize = 6 + (iconEntries.length * 16)
  let offset = headerSize
  const chunks = []

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(iconEntries.length, 4)

  iconEntries.forEach((entry, index) => {
    const entryOffset = 6 + (index * 16)
    const dimension = entry.size >= 256 ? 0 : entry.size
    header.writeUInt8(dimension, entryOffset + 0)
    header.writeUInt8(dimension, entryOffset + 1)
    header.writeUInt8(0, entryOffset + 2)
    header.writeUInt8(0, entryOffset + 3)
    header.writeUInt16LE(1, entryOffset + 4)
    header.writeUInt16LE(32, entryOffset + 6)
    header.writeUInt32LE(entry.png.length, entryOffset + 8)
    header.writeUInt32LE(offset, entryOffset + 12)
    offset += entry.png.length
    chunks.push(entry.png)
  })

  return Buffer.concat([header, ...chunks])
}

function runBuffer(command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: false
    })

    const stdoutChunks = []
    const stderrChunks = []

    child.stdout.on('data', (chunk) => {
      stdoutChunks.push(Buffer.from(chunk))
    })

    child.stderr.on('data', (chunk) => {
      stderrChunks.push(Buffer.from(chunk))
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks))
        return
      }
      reject(new Error(Buffer.concat(stderrChunks).toString('utf8').trim() || `${command} exited with code ${code ?? 1}`))
    })
  })
}

async function renderPngBuffer(inputSvgPath, size) {
  return await runBuffer('rsvg-convert', [
    '--format=png',
    '--width',
    String(size),
    '--height',
    String(size),
    inputSvgPath
  ])
}

async function exportIcon(inputSvgPath, outputPngPath, outputIcoPath) {
  const pngSize = 512
  const pngBuffer = await renderPngBuffer(inputSvgPath, pngSize)
  if (!pngBuffer.length) {
    throw new Error(`Failed to rasterize SVG icon: ${inputSvgPath}`)
  }

  const icoSizes = [16, 32, 48, 64, 128, 256]
  const icoBuffer = createIco(await Promise.all(icoSizes.map(async (size) => ({
    size,
    png: await renderPngBuffer(inputSvgPath, size)
  }))))

  await mkdir(path.dirname(outputPngPath), { recursive: true })
  await writeFile(outputPngPath, pngBuffer)
  await writeFile(outputIcoPath, icoBuffer)
}

const [inputSvgPath, outputPngPath, outputIcoPath] = process.argv.slice(2).map((value) => path.resolve(String(value || '')))
if (!inputSvgPath || !outputPngPath || !outputIcoPath) {
  usage()
  process.exitCode = 1
} else {
  exportIcon(inputSvgPath, outputPngPath, outputIcoPath).catch((error) => {
    console.error(String(error?.message || error))
    process.exitCode = 1
  })
}
