import AppKit
import Foundation

enum JSONValue: Codable {
  case string(String)
  case number(Double)
  case bool(Bool)
  case object([String: JSONValue])
  case array([JSONValue])
  case null

  init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if container.decodeNil() {
      self = .null
    } else if let value = try? container.decode(Bool.self) {
      self = .bool(value)
    } else if let value = try? container.decode(Double.self) {
      self = .number(value)
    } else if let value = try? container.decode(String.self) {
      self = .string(value)
    } else if let value = try? container.decode([JSONValue].self) {
      self = .array(value)
    } else {
      self = .object(try container.decode([String: JSONValue].self))
    }
  }

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value):
      try container.encode(value)
    case .number(let value):
      try container.encode(value)
    case .bool(let value):
      try container.encode(value)
    case .object(let value):
      try container.encode(value)
    case .array(let value):
      try container.encode(value)
    case .null:
      try container.encodeNil()
    }
  }
}

struct MenuPayload: Decodable {
  let label: String?
  let type: String?
  let enabled: Bool?
  let checked: Bool?
  let value: Double?
  let min: Double?
  let max: Double?
  let step: Double?
  let command: [String: JSONValue]?
  let submenu: [MenuPayload]?
}

struct StatePayload: Decodable {
  let phase: String?
  let phaseLabel: String?
  let dictating: Bool?
  let menu: [MenuPayload]?
  let quit: Bool?
}

final class CommandSlider: NSSlider {
  var commandPayload: [String: JSONValue] = [:]
  var stepValue: Double = 0.1
  weak var valueLabel: NSTextField?
}

final class StatusMenuController: NSObject, NSApplicationDelegate {
  private let statePath: String
  private let commandPath: String
  private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  private var timer: Timer?
  private var lastRenderedState = ""
  private var statusIcon: NSImage?
  private var activeStatusIcon: NSImage?

