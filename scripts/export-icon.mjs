import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'

function usage() {
  console.error('Usage: electron scripts/export-icon.mjs <input.svg> <output.png> <output.ico>')
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

async function exportIcon(inputSvgPath, outputPngPath, outputIcoPath) {
  const svg = await readFile(inputSvgPath, 'utf8')
  const pngSize = 512
  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: transparent;
            overflow: hidden;
          }
          body > svg {
            display: block;
            width: 100%;
            height: 100%;
          }
        </style>
      </head>
      <body>${svg}</body>
    </html>
  `.trim()
  const window = new BrowserWindow({
    show: false,
    width: pngSize,
    height: pngSize,
    frame: false,
    transparent: true,
    resizable: false,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    webPreferences: {
      backgroundThrottling: false,
      sandbox: false
    }
  })

  try {
    const htmlDataUrl = `data:text/html;base64,${Buffer.from(html).toString('base64')}`
    await window.loadURL(htmlDataUrl)
    await new Promise((resolve) => setTimeout(resolve, 100))
    const sourceImage = await window.webContents.capturePage({ x: 0, y: 0, width: pngSize, height: pngSize })
    if (sourceImage.isEmpty()) {
      throw new Error(`Failed to rasterize SVG icon: ${inputSvgPath}`)
    }

    const pngImage = sourceImage.resize({ width: pngSize, height: pngSize, quality: 'best' })
    const pngBuffer = pngImage.toPNG()
    const icoSizes = [16, 32, 48, 64, 128, 256]
    const icoBuffer = createIco(
      icoSizes.map((size) => ({
        size,
        png: sourceImage.resize({ width: size, height: size, quality: 'best' }).toPNG()
      }))
    )

    await mkdir(path.dirname(outputPngPath), { recursive: true })
    await writeFile(outputPngPath, pngBuffer)
    await writeFile(outputIcoPath, icoBuffer)
  } finally {
    window.destroy()
  }
}

const [inputSvgPath, outputPngPath, outputIcoPath] = process.argv.slice(-3).map((value) => path.resolve(String(value || '')))
if (!inputSvgPath || !outputPngPath || !outputIcoPath) {
  usage()
  process.exitCode = 1
} else {
  app.whenReady().then(async () => {
    try {
      await exportIcon(inputSvgPath, outputPngPath, outputIcoPath)
    } catch (error) {
      console.error(String(error?.message || error))
      process.exitCode = 1
    } finally {
      app.quit()
    }
  })
}
