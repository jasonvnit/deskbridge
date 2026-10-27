import CoreGraphics
import Foundation

/// Posts synthetic mouse and keyboard events and keeps track of what is held down,
/// so everything can be released when the client disconnects.
final class InputInjector {
    private enum Button: Int {
        case left = 0, right = 1, middle = 2

        var cgButton: CGMouseButton {
            switch self {
            case .left: return .left
            case .right: return .right
            case .middle: return .center
            }
        }

        var downType: CGEventType {
            switch self {
            case .left: return .leftMouseDown
            case .right: return .rightMouseDown
            case .middle: return .otherMouseDown
            }
        }

        var upType: CGEventType {
            switch self {
            case .left: return .leftMouseUp
            case .right: return .rightMouseUp
            case .middle: return .otherMouseUp
            }
        }

        var dragType: CGEventType {
            switch self {
            case .left: return .leftMouseDragged
            case .right: return .rightMouseDragged
            case .middle: return .otherMouseDragged
            }
        }

        init?(name: String?) {
            switch name {
            case nil, "left": self = .left
            case "right": self = .right
            case "middle": self = .middle
            default: return nil
            }
        }
    }

    private struct LastClick {
        let time: TimeInterval
        let point: CGPoint
        let button: Button
        let count: Int
    }

    private static let doubleClickInterval: TimeInterval = 0.45
    private static let doubleClickDistance: CGFloat = 12
    private static let typingDelay: useconds_t = 2_000

    private let lock = NSLock()
    private let source = CGEventSource(stateID: .hidSystemState)
    private var pressedKeys = Set<CGKeyCode>()
    private var pressedButtons = Set<Int>()
    private var point = CGPoint.zero
    private let seqLock = NSLock()
    private var lastAppliedSeq = 0

    /// Sequence number of the last mouse command applied. Sent back with cursor
    /// positions so the client can ignore positions older than its own input.
    var appliedSeq: Int {
        seqLock.lock()
        defer { seqLock.unlock() }
        return lastAppliedSeq
    }
    private var lastClick: LastClick?
    private var clickCount = 1

    // MARK: Mouse

    func mouse(_ message: [String: Any]) {
        lock.lock()
        defer {
            lock.unlock()
            if let seq = message["seq"] as? Int {
                seqLock.lock()
                lastAppliedSeq = max(lastAppliedSeq, seq)
                seqLock.unlock()
            }
        }

        let displayID = (message["displayId"] as? NSNumber).map { CGDirectDisplayID($0.uint32Value) } ?? CGMainDisplayID()
        if let x = message["x"] as? Double, let y = message["y"] as? Double {
            let bounds = CGDisplayBounds(displayID)
            point = CGPoint(
                x: bounds.minX + clamp(x) * bounds.width,
                y: bounds.minY + clamp(y) * bounds.height
            )
        }

        switch message["action"] as? String {
        case "move":
            postMove()
        case "down":
            guard let button = Button(name: message["button"] as? String) else { return }
            postButton(button, down: true)
        case "up":
            guard let button = Button(name: message["button"] as? String) else { return }
            postButton(button, down: false)
        case "scroll":
            let dx = (message["dx"] as? Double) ?? 0
            let dy = (message["dy"] as? Double) ?? 0
            postScroll(dx: dx, dy: dy)
        default:
            break
        }
    }

