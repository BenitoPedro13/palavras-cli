import AppKit
import Foundation

enum OutputResult: String {
  case cancelled = "CANCELLED"
  case fullscreen = "FULLSCREEN"
}

let SAFETY_TIMEOUT_SECONDS: TimeInterval = 30

enum DragMode {
  case none
  case create
  case move
  case resizeLeft
  case resizeRight
  case resizeTop
  case resizeBottom
  case resizeTopLeft
  case resizeTopRight
  case resizeBottomLeft
  case resizeBottomRight
}

final class OverlayWindow: NSWindow {
  override var canBecomeKey: Bool { true }
  override var canBecomeMain: Bool { true }
}

final class OverlayView: NSView {
  private let handleSize: CGFloat = 8
  private let minSize: CGFloat = 20
  private var selection: NSRect?
  private var baseSelection: NSRect?
  private var dragMode: DragMode = .none
  private var anchorPoint = NSPoint.zero
  private let onFinish: (String) -> Void
  private let screenFrame: NSRect
  private var safetyTimer: Timer?

  init(frame: NSRect, initial: NSRect?, onFinish: @escaping (String) -> Void) {
    self.screenFrame = frame
    self.onFinish = onFinish
    if let initial {
      self.selection = initial.standardized
    }
    super.init(frame: frame)
    wantsLayer = true
    scheduleSafetyTimeout()
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var acceptsFirstResponder: Bool { true }

  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedWhite: 0, alpha: 0.45).setFill()
    bounds.fill()

    let help = "Arraste para criar area | arraste dentro para mover | arraste bordas/cantos para redimensionar | Enter confirma | F tela inteira | Esc cancela | timeout 30s"
    let attrs: [NSAttributedString.Key: Any] = [
      .foregroundColor: NSColor.white,
      .font: NSFont.systemFont(ofSize: 14, weight: .bold)
    ]
    help.draw(at: NSPoint(x: 20, y: bounds.height - 34), withAttributes: attrs)

    guard let rect = selection else { return }
    NSColor.clear.setFill()
    rect.fill()

    let stroke = NSBezierPath(rect: rect)
    NSColor.systemTeal.setStroke()
    stroke.lineWidth = 3
    stroke.stroke()

