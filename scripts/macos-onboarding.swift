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
  let sttPromptContext: String?
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
  let sttPromptContext: String?
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
  let sttPromptContext: String
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

final class FlippedStackView: NSStackView {
  override var isFlipped: Bool {
    true
  }
}

let fallbackHotkeyPresets = [
  ResolvedHotkeyPreset(value: "CommandOrControl+Space", label: "Ctrl+Space"),
  ResolvedHotkeyPreset(value: "Alt+Space", label: "Alt+Space"),
  ResolvedHotkeyPreset(value: "CommandOrControl+Alt+F12", label: "Ctrl+Alt+F12"),
  ResolvedHotkeyPreset(value: "CommandOrControl+Alt+F13", label: "Ctrl+Alt+F13"),
  ResolvedHotkeyPreset(value: "CommandOrControl+Alt+O", label: "Ctrl+Alt+O")
]

let largeStudyAverageWpm = 52.0

let typingScoreBands = [
  "Careful typer: under 30",
  "Casual: 30-39",
  "Office-ready: 40-51",
  "Above average: 52-69",
  "Fast: 70-89",
  "Very fast: 90+"
]

func compactSpaces(_ value: String) -> String {
  value
    .components(separatedBy: .whitespacesAndNewlines)
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

func normalizeTypedText(_ value: String) -> String {
  compactSpaces(value)
    .replacingOccurrences(of: "’", with: "'")
    .replacingOccurrences(of: "‘", with: "'")
    .replacingOccurrences(of: "ʼ", with: "'")
    .lowercased()
}

func typingScoreLabel(_ wpm: Double) -> String {
  switch max(0, wpm) {
  case ..<30:
    return "Careful typer"
  case ..<40:
    return "Casual"
  case ..<largeStudyAverageWpm:
    return "Office-ready"
  case ..<70:
    return "Above average"
  case ..<90:
    return "Fast"
  default:
    return "Very fast"
  }
}

func typingPlacementLine(_ wpm: Double) -> String {
  let roundedWpm = max(0, Int(round(wpm)))
  let averageWpm = Int(largeStudyAverageWpm)
  if roundedWpm > averageWpm {
    return "\(roundedWpm) WPM (words per minute) • above the large-study average of \(averageWpm)."
  }
  if roundedWpm == averageWpm {
    return "\(roundedWpm) WPM (words per minute) • matches the large-study average of \(averageWpm)."
  }
  return "\(roundedWpm) WPM (words per minute) • below the large-study average of \(averageWpm)."
}

func typingScoreTooltip(currentScore: String = "") -> String {
  var lines = [String]()
  if !currentScore.isEmpty {
    lines.append("You are here: \(currentScore)")
    lines.append("")
  }
  lines.append("Typing ladder")
  lines.append("WPM = words per minute")
  lines.append("")
  lines.append(contentsOf: typingScoreBands)
  return lines.joined(separator: "\n")
}

func normalizeProfileName(_ value: String) -> String {
  let normalized = compactSpaces(value)
  if normalized.count <= 40 {
    return normalized
  }
  return String(normalized.prefix(40))
}

func normalizeSttPromptContext(_ value: String) -> String {
  let normalized = value
    .replacingOccurrences(of: "\r\n", with: "\n")
    .replacingOccurrences(of: "\r", with: "\n")
    .components(separatedBy: "\n")
    .map { compactSpaces($0) }
    .filter { !$0.isEmpty }
    .joined(separator: "\n")
  if normalized.count <= 1200 {
    return normalized
  }
  return String(normalized.prefix(1200)).trimmingCharacters(in: .whitespacesAndNewlines)
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
  label.alignment = .left
  label.lineBreakMode = .byWordWrapping
  label.maximumNumberOfLines = 0
  label.cell?.wraps = true
  label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
  return label
}

func makeStack(_ orientation: NSUserInterfaceLayoutOrientation = .vertical, spacing: CGFloat = 10) -> NSStackView {
  let stack = NSStackView()
  stack.orientation = orientation
  stack.spacing = spacing
  stack.translatesAutoresizingMaskIntoConstraints = false
  return stack
}

func makeFlippedStack(_ orientation: NSUserInterfaceLayoutOrientation = .vertical, spacing: CGFloat = 10) -> FlippedStackView {
  let stack = FlippedStackView()
  stack.orientation = orientation
  stack.spacing = spacing
  stack.translatesAutoresizingMaskIntoConstraints = false
  return stack
}

func addFullWidthArrangedSubview(_ view: NSView, to stack: NSStackView) {
  view.translatesAutoresizingMaskIntoConstraints = false
  stack.addArrangedSubview(view)
  view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
}

func makeInsetControl(_ view: NSView, horizontalInset: CGFloat = 4, fixedWidth: CGFloat? = nil) -> NSView {
  let container = NSView()
  container.translatesAutoresizingMaskIntoConstraints = false
  view.translatesAutoresizingMaskIntoConstraints = false
  container.addSubview(view)

  var constraints = [
    view.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: horizontalInset),
    view.topAnchor.constraint(equalTo: container.topAnchor),
    view.bottomAnchor.constraint(equalTo: container.bottomAnchor)
  ]
  if let fixedWidth {
    constraints.append(view.widthAnchor.constraint(equalToConstant: fixedWidth))
    constraints.append(view.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -horizontalInset))
  } else {
    constraints.append(view.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -horizontalInset))
  }
  NSLayoutConstraint.activate(constraints)
  return container
}

