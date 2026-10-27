import AppKit

enum Clipboard {
    /// Returns the current pasteboard content: text and/or a PNG image (base64).
    static func read() -> [String: Any] {
        let board = NSPasteboard.general
        var result: [String: Any] = ["changeCount": board.changeCount]

        if let text = board.string(forType: .string) {
            result["text"] = text
        }
        if let png = imagePNG(from: board) {
            result["image"] = png.base64EncodedString()
        }
        return result
    }

    static func setText(_ text: String) {
        let board = NSPasteboard.general
        board.clearContents()
        board.setString(text, forType: .string)
    }

    /// Accepts any image format NSImage can decode (PNG, JPEG, HEIC, GIF...).
    static func setImage(_ data: Data) -> Bool {
        guard let image = NSImage(data: data),
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else {
            return false
        }
        let board = NSPasteboard.general
        board.clearContents()
        board.declareTypes([.png, .tiff], owner: nil)
        board.setData(png, forType: .png)
        board.setData(tiff, forType: .tiff)
        return true
    }

    private static func imagePNG(from board: NSPasteboard) -> Data? {
        if let png = board.data(forType: .png) {
            return png
        }
        if let tiff = board.data(forType: .tiff),
           let rep = NSBitmapImageRep(data: tiff) {
            return rep.representation(using: .png, properties: [:])
        }
        return nil
    }
}
