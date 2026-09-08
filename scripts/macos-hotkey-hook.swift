import AppKit
import ApplicationServices
import Foundation

struct HotkeyDefinition {
  let control: Bool
  let option: Bool
  let shift: Bool
  let command: Bool
  let keyCode: Int64
}

struct KeyPressDefinition {
  let keyCode: CGKeyCode
  let flags: CGEventFlags
  let rawShortcut: String
  let source: String
}

enum HotkeyParseError: Error, CustomStringConvertible {
  case empty
  case missingKey(String)
  case duplicateKey(String)
  case unsupportedToken(String)

  var description: String {
    switch self {
    case .empty:
      return "Shortcut cannot be empty."
    case .missingKey(let input):
      return "Shortcut must include one non-modifier key: \(input)"
    case .duplicateKey(let input):
      return "Shortcut must contain exactly one non-modifier key: \(input)"
    case .unsupportedToken(let token):
      return "Unsupported shortcut key token: \(token)"
    }
  }
}

func keyCode(for token: String) throws -> Int64 {
  let normalized = token.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  if normalized.count == 1 {
    switch normalized {
    case "a": return 0
    case "s": return 1
    case "d": return 2
    case "f": return 3
    case "h": return 4
    case "g": return 5
    case "z": return 6
    case "x": return 7
    case "c": return 8
    case "v": return 9
    case "b": return 11
    case "q": return 12
    case "w": return 13
    case "e": return 14
    case "r": return 15
    case "y": return 16
    case "t": return 17
    case "1": return 18
    case "2": return 19
    case "3": return 20
    case "4": return 21
    case "6": return 22
    case "5": return 23
    case "=": return 24
    case "9": return 25
    case "7": return 26
    case "-": return 27
    case "8": return 28
    case "0": return 29
    case "]": return 30
    case "o": return 31
    case "u": return 32
    case "[": return 33
    case "i": return 34
    case "p": return 35
    case "l": return 37
    case "j": return 38
    case "'": return 39
    case "k": return 40
    case ";": return 41
    case "\\": return 42
    case ",": return 43
    case "/": return 44
    case "n": return 45
    case "m": return 46
    case ".": return 47
    case "`": return 50
    default:
      break
    }
  }

  if normalized.hasPrefix("f"), let number = Int(normalized.dropFirst()) {
    switch number {
    case 1: return 122
    case 2: return 120
    case 3: return 99
    case 4: return 118
    case 5: return 96
    case 6: return 97
    case 7: return 98
    case 8: return 100
    case 9: return 101
    case 10: return 109
    case 11: return 103
    case 12: return 111
    case 13: return 105
    case 14: return 107
    case 15: return 113
    case 16: return 106
    case 17: return 64
    case 18: return 79
    case 19: return 80
    case 20: return 90
    default:
      throw HotkeyParseError.unsupportedToken(token)
    }
  }

  switch normalized {
  case "space":
    return 49
  case "tab":
    return 48
  case "enter", "return":
    return 36
  case "esc", "escape":
    return 53
  case "backspace", "delete":
    return 51
  case "forwarddelete", "del":
    return 117
  case "home":
    return 115
  case "end":
    return 119
  case "pageup", "pgup":
    return 116
  case "pagedown", "pgdn":
    return 121
  case "up":
    return 126
  case "down":
    return 125
  case "left":
    return 123
  case "right":
    return 124
  default:
    throw HotkeyParseError.unsupportedToken(token)
  }
}

func parseHotkey(_ input: String) throws -> HotkeyDefinition {
  let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
  if text.isEmpty {
    throw HotkeyParseError.empty
  }

  var control = false
  var option = false
  var shift = false
  var command = false
  var resolvedKeyCode: Int64?

  for rawToken in text.split(separator: "+") {
    let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
    switch token.lowercased() {
    case "ctrl", "control", "commandorcontrol", "cmdorctrl":
      control = true
      continue
    case "alt", "option":
      option = true
      continue
    case "shift":
      shift = true
      continue
    case "cmd", "command", "super", "meta":
      command = true
      continue
    default:
      break
    }

    if resolvedKeyCode != nil {
      throw HotkeyParseError.duplicateKey(text)
    }
    resolvedKeyCode = try keyCode(for: token)
  }

  guard let keyCode = resolvedKeyCode else {
    throw HotkeyParseError.missingKey(text)
  }

  return HotkeyDefinition(
    control: control,
    option: option,
    shift: shift,
    command: command,
    keyCode: keyCode
  )
}

func requiredFlags(for definition: HotkeyDefinition) -> CGEventFlags {
  var flags = CGEventFlags()
  if definition.control {
    flags.insert(.maskControl)
  }
  if definition.option {
    flags.insert(.maskAlternate)
  }
  if definition.shift {
    flags.insert(.maskShift)
  }
  if definition.command {
    flags.insert(.maskCommand)
  }
  return flags
}