  init(statePath: String, commandPath: String) {
    self.statePath = statePath
    self.commandPath = commandPath
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    statusIcon = loadStatusIcon(named: "dictray-logo-template.png", template: true, size: NSSize(width: 15, height: 15))
    activeStatusIcon = makeActiveStatusIcon(
      logo: loadStatusIcon(named: "dictray-logo-dark.png", template: false, size: NSSize(width: 15, height: 15))
    )
    if statusIcon != nil || activeStatusIcon != nil {
      statusItem.length = 26
    }
    configureStatusButton(dictating: false, tooltip: "DicTray")
    renderPlaceholderMenu()
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 0.45, repeats: true) { [weak self] _ in
      self?.refresh()
    }
  }

  private func renderPlaceholderMenu() {
    configureStatusButton(dictating: false, tooltip: "Waiting for DicTray")
    let menu = NSMenu()
    let item = NSMenuItem(title: "Waiting for DicTray", action: nil, keyEquivalent: "")
    item.isEnabled = false
    menu.addItem(item)
    statusItem.menu = menu
  }

  private func refresh() {
    guard let data = FileManager.default.contents(atPath: statePath),
          let raw = String(data: data, encoding: .utf8),
          !raw.isEmpty,
          raw != lastRenderedState
    else {
      return
    }

    lastRenderedState = raw
    guard let payload = try? JSONDecoder().decode(StatePayload.self, from: data) else {
      return
    }
    if payload.quit == true {
      NSApp.terminate(nil)
      return
    }
    render(payload)
  }

  private func render(_ payload: StatePayload) {
    let phase = (payload.phase ?? "idle").trimmingCharacters(in: .whitespacesAndNewlines)
    let dictating = payload.dictating == true || phase != "idle"
    configureStatusButton(dictating: dictating, tooltip: payload.phaseLabel ?? phase)

    let menu = NSMenu()
    appendMenuItems(payload.menu ?? [], to: menu)
    if menu.items.isEmpty {
      renderPlaceholderMenu()
      return
    }
    statusItem.menu = menu
  }

  private func loadStatusIcon(named filename: String, template: Bool, size: NSSize) -> NSImage? {
    let executable = URL(fileURLWithPath: CommandLine.arguments.first ?? "").resolvingSymlinksInPath()
    let appCore = executable.deletingLastPathComponent().deletingLastPathComponent()
    let candidates = [
      appCore.appendingPathComponent("assets/brand/\(filename)")
    ]

    for candidate in candidates {
      if let image = NSImage(contentsOf: candidate) {
        image.isTemplate = template
        image.size = size
        return image
      }
    }

    return nil
  }

  private func makeActiveStatusIcon(logo: NSImage?) -> NSImage? {
    guard let logo else {
      return nil
    }

    let image = NSImage(size: NSSize(width: 25, height: 18))
    image.lockFocus()

    logo.draw(
      in: NSRect(x: 1, y: 1.5, width: 15, height: 15),
      from: .zero,
      operation: .sourceOver,
      fraction: 1.0
    )

    NSColor.systemGreen.setFill()
    NSBezierPath(ovalIn: NSRect(x: 18, y: 6, width: 6, height: 6)).fill()

    image.unlockFocus()
    image.isTemplate = false
    return image
  }

  private func configureStatusButton(dictating: Bool, tooltip: String) {
    guard let button = statusItem.button else {
      return
    }

    let icon = dictating
      ? (activeStatusIcon ?? statusIcon)
      : (statusIcon ?? activeStatusIcon)

    if let icon {
      button.title = ""
      button.image = icon
      button.imagePosition = .imageOnly
      button.layer?.backgroundColor = nil
      button.layer?.cornerRadius = 0
      button.layer?.masksToBounds = false
      if #available(macOS 10.14, *) {
        button.contentTintColor = nil
      }
    } else {
      button.image = nil
      button.title = dictating ? "DicTray REC" : "DicTray"
    }
    button.toolTip = tooltip
  }

  private func appendMenuItems(_ items: [MenuPayload], to menu: NSMenu) {
    for payload in items {
      let type = (payload.type ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      if type == "separator" {
        menu.addItem(.separator())
        continue
      }

      let title = (payload.label ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
      if title.isEmpty {
        continue
      }

      if type == "slider" {
        appendSliderMenuItem(payload, title: title, to: menu)
        continue
      }

      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.isEnabled = payload.enabled ?? true
      if type == "checkbox" || type == "radio" {
        item.state = payload.checked == true ? .on : .off
      }

      if let children = payload.submenu, !children.isEmpty {
        let submenu = NSMenu()
        appendMenuItems(children, to: submenu)
        item.submenu = submenu
      } else if let command = payload.command {
        item.target = self
        item.action = #selector(handleMenuCommand(_:))
        item.representedObject = try? JSONEncoder().encode(command)
      } else if payload.enabled == nil {
        item.isEnabled = false
      }

      menu.addItem(item)
    }
  }

  private func appendSliderMenuItem(_ payload: MenuPayload, title: String, to menu: NSMenu) {
    let enabled = payload.enabled ?? true
    let minimum = payload.min ?? 0.0
    let maximum = payload.max ?? 1.0
    let step = max(0.001, payload.step ?? 0.1)
    let value = steppedSliderValue(payload.value ?? minimum, minimum: minimum, maximum: maximum, step: step)
    let width: CGFloat = 272
    let height: CGFloat = 50
    let container = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))

    let titleLabel = NSTextField(labelWithString: title)
    titleLabel.frame = NSRect(x: 12, y: 29, width: 170, height: 16)
    titleLabel.font = NSFont.menuFont(ofSize: 13)
    titleLabel.textColor = enabled ? .labelColor : .disabledControlTextColor
    container.addSubview(titleLabel)

    let valueLabel = NSTextField(labelWithString: percentLabel(value))
    valueLabel.frame = NSRect(x: width - 62, y: 29, width: 50, height: 16)
    valueLabel.alignment = .right
    valueLabel.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular)
    valueLabel.textColor = enabled ? .secondaryLabelColor : .disabledControlTextColor
    container.addSubview(valueLabel)

    let slider = CommandSlider(frame: NSRect(x: 10, y: 5, width: width - 20, height: 22))
    slider.minValue = minimum
    slider.maxValue = maximum
    slider.doubleValue = value
    slider.stepValue = step
    slider.commandPayload = payload.command ?? [:]
    slider.valueLabel = valueLabel
    slider.isEnabled = enabled && payload.command != nil
    slider.isContinuous = false
    slider.numberOfTickMarks = max(2, Int(round((maximum - minimum) / step)) + 1)
    slider.allowsTickMarkValuesOnly = true
    slider.target = self
    slider.action = #selector(handleSliderChange(_:))
    container.addSubview(slider)

    let item = NSMenuItem()
    item.view = container
    item.isEnabled = enabled
    menu.addItem(item)
  }

  private func steppedSliderValue(_ raw: Double, minimum: Double, maximum: Double, step: Double) -> Double {
    let clamped = min(maximum, max(minimum, raw))
    let steps = round((clamped - minimum) / step)
    return min(maximum, max(minimum, minimum + (steps * step)))
  }

  private func percentLabel(_ value: Double) -> String {
    "\(Int(round(value * 100)))%"
  }

  @objc private func handleMenuCommand(_ sender: NSMenuItem) {
    guard let data = sender.representedObject as? Data,
          let command = try? JSONDecoder().decode([String: JSONValue].self, from: data)
    else {
      return
    }

    writeCommand(command)
  }

  @objc private func handleSliderChange(_ sender: NSSlider) {
    guard let slider = sender as? CommandSlider else {
      return
    }

    let value = steppedSliderValue(
      slider.doubleValue,
      minimum: slider.minValue,
      maximum: slider.maxValue,
      step: slider.stepValue
    )
    slider.doubleValue = value
    slider.valueLabel?.stringValue = percentLabel(value)

    var command = slider.commandPayload
    command["value"] = .number(value)
    writeCommand(command)
  }

  private func writeCommand(_ commandInput: [String: JSONValue]) {
    var command = commandInput
    command["requestedAt"] = .number(Date().timeIntervalSince1970 * 1000)
    guard let output = try? JSONEncoder().encode(command) else {
      return
    }

    let url = URL(fileURLWithPath: commandPath)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? output.write(to: url, options: .atomic)
  }
}

let statePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let commandPath = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""

if statePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  || commandPath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  fputs("Usage: macos-menu-bar <state-path> <command-path>\n", stderr)
  exit(1)
}

let controller = StatusMenuController(statePath: statePath, commandPath: commandPath)
NSApplication.shared.delegate = controller
NSApplication.shared.run()