func makeSectionBox(title: String, subtitle: String = "", views: [NSView]) -> NSStackView {
  let stack = makeStack(.vertical, spacing: 8)
  stack.alignment = .leading
  stack.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
  addFullWidthArrangedSubview(makeLabel(title, font: .systemFont(ofSize: 16, weight: .semibold)), to: stack)
  if !compactSpaces(subtitle).isEmpty {
    let subtitleLabel = makeLabel(subtitle, font: .systemFont(ofSize: 12.5), color: .secondaryLabelColor)
    subtitleLabel.maximumNumberOfLines = 2
    addFullWidthArrangedSubview(subtitleLabel, to: stack)
  }
  views.forEach { addFullWidthArrangedSubview($0, to: stack) }
  return stack
}

func makeSeparator() -> NSBox {
  let separator = NSBox()
  separator.boxType = .separator
  return separator
}

func makeSidebarItem(_ number: String, title: String, detail: String) -> NSView {
  let row = NSView()
  row.translatesAutoresizingMaskIntoConstraints = false

  let index = makeLabel(number, font: .monospacedDigitSystemFont(ofSize: 12, weight: .semibold), color: .controlAccentColor)
  index.alignment = .right
  index.maximumNumberOfLines = 1
  index.translatesAutoresizingMaskIntoConstraints = false

  let titleLabel = makeLabel(title, font: .systemFont(ofSize: 13, weight: .medium))
  titleLabel.maximumNumberOfLines = 1
  titleLabel.lineBreakMode = .byTruncatingTail

  let detailLabel = makeLabel(detail, font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
  detailLabel.maximumNumberOfLines = 1
  detailLabel.lineBreakMode = .byTruncatingTail

  let copy = makeStack(.vertical, spacing: 2)
  copy.alignment = .leading
  copy.addArrangedSubview(titleLabel)
  copy.addArrangedSubview(detailLabel)

  row.addSubview(index)
  row.addSubview(copy)
  NSLayoutConstraint.activate([
    row.heightAnchor.constraint(equalToConstant: 42),
    index.leadingAnchor.constraint(equalTo: row.leadingAnchor),
    index.topAnchor.constraint(equalTo: row.topAnchor, constant: 2),
    index.widthAnchor.constraint(equalToConstant: 18),
    copy.leadingAnchor.constraint(equalTo: index.trailingAnchor, constant: 10),
    copy.trailingAnchor.constraint(equalTo: row.trailingAnchor),
    copy.topAnchor.constraint(equalTo: row.topAnchor),
    copy.bottomAnchor.constraint(lessThanOrEqualTo: row.bottomAnchor)
  ])
  return row
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
  private var benchmarkTimer: Timer?
  private var benchmarkInfoPopover: NSPopover?
  private var hotkeyPresets = fallbackHotkeyPresets

  private let nameField = NSTextField()
  private let sampleLabel = makeLabel("", font: .boldSystemFont(ofSize: 19))
  private let typingView = NSTextView()
  private let sttContextView = NSTextView()
  private let benchmarkSummaryLabel = makeLabel("", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let benchmarkHintLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
  private let benchmarkInfoButton = NSButton(title: "?", target: nil, action: nil)
  private let resetBenchmarkButton = NSButton(title: "Restart", target: nil, action: nil)
  private let rewriteCheckbox = NSButton(checkboxWithTitle: "Polish transcript text before inserting", target: nil, action: nil)
  private let effortControl = NSSegmentedControl(labels: ["Faster", "Balanced", "Quality"], trackingMode: .selectOne, target: nil, action: nil)
  private let hotkeyPopup = NSPopUpButton()
  private let hotkeyHintLabel = makeLabel("", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
  private let runtimeLabel = makeLabel("", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let summaryLabel = makeLabel("", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
  private let statusLabel = makeLabel("Complete setup, then finish Quick Start.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
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
    benchmarkTimer?.invalidate()
  }

  func textDidChange(_ notification: Notification) {
    guard let textView = notification.object as? NSTextView else {
      return
    }
    if textView === typingView {
      updateBenchmarkSummary()
      return
    }
    if textView === sttContextView {
      updateSummary()
    }
  }

  @objc private func formChanged(_ sender: Any?) {
    updateSummary()
  }

  @objc private func effortChanged(_ sender: Any?) {
    updateSummary()
  }

  @objc private func skip(_ sender: Any?) {
    window?.close()
    NSApp.terminate(nil)
  }

  @objc private func finish(_ sender: Any?) {
    sendCompleteCommand()
  }

  @objc private func resetBenchmark(_ sender: Any?) {
    benchmarkTimer?.invalidate()
    benchmarkTimer = nil
    benchmarkStartedAt = nil
    benchmarkElapsedMs = 0
    typingView.string = ""
    typingView.textColor = .labelColor
    updateBenchmarkSummary()
    window?.makeFirstResponder(typingView)
  }

  @objc private func showBenchmarkScoreHelp(_ sender: Any?) {
    benchmarkInfoPopover?.close()

    let score = currentBenchmarkScore()
    benchmarkInfoButton.toolTip = typingScoreTooltip(currentScore: score)

    let label = makeLabel(typingScoreTooltip(currentScore: score), font: .systemFont(ofSize: 12))
    label.maximumNumberOfLines = 0
    label.translatesAutoresizingMaskIntoConstraints = false

    let content = NSView()
    content.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(label)

    NSLayoutConstraint.activate([
      label.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 14),
      label.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -14),
      label.topAnchor.constraint(equalTo: content.topAnchor, constant: 12),
      label.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -12),
      label.widthAnchor.constraint(equalToConstant: 250)
    ])

    let controller = NSViewController()
    controller.view = content

    let popover = NSPopover()
    popover.behavior = .transient
    popover.contentViewController = controller
    popover.contentSize = NSSize(width: 278, height: score.isEmpty ? 164 : 194)
    benchmarkInfoPopover = popover
    popover.show(relativeTo: benchmarkInfoButton.bounds, of: benchmarkInfoButton, preferredEdge: .maxY)
  }

  private func appCoreRoots() -> [URL] {
    let paths = [
      CommandLine.arguments.first ?? "",
      #file
    ]
    var seen = Set<String>()
    var roots: [URL] = []

    for path in paths {
      let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty {
        continue
      }
      let root = URL(fileURLWithPath: trimmed)
        .resolvingSymlinksInPath()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
      let key = root.path
      if !seen.contains(key) {
        seen.insert(key)
        roots.append(root)
      }
    }

    return roots
  }

  private func loadBrandLogoImage() -> NSImage? {
    for root in appCoreRoots() {
      let candidates = [
        root.appendingPathComponent("assets/brand/dictray-logo-template.png"),
        root.appendingPathComponent("assets/brand/dictray-logo-light.png")
      ]
      for candidate in candidates {
        if let image = NSImage(contentsOf: candidate) {
          image.isTemplate = true
          return image
        }
      }
    }

    return nil
  }

  private func makeBrandLogoView(size: CGFloat) -> NSImageView? {
    guard let image = loadBrandLogoImage() else {
      return nil
    }

    let imageView = NSImageView(image: image)
    imageView.imageScaling = .scaleProportionallyUpOrDown
    imageView.translatesAutoresizingMaskIntoConstraints = false
    if #available(macOS 10.14, *) {
      imageView.contentTintColor = .labelColor
    }
    NSLayoutConstraint.activate([
      imageView.widthAnchor.constraint(equalToConstant: size),
      imageView.heightAnchor.constraint(equalToConstant: size)
    ])
    return imageView
  }

  private func buildWindow() {
    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 920, height: 640),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "Quick Start"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.styleMask.insert(.fullSizeContentView)
    window.minSize = NSSize(width: 820, height: 540)
    window.center()
    window.isReleasedWhenClosed = false
    window.delegate = self

    let background = NSVisualEffectView()
    background.material = .contentBackground
    background.blendingMode = .withinWindow
    background.state = .active

    let root = makeStack(.horizontal, spacing: 0)
    root.alignment = .top

    let sidebar = NSVisualEffectView()
    sidebar.material = .sidebar
    sidebar.blendingMode = .withinWindow
    sidebar.state = .active
    sidebar.translatesAutoresizingMaskIntoConstraints = false

    let sidebarStack = makeStack(.vertical, spacing: 16)
    sidebarStack.alignment = .leading
    sidebarStack.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)

    let appTitle = makeLabel("DicTray", font: .systemFont(ofSize: 24, weight: .semibold))
    let appSubtitle = makeLabel("Quick Start", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
    let brandText = makeStack(.vertical, spacing: 2)
    brandText.alignment = .leading
    brandText.addArrangedSubview(appTitle)
    brandText.addArrangedSubview(appSubtitle)

    let sidebarHeader = makeStack(.horizontal, spacing: 10)
    sidebarHeader.alignment = .centerY
    if let logoView = makeBrandLogoView(size: 34) {
      sidebarHeader.addArrangedSubview(logoView)
    }
    sidebarHeader.addArrangedSubview(brandText)

    addFullWidthArrangedSubview(sidebarHeader, to: sidebarStack)
    sidebarStack.setCustomSpacing(24, after: sidebarHeader)
    addFullWidthArrangedSubview(makeSidebarItem("1", title: "Profile", detail: "Name and greeting"), to: sidebarStack)
    addFullWidthArrangedSubview(makeSidebarItem("2", title: "Typing Pace", detail: "Savings estimate"), to: sidebarStack)
    addFullWidthArrangedSubview(makeSidebarItem("3", title: "Dictation", detail: "Model and cleanup"), to: sidebarStack)
    addFullWidthArrangedSubview(makeSidebarItem("4", title: "Shortcut", detail: "Push to talk"), to: sidebarStack)
    sidebarStack.addArrangedSubview(NSView())

    sidebar.addSubview(sidebarStack)
    NSLayoutConstraint.activate([
      sidebar.widthAnchor.constraint(equalToConstant: 204),
      sidebarStack.leadingAnchor.constraint(equalTo: sidebar.leadingAnchor, constant: 28),
      sidebarStack.trailingAnchor.constraint(equalTo: sidebar.trailingAnchor, constant: -22),
      sidebarStack.topAnchor.constraint(equalTo: sidebar.topAnchor, constant: 40),
      sidebarStack.bottomAnchor.constraint(equalTo: sidebar.bottomAnchor, constant: -24)
    ])

    let main = makeStack(.vertical, spacing: 18)
    main.alignment = .leading
    main.edgeInsets = NSEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
    main.setContentHuggingPriority(.defaultLow, for: .horizontal)
    main.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    main.widthAnchor.constraint(greaterThanOrEqualToConstant: 620).isActive = true

    let header = makeStack(.vertical, spacing: 6)
    header.alignment = .leading
    addFullWidthArrangedSubview(makeLabel("Set up DicTray on macOS", font: .systemFont(ofSize: 24, weight: .semibold)), to: header)
    let headerSubtitle = makeLabel("Measure your typing pace, choose speech-to-text behavior, and pick a push-to-talk shortcut.", font: .systemFont(ofSize: 13), color: .secondaryLabelColor)
    headerSubtitle.maximumNumberOfLines = 2
    addFullWidthArrangedSubview(headerSubtitle, to: header)
    runtimeLabel.maximumNumberOfLines = 2
    addFullWidthArrangedSubview(runtimeLabel, to: header)

    let contentStack = makeFlippedStack(.vertical, spacing: 26)
    contentStack.alignment = .leading

    nameField.placeholderString = "Avery"
    nameField.target = self
    nameField.action = #selector(formChanged(_:))
    NotificationCenter.default.addObserver(self, selector: #selector(formChanged(_:)), name: NSControl.textDidChangeNotification, object: nameField)
    nameField.translatesAutoresizingMaskIntoConstraints = false
    nameField.heightAnchor.constraint(equalToConstant: 28).isActive = true
    let profileSection = makeSectionBox(
      title: "Profile",
      subtitle: "Used for the menu-bar greeting and daily savings summary.",
      views: [makeInsetControl(nameField)]
    )

    sampleLabel.font = .systemFont(ofSize: 16, weight: .medium)
    sampleLabel.textColor = .labelColor
    sampleLabel.maximumNumberOfLines = 2
    let sampleCaption = makeLabel("Type this exact phrase", font: .systemFont(ofSize: 12, weight: .medium), color: .secondaryLabelColor)
    sampleCaption.maximumNumberOfLines = 1
    let sampleBox = NSView()
    sampleBox.translatesAutoresizingMaskIntoConstraints = false
    sampleBox.wantsLayer = true
    sampleBox.layer?.cornerRadius = 8
    sampleBox.layer?.backgroundColor = NSColor.controlBackgroundColor.withAlphaComponent(0.52).cgColor
    sampleBox.layer?.borderColor = NSColor.separatorColor.withAlphaComponent(0.55).cgColor
    sampleBox.layer?.borderWidth = 1
    let sampleContent = makeFlippedStack(.vertical, spacing: 4)
    sampleContent.alignment = .leading
    sampleContent.addArrangedSubview(sampleCaption)
    sampleContent.addArrangedSubview(sampleLabel)
    sampleBox.addSubview(sampleContent)
    NSLayoutConstraint.activate([
      sampleContent.leadingAnchor.constraint(equalTo: sampleBox.leadingAnchor, constant: 12),
      sampleContent.trailingAnchor.constraint(equalTo: sampleBox.trailingAnchor, constant: -12),
      sampleContent.topAnchor.constraint(equalTo: sampleBox.topAnchor, constant: 10),
      sampleContent.bottomAnchor.constraint(equalTo: sampleBox.bottomAnchor, constant: -10)
    ])
    typingView.minSize = NSSize(width: 0, height: 120)
    typingView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    typingView.isVerticallyResizable = true
    typingView.isHorizontallyResizable = false
    typingView.textContainer?.widthTracksTextView = true
    typingView.textContainerInset = NSSize(width: 6, height: 6)
    typingView.font = .systemFont(ofSize: 15)
    typingView.delegate = self
    let typingScroll = NSScrollView()
    typingScroll.hasVerticalScroller = true
    typingScroll.borderType = .bezelBorder
    typingScroll.documentView = typingView
    typingScroll.translatesAutoresizingMaskIntoConstraints = false
    typingScroll.heightAnchor.constraint(equalToConstant: 118).isActive = true
    resetBenchmarkButton.target = self
    resetBenchmarkButton.action = #selector(resetBenchmark(_:))
    resetBenchmarkButton.bezelStyle = .rounded
    benchmarkInfoButton.bezelStyle = .helpButton
    benchmarkInfoButton.target = self
    benchmarkInfoButton.action = #selector(showBenchmarkScoreHelp(_:))
    benchmarkInfoButton.toolTip = typingScoreTooltip()
    benchmarkSummaryLabel.maximumNumberOfLines = 2
    let benchmarkStatusRow = NSView()
    benchmarkStatusRow.translatesAutoresizingMaskIntoConstraints = false
    benchmarkStatusRow.addSubview(benchmarkSummaryLabel)
    benchmarkStatusRow.addSubview(benchmarkInfoButton)
    benchmarkStatusRow.addSubview(resetBenchmarkButton)
    benchmarkSummaryLabel.translatesAutoresizingMaskIntoConstraints = false
    benchmarkInfoButton.translatesAutoresizingMaskIntoConstraints = false
    resetBenchmarkButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      benchmarkSummaryLabel.leadingAnchor.constraint(equalTo: benchmarkStatusRow.leadingAnchor),
      benchmarkSummaryLabel.trailingAnchor.constraint(lessThanOrEqualTo: benchmarkInfoButton.leadingAnchor, constant: -8),
      benchmarkSummaryLabel.topAnchor.constraint(equalTo: benchmarkStatusRow.topAnchor),
      benchmarkSummaryLabel.bottomAnchor.constraint(equalTo: benchmarkStatusRow.bottomAnchor),
      benchmarkInfoButton.trailingAnchor.constraint(lessThanOrEqualTo: resetBenchmarkButton.leadingAnchor, constant: -12),
      benchmarkInfoButton.centerYAnchor.constraint(equalTo: benchmarkStatusRow.centerYAnchor),
      resetBenchmarkButton.trailingAnchor.constraint(equalTo: benchmarkStatusRow.trailingAnchor),
      resetBenchmarkButton.centerYAnchor.constraint(equalTo: benchmarkStatusRow.centerYAnchor),
      benchmarkStatusRow.heightAnchor.constraint(greaterThanOrEqualTo: resetBenchmarkButton.heightAnchor)
    ])
    benchmarkSummaryLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    benchmarkInfoButton.setContentHuggingPriority(.required, for: .horizontal)
    resetBenchmarkButton.setContentHuggingPriority(.required, for: .horizontal)
    let benchmarkSection = makeSectionBox(
      title: "Typing Pace",
      subtitle: "Read the phrase once, then type it naturally. DicTray uses the timing to estimate saved keyboard time.",
      views: [sampleBox, benchmarkStatusRow, makeInsetControl(typingScroll), benchmarkHintLabel]
    )

    rewriteCheckbox.target = self
    rewriteCheckbox.action = #selector(formChanged(_:))
    rewriteCheckbox.controlSize = .regular

    effortControl.target = self
    effortControl.action = #selector(effortChanged(_:))
    effortControl.selectedSegment = 1
    effortControl.controlSize = .large
    effortControl.segmentStyle = .rounded
    effortControl.translatesAutoresizingMaskIntoConstraints = false
    effortControl.heightAnchor.constraint(equalToConstant: 32).isActive = true
    let effortHint = makeLabel("Faster uses tiny.en, Balanced uses base.en, and Quality uses small.en.", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
    sttContextView.minSize = NSSize(width: 0, height: 82)
    sttContextView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
    sttContextView.isVerticallyResizable = true
    sttContextView.isHorizontallyResizable = false
    sttContextView.textContainer?.widthTracksTextView = true
    sttContextView.textContainerInset = NSSize(width: 8, height: 7)
    sttContextView.font = .systemFont(ofSize: 13)
    sttContextView.delegate = self
    let contextScroll = NSScrollView()
    contextScroll.hasVerticalScroller = true
    contextScroll.borderType = .bezelBorder
    contextScroll.documentView = sttContextView
    contextScroll.translatesAutoresizingMaskIntoConstraints = false
    contextScroll.heightAnchor.constraint(equalToConstant: 90).isActive = true
    let contextTitle = makeLabel("Speech context", font: .systemFont(ofSize: 13, weight: .medium))
    let contextHint = makeLabel("Add names, company terms, product words, and corrections. Example: Avery writes for Northstar Labs; LumaNote is one word.", font: .systemFont(ofSize: 12), color: .secondaryLabelColor)
    let dictationSection = makeSectionBox(
      title: "Dictation",
      subtitle: "Choose the speed/quality balance and whether transcripts should be cleaned up before insertion.",
      views: [makeInsetControl(effortControl, fixedWidth: 360), effortHint, contextTitle, makeInsetControl(contextScroll), contextHint, rewriteCheckbox]
    )

    hotkeyPopup.target = self
    hotkeyPopup.action = #selector(formChanged(_:))
    hotkeyPopup.controlSize = .large
    let hotkeySection = makeSectionBox(
      title: "Shortcut",
      subtitle: "Hold this shortcut when you want DicTray to listen.",
      views: [makeInsetControl(hotkeyPopup, fixedWidth: 260), hotkeyHintLabel]
    )

    let summarySection = makeSectionBox(
      title: "Summary",
      views: [summaryLabel]
    )

    addFullWidthArrangedSubview(profileSection, to: contentStack)
    addFullWidthArrangedSubview(benchmarkSection, to: contentStack)
    addFullWidthArrangedSubview(dictationSection, to: contentStack)
    addFullWidthArrangedSubview(hotkeySection, to: contentStack)
    addFullWidthArrangedSubview(summarySection, to: contentStack)

    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = false
    scrollView.documentView = contentStack
    scrollView.translatesAutoresizingMaskIntoConstraints = false
    contentStack.widthAnchor.constraint(equalTo: scrollView.contentView.widthAnchor).isActive = true

    let footer = makeStack(.horizontal, spacing: 12)
    footer.alignment = .centerY
    footer.edgeInsets = NSEdgeInsets(top: 8, left: 0, bottom: 0, right: 0)
    let skipButton = NSButton(title: "Not Now", target: self, action: #selector(skip(_:)))
    finishButton.target = self
    finishButton.action = #selector(finish(_:))
    finishButton.bezelStyle = .rounded
    finishButton.keyEquivalent = "\r"
    footer.addArrangedSubview(statusLabel)
    footer.addArrangedSubview(skipButton)
    footer.addArrangedSubview(finishButton)
    statusLabel.maximumNumberOfLines = 2
    statusLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
    statusLabel.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    statusLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true

    addFullWidthArrangedSubview(header, to: main)
    addFullWidthArrangedSubview(makeSeparator(), to: main)
    addFullWidthArrangedSubview(scrollView, to: main)
    addFullWidthArrangedSubview(footer, to: main)
    scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 330).isActive = true

    let mainContainer = NSView()
    mainContainer.translatesAutoresizingMaskIntoConstraints = false
    mainContainer.setContentHuggingPriority(.defaultLow, for: .horizontal)
    mainContainer.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    mainContainer.addSubview(main)
    NSLayoutConstraint.activate([
      main.leadingAnchor.constraint(equalTo: mainContainer.leadingAnchor, constant: 30),
      main.trailingAnchor.constraint(equalTo: mainContainer.trailingAnchor, constant: -30),
      main.topAnchor.constraint(equalTo: mainContainer.topAnchor, constant: 32),
      main.bottomAnchor.constraint(equalTo: mainContainer.bottomAnchor, constant: -18)
    ])

    root.addArrangedSubview(sidebar)
    root.addArrangedSubview(mainContainer)
    background.addSubview(root)
    NSLayoutConstraint.activate([
      root.leadingAnchor.constraint(equalTo: background.leadingAnchor),
      root.trailingAnchor.constraint(equalTo: background.trailingAnchor),
      root.topAnchor.constraint(equalTo: background.topAnchor),
      root.bottomAnchor.constraint(equalTo: background.bottomAnchor)
    ])
    window.contentView = background
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
    if effortControl.selectedSegment == 0 {
      return "low"
    }
    if effortControl.selectedSegment == 2 {
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

  private func sttContextText() -> String {
    normalizeSttPromptContext(sttContextView.string)
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

  private func currentBenchmarkScore() -> String {
    if benchmarkElapsedMs <= 0 {
      return ""
    }
    if normalizeTypedText(typingText()) != normalizeTypedText(latestPayload.sampleText ?? "") {
      return ""
    }
    return typingScoreLabel(benchmarkStats(elapsedMs: benchmarkElapsedMs).wordsPerMinute)
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
      ? "Text improvement: \(provider)."
      : "Text improvement is optional."
    runtimeLabel.stringValue = "Built-in speech to text is ready on macOS. \(improvement)"
  }

  private func updateHotkeyUi() {
    let managed = latestPayload.runtime?.hotkeyManagedByEnv == true
    hotkeyPopup.isEnabled = !managed
    hotkeyHintLabel.stringValue = managed
      ? "Shortcut is managed externally and currently set to \(compactSpaces(latestPayload.runtime?.hotkey ?? "unknown"))."
      : "Choose the shortcut you want to hold when you speak."
  }

  private func formatBenchmarkSeconds(_ elapsedMs: Int) -> String {
    String(format: "%.1fs", Double(max(0, elapsedMs)) / 1000.0)
  }

  private func activeBenchmarkElapsedMs() -> Int {
    guard let startedAt = benchmarkStartedAt else {
      return 0
    }
    return max(1, Int(Date().timeIntervalSince(startedAt) * 1000.0))
  }

  private func startBenchmarkTimer() {
    guard benchmarkTimer == nil else {
      return
    }
    benchmarkTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
      self?.updateBenchmarkSummary()
    }
  }

  private func stopBenchmarkTimer() {
    benchmarkTimer?.invalidate()
    benchmarkTimer = nil
  }

  private func updateBenchmarkSummary() {
    let typed = normalizeTypedText(typingText())
    let sample = normalizeTypedText(latestPayload.sampleText ?? "")
    let rawTypedCount = Array(typingText()).count
    let sampleCount = Array(compactSpaces(latestPayload.sampleText ?? "")).count
    resetBenchmarkButton.isEnabled = !typed.isEmpty || benchmarkElapsedMs > 0
    if typed.isEmpty {
      benchmarkElapsedMs = 0
      benchmarkStartedAt = nil
      stopBenchmarkTimer()
      typingView.textColor = .labelColor
      benchmarkSummaryLabel.textColor = .secondaryLabelColor
      benchmarkHintLabel.textColor = .secondaryLabelColor
      benchmarkSummaryLabel.stringValue = "Ready. Read the phrase once first, then type it naturally."
      benchmarkHintLabel.stringValue = "Smart apostrophes are accepted, so both I'm and I’m will match."
      benchmarkInfoButton.toolTip = typingScoreTooltip()
      updateSummary()
      return
    }
    if typed == sample {
      if benchmarkStartedAt == nil {
        benchmarkStartedAt = Date()
      }
      if benchmarkElapsedMs <= 0 {
        benchmarkElapsedMs = activeBenchmarkElapsedMs()
      }
      stopBenchmarkTimer()
      let stats = benchmarkStats(elapsedMs: benchmarkElapsedMs)
      typingView.textColor = .systemGreen
      benchmarkSummaryLabel.textColor = .systemGreen
      benchmarkHintLabel.textColor = .systemGreen
      let score = typingScoreLabel(stats.wordsPerMinute)
      benchmarkSummaryLabel.stringValue = "You are here: \(score)"
      benchmarkHintLabel.stringValue = "\(typingPlacementLine(stats.wordsPerMinute)) Time: \(formatBenchmarkSeconds(stats.elapsedMs))."
      benchmarkInfoButton.toolTip = typingScoreTooltip(currentScore: score)
      updateSummary()
      return
    }
    if benchmarkStartedAt == nil || benchmarkElapsedMs > 0 {
      benchmarkStartedAt = Date()
      benchmarkElapsedMs = 0
    }
    benchmarkElapsedMs = 0
    startBenchmarkTimer()
    typingView.textColor = .labelColor
    benchmarkSummaryLabel.textColor = .secondaryLabelColor
    benchmarkHintLabel.textColor = .secondaryLabelColor
    benchmarkSummaryLabel.stringValue = "Typing: \(formatBenchmarkSeconds(activeBenchmarkElapsedMs())) • \(min(rawTypedCount, sampleCount))/\(sampleCount) characters."
    benchmarkHintLabel.stringValue = "Keep going until the typed text matches the phrase exactly once."
    benchmarkInfoButton.toolTip = typingScoreTooltip()
    updateSummary()
  }

  private func updateSummary() {
    let name = normalizeProfileName(nameField.stringValue)
    let presetLabel = hotkeyPopup.titleOfSelectedItem ?? "Unknown"
    summaryLabel.stringValue = [
      "Profile: \(name.isEmpty ? "Anonymous" : name)",
      "Text improvement: \(rewriteCheckbox.state == .on ? "On" : "Off")",
      "Speech effort: \(speechEffortLabel(selectedSpeechEffort()))",
      "Speech context: \(sttContextText().isEmpty ? "Empty" : "Added")",
      "Push-to-talk: \(presetLabel)"
    ].joined(separator: "\n")
  }

  private func hydrateFromState() {
    let state = latestPayload.state
    let profileName = normalizeProfileName(state?.profile?.name ?? "")
    let rewriteCleanup = state?.choices?.rewriteCleanup == true
    let speechEffort = normalizeSpeechEffort(state?.choices?.speechEffort) == ""
      ? (normalizeSpeechEffort(latestPayload.runtime?.speechEffort) == "" ? "mid" : normalizeSpeechEffort(latestPayload.runtime?.speechEffort))
      : normalizeSpeechEffort(state?.choices?.speechEffort)
    let pushToTalkHotkey = compactSpaces(state?.choices?.pushToTalkHotkey ?? latestPayload.runtime?.hotkey ?? "")
    let sttPromptContext = normalizeSttPromptContext(state?.choices?.sttPromptContext ?? latestPayload.runtime?.sttPromptContext ?? "")

    nameField.stringValue = profileName
    rewriteCheckbox.state = rewriteCleanup ? .on : .off
    effortControl.selectedSegment = speechEffort == "low" ? 0 : speechEffort == "high" ? 2 : 1
    sttContextView.string = sttPromptContext

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
          pushToTalkHotkey: selectedHotkeyValue(),
          sttPromptContext: sttContextText()
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
