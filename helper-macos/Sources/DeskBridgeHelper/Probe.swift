import Foundation
import ScreenCaptureKit

/// Starts a short real capture to check that macOS actually lets this binary record
/// the screen. The permission APIs can report "granted" while ScreenCaptureKit still
/// refuses, e.g. when a stale permission entry exists for an older build of the helper.
final class CaptureProbe: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var finished = false
    private let completion: (Bool, String) -> Void

    init(completion: @escaping (Bool, String) -> Void) {
        self.completion = completion
    }

    func run(timeout: TimeInterval = 3) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
            guard let display = content?.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content?.displays.first else {
                self.finish(false, "cannot list displays: \(error?.localizedDescription ?? "unknown error")")
                return
            }
            let config = SCStreamConfiguration()
            config.width = 320
            config.height = 180
            config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
            let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: self)
            self.stream = stream
            do {
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: .main)
            } catch {
                self.finish(false, error.localizedDescription)
                return
            }
            stream.startCapture { error in
                if let error { self.finish(false, error.localizedDescription) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + timeout) {
            self.finish(false, "no frame received")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        finish(true, "ok")
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        finish(false, error.localizedDescription)
    }

    private func finish(_ ok: Bool, _ message: String) {
        DispatchQueue.main.async {
            guard !self.finished else { return }
            self.finished = true
            self.stream?.stopCapture { _ in }
            self.completion(ok, message)
        }
    }
}
