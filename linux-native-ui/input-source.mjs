#!/usr/bin/env gjs -m
import Adw from 'gi://Adw?version=1'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Gtk from 'gi://Gtk?version=4.0'
import {
  clampUnitInterval,
  compactSpaces,
  installCss,
  parseCliArgs,
  parseLevelLine,
  pollJsonFile,
  readJsonFile,
  removeSource,
  writeJsonFile
} from './common.mjs'

const cli = parseCliArgs(ARGV)
const GST_BIN = 'gst-launch-1.0'
const CAPTURE_SAMPLE_RATE = 16000
const CAPTURE_CHANNELS = 1
const PROBE_CLIENT_NAME = 'DicTray Preview'

if (cli.selfTest) {
  installCss('window {}')
  print(JSON.stringify({ ok: true, script: 'input-source' }))
} else {
  Adw.init()
  installCss(`
    window {
      background: linear-gradient(180deg, #08131a 0%, #071018 100%);
    }
    .hero-card,
    .panel-card,
    .device-row {
      background: rgba(10, 24, 31, 0.94);
      border: 1px solid rgba(117, 217, 176, 0.18);
      border-radius: 22px;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
    }
    .hero-card {
      padding: 24px;
    }
    .panel-card {
      padding: 18px;
    }
    .eyebrow {
      color: #69e4ac;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.22em;
      text-transform: uppercase;
    }
    .headline {
      color: #f0fff7;
      font-size: 26px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .subtle,
    .device-note,
    .device-meta,
    .meter-note {
      color: rgba(220, 244, 234, 0.78);
    }
    .status-label {
      color: #dff8eb;
    }
    .status-label.error {
      color: #ff9f9f;
    }
    .meter-title {
      color: #f0fff7;
      font-size: 17px;
      font-weight: 700;
    }
    .meter-value {
      color: #69e4ac;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .device-row {
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    .device-row:selected,
    .device-row.selected {
      border-color: rgba(96, 228, 172, 0.62);
      background: linear-gradient(180deg, rgba(96, 228, 172, 0.1), rgba(10, 24, 31, 0.94));
    }
    .device-name {
      color: #f4fff9;
      font-size: 15px;
      font-weight: 700;
    }
    .badge {
      border-radius: 999px;
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.08);
      color: rgba(226, 244, 235, 0.78);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .badge-hot {
      background: rgba(96, 228, 172, 0.18);
      color: #69e4ac;
    }
    progressbar trough {
      min-height: 14px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.08);
    }
    progressbar progress {
      border-radius: 999px;
      background: linear-gradient(90deg, #69e4ac 0%, #7bd9ff 100%);
      box-shadow: 0 0 18px rgba(105, 228, 172, 0.32);
    }
  `)

  let window = null
  let statePollId = 0
  let meterAnimationId = 0
  let statePayload = {
    preferredInputDeviceId: '',
    activeDeviceId: '',
    activeLabel: '',
    devices: [],
    error: ''
  }
  let currentProbeDeviceId = ''
  let currentProbeProcess = null
  let currentProbeStreams = []
  let currentMeterLevel = 0
  let renderedMeterLevel = 0

  const widgets = {}

  function buildProbeArgs(deviceId) {
    return [
      '-m',
      '-e',
      'pulsesrc',
      `device=${deviceId}`,
      `client-name=${PROBE_CLIENT_NAME}`,
      'do-timestamp=true',
      '!', 'queue',
      '!', 'audioconvert',
      '!', 'audioresample',
      '!', `audio/x-raw,format=S16LE,rate=${CAPTURE_SAMPLE_RATE},channels=${CAPTURE_CHANNELS}`,
      '!', 'level',
      'post-messages=true',
      'interval=100000000',
      '!', 'fakesink',
      'sync=false',
      'async=false'
    ]
  }

  function defaultRow(activeLabel) {
    const label = compactSpaces(activeLabel) || 'Current default microphone'
    return {
      deviceId: '',
      label: 'System Default',
      note: `Uses ${label}.`
    }
  }

  function allRows() {
    const devices = Array.isArray(statePayload.devices) ? statePayload.devices : []
    return [
      defaultRow(statePayload.activeLabel),
      ...devices.map((device) => ({
        deviceId: String(device?.deviceId || '').trim(),
        label: compactSpaces(device?.label || device?.deviceId || 'Microphone'),
        note: 'Specific input source'
      }))
    ]
  }

  function selectedRowDeviceId() {
    return String(statePayload.preferredInputDeviceId || '').trim()
  }

  function activeProbeDeviceId() {
    const preferredId = String(statePayload.preferredInputDeviceId || '').trim()
    if (preferredId) {
      return preferredId
    }
    return String(statePayload.activeDeviceId || '').trim()
  }

  function showStatus(message, cssClass = '') {
    widgets.statusLabel.set_label(compactSpaces(message) || 'Ready.')
    widgets.statusLabel.set_css_classes(cssClass ? ['status-label', cssClass] : ['status-label'])
  }

  function updateMeterWidgets() {
    renderedMeterLevel += (currentMeterLevel - renderedMeterLevel) * 0.28
    if (Math.abs(currentMeterLevel - renderedMeterLevel) < 0.003) {
      renderedMeterLevel = currentMeterLevel
    }

    widgets.meterBar.set_fraction(clampUnitInterval(renderedMeterLevel))
    widgets.meterValueLabel.set_label(`${Math.round(clampUnitInterval(renderedMeterLevel) * 100)}%`)
    return GLib.SOURCE_CONTINUE
  }

  function stopProbe() {
    for (const stream of currentProbeStreams) {
      try {
        stream.close(null)
      } catch {
        // ignore
      }
    }
    currentProbeStreams = []

    if (currentProbeProcess) {
      try {
        currentProbeProcess.force_exit()
      } catch {
        // ignore
      }
    }

    currentProbeProcess = null
    currentProbeDeviceId = ''
    currentMeterLevel = 0
  }

  function readProbeLines(stream) {
    if (!stream) {
      return
    }

    stream.read_line_async(GLib.PRIORITY_DEFAULT, null, (_source, result) => {
      let line = null
      try {
        ;[line] = stream.read_line_finish_utf8(result)
      } catch {
        return
      }

      if (line === null) {
        return
      }

      const parsedLevel = parseLevelLine(line)
      if (parsedLevel !== null) {
        currentMeterLevel = parsedLevel
      }

      readProbeLines(stream)
    })
  }

  function startProbe(deviceId) {
    const nextDeviceId = String(deviceId || '').trim()
    if (!nextDeviceId) {
      stopProbe()
      widgets.meterTitleLabel.set_label('No active microphone source')
      widgets.meterNoteLabel.set_label('Pick a source below to preview its signal.')
      return
    }

    if (nextDeviceId === currentProbeDeviceId && currentProbeProcess) {
      return
    }

    stopProbe()

    try {
      const process = Gio.Subprocess.new(
        [GST_BIN, ...buildProbeArgs(nextDeviceId)],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
      )
      currentProbeProcess = process
      currentProbeDeviceId = nextDeviceId
      currentProbeStreams = [
        new Gio.DataInputStream({ base_stream: process.get_stdout_pipe() }),
        new Gio.DataInputStream({ base_stream: process.get_stderr_pipe() })
      ]
      for (const stream of currentProbeStreams) {
        readProbeLines(stream)
      }
    } catch (error) {
      showStatus(String(error?.message || error || 'Unable to start live preview.'), 'error')
      stopProbe()
    }
  }

  function sendCommand(action, value = null) {
    if (!cli.commandPath) {
      return
    }

    const payload = {
      action,
      requestedAt: Date.now()
    }
    if (value !== null) {
      payload.value = value
    }
    writeJsonFile(cli.commandPath, payload)
  }

  function buildDeviceRow(entry) {
    const row = new Gtk.ListBoxRow({ selectable: false, activatable: true })
    row.add_css_class('device-row')
    row.deviceId = String(entry.deviceId || '')
    row.title = entry.label

    const shell = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8
    })

    const topline = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 10,
      hexpand: true
    })

    const nameLabel = new Gtk.Label({
      label: entry.label,
      xalign: 0,
      hexpand: true,
      wrap: true
    })
    nameLabel.add_css_class('device-name')

    const badge = new Gtk.Label({
      xalign: 1,
      halign: Gtk.Align.END,
      valign: Gtk.Align.START
    })
    badge.add_css_class('badge')

    const selectedId = selectedRowDeviceId()
    const activeId = String(statePayload.activeDeviceId || '').trim()
    const isSelected = row.deviceId === selectedId
    const isDefaultActive = !selectedId && row.deviceId === ''
    const isCurrentDefault = row.deviceId && row.deviceId === activeId

    if (isSelected || isDefaultActive) {
      row.add_css_class('selected')
      badge.add_css_class('badge-hot')
      badge.set_label('Selected')
    } else if (isCurrentDefault) {
      badge.set_label('Default')
    } else {
      badge.set_label('Available')
    }

    topline.append(nameLabel)
    topline.append(badge)

    const noteLabel = new Gtk.Label({
      label: entry.note,
      xalign: 0,
      wrap: true
    })
    noteLabel.add_css_class('device-note')

    shell.append(topline)
    shell.append(noteLabel)
    row.set_child(shell)

    return row
  }

  function renderDeviceList() {
    while (widgets.deviceList.get_first_child()) {
      widgets.deviceList.remove(widgets.deviceList.get_first_child())
    }

    for (const entry of allRows()) {
      widgets.deviceList.append(buildDeviceRow(entry))
    }
  }

  function activePreviewLabel() {
    const preferredId = String(statePayload.preferredInputDeviceId || '').trim()
    const activeId = String(statePayload.activeDeviceId || '').trim()
    const devices = Array.isArray(statePayload.devices) ? statePayload.devices : []
    const match = devices.find((device) => String(device?.deviceId || '').trim() === (preferredId || activeId)) || null

    if (preferredId) {
      return match?.label || 'Selected microphone'
    }

    return compactSpaces(statePayload.activeLabel) || match?.label || 'System Default'
  }

  function syncUi() {
    const devices = Array.isArray(statePayload.devices) ? statePayload.devices : []
    widgets.meterTitleLabel.set_label(activePreviewLabel())
    widgets.meterNoteLabel.set_label(
      devices.length
        ? 'Speak normally. This live meter follows the source that DicTray will actually use.'
        : 'No Linux microphone inputs are available right now.'
    )
    renderDeviceList()

    const errorMessage = compactSpaces(statePayload.error)
    if (errorMessage) {
      showStatus(errorMessage, 'error')
    } else if (!devices.length) {
      showStatus('No microphone inputs were found. Check PipeWire or PulseAudio and reopen this panel.', 'error')
    } else {
      showStatus('Pick a source below. System Default will follow the current Linux default microphone.')
    }

    startProbe(activeProbeDeviceId())
  }

  function buildWindow(application) {
    const applicationWindow = new Adw.ApplicationWindow({
      application,
      title: 'DicTray Input Source',
      default_width: 500,
      default_height: 640
    })

    const root = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18,
      margin_top: 18,
      margin_bottom: 18,
      margin_start: 18,
      margin_end: 18
    })

    const hero = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 8
    })
    hero.add_css_class('hero-card')

    const eyebrow = new Gtk.Label({ label: 'Input Source', xalign: 0 })
    eyebrow.add_css_class('eyebrow')

    const headline = new Gtk.Label({
      label: 'Native microphone setup',
      xalign: 0,
      wrap: true
    })
    headline.add_css_class('headline')

    const subtitle = new Gtk.Label({
      label: 'This Linux-native panel handles microphone setup directly in GNOME. Keep it open while you talk, watch the live meter, and switch inputs without leaving GNOME.',
      xalign: 0,
      wrap: true
    })
    subtitle.add_css_class('subtle')

    hero.append(eyebrow)
    hero.append(headline)
    hero.append(subtitle)

    const meterCard = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 10
    })
    meterCard.add_css_class('panel-card')

    const meterTopline = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      hexpand: true
    })

    widgets.meterTitleLabel = new Gtk.Label({
      label: 'Waiting for microphone data',
      xalign: 0,
      hexpand: true,
      wrap: true
    })
    widgets.meterTitleLabel.add_css_class('meter-title')

    widgets.meterValueLabel = new Gtk.Label({
      label: '0%',
      xalign: 1,
      halign: Gtk.Align.END
    })
    widgets.meterValueLabel.add_css_class('meter-value')

    meterTopline.append(widgets.meterTitleLabel)
    meterTopline.append(widgets.meterValueLabel)

    widgets.meterBar = new Gtk.ProgressBar({ show_text: false })
    widgets.meterBar.set_fraction(0)

    widgets.meterNoteLabel = new Gtk.Label({
      label: 'Speak normally to test the currently selected source.',
      xalign: 0,
      wrap: true
    })
    widgets.meterNoteLabel.add_css_class('meter-note')

    meterCard.append(meterTopline)
    meterCard.append(widgets.meterBar)
    meterCard.append(widgets.meterNoteLabel)

    const statusCard = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      hexpand: true
    })
    statusCard.add_css_class('panel-card')

    widgets.statusLabel = new Gtk.Label({
      label: 'Opening microphone setup…',
      xalign: 0,
      hexpand: true,
      wrap: true
    })
    widgets.statusLabel.add_css_class('status-label')

    const refreshButton = new Gtk.Button({ label: 'Refresh Inputs' })
    refreshButton.connect('clicked', () => {
      showStatus('Refreshing Linux audio inputs…')
      sendCommand('refresh_inputs')
    })

    statusCard.append(widgets.statusLabel)
    statusCard.append(refreshButton)

    widgets.deviceList = new Gtk.ListBox()
    widgets.deviceList.set_selection_mode(Gtk.SelectionMode.NONE)
    widgets.deviceList.add_css_class('boxed-list')
    widgets.deviceList.connect('row-activated', (_list, row) => {
      sendCommand('set_input_source', row.deviceId || '')
      showStatus(`Switching input source to ${row.deviceId ? row.title : 'System Default'}…`)
    })

    const scroller = new Gtk.ScrolledWindow({
      vexpand: true,
      hexpand: true,
      hscrollbar_policy: Gtk.PolicyType.NEVER,
      min_content_height: 280
    })
    scroller.set_child(widgets.deviceList)

    root.append(hero)
    root.append(meterCard)
    root.append(statusCard)
    root.append(scroller)
    applicationWindow.set_content(root)

    applicationWindow.connect('close-request', () => {
      stopProbe()
      return false
    })

    return applicationWindow
  }

  const app = new Adw.Application({
    application_id: 'com.okzea.DicTray.InputSource'
  })

  app.connect('activate', () => {
    if (!window) {
      window = buildWindow(app)
      statePollId = pollJsonFile(cli.statePath, (payload) => {
        statePayload = payload || {}
        syncUi()
      }, 240)
      meterAnimationId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, updateMeterWidgets)
    }

    window.present()
    const initialPayload = readJsonFile(cli.statePath, null)
    if (initialPayload) {
      statePayload = initialPayload
    }
    syncUi()
  })

  app.connect('shutdown', () => {
    stopProbe()
    removeSource(statePollId)
    removeSource(meterAnimationId)
  })

  app.run([])
}
