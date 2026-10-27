import AppKit
import CoreImage
import CoreMedia
import ScreenCaptureKit

enum Codec: String {
    case jpeg
    case h264
}

struct StreamOptions {
    var displayID: CGDirectDisplayID?
    var codec: Codec = .jpeg
    var fps: Int = 15
    /// JPEG quality, 0.1...1.
    var quality: Double = 0.6
    /// H.264 average bitrate.
    var bitrateKbps: Int = 3000
    /// Maximum frame width in pixels; 0 means native resolution.
    var maxWidth: Int = 1920

    init() {}

    init(_ message: [String: Any]) {
        if let id = message["displayId"] as? NSNumber, id.intValue > 0 {
            displayID = CGDirectDisplayID(id.uint32Value)
        }
        if let name = message["codec"] as? String, let value = Codec(rawValue: name) {
            codec = value
        }
        if let value = message["fps"] as? NSNumber {
            fps = max(1, min(60, value.intValue))
        }
        if let value = message["quality"] as? NSNumber {
            quality = max(0.1, min(1, value.doubleValue))
        }
        if let value = message["bitrate"] as? NSNumber {
            bitrateKbps = max(200, min(50_000, value.intValue))
        }
        if let value = message["maxWidth"] as? NSNumber {
            maxWidth = max(0, value.intValue)
        }
    }
}

/// Captures one display with ScreenCaptureKit and emits JPEG frames or H.264 video.
///
/// Flow control: a frame is only encoded when the server has granted credit.
/// The newest captured frame is kept, so a slow client always gets the latest
/// picture and a static screen costs nothing. With H.264, skipped captures are
/// simply never encoded, so the stream stays valid.
final class ScreenCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Hardware encoders top out at 4096 pixels wide.
    private static let maxVideoWidth = 4096
    /// After the screen stops changing, re-encode the last frame so H.264 detail sharpens.
    private static let refineDelays: [Double] = [0.25, 0.8, 2.0]

    private let output: Output
    private let queue = DispatchQueue(label: "deskbridge.capture", qos: .userInteractive)
    private let ciContext = CIContext(options: [.cacheIntermediates: false])
    private let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!

    private var stream: SCStream?
    private var encoder: H264Encoder?
    private var options = StreamOptions()
    private var generation = 0
    private var latest: CVPixelBuffer?
    private var captureCount = 0
    private var dirty = false
    private var credits = 0

    /// Called when a stream starts (with its display) and when it stops.
    var onStart: (CGDirectDisplayID) -> Void = { _ in }
    var onStop: () -> Void = {}

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

    /// Makes the next H.264 frame a key frame (new client, decoder error) and sends it.
    func requestKeyFrame() {
        queue.async {
            guard let encoder = self.encoder else { return }
            encoder.requestKeyFrame()
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
        var limit = options.maxWidth
        if options.codec == .h264 {
            limit = limit > 0 ? min(limit, ScreenCapture.maxVideoWidth) : ScreenCapture.maxVideoWidth
        }
        if limit > 0, width > limit {
            height = Int((Double(height) * Double(limit) / Double(width)).rounded())
            width = limit
        }
        width &= ~1
        height &= ~1

        var codec = options.codec
        if codec == .h264 {
            if let encoder = H264Encoder(width: width, height: height, fps: options.fps, bitrateKbps: options.bitrateKbps, output: output) {
                encoder.onDrop = { [weak self] in self?.addCredit(1) }
                self.encoder = encoder
            } else {
                codec = .jpeg
                log("falling back to JPEG")
            }
        }

        let config = SCStreamConfiguration()
        config.width = width
        config.height = height
        config.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        // The video encoder works natively in 4:2:0; JPEG encoding uses BGRA.
        config.pixelFormat = codec == .h264 ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA
        config.colorSpaceName = CGColorSpace.sRGB
        // The cursor is sent separately (CursorTracker) and drawn by the client without delay.
        config.showsCursor = false
        config.queueDepth = 5

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let newStream = SCStream(filter: filter, configuration: config, delegate: self)
        do {
            try newStream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        } catch {
            encoder = nil
            reportError("cannot attach stream output: \(error.localizedDescription)")
            return
        }

        stream = newStream
        latest = nil
        dirty = false
        let generation = self.generation
        let fps = options.fps

        newStream.startCapture { error in
            if let error {
                self.queue.async {
                    guard generation == self.generation else { return }
                    self.stream = nil
                    self.encoder = nil
                    self.reportError("cannot start capture: \(error.localizedDescription)")
                }
                return
            }
            self.onStart(display.displayID)
            self.output.send([
                "type": "streamInfo",
                "displayId": Int(display.displayID),
                "codec": codec.rawValue,
                "width": width,
                "height": height,
                "pointWidth": display.width,
                "pointHeight": display.height,
                "fps": fps,
            ])
        }
    }

    private func stopStream() {
        encoder = nil
        guard let current = stream else { return }
        onStop()
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
        captureCount += 1
        dirty = true
        emitIfPossible()
        scheduleRefinements(after: captureCount)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async {
            guard stream === self.stream else { return }
            self.stream = nil
            self.encoder = nil
            self.onStop()
            self.reportError("capture stopped: \(error.localizedDescription)")
        }
    }

    /// Encodes and sends the latest frame if there is credit.
    private func emitIfPossible() {
        guard credits > 0, dirty, let pixelBuffer = latest else { return }

        if let encoder {
            credits -= 1
            dirty = false
            encoder.encode(pixelBuffer)
            return
        }

        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let qualityKey = CIImageRepresentationOption(rawValue: kCGImageDestinationLossyCompressionQuality as String)
        guard let jpeg = ciContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: [qualityKey: options.quality]) else {
            return
        }
        credits -= 1
        dirty = false
        output.sendFrame(jpeg)
    }

    /// H.264 only: when nothing changes for a moment, encode the same picture again
    /// a few times. Each pass adds detail, so text becomes sharp once motion stops.
    private func scheduleRefinements(after count: Int) {
        guard encoder != nil else { return }
        let generation = self.generation
        for delay in ScreenCapture.refineDelays {
            queue.asyncAfter(deadline: .now() + delay) {
                guard generation == self.generation, self.captureCount == count, self.latest != nil else { return }
                self.dirty = true
                self.emitIfPossible()
            }
        }
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
