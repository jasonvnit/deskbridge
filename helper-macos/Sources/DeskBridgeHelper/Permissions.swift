import ApplicationServices
import CoreGraphics

enum Permissions {
    static func status() -> [String: Any] {
        [
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
        ]
    }

    /// Triggers the system prompts for any permission that is still missing.
    static func request() -> [String: Any] {
        if !CGPreflightScreenCaptureAccess() {
            _ = CGRequestScreenCaptureAccess()
        }
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        return status()
    }
}
