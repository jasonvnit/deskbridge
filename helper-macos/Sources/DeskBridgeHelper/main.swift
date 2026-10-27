import AppKit
import Foundation

// DeskBridge helper.
//
// One-shot commands:
//   deskbridge-helper permissions          print permission status as JSON
//   deskbridge-helper request-permissions  show the system prompts, then print status
//   deskbridge-helper displays             print the display list as JSON
//   deskbridge-helper probe                try a real capture; exit 0 if it works
//
// Without arguments it runs as the server's child process: JSON-lines commands on
// stdin, length-prefixed JSON/JPEG messages on stdout (see Output.swift), logs on stderr.

signal(SIGPIPE, SIG_IGN)

func printJSON(_ value: Any) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
       let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

let arguments = CommandLine.arguments
if arguments.count > 1 {
    switch arguments[1] {
    case "permissions":
        printJSON(Permissions.status())
        exit(0)
    case "request-permissions":
        printJSON(Permissions.request())
        exit(0)
    case "displays":
        ScreenCapture.listDisplays { displays in
            printJSON(displays)
            exit(0)
        }
        dispatchMain()
    case "probe":
        let probe = CaptureProbe { ok, message in
            printJSON(["capture": ok, "message": message])
            exit(ok ? 0 : 1)
        }
        probe.run()
        dispatchMain()
    default:
        FileHandle.standardError.write(Data("usage: deskbridge-helper [permissions|request-permissions|displays|probe]\n".utf8))
        exit(2)
    }
}

final class Controller {
    private let output = Output()
    private lazy var capture: ScreenCapture = {
        let capture = ScreenCapture(output: output)
        let input = self.input
        let cursor = CursorTracker(output: output, appliedSeq: { input.appliedSeq })
        capture.onStart = { cursor.start(displayID: $0) }
        capture.onStop = { cursor.stop() }
        return capture
    }()
    private let input = InputInjector()
    private let inputQueue = DispatchQueue(label: "deskbridge.input", qos: .userInteractive)

    func run() {
        _ = NSApplication.shared
        NSApplication.shared.setActivationPolicy(.prohibited)

        let reader = Thread {
            while let line = readLine(strippingNewline: true) {
                self.handle(line)
            }
            // stdin closed: the server went away.
            self.inputQueue.sync { self.input.releaseAll() }
            exit(0)
        }
        reader.stackSize = 4 << 20
        reader.start()

        output.send(["type": "ready", "permissions": Permissions.status()])
        dispatchMain()
    }

    private func handle(_ line: String) {
        guard !line.isEmpty,
              let data = line.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = message["type"] as? String
        else {
            log("ignoring malformed command")
            return
        }
        let id = message["id"] as? Int

        switch type {
        case "start":
            capture.start(StreamOptions(message))
        case "stop":
            capture.stop()
        case "credit":
            capture.addCredit((message["n"] as? Int) ?? 1)
        case "resetCredits":
            capture.resetCredits((message["n"] as? Int) ?? 2)
        case "refresh":
            capture.refresh()
        case "keyframe":
            capture.requestKeyFrame()

        case "mouse":
            inputQueue.async { self.input.mouse(message) }
        case "key":
            guard let code = message["code"] as? String else { return }
            let down = (message["down"] as? Bool) ?? true
            let isRepeat = (message["repeat"] as? Bool) ?? false
            inputQueue.async { self.input.key(code: code, down: down, isRepeat: isRepeat) }
        case "text":
            guard let text = message["text"] as? String else { return }
            inputQueue.async { self.input.type(text) }
        case "releaseAll":
            inputQueue.async { self.input.releaseAll() }

        case "clipboardGet":
            DispatchQueue.main.async { self.reply(id, Clipboard.read()) }
        case "clipboardSetText":
            let text = (message["text"] as? String) ?? ""
            DispatchQueue.main.async {
                Clipboard.setText(text)
                self.reply(id, [:])
            }
        case "clipboardSetImage":
            guard let base64 = message["data"] as? String, let data = Data(base64Encoded: base64) else {
                replyError(id, "invalid image data")
                return
            }
            DispatchQueue.main.async {
                if Clipboard.setImage(data) {
                    self.reply(id, [:])
                } else {
                    self.replyError(id, "unsupported image format")
                }
            }

        case "displays":
            ScreenCapture.listDisplays { displays in self.reply(id, ["displays": displays]) }
        case "permissions":
            reply(id, Permissions.status())

        default:
            log("unknown command: \(type)")
            replyError(id, "unknown command")
        }
    }

    private func reply(_ id: Int?, _ result: [String: Any]) {
        guard let id else { return }
        output.send(["type": "reply", "id": id, "ok": true, "result": result])
    }

    private func replyError(_ id: Int?, _ message: String) {
        guard let id else { return }
        output.send(["type": "reply", "id": id, "ok": false, "error": message])
    }
}

Controller().run()
