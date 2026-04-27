import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gdk from 'gi://Gdk?version=4.0'
import Gtk from 'gi://Gtk?version=4.0'

export function parseCliArgs(argv = []) {
  const result = {
    statePath: '',
    commandPath: '',
    selfTest: false
  }

  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '').trim()
    switch (token) {
      case '--state':
        result.statePath = String(argv[index + 1] || '').trim()
        index += 1
        break
      case '--command':
        result.commandPath = String(argv[index + 1] || '').trim()
        index += 1
        break
      case '--self-test':
        result.selfTest = true
        break
      default:
        break
    }
  }

  return result
}

export function clampUnitInterval(value) {
  return Math.max(0, Math.min(1, Number(value) || 0))
}

export function normalizeText(value) {
  return String(value || '').trim()
}

export function compactSpaces(value) {
  return normalizeText(value).replace(/\s+/g, ' ')
}

export function readJsonFile(filePath, fallback = null) {
  const targetPath = normalizeText(filePath)
  if (!targetPath) {
    return fallback
  }

  try {
    const file = Gio.File.new_for_path(targetPath)
    const [ok, contents] = file.load_contents(null)
    if (!ok || !contents) {
      return fallback
    }
    return JSON.parse(new TextDecoder().decode(contents))
  } catch {
    return fallback
  }
}

export function writeJsonFile(filePath, payload) {
  const targetPath = normalizeText(filePath)
  if (!targetPath) {
    return
  }

  const parentDir = GLib.path_get_dirname(targetPath)
  if (parentDir) {
    GLib.mkdir_with_parents(parentDir, 0o755)
  }

  GLib.file_set_contents(targetPath, `${JSON.stringify(payload, null, 2)}\n`)
}

export function installCss(css) {
  const provider = new Gtk.CssProvider()
  provider.load_from_data(css)
  const display = Gdk.Display.get_default()
  if (!display) {
    return
  }
  Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
}

export function pollJsonFile(filePath, onUpdate, intervalMs = 280) {
  let lastSerialized = ''
  return GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(80, Number(intervalMs) || 280), () => {
    const payload = readJsonFile(filePath, null)
    if (payload === null) {
      return GLib.SOURCE_CONTINUE
    }

    const serialized = JSON.stringify(payload)
    if (serialized === lastSerialized) {
      return GLib.SOURCE_CONTINUE
    }

    lastSerialized = serialized
    onUpdate(payload)
    return GLib.SOURCE_CONTINUE
  })
}

export function removeSource(sourceId) {
  if (Number.isInteger(sourceId) && sourceId > 0) {
    GLib.Source.remove(sourceId)
  }
}

export function parseLevelLine(line) {
  const text = String(line || '').trim()
  if (!text.includes('(element): level')) {
    return null
  }

  const match = text.match(/rms=\(GValueArray\)<\s*([^\s,>]+)/i)
  if (!match) {
    return null
  }

  const numeric = Number(match[1])
  if (!Number.isFinite(numeric)) {
    return null
  }

  const amplitude = 10 ** (numeric / 20)
  return clampUnitInterval(amplitude * 8)
}
