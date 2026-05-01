import AppKit

guard let screen = NSScreen.main ?? NSScreen.screens.first else {
  fputs("no screen\n", stderr)
  exit(1)
}

let frame = screen.frame
print("\(Int(frame.width)) \(Int(frame.height))")
