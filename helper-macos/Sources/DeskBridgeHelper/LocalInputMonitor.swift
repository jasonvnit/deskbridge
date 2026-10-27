import CoreGraphics
import Foundation

/// Marks events posted by DeskBridge, so they can be told apart from real input.
enum SyntheticEvent {
    static let marker: Int64 = 0x0DE5_B21D

    static func mark(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: marker)
    }

    static func isMarked(_ event: CGEvent) -> Bool {
        event.getIntegerValueField(.eventSourceUserData) == marker
    }
}

/// Watches for keyboard/mouse input made directly on the Mac (not by DeskBridge)
/// while a remote session is streaming, and reports it as {"type":"localInput"}.
///
/// Key presses, clicks and scrolling count immediately; pointer movement only
/// counts after `moveThreshold` points within one second, so a bumped desk does
/// not end the session.
final class LocalInputMonitor {
    private static let moveThreshold: Double = 40
    private static let moveWindow: TimeInterval = 1
    private static let reportInterval: TimeInterval = 2

    private let output: Output
    private let lock = NSLock()
    private var thread: Thread?
    private var runLoop: CFRunLoop?
    private var tap: CFMachPort?
    private var moved: Double = 0
    private var moveWindowStart: TimeInterval = 0
    private var lastReport: TimeInterval = 0

    init(output: Output) {
        self.output = output
    }

    func start() {
        lock.lock()
        defer { lock.unlock() }
        guard thread == nil else { return }
        let thread = Thread { [weak self] in self?.run() }
        thread.name = "deskbridge.local-input"
        self.thread = thread
        thread.start()
    }

    func stop() {
        lock.lock()
        let runLoop = self.runLoop
        thread = nil
        self.runLoop = nil
        lock.unlock()
        if let runLoop {
            CFRunLoopStop(runLoop)
        }
    }

    private func run() {
        let types: [CGEventType] = [
            .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
            .scrollWheel, .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged,
        ]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let refcon = Unmanaged.passUnretained(self).toOpaque()

        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap, place: .tailAppendEventTap, options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, refcon in
                if let refcon {
                    Unmanaged<LocalInputMonitor>.fromOpaque(refcon).takeUnretainedValue().handle(type, event)
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: refcon
        ) else {
            log("cannot watch local input (event tap not permitted)")
            return
        }
        guard let source = CFMachPortCreateRunLoopSource(nil, tap, 0) else { return }

        let runLoop = CFRunLoopGetCurrent()
        lock.lock()
        // stop() may have been called before this thread got here.
        guard thread === Thread.current else {
            lock.unlock()
            CFMachPortInvalidate(tap)
            return
        }
        self.tap = tap
        self.runLoop = runLoop
        lock.unlock()

        CFRunLoopAddSource(runLoop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        CFRunLoopRun()

        CGEvent.tapEnable(tap: tap, enable: false)
        CFRunLoopRemoveSource(runLoop, source, .commonModes)
        CFMachPortInvalidate(tap)
        lock.lock()
        self.tap = nil
        lock.unlock()
    }

    private func handle(_ type: CGEventType, _ event: CGEvent) {
        // macOS disables slow taps; turn it back on.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
            return
        }
        if SyntheticEvent.isMarked(event) { return }

        let now = ProcessInfo.processInfo.systemUptime
        switch type {
        case .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged:
            if now - moveWindowStart > LocalInputMonitor.moveWindow {
                moveWindowStart = now
                moved = 0
            }
            let dx = Double(event.getIntegerValueField(.mouseEventDeltaX))
            let dy = Double(event.getIntegerValueField(.mouseEventDeltaY))
            moved += hypot(dx, dy)
            if moved >= LocalInputMonitor.moveThreshold { report(now) }
        default:
            report(now)
        }
    }

    private func report(_ now: TimeInterval) {
        guard now - lastReport >= LocalInputMonitor.reportInterval else { return }
        lastReport = now
        moved = 0
        output.send(["type": "localInput"])
    }
}
