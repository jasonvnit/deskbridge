import AppKit

/// Reports the pointer position and shape separately from the video frames,
/// so the client can draw the cursor instantly instead of waiting for a frame.
///
/// Events:
///   {"type":"cursor","x":0..1,"y":0..1,"visible":bool,"seq":n}
///     seq = last mouse command applied before this position was read
///   {"type":"cursorShape","id":"…","png":base64,"hotX":pt,"hotY":pt,"width":pt,"height":pt}
///   {"type":"cursorShape","id":"…"}   (shape already sent during this stream; the client caches it)
final class CursorTracker {
    private static let interval: DispatchTimeInterval = .milliseconds(33)

    private let output: Output
    private var timer: DispatchSourceTimer?
    private var displayID: CGDirectDisplayID = CGMainDisplayID()
    private var lastPosition: (x: Double, y: Double, visible: Bool, seq: Int)?
    private let appliedMove: () -> InputInjector.AppliedMove
    /// Sequence number reported to the client: only once the pointer is really there.
    private var confirmedSeq = 0
    private var lastShapeKey: UInt64?
    private var sentShapes = Set<UInt64>()

    /// A posted move counts as done once the pointer is this close, or after this long.
    private static let arrivalDistance: CGFloat = 3
    private static let arrivalTimeout: TimeInterval = 0.25

    init(output: Output, appliedMove: @escaping () -> InputInjector.AppliedMove) {
        self.output = output
        self.appliedMove = appliedMove
    }

    func start(displayID: CGDirectDisplayID) {
        DispatchQueue.main.async {
            self.displayID = displayID
            self.lastPosition = nil
            self.lastShapeKey = nil
            self.sentShapes.removeAll()
            guard self.timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now(), repeating: CursorTracker.interval, leeway: .milliseconds(5))
            timer.setEventHandler { self.tick() }
            timer.resume()
            self.timer = timer
        }
    }

    func stop() {
        DispatchQueue.main.async {
            self.timer?.cancel()
            self.timer = nil
        }
    }

    private func tick() {
        // Read the last move first, then the position. macOS applies posted events
        // asynchronously, so confirm a move only once the pointer has arrived.
        let move = appliedMove()
        guard let location = CGEvent(source: nil)?.location else { return }
        if move.seq != confirmedSeq {
            let arrived = hypot(location.x - move.point.x, location.y - move.point.y) <= CursorTracker.arrivalDistance
            if arrived || ProcessInfo.processInfo.systemUptime - move.time > CursorTracker.arrivalTimeout {
                confirmedSeq = move.seq
            }
        }
        let seq = confirmedSeq
        let bounds = CGDisplayBounds(displayID)
        let visible = bounds.width > 0 && bounds.contains(location)
        let x = bounds.width > 0 ? Double((location.x - bounds.minX) / bounds.width) : 0
        let y = bounds.height > 0 ? Double((location.y - bounds.minY) / bounds.height) : 0

        if lastPosition == nil
            || lastPosition!.seq != seq
            || lastPosition!.visible != visible
            || abs(lastPosition!.x - x) > 0.00005
            || abs(lastPosition!.y - y) > 0.00005 {
            lastPosition = (x, y, visible, seq)
            output.send(["type": "cursor", "x": x, "y": y, "visible": visible, "seq": seq])
        }

        sendShapeIfChanged()
    }

    private func sendShapeIfChanged() {
        guard let cursor = NSCursor.currentSystem else { return }
        let image = cursor.image
        guard let tiff = image.tiffRepresentation else { return }

        var key = fnv1a(tiff)
        key ^= UInt64(cursor.hotSpot.x * 1000) &* 31
        key ^= UInt64(cursor.hotSpot.y * 1000) &* 131
        guard key != lastShapeKey else { return }
        lastShapeKey = key
        let id = String(key, radix: 36)
        if sentShapes.contains(key) {
            output.send(["type": "cursorShape", "id": id])
            return
        }

        // Render at 2x so the cursor stays sharp on high-density screens.
        let size = image.size
        var rect = CGRect(x: 0, y: 0, width: size.width * 2, height: size.height * 2)
        guard size.width > 0,
              let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil),
              let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:])
        else { return }

        sentShapes.insert(key)
        output.send([
            "type": "cursorShape",
            "id": id,
            "png": png.base64EncodedString(),
            "hotX": Double(cursor.hotSpot.x),
            "hotY": Double(cursor.hotSpot.y),
            "width": Double(size.width),
            "height": Double(size.height),
        ])
    }

    private func fnv1a(_ data: Data) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in data {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return hash
    }
}
