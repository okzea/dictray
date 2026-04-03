#!/usr/bin/env gjs -m
import Adw from 'gi://Adw?version=1'
import GLib from 'gi://GLib'
import Gtk from 'gi://Gtk?version=4.0'
import {
  compactSpaces,
  installCss,
  parseCliArgs,
  pollJsonFile,
  readJsonFile,
  removeSource,
  writeJsonFile
} from './common.mjs'

const cli = parseCliArgs(ARGV)
const FALLBACK_HOTKEY_PRESETS = [
  { value: 'CommandOrControl+Space', label: 'Ctrl+Space' },
  { value: 'Alt+Space', label: 'Alt+Space' },
  { value: 'CommandOrControl+Alt+F12', label: 'Ctrl+Alt+F12' },
  { value: 'CommandOrControl+Alt+F13', label: 'Ctrl+Alt+F13' },
  { value: 'CommandOrControl+Alt+O', label: 'Ctrl+Alt+O' }
]

if (cli.selfTest) {
  print(JSON.stringify({ ok: true, script: 'onboarding' }))
} else {
  Adw.init()
  installCss(`
    window {
      background: linear-gradient(180deg, #08131a 0%, #071018 100%);
    }
    .hero-card,
    .section-card {
      background: rgba(10, 24, 31, 0.94);
      border: 1px solid rgba(117, 217, 176, 0.18);
      border-radius: 22px;
      box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
      padding: 22px;
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
      font-size: 28px;
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .subtle,
    .section-copy,
    .field-hint,
    .runtime-copy,
    .summary-copy,
    .sample-copy {
      color: rgba(220, 244, 234, 0.78);
    }
    .section-title {
      color: #f4fff8;
      font-size: 17px;
      font-weight: 700;
    }
    .sample-card {
      background: rgba(105, 228, 172, 0.1);
      border: 1px solid rgba(105, 228, 172, 0.22);
      border-radius: 18px;
      padding: 14px 16px;
    }
    .sample-text {
      color: #f4fff8;
      font-size: 22px;
      font-weight: 800;
      letter-spacing: 0.01em;
    }
    .status-label {
      color: #dff8eb;
    }
    .status-label.error {
      color: #ff9f9f;
    }
    .status-label.success {
      color: #69e4ac;
    }
    entry,
    textview,
    dropdown,
    button {
      border-radius: 16px;
    }
    textview {
      background: rgba(3, 13, 18, 0.88);
      color: #f3fff8;
      min-height: 140px;
    }
    .choice-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(117, 217, 176, 0.14);
      border-radius: 18px;
      padding: 12px 14px;
    }
  `)

  let window = null
  let statePollId = 0
  let closeDelayId = 0
  let hydrated = false
  let submitted = false
  let initialCompletedAt = ''
  let benchmarkStartedAt = 0
  let benchmarkElapsedMs = 0
  let latestPayload = {
    sampleText: '',
    state: {},
    runtime: {},
    ui: {}
  }

  const widgets = {
    effortButtons: new Map(),
    hotkeyPresets: []
  }

  function normalizeTypedText(value) {
    return compactSpaces(value).toLowerCase()
  }

  function normalizeProfileName(value) {
    return compactSpaces(value).slice(0, 40)
  }

  function normalizeSpeechEffort(value) {
    switch (String(value || '').trim().toLowerCase()) {
      case 'low':
      case 'fast':
      case 'faster':
        return 'low'
      case 'high':
      case 'quality':
        return 'high'
      case 'mid':
      case 'middle':
      case 'medium':
      case 'balanced':
        return 'mid'
      default:
        return ''
    }
  }

  function speechEffortLabel(value) {
    switch (normalizeSpeechEffort(value)) {
      case 'low':
        return 'Low (Faster)'
      case 'high':
        return 'High (Quality)'
      case 'mid':
      default:
        return 'Mid (Balanced)'
    }
  }

  function hotkeyPresets() {
    const presets = Array.isArray(latestPayload.runtime?.hotkeyPresets) && latestPayload.runtime.hotkeyPresets.length
      ? latestPayload.runtime.hotkeyPresets
      : FALLBACK_HOTKEY_PRESETS

    return presets
      .map((preset) => ({
        value: String(preset?.value || '').trim(),
        label: compactSpaces(preset?.label || preset?.value || '')
      }))
      .filter((preset) => preset.value && preset.label)
  }

  function selectedSpeechEffort() {
    for (const [value, button] of widgets.effortButtons.entries()) {
      if (button.get_active()) {
        return value
      }
    }
    return 'mid'
  }

  function selectedHotkeyValue() {
    const presets = widgets.hotkeyPresets.length ? widgets.hotkeyPresets : hotkeyPresets()
    const index = widgets.hotkeyDropdown.get_selected()
    return presets[index]?.value || presets[0]?.value || FALLBACK_HOTKEY_PRESETS[0].value
  }

  function typingBufferText() {
    const buffer = widgets.typingView.get_buffer()
    return buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false)
  }

  function benchmarkStats(elapsedMs) {
    const elapsed = Math.max(0, Math.floor(Number(elapsedMs || 0) || 0))
    const sampleText = compactSpaces(latestPayload.sampleText || '')
    const characters = Array.from(sampleText).length
    const words = sampleText.split(/\s+/).filter(Boolean).length
    return {
      elapsedMs: elapsed,
      charactersPerMinute: elapsed > 0 ? Math.max(0, Math.round((characters / elapsed) * 60000)) : 0,
      wordsPerMinute: elapsed > 0 ? Math.max(0, Number(((words / elapsed) * 60000).toFixed(1)) || 0) : 0,
      measuredAt: elapsed > 0 ? new Date().toISOString() : ''
    }
  }

  function localValidationError() {
    if (!normalizeProfileName(widgets.nameEntry.get_text())) {
      return 'Add your name before finishing Quick Start.'
    }

    if (!benchmarkElapsedMs) {
      return 'Complete the typing benchmark before finishing Quick Start.'
    }

    if (normalizeTypedText(typingBufferText()) !== normalizeTypedText(latestPayload.sampleText || '')) {
      return 'Type the sample sentence exactly once before finishing Quick Start.'
    }

    return ''
  }

  function showStatus(message, cssClass = '') {
    widgets.statusLabel.set_label(compactSpaces(message) || 'Ready.')
    widgets.statusLabel.set_css_classes(cssClass ? ['status-label', cssClass] : ['status-label'])
  }

  function updateRuntimeSummary() {
    const rewriteProvider = compactSpaces(latestPayload.runtime?.rewriteProvider || '')
    const textImprovement = rewriteProvider && rewriteProvider.toLowerCase() !== 'none'
      ? `Text improvement can use ${rewriteProvider}.`
      : 'Text improvement stays optional.'
    widgets.runtimeLabel.set_label(`Built-in speech to text is the default. ${textImprovement}`)
  }

  function updateBenchmarkSummary() {
    const typed = normalizeTypedText(typingBufferText())
    const sample = normalizeTypedText(latestPayload.sampleText || '')

    if (!typed) {
      widgets.benchmarkSummaryLabel.set_label('Type the sentence once. The timer starts on your first keystroke.')
      widgets.benchmarkHintLabel.set_label('DicTray uses this to estimate how much keyboard time it saves you each day.')
      return
    }

    if (!benchmarkStartedAt) {
      benchmarkStartedAt = Date.now()
    }

    if (typed === sample) {
      benchmarkElapsedMs = Math.max(0, Date.now() - benchmarkStartedAt)
      const stats = benchmarkStats(benchmarkElapsedMs)
      widgets.benchmarkSummaryLabel.set_label(`Typing pace captured: ${stats.charactersPerMinute} chars/min and ${stats.wordsPerMinute} words/min.`)
      widgets.benchmarkHintLabel.set_label(`Benchmark duration: ${Math.max(1, Math.round(stats.elapsedMs / 1000))}s.`)
      return
    }

    benchmarkElapsedMs = 0
    widgets.benchmarkSummaryLabel.set_label('Keep going until the sample matches exactly once.')
    widgets.benchmarkHintLabel.set_label('Upper/lowercase and extra spaces do not matter, but the words must match.')
  }

  function updateHotkeyUi() {
    const managedByEnv = Boolean(latestPayload.runtime?.hotkeyManagedByEnv)
    widgets.hotkeyDropdown.set_sensitive(!managedByEnv)
    widgets.hotkeyHintLabel.set_label(
      managedByEnv
        ? `Shortcut is managed externally and currently set to ${compactSpaces(latestPayload.runtime?.hotkey || 'unknown')}.`
        : 'Choose the shortcut you want to hold when you speak.'
    )
  }

  function updateSummary() {
    const name = normalizeProfileName(widgets.nameEntry.get_text()) || 'Anonymous'
    const rewriteCleanup = widgets.rewriteSwitch.get_active()
    const summary = [
      `Profile: ${name}`,
      `Text improvement: ${rewriteCleanup ? 'On' : 'Off'}`,
      `Speech effort: ${speechEffortLabel(selectedSpeechEffort())}`,
      `Push-to-talk: ${widgets.hotkeyPresets[widgets.hotkeyDropdown.get_selected()]?.label || 'Unknown'}`
    ]
    widgets.summaryLabel.set_label(summary.join('  |  '))
  }

  function hydrateFromState() {
    const state = latestPayload.state || {}
    const profileName = normalizeProfileName(state?.profile?.name || '')
    const rewriteCleanup = Boolean(state?.choices?.rewriteCleanup)
    const speechEffort = normalizeSpeechEffort(state?.choices?.speechEffort || latestPayload.runtime?.speechEffort || 'mid') || 'mid'
    const pushToTalkHotkey = String(state?.choices?.pushToTalkHotkey || latestPayload.runtime?.hotkey || '').trim()
    const typingBenchmark = state?.typingBenchmark || {}

    widgets.nameEntry.set_text(profileName)
    widgets.rewriteSwitch.set_active(rewriteCleanup)

    for (const [value, button] of widgets.effortButtons.entries()) {
      button.set_active(value === speechEffort)
    }

    const presets = hotkeyPresets()
    widgets.hotkeyPresets = presets
    widgets.hotkeyDropdown.set_model(Gtk.StringList.new(presets.map((preset) => preset.label)))
    const hotkeyIndex = Math.max(0, presets.findIndex((preset) => preset.value === pushToTalkHotkey || preset.value === latestPayload.runtime?.hotkey))
    widgets.hotkeyDropdown.set_selected(hotkeyIndex)

    const buffer = widgets.typingView.get_buffer()
    buffer.set_text(String(typingBenchmark?.sampleText && typingBenchmark?.elapsedMs ? latestPayload.sampleText : ''))
    benchmarkElapsedMs = Math.max(0, Number(typingBenchmark?.elapsedMs || 0) || 0)
    benchmarkStartedAt = benchmarkElapsedMs ? Date.now() - benchmarkElapsedMs : 0

    widgets.sampleLabel.set_label(compactSpaces(latestPayload.sampleText || ''))
    updateRuntimeSummary()
    updateHotkeyUi()
    updateBenchmarkSummary()
    updateSummary()
    hydrated = true
  }

  function sendCompleteCommand() {
    const error = localValidationError()
    if (error) {
      showStatus(error, 'error')
      return
    }

    const payload = {
      action: 'complete_onboarding',
      requestedAt: Date.now(),
      payload: {
        profile: {
          name: normalizeProfileName(widgets.nameEntry.get_text())
        },
        choices: {
          rewriteCleanup: widgets.rewriteSwitch.get_active(),
          speechEffort: selectedSpeechEffort(),
          pushToTalkHotkey: selectedHotkeyValue()
        },
        typingBenchmark: benchmarkStats(benchmarkElapsedMs)
      }
    }

    submitted = true
    showStatus('Applying Quick Start choices…')
    widgets.finishButton.set_sensitive(false)
    writeJsonFile(cli.commandPath, payload)
  }

  function handleStateUpdate(payload) {
    latestPayload = payload || { sampleText: '', state: {}, runtime: {}, ui: {} }
    if (!hydrated) {
      initialCompletedAt = String(latestPayload.state?.completedAt || '').trim()
      hydrateFromState()
    }

    updateRuntimeSummary()
    updateHotkeyUi()

    const pending = Boolean(latestPayload.ui?.pending)
    const error = compactSpaces(latestPayload.ui?.error || '')
    const currentCompletedAt = String(latestPayload.state?.completedAt || '').trim()

    if (submitted) {
      widgets.finishButton.set_sensitive(!pending)
      if (error) {
        showStatus(error, 'error')
      } else if (pending) {
        showStatus('Applying Quick Start choices…')
      } else if (currentCompletedAt && currentCompletedAt !== initialCompletedAt) {
        showStatus('Quick Start complete. DicTray is ready.', 'success')
        if (!closeDelayId) {
          closeDelayId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 900, () => {
            closeDelayId = 0
            window?.close()
            return GLib.SOURCE_REMOVE
          })
        }
      }
    }
  }

  function buildChoiceCard(title, body, child) {
    const box = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 10
    })
    box.add_css_class('choice-card')

    const titleLabel = new Gtk.Label({ label: title, xalign: 0, wrap: true })
    titleLabel.add_css_class('section-title')

    const bodyLabel = new Gtk.Label({ label: body, xalign: 0, wrap: true })
    bodyLabel.add_css_class('section-copy')

    box.append(titleLabel)
    box.append(bodyLabel)
    box.append(child)
    return box
  }

  function buildWindow(application) {
    const applicationWindow = new Adw.ApplicationWindow({
      application,
      title: 'DicTray Quick Start',
      default_width: 620,
      default_height: 820
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

    const eyebrow = new Gtk.Label({ label: 'Quick Start', xalign: 0 })
    eyebrow.add_css_class('eyebrow')

    const headline = new Gtk.Label({
      label: 'Native Linux setup',
      xalign: 0,
      wrap: true
    })
    headline.add_css_class('headline')

    const subtitle = new Gtk.Label({
      label: 'DicTray now uses a Linux-native setup flow. Set your profile, measure your typing pace once, choose your speech effort, and finish with one clean pass.',
      xalign: 0,
      wrap: true
    })
    subtitle.add_css_class('subtle')

    widgets.runtimeLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true })
    widgets.runtimeLabel.add_css_class('runtime-copy')

    hero.append(eyebrow)
    hero.append(headline)
    hero.append(subtitle)
    hero.append(widgets.runtimeLabel)

    const scroller = new Gtk.ScrolledWindow({
      vexpand: true,
      hexpand: true,
      hscrollbar_policy: Gtk.PolicyType.NEVER
    })

    const form = new Gtk.Box({
      orientation: Gtk.Orientation.VERTICAL,
      spacing: 18
    })

    const profileCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    profileCard.add_css_class('section-card')
    const profileTitle = new Gtk.Label({ label: 'Your name', xalign: 0 })
    profileTitle.add_css_class('section-title')
    const profileCopy = new Gtk.Label({ label: 'DicTray uses this in the tray greeting and in your daily savings summary.', xalign: 0, wrap: true })
    profileCopy.add_css_class('section-copy')
    widgets.nameEntry = new Gtk.Entry({ placeholder_text: 'Denim' })
    widgets.nameEntry.connect('changed', () => {
      updateSummary()
    })
    profileCard.append(profileTitle)
    profileCard.append(profileCopy)
    profileCard.append(widgets.nameEntry)

    const benchmarkCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 12 })
    benchmarkCard.add_css_class('section-card')
    const benchmarkTitle = new Gtk.Label({ label: 'Show me your typing pace', xalign: 0 })
    benchmarkTitle.add_css_class('section-title')
    const benchmarkCopy = new Gtk.Label({ label: 'Type this sentence exactly once so DicTray can estimate how much keyboard time it saves you.', xalign: 0, wrap: true })
    benchmarkCopy.add_css_class('section-copy')
    const sampleCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 6 })
    sampleCard.add_css_class('sample-card')
    const sampleHint = new Gtk.Label({ label: 'Sample sentence', xalign: 0 })
    sampleHint.add_css_class('sample-copy')
    widgets.sampleLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true })
    widgets.sampleLabel.add_css_class('sample-text')
    sampleCard.append(sampleHint)
    sampleCard.append(widgets.sampleLabel)
    widgets.benchmarkSummaryLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true })
    widgets.benchmarkSummaryLabel.add_css_class('summary-copy')
    widgets.typingView = new Gtk.TextView({ monospace: false, wrap_mode: Gtk.WrapMode.WORD_CHAR })
    widgets.typingView.get_buffer().connect('changed', () => {
      updateBenchmarkSummary()
    })
    const typingScroller = new Gtk.ScrolledWindow({ min_content_height: 160, hexpand: true })
    typingScroller.set_child(widgets.typingView)
    widgets.benchmarkHintLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true })
    widgets.benchmarkHintLabel.add_css_class('field-hint')
    benchmarkCard.append(benchmarkTitle)
    benchmarkCard.append(benchmarkCopy)
    benchmarkCard.append(sampleCard)
    benchmarkCard.append(widgets.benchmarkSummaryLabel)
    benchmarkCard.append(typingScroller)
    benchmarkCard.append(widgets.benchmarkHintLabel)

    widgets.rewriteSwitch = new Gtk.Switch({ active: false, halign: Gtk.Align.START })
    widgets.rewriteSwitch.connect('notify::active', () => {
      updateSummary()
    })
    const rewriteCard = buildChoiceCard(
      'Do you want improved text?',
      'Use text improvement only if you want the transcript polished before insert. Built-in speech to text works on its own.',
      widgets.rewriteSwitch
    )
    rewriteCard.add_css_class('section-card')

    const effortBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    const lowButton = new Gtk.CheckButton({ label: 'Low (Faster)' })
    const midButton = new Gtk.CheckButton({ label: 'Mid (Balanced)' })
    const highButton = new Gtk.CheckButton({ label: 'High (Quality)' })
    midButton.set_group(lowButton)
    highButton.set_group(lowButton)
    widgets.effortButtons.set('low', lowButton)
    widgets.effortButtons.set('mid', midButton)
    widgets.effortButtons.set('high', highButton)
    for (const button of widgets.effortButtons.values()) {
      button.connect('toggled', () => {
        updateSummary()
      })
      effortBox.append(button)
    }
    const effortCard = buildChoiceCard(
      'How much effort should speech to text use?',
      'Pick the balance you want between speed and quality for local STT on Linux.',
      effortBox
    )
    effortCard.add_css_class('section-card')

    widgets.hotkeyDropdown = Gtk.DropDown.new_from_strings(['Loading shortcuts…'])
    widgets.hotkeyDropdown.connect('notify::selected', () => {
      updateSummary()
    })
    widgets.hotkeyHintLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true })
    widgets.hotkeyHintLabel.add_css_class('field-hint')
    const hotkeyBox = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    hotkeyBox.append(widgets.hotkeyDropdown)
    hotkeyBox.append(widgets.hotkeyHintLabel)
    const hotkeyCard = buildChoiceCard(
      'Choose your push-to-talk shortcut',
      'Hold this shortcut when you want DicTray to listen.',
      hotkeyBox
    )
    hotkeyCard.add_css_class('section-card')

    const summaryCard = new Gtk.Box({ orientation: Gtk.Orientation.VERTICAL, spacing: 10 })
    summaryCard.add_css_class('section-card')
    const summaryTitle = new Gtk.Label({ label: 'Ready to finish', xalign: 0 })
    summaryTitle.add_css_class('section-title')
    widgets.summaryLabel = new Gtk.Label({ label: '', xalign: 0, wrap: true })
    widgets.summaryLabel.add_css_class('summary-copy')
    summaryCard.append(summaryTitle)
    summaryCard.append(widgets.summaryLabel)

    form.append(profileCard)
    form.append(benchmarkCard)
    form.append(rewriteCard)
    form.append(effortCard)
    form.append(hotkeyCard)
    form.append(summaryCard)
    scroller.set_child(form)

    const footer = new Gtk.Box({
      orientation: Gtk.Orientation.HORIZONTAL,
      spacing: 12,
      hexpand: true
    })
    footer.add_css_class('section-card')

    widgets.statusLabel = new Gtk.Label({
      label: 'Complete the fields above, then finish Quick Start.',
      xalign: 0,
      hexpand: true,
      wrap: true
    })
    widgets.statusLabel.add_css_class('status-label')

    const skipButton = new Gtk.Button({ label: 'Skip for now' })
    skipButton.connect('clicked', () => {
      applicationWindow.close()
    })

    widgets.finishButton = new Gtk.Button({ label: 'Finish Quick Start' })
    widgets.finishButton.connect('clicked', () => {
      sendCompleteCommand()
    })

    footer.append(widgets.statusLabel)
    footer.append(skipButton)
    footer.append(widgets.finishButton)

    root.append(hero)
    root.append(scroller)
    root.append(footer)
    applicationWindow.set_content(root)

    applicationWindow.connect('close-request', () => {
      removeSource(closeDelayId)
      closeDelayId = 0
      return false
    })

    return applicationWindow
  }

  const app = new Adw.Application({
    application_id: 'com.okzea.DicTray.Onboarding'
  })

  app.connect('activate', () => {
    if (!window) {
      window = buildWindow(app)
      const initialPayload = readJsonFile(cli.statePath, null)
      if (initialPayload) {
        handleStateUpdate(initialPayload)
      }
      statePollId = pollJsonFile(cli.statePath, handleStateUpdate, 260)
    }

    window.present()
  })

  app.connect('shutdown', () => {
    removeSource(statePollId)
    removeSource(closeDelayId)
  })

  app.run(ARGV)
}