func shortcutFlags(control: Bool, option: Bool, shift: Bool, command: Bool) -> CGEventFlags {
  var flags = CGEventFlags()
  if control {
    flags.insert(.maskControl)
  }
  if option {
    flags.insert(.maskAlternate)
  }
  if shift {
    flags.insert(.maskShift)
  }
  if command {
    flags.insert(.maskCommand)
  }
  return flags
}

func eventMatches(_ event: CGEvent, definition: HotkeyDefinition) -> Bool {
  let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
  if keyCode != definition.keyCode {
    return false
  }
  let relevantFlags: CGEventFlags = [.maskControl, .maskAlternate, .maskShift, .maskCommand]
  return event.flags.intersection(relevantFlags) == requiredFlags(for: definition)
}

func requiredModifiersStillPressed(_ event: CGEvent, definition: HotkeyDefinition) -> Bool {
  let required = requiredFlags(for: definition)
  for flag in [CGEventFlags.maskControl, .maskAlternate, .maskShift, .maskCommand] {
    if required.contains(flag) && !event.flags.contains(flag) {
      return false
    }
  }
  return true
}

func overlayStateAllowsCancel(_ statePath: String) -> Bool {
  let trimmedPath = statePath.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmedPath.isEmpty {
    return false
  }

  guard let data = FileManager.default.contents(atPath: trimmedPath),
        let object = try? JSONSerialization.jsonObject(with: data),
        let payload = object as? [String: Any]
  else {
    return false
  }

  let phase = compact(payload["phase"] as? String ?? "").lowercased()
  let visible = payload["visible"] as? Bool ?? false
  return visible && [
    "listening",
    "processing",
    "transcribing",
    "rewriting",
    "inserting",
    "pending_insert"
  ].contains(phase)
}

func emit(_ text: String) {
  print(text)
  fflush(stdout)
}

func jsonEscape(_ value: String) -> String {
  var result = ""
  for scalar in value.unicodeScalars {
    switch scalar {
    case "\"":
      result += "\\\""
    case "\\":
      result += "\\\\"
    case "\n":
      result += "\\n"
    case "\r":
      result += "\\r"
    case "\t":
      result += "\\t"
    default:
      if scalar.value < 0x20 {
        result += String(format: "\\u%04x", scalar.value)
      } else {
        result.append(Character(scalar))
      }
    }
  }
  return result
}

func jsonString(_ value: String) -> String {
  "\"\(jsonEscape(value))\""
}

func printError(_ message: String, code: Int32 = 1) -> Never {
  fputs("\(message)\n", stderr)
  exit(code)
}

func compact(_ value: String) -> String {
  value
    .components(separatedBy: .whitespacesAndNewlines)
    .filter { !$0.isEmpty }
    .joined(separator: " ")
}

func accessibilityTrusted(prompt: Bool = false) -> Bool {
  if !prompt {
    return AXIsProcessTrusted()
  }
  let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  return AXIsProcessTrustedWithOptions(options)
}

func runningApp(named name: String) -> NSRunningApplication? {
  let normalized = compact(name).lowercased()
  if normalized.isEmpty {
    return NSWorkspace.shared.frontmostApplication
  }
  return NSWorkspace.shared.runningApplications.first { app in
    compact(app.localizedName ?? "").lowercased() == normalized
      || compact(app.bundleIdentifier ?? "").lowercased() == normalized
  }
}

func axString(_ element: AXUIElement, _ attribute: String) -> String {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else {
    return ""
  }
  return value as? String ?? ""
}

func axPoint(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let axValue = value,
        CFGetTypeID(axValue) == AXValueGetTypeID()
  else {
    return nil
  }
  var point = CGPoint.zero
  guard AXValueGetValue((axValue as! AXValue), .cgPoint, &point) else {
    return nil
  }
  return point
}

func axSize(_ element: AXUIElement, _ attribute: String) -> CGSize? {
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success,
        let axValue = value,
        CFGetTypeID(axValue) == AXValueGetTypeID()
  else {
    return nil
  }
  var size = CGSize.zero
  guard AXValueGetValue((axValue as! AXValue), .cgSize, &size) else {
    return nil
  }
  return size
}

func appWindows(_ app: NSRunningApplication) -> [AXUIElement] {
  let appElement = AXUIElementCreateApplication(app.processIdentifier)
  var value: CFTypeRef?
  guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &value) == .success else {
    return []
  }
  return value as? [AXUIElement] ?? []
}

