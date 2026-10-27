import CoreMedia
import Foundation
import VideoToolbox

/// Hardware H.264 encoder tuned for remote desktop: real-time, no B-frames,
/// low-latency rate control when available, key frames only on request.
///
/// Output:
///   - JSON {"type":"videoConfig","codec":"avc1.XXXXXX","description":base64 avcC,"width","height"}
///     before every key frame whose parameters changed.
///   - Video message (kind 3): 1 byte (1 = key frame, 0 = delta) + AVCC (length-prefixed NAL units).
final class H264Encoder {
    private let output: Output
    private let session: VTCompressionSession
    private let lock = NSLock()
    private var forceKeyFrame = true
    private var lastDescription: Data?

    /// Called when the encoder drops a frame, so the caller can return its credit.
    var onDrop: () -> Void = {}

    init?(width: Int, height: Int, fps: Int, bitrateKbps: Int, output: Output) {
        self.output = output

        var created: VTCompressionSession?
        let lowLatency = [kVTVideoEncoderSpecification_EnableLowLatencyRateControl: true] as CFDictionary
        var status = VTCompressionSessionCreate(
            allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
            encoderSpecification: lowLatency, imageBufferAttributes: nil, compressedDataAllocator: nil,
            outputCallback: nil, refcon: nil, compressionSessionOut: &created
        )
        let usesLowLatency = status == noErr
        if status != noErr {
            status = VTCompressionSessionCreate(
                allocator: nil, width: Int32(width), height: Int32(height), codecType: kCMVideoCodecType_H264,
                encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil,
                outputCallback: nil, refcon: nil, compressionSessionOut: &created
            )
        }
        guard status == noErr, let session = created else {
            log("cannot create H.264 encoder (status \(status))")
            return nil
        }
        self.session = session

        let bitsPerSecond = max(200, bitrateKbps) * 1000
        set(kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        set(kVTCompressionPropertyKey_ProfileLevel,
            usesLowLatency ? kVTProfileLevel_H264_ConstrainedHigh_AutoLevel : kVTProfileLevel_H264_Main_AutoLevel)
        set(kVTCompressionPropertyKey_AverageBitRate, bitsPerSecond as CFNumber)
        set(kVTCompressionPropertyKey_ExpectedFrameRate, fps as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameInterval, (fps * 120) as CFNumber)
        set(kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 120 as CFNumber)
        if !usesLowLatency {
            // Cap bursts (e.g. a full-screen change) at 1.5x the average over one second.
            let limits = [Double(bitsPerSecond) / 8 * 1.5, 1.0] as CFArray
            set(kVTCompressionPropertyKey_DataRateLimits, limits)
        }
        if #available(macOS 12.0, *) {
            set(kVTCompressionPropertyKey_PrioritizeEncodingSpeedOverQuality, kCFBooleanTrue)
        }
        VTCompressionSessionPrepareToEncodeFrames(session)
        log("H.264 encoder ready: \(width)x\(height) @ \(fps) fps, \(bitrateKbps) kbps, low latency: \(usesLowLatency)")
    }

    deinit {
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
    }

    func requestKeyFrame() {
        lock.lock()
        forceKeyFrame = true
        lock.unlock()
    }

    func encode(_ pixelBuffer: CVPixelBuffer) {
        lock.lock()
        let key = forceKeyFrame
        forceKeyFrame = false
        lock.unlock()

        let timestamp = CMClockGetTime(CMClockGetHostTimeClock())
        let properties = key ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: pixelBuffer, presentationTimeStamp: timestamp, duration: .invalid,
            frameProperties: properties, infoFlagsOut: nil
        ) { [weak self] status, flags, sampleBuffer in
            guard let self else { return }
            guard status == noErr, !flags.contains(.frameDropped), let sampleBuffer, CMSampleBufferDataIsReady(sampleBuffer) else {
                if key { self.requestKeyFrame() }
                self.onDrop()
                return
            }
            self.emit(sampleBuffer)
        }
        if status != noErr {
            log("H.264 encode failed (status \(status))")
            if key { requestKeyFrame() }
            onDrop()
        }
    }

    // MARK: Output

    private func emit(_ sampleBuffer: CMSampleBuffer) {
        let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[CFString: Any]]
        let notSync = (attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false
        let isKey = !notSync

        if isKey, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            sendConfigIfChanged(format)
        }

        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        let length = CMBlockBufferGetDataLength(block)
        var payload = Data(count: length + 1)
        payload[0] = isKey ? 1 : 0
        let copied = payload.withUnsafeMutableBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return -1 }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base + 1)
        }
        guard copied == noErr else { return }
        output.sendVideo(payload)
    }

    private func sendConfigIfChanged(_ format: CMFormatDescription) {
        guard let atoms = CMFormatDescriptionGetExtension(
            format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms
        ) as? [String: Any],
            let avcC = atoms["avcC"] as? Data, avcC.count >= 4
        else { return }
        guard avcC != lastDescription else { return }
        lastDescription = avcC

        let codec = String(format: "avc1.%02X%02X%02X", avcC[1], avcC[2], avcC[3])
        let dimensions = CMVideoFormatDescriptionGetDimensions(format)
        output.send([
            "type": "videoConfig",
            "codec": codec,
            "description": avcC.base64EncodedString(),
            "width": Int(dimensions.width),
            "height": Int(dimensions.height),
        ])
    }

    private func set(_ key: CFString, _ value: CFTypeRef) {
        let status = VTSessionSetProperty(session, key: key, value: value)
        if status != noErr {
            log("encoder property \(key) not supported (status \(status))")
        }
    }
}
