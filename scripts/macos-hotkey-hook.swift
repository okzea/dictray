import ApplicationServices
import Foundation

struct HotkeyDefinition {
  let control: Bool
  let option: Bool
  let shift: Bool
  let command: Bool
  let keyCode: Int64
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

func emit(_ text: String) {
  print(text)
  fflush(stdout)
}

let mainHotkey: HotkeyDefinition
let promptHotkey: HotkeyDefinition?

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

let promptOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
if !AXIsProcessTrustedWithOptions(promptOptions) {
  fputs("Accessibility permission is required for global push-to-talk on macOS.\n", stderr)
  exit(2)
}

var mainIsDown = false
var promptIsDown = false

let callback: CGEventTapCallBack = { _, type, event, _ in
  let isKeyDown = type == .keyDown
  let isKeyUp = type == .keyUp
  let keyCode = event.getIntegerValueField(.keyboardEventKeycode)

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
