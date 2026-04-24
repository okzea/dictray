import AppKit
import Foundation

struct HotkeyPreset: Decodable {
  let value: String?
  let label: String?
}

struct ProfileState: Decodable {
  let name: String?
}

struct ChoiceState: Decodable {
  let rewriteCleanup: Bool?
  let speechEffort: String?
  let pushToTalkHotkey: String?
}

struct BenchmarkState: Decodable {
  let elapsedMs: Double?
}

struct OnboardingState: Decodable {
  let seenAt: String?
  let completedAt: String?
  let profile: ProfileState?
  let choices: ChoiceState?
  let typingBenchmark: BenchmarkState?
}

struct RuntimeState: Decodable {
  let rewriteProvider: String?
  let speechEffort: String?
  let hotkey: String?
  let hotkeyManagedByEnv: Bool?
  let hotkeyPresets: [HotkeyPreset]?
}

struct UiState: Decodable {
  let pending: Bool?
  let error: String?
}

struct StatePayload: Decodable {
  let sampleText: String?
  let state: OnboardingState?
  let runtime: RuntimeState?
  let ui: UiState?
  let quit: Bool?
}

struct CommandProfile: Encodable {
  let name: String
}

struct CommandChoices: Encodable {
  let rewriteCleanup: Bool
  let speechEffort: String
  let pushToTalkHotkey: String
}

struct CommandTypingBenchmark: Encodable {
  let sampleText: String
  let elapsedMs: Int
  let charactersPerMinute: Int
  let wordsPerMinute: Double
  let measuredAt: String
}

struct CommandBody: Encodable {
  let profile: CommandProfile
  let choices: CommandChoices
  let typingBenchmark: CommandTypingBenchmark
}

struct CompleteCommand: Encodable {
  let action: String
  let requestedAt: Double
  let payload: CommandBody
}

struct ResolvedHotkeyPreset {
  let value: String
  let label: String
}

let fallbackHotkeyPresets = [
  ResolvedHotkeyPreset(value: "CommandOrControl+Space", label: "Ctrl+Space"),
  ResolvedHotkeyPreset(value: "Alt+Space", label: "Alt+Space"),
  ResolvedHotkeyPreset(value: "CommandOrControl+Alt+F12", label: "Ctrl+Alt+F12"),
  ResolvedHotkeyPreset(value: "CommandOrControl+Alt+F13", label: "Ctrl+Alt+F13"),
  ResolvedHotkeyPreset(value: "CommandOrControl+Alt+O", label: "Ctrl+Alt+O")
]

func compactSpaces(_ value: String) -> String {
  value
    .components(separatedBy: .whitespacesAndNewlines)
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

func normalizeTypedText(_ value: String) -> String {
  compactSpaces(value).lowercased()
}

func normalizeProfileName(_ value: String) -> String {
  let normalized = compactSpaces(value)
  if normalized.count <= 40 {
    return normalized
  }
  return String(normalized.prefix(40))
}

func normalizeSpeechEffort(_ value: String?) -> String {
  switch compactSpaces(value ?? "").lowercased() {
  case "low", "fast", "faster":
    return "low"
  case "high", "quality":
    return "high"
  case "mid", "middle", "medium", "balanced":
    return "mid"
  default:
    return ""
  }
}

func speechEffortLabel(_ value: String) -> String {
  switch normalizeSpeechEffort(value) {
  case "low":
    return "Low (Faster)"
  case "high":
    return "High (Quality)"
  default:
    return "Mid (Balanced)"
  }
}

func readPayload(at path: String) -> (String, StatePayload?) {
  guard let data = FileManager.default.contents(atPath: path),
        let raw = String(data: data, encoding: .utf8),
        !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  else {
    return ("", nil)
  }

  return (raw, try? JSONDecoder().decode(StatePayload.self, from: data))
}

func writeCommand(_ command: CompleteCommand, to path: String) {
  let url = URL(fileURLWithPath: path)
  try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard let data = try? JSONEncoder().encode(command) else {
    return
  }
  try? data.write(to: url, options: .atomic)
}

func makeLabel(_ text: String, font: NSFont, color: NSColor = .labelColor) -> NSTextField {
  let label = NSTextField(labelWithString: text)
  label.font = font
  label.textColor = color
  label.lineBreakMode = .byWordWrapping
  label.maximumNumberOfLines = 0
  return label
}

func makeCard() -> NSStackView {
  let stack = NSStackView()
  stack.orientation = .vertical
  stack.spacing = 10
  stack.edgeInsets = NSEdgeInsets(top: 16, left: 16, bottom: 16, right: 16)
  stack.wantsLayer = true
  stack.layer?.cornerRadius = 10
  stack.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.72).cgColor
  stack.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.4).cgColor
  stack.layer?.borderWidth = 1
  return stack
}

