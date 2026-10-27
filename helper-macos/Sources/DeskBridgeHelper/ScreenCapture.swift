import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

struct StreamOptions {
    var displayID: CGDirectDisplayID?
    var fps: Int = 15
    var quality: Double = 0.6
    /// Maximum frame width in pixels; 0 means native resolution.
    var maxWidth: Int = 1920

    init() {}

    init(_ message: [String: Any]) {
        if let id = message["displayId"] as? NSNumber, id.intValue > 0 {
            displayID = CGDirectDisplayID(id.uint32Value)
        }
        if let value = message["fps"] as? NSNumber {
            fps = max(1, min(60, value.intValue))
        }
        if let value = message["quality"] as? NSNumber {
            quality = max(0.1, min(1, value.doubleValue))
        }
        if let value = message["maxWidth"] as? NSNumber {
            maxWidth = max(0, value.intValue)
        }
    }
}

/// Captures one display with ScreenCaptureKit and emits JPEG frames.
///
/// Flow control: frames are only encoded when the server has granted credit.
/// The newest frame is kept, so a slow client always gets the latest picture
/// and a static screen costs nothing.
final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private let output: Output
    private let queue = DispatchQueue(label: "deskbridge.capture", qos: .userInteractive)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    private var stream: SCStream?
    private var options = StreamOptions()
    private var generation = 0
    private var latest: CVPixelBuffer?
    private var dirty = false
    private var credits = 0

    init(output: Output) {
        self.output = output
    }

    // MARK: Control (all state lives on `queue`)

    func start(_ newOptions: StreamOptions) {
        queue.async {
            self.options = newOptions
            self.generation += 1
            let generation = self.generation
            self.stopStream()

            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                self.queue.async {
                    guard generation == self.generation else { return }
                    guard let content else {
                        self.reportError("cannot list displays: \(error?.localizedDescription ?? "unknown error")")
                        return
                    }
                    self.startStream(content: content)
                }
            }
        }
    }

    func stop() {
        queue.async {
            self.generation += 1
            self.stopStream()
        }
    }

    func addCredit(_ count: Int) {
        queue.async {
            self.credits = min(self.credits + count, 8)
            self.emitIfPossible()
        }
    }

    func resetCredits(_ count: Int) {
        queue.async {
            self.credits = count
            self.emitIfPossible()
        }
    }

    /// Re-sends the current frame, e.g. for a newly connected client.
    func refresh() {
        queue.async {
            if self.latest != nil {
                self.dirty = true
                self.emitIfPossible()
            }
        }
    }

    // MARK: Stream lifecycle

    private func startStream(content: SCShareableContent) {
        let mainID = CGMainDisplayID()
        guard let display = content.displays.first(where: { $0.displayID == options.displayID })
            ?? content.displays.first(where: { $0.displayID == mainID })
            ?? content.displays.first
        else {
            reportError("no display found")
            return
        }

        let scale = backingScale(for: display.displayID)
        var width = Int((Double(display.width) * scale).rounded())
        var height = Int((Double(display.height) * scale).rounded())
        if options.maxWidth > 0, width > options.maxWidth {
            height = Int((Double(height) * Double(options.maxWidth) / Double(width)).rounded())
            width = options.maxWidth
        }
        width &= ~1
        height &= ~1

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        config.pixelFormat = kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB
        config.showsCursor = true
        config.queueDepth = 5

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let newStream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            reportError("cannot attach stream output: \(error.localizedDescription)")
            return
        }

        stream = newStream
        latest = nil
        dirty = false
        let generation = self.generation

        newStream.startCapture { error in
            if let error {
                self.queue.async {
                    guard generation == self.generation else { return }
                    self.stream = nil
                    self.reportError("cannot start capture: \(error.localizedDescription)")
                }
                return
            }
            self.output.send([
                "type": "streamInfo",
                "displayId": Int(display.displayID),
                "width": width,
                "height": height,
                "fps": self.options.fps,
            ])
        }
    }

    private func stopStream() {
        guard let current = stream else { return }
        stream = nil
        latest = nil
        dirty = false
        current.stopCapture { _ in }
    }

    // MARK: Frames

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, stream === self.stream else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let rawStatus = attachments.first?[.status] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let pixelBuffer = sampleBuffer.imageBuffer
        else { return }

        latest = pixelBuffer
        dirty = true
        emitIfPossible()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async {
            guard stream === self.stream else { return }
            self.stream = nil
            self.reportError("capture stopped: \(error.localizedDescription)")
        }
    }

    private func emitIfPossible() {
        guard credits > 0, dirty, let pixelBuffer = latest else { return }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = ciContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: [qualityKey: options.quality]) else {
            return
        }
        credits -= 1
        dirty = false
        output.sendFrame(jpeg)
    }

    // MARK: Helpers

    private func reportError(_ message: String) {
        log(message)
        output.send(["type": "streamError", "message": message])
    }

    private func backingScale(for displayID: CGDirectDisplayID) -> Double {
        guard let mode = CGDisplayCopyDisplayMode(displayID), mode.width > 0 else { return 1 }
        return Double(mode.pixelWidth) / Double(mode.width)
    }

    // MARK: Display list

    static func listDisplays(completion: @escaping ([[String: Any]]) -> Void) {
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
            let displays = content?.displays ?? []
            DispatchQueue.main.async {
                var names: [CGDirectDisplayID: String] = [:]
                for screen in NSScreen.screens {
                    if let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
                        names[CGDirectDisplayID(number.uint32Value)] = screen.localizedName
                    }
                }
                let mainID = CGMainDisplayID()
                completion(displays.map { display in
                    [
                        "id": Int(display.displayID),
                        "name": names[display.displayID] ?? "Display \(display.displayID)",
                        "width": display.width,
                        "height": display.height,
                        "isMain": display.displayID == mainID,
                    ]
                })
            }
        }
    }
}
