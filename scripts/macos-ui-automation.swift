import AppKit
import ApplicationServices
import Foundation

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
  guard let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false)
  else {
    printError("Unable to create keyboard event.")
  }
  down.flags = flags
  up.flags = flags
  down.post(tap: .cghidEventTap)
  usleep(25_000)
  up.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments
if args.contains("--self-test") {
  print("{\"ok\":true,\"script\":\"macos-ui-automation\"}")
  exit(0)
}

let command = args.count > 1 ? compact(args[1]) : ""
if command.isEmpty {
  printError("Usage: macos-ui-automation <focused|paste|enter> [process-name] [title-contains]")
}

if command == "focused" {
  print("{\(focusedWindowPayload())}")
  exit(0)
}

if !accessibilityTrusted(prompt: true) {
  printError("Accessibility permission is required for macOS paste automation.", code: 2)
}

let processName = args.count > 2 ? args[2] : ""
let titleContains = args.count > 3 ? args[3] : ""
let focused = focusTarget(processName: processName, titleContains: titleContains)

switch command {
case "paste":
  postKey(9, flags: .maskCommand)
  print("{\"ok\":true,\"focused\":\(focused ? "true" : "false")}")
case "enter":
  postKey(36)
  print("{\"ok\":true,\"focused\":\(focused ? "true" : "false")}")
default:
  printError("Unsupported macOS UI automation command: \(command)")
}