func shortcutFromCocoaKeyEquivalent(_ value: String, source: String) -> KeyPressDefinition? {
  let raw = value.trimmingCharacters(in: .whitespacesAndNewlines)
  if raw.isEmpty {
    return nil
  }

  var control = false
  var option = false
  var shift = false
  var command = false
  var key = ""

  for scalar in raw.unicodeScalars {
    switch scalar {
    case "^":
      control = true
    case "~":
      option = true
    case "$":
      shift = true
    case "@":
      command = true
    default:
      key.append(Character(scalar))
    }
  }

  let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
  if trimmedKey.isEmpty {
    return nil
  }

  if trimmedKey.count == 1 && trimmedKey.uppercased() == trimmedKey && trimmedKey.lowercased() != trimmedKey {
    shift = true
  }

  do {
    let code = try keyCode(for: trimmedKey.lowercased())
    return KeyPressDefinition(
      keyCode: CGKeyCode(code),
      flags: shortcutFlags(control: control, option: option, shift: shift, command: command),
      rawShortcut: raw,
      source: source
    )
  } catch {
    return nil
  }
}

func userKeyEquivalent(named menuTitle: String, inDomain domain: String) -> String? {
  guard let preferences = UserDefaults.standard.persistentDomain(forName: domain),
        let equivalents = preferences["NSUserKeyEquivalents"] as? [String: Any]
  else {
    return nil
  }

  let normalizedTitle = compact(menuTitle).lowercased()
  for (key, value) in equivalents {
    if compact(key).lowercased() == normalizedTitle {
      return value as? String
    }
  }
  return nil
}

func pasteShortcut(for app: NSRunningApplication?) -> KeyPressDefinition {
  var domains: [(String, String)] = []
  if let bundleIdentifier = app?.bundleIdentifier, !bundleIdentifier.isEmpty {
    domains.append((bundleIdentifier, "app:\(bundleIdentifier)"))
  }
  domains.append((UserDefaults.globalDomain, "global"))
  domains.append((".GlobalPreferences", "global"))

  for (domain, source) in domains {
    if let raw = userKeyEquivalent(named: "Paste", inDomain: domain),
       let shortcut = shortcutFromCocoaKeyEquivalent(raw, source: source) {
      return shortcut
    }
  }

  return KeyPressDefinition(
    keyCode: 9,
    flags: .maskCommand,
    rawShortcut: "@v",
    source: "default"
  )
}

func focusedWindowPayload() -> String {
  let app = NSWorkspace.shared.frontmostApplication
  let appName = compact(app?.localizedName ?? "")
  var title = ""
  var left = 0.0
  var top = 0.0
  var width = 0.0
  var height = 0.0

  if accessibilityTrusted(), let app {
    let windows = appWindows(app)
    if let window = windows.first {
      title = compact(axString(window, kAXTitleAttribute))
      if let position = axPoint(window, kAXPositionAttribute), let size = axSize(window, kAXSizeAttribute) {
        left = Double(position.x)
        top = Double(position.y)
        width = Double(size.width)
        height = Double(size.height)
      }
    }
  }

  return [
    "\"ok\":true",
    "\"focused\":true",
    "\"processName\":\(jsonString(appName))",
    "\"macosApplication\":\(jsonString(appName))",
    "\"title\":\(jsonString(title))",
    "\"bounds\":{\"left\":\(left),\"top\":\(top),\"width\":\(width),\"height\":\(height)}"
  ].joined(separator: ",")
}

func focusTarget(processName: String, titleContains: String) -> Bool {
  guard let app = runningApp(named: processName) else {
    return false
  }
  if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier {
    return true
  }
  app.activate()
  Thread.sleep(forTimeInterval: 0.06)

  if accessibilityTrusted() {
    let titleNeedle = compact(titleContains).lowercased()
    let windows = appWindows(app)
    let matchingWindow = titleNeedle.isEmpty
      ? windows.first
      : windows.first { compact(axString($0, kAXTitleAttribute)).lowercased().contains(titleNeedle) }
    if let matchingWindow {
      AXUIElementPerformAction(matchingWindow, kAXRaiseAction as CFString)
    }
  }
  Thread.sleep(forTimeInterval: 0.04)
  return true
}

func postKey(_ keyCode: CGKeyCode, flags: CGEventFlags = []) {
  let source = CGEventSource(stateID: .hidSystemState)
  if let source {
    source.localEventsSuppressionInterval = 0
  }
  guard let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false)
  else {
    printError("Unable to create keyboard event.")
  }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  usleep(25_000)
  up.post(tap: .cghidEventTap)
  usleep(20_000)
}