    private func postMove() {
        var type = CGEventType.mouseMoved
        var cgButton = CGMouseButton.left
        for candidate in [Button.left, .right, .middle] where pressedButtons.contains(candidate.rawValue) {
            type = candidate.dragType
            cgButton = candidate.cgButton
            break
        }
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: cgButton) else { return }
        event.flags = currentFlags()
        event.post(tap: .cghidEventTap)
    }

    private func postButton(_ button: Button, down: Bool) {
        if down {
            let now = ProcessInfo.processInfo.systemUptime
            if let last = lastClick,
               last.button == button,
               now - last.time < InputInjector.doubleClickInterval,
               hypot(last.point.x - point.x, last.point.y - point.y) < InputInjector.doubleClickDistance {
                clickCount = last.count + 1
            } else {
                clickCount = 1
            }
            lastClick = LastClick(time: now, point: point, button: button, count: clickCount)
            pressedButtons.insert(button.rawValue)
        } else {
            pressedButtons.remove(button.rawValue)
        }

        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: down ? button.downType : button.upType,
            mouseCursorPosition: point,
            mouseButton: button.cgButton
        ) else { return }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        if button == .middle {
            event.setIntegerValueField(.mouseEventButtonNumber, value: 2)
        }
        event.flags = currentFlags()
        event.post(tap: .cghidEventTap)
    }

    private func postScroll(dx: Double, dy: Double) {
        let wheelY = Int32(max(-10_000, min(10_000, dy.rounded())))
        let wheelX = Int32(max(-10_000, min(10_000, dx.rounded())))
        guard wheelX != 0 || wheelY != 0 else { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 2,
            wheel1: wheelY,
            wheel2: wheelX,
            wheel3: 0
        ) else { return }
        event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        event.location = point
        event.flags = currentFlags()
        event.post(tap: .cghidEventTap)
    }

    // MARK: Keyboard

    func key(code: String, down: Bool, isRepeat: Bool) {
        lock.lock()
        defer { lock.unlock() }

        guard let keyCode = KeyMap.codes[code] else {
            log("unknown key code: \(code)")
            return
        }
        postKey(keyCode, down: down, isRepeat: isRepeat)
    }

    private func postKey(_ keyCode: CGKeyCode, down: Bool, isRepeat: Bool = false) {
        if down {
            pressedKeys.insert(keyCode)
        } else {
            pressedKeys.remove(keyCode)
        }

        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else { return }

        if KeyMap.modifierFlags[keyCode] != nil {
            event.type = .flagsChanged
            event.flags = currentFlags()
        } else {
            var flags = currentFlags()
            if KeyMap.functionKeys.contains(keyCode) {
                flags.insert(.maskSecondaryFn)
            }
            if KeyMap.arrowKeys.contains(keyCode) {
                flags.insert(.maskNumericPad)
            }
            event.flags = flags
            if isRepeat {
                event.setIntegerValueField(.keyboardEventAutorepeat, value: 1)
            }
        }
        event.post(tap: .cghidEventTap)
    }

    /// Types arbitrary Unicode text, independent of the remote keyboard layout.
    func type(_ text: String) {
        lock.lock()
        defer { lock.unlock() }

        for character in text {
            switch character {
            case "\n", "\r", "\r\n":
                tap(KeyMap.returnKey)
            case "\t":
                tap(KeyMap.tabKey)
            default:
                let units = Array(String(character).utf16)
                for down in [true, false] {
                    guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else { continue }
                    event.flags = []
                    event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
                    event.post(tap: .cghidEventTap)
                }
            }
            usleep(InputInjector.typingDelay)
        }
    }

    private func tap(_ keyCode: CGKeyCode) {
        postKey(keyCode, down: true)
        postKey(keyCode, down: false)
    }

    // MARK: Release

    func releaseAll() {
        lock.lock()
        defer { lock.unlock() }

        for button in [Button.left, .right, .middle] where pressedButtons.contains(button.rawValue) {
            postButton(button, down: false)
        }
        let nonModifiers = pressedKeys.filter { KeyMap.modifierFlags[$0] == nil }
        let modifiers = pressedKeys.filter { KeyMap.modifierFlags[$0] != nil }
        for keyCode in nonModifiers {
            postKey(keyCode, down: false)
        }
        for keyCode in modifiers {
            postKey(keyCode, down: false)
        }
    }

    // MARK: Helpers

    private func currentFlags() -> CGEventFlags {
        var flags: CGEventFlags = []
        for keyCode in pressedKeys {
            if let flag = KeyMap.modifierFlags[keyCode] {
                flags.insert(flag)
            }
        }
        return flags
    }

    private func clamp(_ value: Double) -> CGFloat {
        CGFloat(max(0, min(1, value)))
    }
}