    let sizeText = "\(Int(rect.width))x\(Int(rect.height))"
    sizeText.draw(
      at: NSPoint(x: rect.minX, y: min(bounds.height - 52, rect.maxY + 8)),
      withAttributes: attrs
    )
    drawHandle(x: rect.minX, y: rect.minY)
    drawHandle(x: rect.maxX, y: rect.minY)
    drawHandle(x: rect.minX, y: rect.maxY)
    drawHandle(x: rect.maxX, y: rect.maxY)
  }

  private func drawHandle(x: CGFloat, y: CGFloat) {
    let handleRect = NSRect(
      x: x - handleSize,
      y: y - handleSize,
      width: handleSize * 2,
      height: handleSize * 2
    )
    NSColor.systemTeal.setFill()
    NSBezierPath(rect: handleRect).fill()
  }

  override func mouseDown(with event: NSEvent) {
    resetSafetyTimeout()
    if event.clickCount == 2 {
      confirmSelection()
      return
    }
    let point = convert(event.locationInWindow, from: nil)
    anchorPoint = point
    baseSelection = selection
    dragMode = hitTestMode(point: point) ?? .create
    if dragMode == .create {
      selection = NSRect(x: point.x, y: point.y, width: 1, height: 1)
    }
    needsDisplay = true
  }

  override func mouseDragged(with event: NSEvent) {
    resetSafetyTimeout()
    let point = clampPoint(convert(event.locationInWindow, from: nil))
    guard var current = selection else { return }

    switch dragMode {
    case .create:
      current = NSRect(
        x: min(anchorPoint.x, point.x),
        y: min(anchorPoint.y, point.y),
        width: abs(point.x - anchorPoint.x),
        height: abs(point.y - anchorPoint.y)
      )
    case .move:
      guard let base = baseSelection else { break }
      let dx = point.x - anchorPoint.x
      let dy = point.y - anchorPoint.y
      current = NSRect(x: base.origin.x + dx, y: base.origin.y + dy, width: base.width, height: base.height)
      current = clampRect(current)
    default:
      guard let base = baseSelection else { break }
      current = resizeRect(base: base, point: point, mode: dragMode)
    }

    selection = enforceMinSize(clampRect(current))
    needsDisplay = true
  }

  override func mouseUp(with event: NSEvent) {
    resetSafetyTimeout()
    _ = event
    dragMode = .none
    if let rect = selection {
      selection = enforceMinSize(clampRect(rect))
    }
    needsDisplay = true
  }

  override func rightMouseDown(with event: NSEvent) {
    resetSafetyTimeout()
    _ = event
    finish(with: OutputResult.cancelled.rawValue)
  }

  override func keyDown(with event: NSEvent) {
    if handleKeyEvent(event) {
      return
    }
  }

  @discardableResult
  func handleKeyEvent(_ event: NSEvent) -> Bool {
    resetSafetyTimeout()
    guard let chars = event.charactersIgnoringModifiers?.lowercased() else { return false }
    if event.keyCode == 53 { // esc
      finish(with: OutputResult.cancelled.rawValue)
      return true
    }
    if event.keyCode == 36 || event.keyCode == 76 { // enter
      confirmSelection()
      return true
    }
    if chars == "f" {
      finish(with: OutputResult.fullscreen.rawValue)
      return true
    }
    if chars == "q" {
      finish(with: OutputResult.cancelled.rawValue)
      return true
    }
    return false
  }

  private func scheduleSafetyTimeout() {
    safetyTimer?.invalidate()
    safetyTimer = Timer.scheduledTimer(withTimeInterval: SAFETY_TIMEOUT_SECONDS, repeats: false) { [weak self] _ in
      self?.finish(with: OutputResult.cancelled.rawValue)
    }
  }

  private func resetSafetyTimeout() {
    scheduleSafetyTimeout()
  }

  private func finish(with result: String) {
    safetyTimer?.invalidate()
    safetyTimer = nil
    onFinish(result)
  }

  private func confirmSelection() {
    guard let rect = selection, rect.width >= minSize, rect.height >= minSize else {
      finish(with: OutputResult.cancelled.rawValue)
      return
    }
    let standardized = rect.standardized
    let topFromTopLeft = Int(screenFrame.height - standardized.maxY)
    let json: [String: Int] = [
      "left": Int(standardized.minX),
      "top": topFromTopLeft,
      "width": Int(standardized.width),
      "height": Int(standardized.height),
      // Pontos da tela principal (para converter retângulo em pixels da captura Retina).
      "screenWidth": Int(screenFrame.width),
      "screenHeight": Int(screenFrame.height),
    ]
    guard
      let data = try? JSONSerialization.data(withJSONObject: json),
      let output = String(data: data, encoding: .utf8)
    else {
      finish(with: OutputResult.cancelled.rawValue)
      return
    }
    finish(with: output)
  }

  private func clampPoint(_ point: NSPoint) -> NSPoint {
    NSPoint(
      x: min(max(0, point.x), bounds.width),
      y: min(max(0, point.y), bounds.height)
    )
  }

  private func clampRect(_ rect: NSRect) -> NSRect {
    var r = rect
    if r.minX < 0 { r.origin.x = 0 }
    if r.minY < 0 { r.origin.y = 0 }
    if r.maxX > bounds.width { r.origin.x = bounds.width - r.width }
    if r.maxY > bounds.height { r.origin.y = bounds.height - r.height }
    r.origin.x = min(max(0, r.origin.x), bounds.width - r.width)
    r.origin.y = min(max(0, r.origin.y), bounds.height - r.height)
    return r
  }

  private func enforceMinSize(_ rect: NSRect) -> NSRect {
    var r = rect
    if r.width < minSize { r.size.width = minSize }
    if r.height < minSize { r.size.height = minSize }
    if r.maxX > bounds.width { r.origin.x = bounds.width - r.width }
    if r.maxY > bounds.height { r.origin.y = bounds.height - r.height }
    return r
  }

  private func hitTestMode(point: NSPoint) -> DragMode? {
    guard let rect = selection?.standardized else { return nil }
    let nearLeft = abs(point.x - rect.minX) <= handleSize
    let nearRight = abs(point.x - rect.maxX) <= handleSize
    let nearBottom = abs(point.y - rect.minY) <= handleSize
    let nearTop = abs(point.y - rect.maxY) <= handleSize
    let insideX = point.x >= rect.minX && point.x <= rect.maxX
    let insideY = point.y >= rect.minY && point.y <= rect.maxY

    if nearLeft && nearTop { return .resizeTopLeft }
    if nearRight && nearTop { return .resizeTopRight }
    if nearLeft && nearBottom { return .resizeBottomLeft }
    if nearRight && nearBottom { return .resizeBottomRight }
    if nearLeft && insideY { return .resizeLeft }
    if nearRight && insideY { return .resizeRight }
    if nearTop && insideX { return .resizeTop }
    if nearBottom && insideX { return .resizeBottom }
    if insideX && insideY { return .move }
    return nil
  }

  private func resizeRect(base: NSRect, point: NSPoint, mode: DragMode) -> NSRect {
    var left = base.minX
    var right = base.maxX
    var bottom = base.minY
    var top = base.maxY

    switch mode {
    case .resizeLeft, .resizeTopLeft, .resizeBottomLeft:
      left = point.x
    default:
      break
    }
    switch mode {
    case .resizeRight, .resizeTopRight, .resizeBottomRight:
      right = point.x
    default:
      break
    }
    switch mode {
    case .resizeBottom, .resizeBottomLeft, .resizeBottomRight:
      bottom = point.y
    default:
      break
    }
    switch mode {
    case .resizeTop, .resizeTopLeft, .resizeTopRight:
      top = point.y
    default:
      break
    }

    let normalizedLeft = min(left, right)
    let normalizedRight = max(left, right)
    let normalizedBottom = min(bottom, top)
    let normalizedTop = max(bottom, top)
    return NSRect(
      x: normalizedLeft,
      y: normalizedBottom,
      width: normalizedRight - normalizedLeft,
      height: normalizedTop - normalizedBottom
    )
  }
}