func handleUiAutomationCommand(_ command: String) {
  if command == "--self-test" {
    print("{\"ok\":true,\"script\":\"macos-hotkey-hook\"}")
    exit(0)
  }

  if command == "focused" {
    print("{\(focusedWindowPayload())}")
    exit(0)
  }

  if command == "paste-shortcut" {
    let processName = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
    let app = runningApp(named: processName) ?? NSWorkspace.shared.frontmostApplication
    let shortcut = pasteShortcut(for: app)
    print("{\"ok\":true,\"shortcut\":\(jsonString(shortcut.rawShortcut)),\"shortcutSource\":\(jsonString(shortcut.source))}")
    exit(0)
  }

  if command != "paste" && command != "enter" {
    return
  }

  if !accessibilityTrusted(prompt: true) {
    printError("Accessibility permission is required for macOS paste automation.", code: 2)
  }

  let processName = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
  let titleContains = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""
  let targetApp = runningApp(named: processName)
  let focused = focusTarget(processName: processName, titleContains: titleContains)

  switch command {
  case "paste":
    let shortcut = pasteShortcut(for: targetApp ?? NSWorkspace.shared.frontmostApplication)
    postKey(shortcut.keyCode, flags: shortcut.flags)
    print("{\"ok\":true,\"focused\":\(focused ? "true" : "false"),\"shortcut\":\(jsonString(shortcut.rawShortcut)),\"shortcutSource\":\(jsonString(shortcut.source))}")
  case "enter":
    postKey(36)
    print("{\"ok\":true,\"focused\":\(focused ? "true" : "false")}")
  default:
    printError("Unsupported macOS UI automation command: \(command)")
  }
  exit(0)
}

let firstArgument = CommandLine.arguments.count > 1 ? compact(CommandLine.arguments[1]) : ""
handleUiAutomationCommand(firstArgument)

let mainHotkey: HotkeyDefinition
let promptHotkey: HotkeyDefinition?
let cancelStatePath = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : ""

do {
  mainHotkey = try parseHotkey(CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "CommandOrControl+Space")
  if CommandLine.arguments.count > 2 && !CommandLine.arguments[2].trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    let parsedPrompt = try parseHotkey(CommandLine.arguments[2])
    promptHotkey = parsedPrompt.keyCode == mainHotkey.keyCode && requiredFlags(for: parsedPrompt) == requiredFlags(for: mainHotkey)
      ? nil
      : parsedPrompt
  } else {
    promptHotkey = nil
  }
} catch {
  fputs("\(error)\n", stderr)
  exit(1)
}

if !accessibilityTrusted(prompt: true) {
  fputs("Accessibility permission is required for global push-to-talk on macOS.\n", stderr)
  exit(2)
}

var mainIsDown = false
var promptIsDown = false
var escapeIsDown = false

let callback: CGEventTapCallBack = { _, type, event, _ in
  let isKeyDown = type == .keyDown
  let isKeyUp = type == .keyUp
  let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

  if keyCode == 53 {
    if isKeyDown && !escapeIsDown && (mainIsDown || promptIsDown || overlayStateAllowsCancel(cancelStatePath)) {
      escapeIsDown = true
      mainIsDown = false
      promptIsDown = false
      emit("cancel")
      return nil
    }
    if isKeyUp && escapeIsDown {
      escapeIsDown = false
      return nil
    }
  }

  if isKeyDown && eventMatches(event, definition: mainHotkey) {
    if !mainIsDown {
      mainIsDown = true
      emit("down")
    }
    return nil
  }
  if isKeyUp && mainIsDown && keyCode == mainHotkey.keyCode {
    mainIsDown = false
    emit("up")
    return nil
  }

  if let prompt = promptHotkey, isKeyDown && eventMatches(event, definition: prompt) {
    if !promptIsDown {
      promptIsDown = true
      emit("prompt-down")
    }
    return nil
  }
  if let prompt = promptHotkey, isKeyUp && promptIsDown && keyCode == prompt.keyCode {
    promptIsDown = false
    emit("prompt-up")
    return nil
  }

  if type == .flagsChanged {
    if mainIsDown && !requiredModifiersStillPressed(event, definition: mainHotkey) {
      mainIsDown = false
      emit("up")
    }
    if let prompt = promptHotkey, promptIsDown && !requiredModifiersStillPressed(event, definition: prompt) {
      promptIsDown = false
      emit("prompt-up")
    }
  }

  return Unmanaged.passUnretained(event)
}

let eventMask =
  (1 << CGEventType.keyDown.rawValue)
  | (1 << CGEventType.keyUp.rawValue)
  | (1 << CGEventType.flagsChanged.rawValue)

guard let eventTap = CGEvent.tapCreate(
  tap: .cgSessionEventTap,
  place: .headInsertEventTap,
  options: .defaultTap,
  eventsOfInterest: CGEventMask(eventMask),
  callback: callback,
  userInfo: nil
) else {
  fputs("Failed to create macOS event tap for global push-to-talk.\n", stderr)
  exit(3)
}

let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
CGEvent.tapEnable(tap: eventTap, enable: true)
CFRunLoopRun()