final class QuickStartController: NSObject, NSApplicationDelegate, NSTextViewDelegate {
  private let statePath: String
  private let commandPath: String
  private var window: NSWindow?
  private var pollTimer: Timer?
  private var closeTimer: Timer?
  private var latestPayload = StatePayload(sampleText: "", state: nil, runtime: nil, ui: nil, quit: nil)
  private var lastRawState = ""
  private var hydrated = false
  private var submitted = false
  private var initialCompletedAt = ""
  private var benchmarkStartedAt: Date?
  private var benchmarkElapsedMs = 0
  private var hotkeyPresets = fallbackHotkeyPresets

  private let nameField = NSTextField()
  private let sampleLabel = makeLabel("", font: .boldSystemFont(ofSize: 19))
  private let typingView = NSTextView()
  private let benchmarkSummaryLabel = makeLabel("", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let benchmarkHintLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
  private let rewriteCheckbox = NSButton(checkboxWithTitle: "Polish transcript text before inserting", target: nil, action: nil)
  private let lowButton = NSButton(radioButtonWithTitle: "Low (Faster)", target: nil, action: nil)
  private let midButton = NSButton(radioButtonWithTitle: "Mid (Balanced)", target: nil, action: nil)
  private let highButton = NSButton(radioButtonWithTitle: "High (Quality)", target: nil, action: nil)
  private let hotkeyPopup = NSPopUpButton()
  private let hotkeyHintLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
  private let runtimeLabel = makeLabel("", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let summaryLabel = makeLabel("", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let statusLabel = makeLabel("Complete the fields above, then finish Quick Start.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let finishButton = NSButton(title: "Finish Quick Start", target: nil, action: nil)

  init(statePath: String, commandPath: String) {
    self.statePath = statePath
    self.commandPath = commandPath
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    buildWindow()
    refreshState(force: true)
    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.28, repeats: true) { [weak self] _ in
      self?.refreshState(force: false)
    }
    window?.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationWillTerminate(_ notification: Notification) {
    pollTimer?.invalidate()
    closeTimer?.invalidate()
  }

  func textDidChange(_ notification: Notification) {
    updateBenchmarkSummary()
  }

  @objc private func formChanged(_ sender: Any?) {
    updateSummary()
  }

  @objc private func effortChanged(_ sender: NSButton) {
    lowButton.state = sender === lowButton ? .on : .off
    midButton.state = sender === midButton ? .on : .off
    highButton.state = sender === highButton ? .on : .off
    updateSummary()
  }

  @objc private func skip(_ sender: Any?) {
    window?.close()
    NSApp.terminate(nil)
  }

  @objc private func finish(_ sender: Any?) {
    sendCompleteCommand()
  }

  private func buildWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 640, height: 760),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "DicTray Quick Start"
    window.center()
    window.isReleasedWhenClosed = false
    window.delegate = self

    let root = NSStackView()
    root.orientation = .vertical
    root.spacing = 14
    root.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
    root.translatesAutoresizingMaskIntoConstraints = false

    let hero = makeCard()
    hero.addArrangedSubview(makeLabel("Quick Start", font: .boldSystemFont(ofSize: 12), color: .systemGreen))
    hero.addArrangedSubview(makeLabel("Set up DicTray on macOS", font: .boldSystemFont(ofSize: 27)))
    hero.addArrangedSubview(makeLabel("Measure your typing pace once, choose a speech-to-text balance, and pick the shortcut you want to hold when you speak.", font: .systemFont(ofSize: 14), color: .secondaryLabelColor))
    hero.addArrangedSubview(runtimeLabel)

    let contentStack = NSStackView()
    contentStack.orientation = .vertical
    contentStack.spacing = 14
    contentStack.translatesAutoresizingMaskIntoConstraints = false

    let profileCard = makeCard()
    profileCard.addArrangedSubview(makeLabel("Your Name", font: .boldSystemFont(ofSize: 16)))
    profileCard.addArrangedSubview(makeLabel("DicTray uses this in the menu-bar greeting and daily savings summary.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor))
    nameField.placeholderString = "Denim"
    nameField.target = self
    nameField.action = #selector(formChanged(_:))
    NotificationCenter.default.addObserver(self, selector: #selector(formChanged(_:)), name: NSControl.textDidChangeNotification, object: nameField)
    profileCard.addArrangedSubview(nameField)

    let benchmarkCard = makeCard()
    benchmarkCard.addArrangedSubview(makeLabel("Show Me Your Typing Pace", font: .boldSystemFont(ofSize: 16)))
    benchmarkCard.addArrangedSubview(makeLabel("Type this sentence exactly once so DicTray can estimate how much keyboard time it saves.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor))
    benchmarkCard.addArrangedSubview(sampleLabel)
    benchmarkCard.addArrangedSubview(benchmarkSummaryLabel)
    typingView.minSize = NSSize(width: 0, height: 120)
    typingView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    typingView.isVerticallyResizable = true
    typingView.isHorizontallyResizable = false
    typingView.textContainer?.widthTracksTextView = true
    typingView.font = .systemFont(ofSize: 15)
    typingView.delegate = self
    let typingScroll = NSScrollView()
    typingScroll.hasVerticalScroller = true
    typingScroll.borderType = .bezelBorder
    typingScroll.documentView = typingView
    typingScroll.translatesAutoresizingMaskIntoConstraints = false
    typingScroll.heightAnchor.constraint(equalToConstant: 130).isActive = true
    benchmarkCard.addArrangedSubview(typingScroll)
    benchmarkCard.addArrangedSubview(benchmarkHintLabel)

    rewriteCheckbox.target = self
    rewriteCheckbox.action = #selector(formChanged(_:))

    let rewriteCard = makeCard()
    rewriteCard.addArrangedSubview(makeLabel("Improved Text", font: .boldSystemFont(ofSize: 16)))
    rewriteCard.addArrangedSubview(makeLabel("Leave this off if you want raw transcripts inserted immediately. Turn it on if you want a cleanup pass first.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor))
    rewriteCard.addArrangedSubview(rewriteCheckbox)

    lowButton.target = self
    lowButton.action = #selector(effortChanged(_:))
    midButton.target = self
    midButton.action = #selector(effortChanged(_:))
    highButton.target = self
    highButton.action = #selector(effortChanged(_:))
    let effortCard = makeCard()
    effortCard.addArrangedSubview(makeLabel("Speech-to-Text Effort", font: .boldSystemFont(ofSize: 16)))
    effortCard.addArrangedSubview(makeLabel("Choose the balance between speed and transcription quality.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor))
    effortCard.addArrangedSubview(lowButton)
    effortCard.addArrangedSubview(midButton)
    effortCard.addArrangedSubview(highButton)

    hotkeyPopup.target = self
    hotkeyPopup.action = #selector(formChanged(_:))
    let hotkeyCard = makeCard()
    hotkeyCard.addArrangedSubview(makeLabel("Push-to-Talk Shortcut", font: .boldSystemFont(ofSize: 16)))
    hotkeyCard.addArrangedSubview(makeLabel("Hold this shortcut when you want DicTray to listen.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor))
    hotkeyCard.addArrangedSubview(hotkeyPopup)
    hotkeyCard.addArrangedSubview(hotkeyHintLabel)

    let summaryCard = makeCard()
    summaryCard.addArrangedSubview(makeLabel("Ready To Finish", font: .boldSystemFont(ofSize: 16)))
    summaryCard.addArrangedSubview(summaryLabel)

    [profileCard, benchmarkCard, rewriteCard, effortCard, hotkeyCard, summaryCard].forEach {
      contentStack.addArrangedSubview($0)
    }

    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.documentView = contentStack
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    contentStack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor).isActive = true

    let footer = NSStackView()
    footer.orientation = .horizontal
    footer.spacing = 12
    footer.edgeInsets = NSEdgeInsets(top: 12, left: 0, bottom: 0, right: 0)
    let skipButton = NSButton(title: "Skip For Now", target: self, action: #selector(skip(_:)))
    finishButton.target = self
    finishButton.action = #selector(finish(_:))
    footer.addArrangedSubview(statusLabel)
    footer.addArrangedSubview(skipButton)
    footer.addArrangedSubview(finishButton)
    statusLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)

    root.addArrangedSubview(hero)
    root.addArrangedSubview(scrollView)
    root.addArrangedSubview(footer)
    scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 340).isActive = true

    let contentView = NSView()
    contentView.addSubview(root)
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      root.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      root.topAnchor.constraint(equalTo: contentView.topAnchor),
      root.bottomAnchor.constraint(equalTo: contentView.bottomAnchor)
    ])
    window.contentView = contentView
    self.window = window
  }

  private func resolvedPresets() -> [ResolvedHotkeyPreset] {
    let payloadPresets = latestPayload.runtime?.hotkeyPresets ?? []
    let resolved = payloadPresets.compactMap { preset -> ResolvedHotkeyPreset? in
      let value = compactSpaces(preset.value ?? "")
      let label = compactSpaces(preset.label ?? preset.value ?? "")
      return value.isEmpty || label.isEmpty ? nil : ResolvedHotkeyPreset(value: value, label: label)
    }
    return resolved.isEmpty ? fallbackHotkeyPresets : resolved
  }

  private func selectedSpeechEffort() -> String {
    if lowButton.state == .on {
      return "low"
    }
    if highButton.state == .on {
      return "high"
    }
    return "mid"
  }

  private func selectedHotkeyValue() -> String {
    let index = max(0, hotkeyPopup.indexOfSelectedItem)
    if index < hotkeyPresets.count {
      return hotkeyPresets[index].value
    }
    return fallbackHotkeyPresets[0].value
  }

  private func typingText() -> String {
    typingView.string
  }

  private func benchmarkStats(elapsedMs: Int) -> CommandTypingBenchmark {
    let sample = compactSpaces(latestPayload.sampleText ?? "")
    let characters = Array(sample).count
    let words = sample.split(separator: " ").count
    let cpm = elapsedMs > 0 ? max(0, Int(round((Double(characters) / Double(elapsedMs)) * 60000.0))) : 0
    let wpmRaw = elapsedMs > 0 ? (Double(words) / Double(elapsedMs)) * 60000.0 : 0
    let wpm = max(0, (wpmRaw * 10.0).rounded() / 10.0)
    return CommandTypingBenchmark(
      sampleText: sample,
      elapsedMs: elapsedMs,
      charactersPerMinute: cpm,
      wordsPerMinute: wpm,
      measuredAt: elapsedMs > 0 ? ISO8601DateFormatter().string(from: Date()) : ""
    )
  }

  private func validationError() -> String {
    if normalizeProfileName(nameField.stringValue).isEmpty {
      return "Add your name before finishing Quick Start."
    }
    if benchmarkElapsedMs <= 0 {
      return "Complete the typing benchmark before finishing Quick Start."
    }
    if normalizeTypedText(typingText()) != normalizeTypedText(latestPayload.sampleText ?? "") {
      return "Type the sample sentence exactly once before finishing Quick Start."
    }
    return ""
  }

  private func setStatus(_ message: String, color: NSColor = .secondaryLabelColor) {
    statusLabel.stringValue = compactSpaces(message).isEmpty ? "Ready." : compactSpaces(message)
    statusLabel.textColor = color
  }

  private func updateRuntimeSummary() {
    let provider = compactSpaces(latestPayload.runtime?.rewriteProvider ?? "")
    let improvement = !provider.isEmpty && provider.lowercased() != "none"
      ? "Text improvement can use \(provider)."
      : "Text improvement stays optional."
    runtimeLabel.stringValue = "Built-in speech to text is the default on macOS. \(improvement)"
  }

  private func updateHotkeyUi() {
    let managed = latestPayload.runtime?.hotkeyManagedByEnv == true
    hotkeyPopup.isEnabled = !managed
    hotkeyHintLabel.stringValue = managed
      ? "Shortcut is managed externally and currently set to \(compactSpaces(latestPayload.runtime?.hotkey ?? "unknown"))."
      : "Choose the shortcut you want to hold when you speak."
  }

  private func updateBenchmarkSummary() {
    let typed = normalizeTypedText(typingText())
    let sample = normalizeTypedText(latestPayload.sampleText ?? "")
    if typed.isEmpty {
      benchmarkElapsedMs = 0
      benchmarkStartedAt = nil
      benchmarkSummaryLabel.stringValue = "Type the sentence once. The timer starts on your first keystroke."
      benchmarkHintLabel.stringValue = "DicTray uses this to estimate how much keyboard time it saves each day."
      updateSummary()
      return
    }
    if benchmarkStartedAt == nil {
      benchmarkStartedAt = Date()
    }
    if typed == sample {
      benchmarkElapsedMs = max(1, Int(Date().timeIntervalSince(benchmarkStartedAt ?? Date()) * 1000.0))
      let stats = benchmarkStats(elapsedMs: benchmarkElapsedMs)
      benchmarkSummaryLabel.stringValue = "Typing pace captured: \(stats.charactersPerMinute) chars/min and \(stats.wordsPerMinute) words/min."
      benchmarkHintLabel.stringValue = "Benchmark duration: \(max(1, Int(round(Double(stats.elapsedMs) / 1000.0))))s."
      updateSummary()
      return
    }
    benchmarkElapsedMs = 0
    benchmarkSummaryLabel.stringValue = "Keep going until the sample matches exactly once."
    benchmarkHintLabel.stringValue = "Upper/lowercase and extra spaces do not matter, but the words must match."
    updateSummary()
  }

  private func updateSummary() {
    let name = normalizeProfileName(nameField.stringValue)
    let presetLabel = hotkeyPopup.titleOfSelectedItem ?? "Unknown"
    summaryLabel.stringValue = [
      "Profile: \(name.isEmpty ? "Anonymous" : name)",
      "Text improvement: \(rewriteCheckbox.state == .on ? "On" : "Off")",
      "Speech effort: \(speechEffortLabel(selectedSpeechEffort()))",
      "Push-to-talk: \(presetLabel)"
    ].joined(separator: "  |  ")
  }

  private func hydrateFromState() {
    let state = latestPayload.state
    let profileName = normalizeProfileName(state?.profile?.name ?? "")
    let rewriteCleanup = state?.choices?.rewriteCleanup == true
    let speechEffort = normalizeSpeechEffort(state?.choices?.speechEffort) == ""
      ? (normalizeSpeechEffort(latestPayload.runtime?.speechEffort) == "" ? "mid" : normalizeSpeechEffort(latestPayload.runtime?.speechEffort))
      : normalizeSpeechEffort(state?.choices?.speechEffort)
    let pushToTalkHotkey = compactSpaces(state?.choices?.pushToTalkHotkey ?? latestPayload.runtime?.hotkey ?? "")

    nameField.stringValue = profileName
    rewriteCheckbox.state = rewriteCleanup ? .on : .off
    lowButton.state = speechEffort == "low" ? .on : .off
    midButton.state = speechEffort == "mid" ? .on : .off
    highButton.state = speechEffort == "high" ? .on : .off

    hotkeyPresets = resolvedPresets()
    hotkeyPopup.removeAllItems()
    hotkeyPopup.addItems(withTitles: hotkeyPresets.map { $0.label })
    let selectedIndex = hotkeyPresets.firstIndex { preset in
      preset.value == pushToTalkHotkey || preset.value == latestPayload.runtime?.hotkey
    } ?? 0
    hotkeyPopup.selectItem(at: selectedIndex)

    sampleLabel.stringValue = compactSpaces(latestPayload.sampleText ?? "")
    let elapsed = Int(state?.typingBenchmark?.elapsedMs ?? 0)
    if elapsed > 0 {
      typingView.string = compactSpaces(latestPayload.sampleText ?? "")
      benchmarkElapsedMs = elapsed
      benchmarkStartedAt = Date(timeIntervalSinceNow: -Double(elapsed) / 1000.0)
    } else {
      typingView.string = ""
      benchmarkElapsedMs = 0
      benchmarkStartedAt = nil
    }

    updateRuntimeSummary()
    updateHotkeyUi()
    updateBenchmarkSummary()
    updateSummary()
    hydrated = true
  }

  private func sendCompleteCommand() {
    let error = validationError()
    if !error.isEmpty {
      setStatus(error, color: .systemRed)
      return
    }

    let command = CompleteCommand(
      action: "complete_onboarding",
      requestedAt: Date().timeIntervalSince1970 * 1000.0,
      payload: CommandBody(
        profile: CommandProfile(name: normalizeProfileName(nameField.stringValue)),
        choices: CommandChoices(
          rewriteCleanup: rewriteCheckbox.state == .on,
          speechEffort: selectedSpeechEffort(),
          pushToTalkHotkey: selectedHotkeyValue()
        ),
        typingBenchmark: benchmarkStats(elapsedMs: benchmarkElapsedMs)
      )
    )

    submitted = true
    finishButton.isEnabled = false
    setStatus("Applying Quick Start choices...")
    writeCommand(command, to: commandPath)
  }

  private func handleStateUpdate(_ payload: StatePayload) {
    latestPayload = payload
    if payload.quit == true {
      NSApp.terminate(nil)
      return
    }

    if !hydrated {
      initialCompletedAt = compactSpaces(payload.state?.completedAt ?? "")
      hydrateFromState()
    }

    updateRuntimeSummary()
    updateHotkeyUi()

    let pending = payload.ui?.pending == true
    let error = compactSpaces(payload.ui?.error ?? "")
    let completedAt = compactSpaces(payload.state?.completedAt ?? "")

    if submitted {
      finishButton.isEnabled = !pending
      if !error.isEmpty {
        setStatus(error, color: .systemRed)
      } else if pending {
        setStatus("Applying Quick Start choices...")
      } else if !completedAt.isEmpty && completedAt != initialCompletedAt {
        setStatus("Quick Start complete. DicTray is ready.", color: .systemGreen)
        if closeTimer == nil {
          closeTimer = Timer.scheduledTimer(withTimeInterval: 0.9, repeats: false) { [weak self] _ in
            self?.window?.close()
            NSApp.terminate(nil)
          }
        }
      }
    }
  }

  private func refreshState(force: Bool) {
    let (raw, payload) = readPayload(at: statePath)
    guard let payload = payload else {
      return
    }
    if !force && raw == lastRawState {
      return
    }
    lastRawState = raw
    handleStateUpdate(payload)
  }
}

extension QuickStartController: NSWindowDelegate {
  func windowWillClose(_ notification: Notification) {
    closeTimer?.invalidate()
    closeTimer = nil
    NSApp.terminate(nil)
  }
}

if CommandLine.arguments.contains("--self-test") {
  print("{\"ok\":true,\"script\":\"macos-onboarding\"}")
  exit(0)
}

let statePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let commandPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""

if statePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  || commandPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  fputs("Usage: macos-onboarding <state-path> <command-path>\n", stderr)
  exit(1)
}

let controller = QuickStartController(statePath: statePath, commandPath: commandPath)
NSApplication.shared.delegate = controller
NSApplication.shared.run()