func parseArg(named name: String) -> Int? {
  guard let idx = CommandLine.arguments.firstIndex(of: name), idx + 1 < CommandLine.arguments.count else {
    return nil
  }
  return Int(CommandLine.arguments[idx + 1])
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let screen = NSScreen.main ?? NSScreen.screens.first
guard let screen else {
  print(OutputResult.cancelled.rawValue)
  exit(0)
}
let frame = screen.frame

let initialRect: NSRect? = {
  guard
    let left = parseArg(named: "--left"),
    let top = parseArg(named: "--top"),
    let width = parseArg(named: "--width"),
    let height = parseArg(named: "--height"),
    width > 0,
    height > 0
  else { return nil }
  let yFromBottom = Int(frame.height) - top - height
  return NSRect(x: left, y: yFromBottom, width: width, height: height)
}()

let window = OverlayWindow(
  contentRect: frame,
  styleMask: [.borderless],
  backing: .buffered,
  defer: false
)
window.level = .screenSaver
window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
window.isOpaque = false
window.backgroundColor = .clear
window.ignoresMouseEvents = false
window.makeKeyAndOrderFront(nil)

let overlay = OverlayView(frame: frame, initial: initialRect) { result in
  print(result)
  NSApplication.shared.terminate(nil)
}

window.contentView = overlay
window.makeFirstResponder(overlay)
app.activate(ignoringOtherApps: true)
window.makeKeyAndOrderFront(nil)
_ = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
  if overlay.handleKeyEvent(event) {
    return nil
  }
  return event
}
app.run()
