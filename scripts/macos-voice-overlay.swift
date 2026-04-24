import AppKit
import Foundation

struct OverlayBounds: Decodable {
  let x: Double?
  let y: Double?
  let width: Double?
  let height: Double?
}

struct OverlayPayload: Decodable {
  let visible: Bool?
  let phase: String?
  let targetWindow: String?
  let note: String?
  let error: String?
  let inputLevel: Double?
  let bounds: OverlayBounds?
  let quit: Bool?
}

final class OverlayView: NSView {
  var payload = OverlayPayload(visible: false, phase: "idle", targetWindow: "", note: "", error: "", inputLevel: 0, bounds: nil, quit: nil) {
    didSet {
      needsDisplay = true
    }
  }

  override var isOpaque: Bool {
    false
  }

  private func phaseTitle() -> String {
    switch (payload.phase ?? "idle").trimmingCharacters(in: .whitespacesAndNewlines) {
    case "processing":
      return "Getting Ready"
    case "listening":
      return "Listening"
    case "transcribing":
      return "Transcribing"
    case "rewriting":
      return "Improving Text"
    case "inserting":
      return "Inserting"
    case "pending_insert":
      return "Waiting To Insert"
    default:
      return payload.error?.isEmpty == false || payload.note?.isEmpty == false ? "DicTray" : "Ready"
    }
  }

  private func detailText() -> String {
    let error = (payload.error ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !error.isEmpty {
      return error
    }
    let note = (payload.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !note.isEmpty {
      return note
    }
    let target = (payload.targetWindow ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !target.isEmpty {
      return target
    }
    return "Hold the shortcut and speak."
  }

  override func draw(_ dirtyRect: NSRect) {
    super.draw(dirtyRect)

    let rect = bounds.insetBy(dx: 1, dy: 1)
    let background = NSBezierPath(roundedRect: rect, xRadius: 16, yRadius: 16)
    NSColor(calibratedWhite: 0.06, alpha: 0.88).setFill()
    background.fill()
    NSColor(calibratedWhite: 1.0, alpha: 0.12).setStroke()
    background.lineWidth = 1
    background.stroke()

    let phase = (payload.phase ?? "idle").trimmingCharacters(in: .whitespacesAndNewlines)
    let accent: NSColor = {
      if !(payload.error ?? "").isEmpty {
        return .systemRed
      }
      if phase == "listening" {
        return .systemGreen
      }
      if phase == "inserting" || phase == "rewriting" || phase == "transcribing" {
        return .systemBlue
      }
      return .systemTeal
    }()

    let dot = NSBezierPath(ovalIn: NSRect(x: 18, y: rect.height - 33, width: 12, height: 12))
    accent.setFill()
    dot.fill()

    let titleAttributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.boldSystemFont(ofSize: 15),
      .foregroundColor: NSColor.white
    ]
    let detailAttributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: 12),
      .foregroundColor: NSColor(calibratedWhite: 1, alpha: 0.74)
    ]

    NSString(string: phaseTitle()).draw(in: NSRect(x: 38, y: rect.height - 37, width: rect.width - 56, height: 20), withAttributes: titleAttributes)
    NSString(string: detailText()).draw(in: NSRect(x: 18, y: 34, width: rect.width - 36, height: 34), withAttributes: detailAttributes)

    let level = max(0, min(1, payload.inputLevel ?? 0))
    let track = NSBezierPath(roundedRect: NSRect(x: 18, y: 18, width: rect.width - 36, height: 6), xRadius: 3, yRadius: 3)
    NSColor(calibratedWhite: 1, alpha: 0.12).setFill()
    track.fill()
    let fillWidth = max(8, (rect.width - 36) * CGFloat(level))
    let fill = NSBezierPath(roundedRect: NSRect(x: 18, y: 18, width: fillWidth, height: 6), xRadius: 3, yRadius: 3)
    accent.setFill()
    fill.fill()
  }
}

final class OverlayController: NSObject, NSApplicationDelegate {
  private let statePath: String
  private let overlayView = OverlayView(frame: NSRect(x: 0, y: 0, width: 308, height: 104))
  private var window: NSPanel?
  private var timer: Timer?
  private var lastRenderedState = ""

  init(statePath: String) {
    self.statePath = statePath
    super.init()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    let panel = NSPanel(
      contentRect: NSRect(x: 200, y: 200, width: 308, height: 104),
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.level = .floating
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    panel.backgroundColor = .clear
    panel.isOpaque = false
    panel.hasShadow = true
    panel.ignoresMouseEvents = true
    panel.contentView = overlayView
    panel.orderOut(nil)
    window = panel
    refresh()
    timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
      self?.refresh()
    }
  }

  func applicationWillTerminate(_ notification: Notification) {
    timer?.invalidate()
  }

  private func appKitFrame(from bounds: OverlayBounds?) -> NSRect {
    let width = max(220, bounds?.width ?? 308)
    let height = max(72, bounds?.height ?? 104)
    let topLeftX = bounds?.x ?? 200
    let topLeftY = bounds?.y ?? 200
    let screen = NSScreen.screens.first { screen in
      let frame = screen.frame
      let convertedY = frame.maxY - topLeftY - height
      return frame.contains(NSPoint(x: topLeftX + 4, y: convertedY + 4))
    } ?? NSScreen.main
    let screenFrame = screen?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
    let x = min(max(topLeftX, screenFrame.minX + 12), screenFrame.maxX - width - 12)
    let y = min(max(screenFrame.maxY - topLeftY - height, screenFrame.minY + 12), screenFrame.maxY - height - 12)
    return NSRect(x: x, y: y, width: width, height: height)
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
    guard let payload = try? JSONDecoder().decode(OverlayPayload.self, from: data) else {
      return
    }
    if payload.quit == true {
      NSApp.terminate(nil)
      return
    }

    overlayView.payload = payload
    window?.setFrame(appKitFrame(from: payload.bounds), display: true)
    if payload.visible == true {
      window?.orderFrontRegardless()
    } else {
      window?.orderOut(nil)
    }
  }
}

if CommandLine.arguments.contains("--self-test") {
  print("{\"ok\":true,\"script\":\"macos-voice-overlay\"}")
  exit(0)
}

let statePath = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
if statePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
  fputs("Usage: macos-voice-overlay <state-path>\n", stderr)
  exit(1)
}

let controller = OverlayController(statePath: statePath)
NSApplication.shared.delegate = controller
NSApplication.shared.run()
