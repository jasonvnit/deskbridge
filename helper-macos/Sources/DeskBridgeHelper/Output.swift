import Foundation

/// Writes length-prefixed messages to stdout.
///
/// Wire format: 1 byte kind + 4 bytes big-endian payload length + payload.
/// Kind 1 = UTF-8 JSON, kind 2 = JPEG frame.
final class Output {
    static let kindJSON: UInt8 = 1
    static let kindFrame: UInt8 = 2

    private let lock = NSLock()
    private let handle = FileHandle.standardOutput

    func send(_ json: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: json) else {
            log("failed to encode JSON message")
            return
        }
        write(kind: Output.kindJSON, payload: data)
    }

    func sendFrame(_ jpeg: Data) {
        write(kind: Output.kindFrame, payload: jpeg)
    }

    private func write(kind: UInt8, payload: Data) {
        var header = Data([kind])
        var length = UInt32(payload.count).bigEndian
        withUnsafeBytes(of: &length) { header.append(contentsOf: $0) }

        lock.lock()
        defer { lock.unlock() }
        do {
            try handle.write(contentsOf: header)
            try handle.write(contentsOf: payload)
        } catch {
            // The parent process is gone; nothing left to do.
            exit(0)
        }
    }
}

func log(_ message: String) {
    FileHandle.standardError.write(Data("[helper] \(message)\n".utf8))
}
