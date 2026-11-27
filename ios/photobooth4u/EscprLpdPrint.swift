import Foundation
import UIKit
import CoreGraphics
import ImageIO
import Network

/**
 * photobooth4u — iPad Epson ESC/P-R Raster Engine, RFC 1179 LPD (:515), Raw (:9100) & Model Probe (SNMP :161 / HTTP :80)
 *
 * Ports Android's `EscprJob.kt` + `NetPrintBridge.kt` Wi-Fi / Wi-Fi Direct printing stack to iPadOS so printers without
 * Apple AirPrint — specifically the Epson EcoTank L8050 over Wi-Fi Direct (192.168.223.1, LPD port 515) and router
 * Wi-Fi (port 631 / 9100 / 515) — print borderless 360 dpi and opt-in 720 dpi photos directly from the iPad app.
 */

// MARK: - ESC/P-R Raster Encoder (64-row low-RAM strip streaming)

enum EscprJob {
    static let dpi = 360
    static let border = 42                         // 3 mm at 360 dpi

    static let mediaPlain = 0x00
    static let mediaMatte = 0x05
    static let mediaPremiumGlossy = 0x0B           // EPS_MTID_PGPHOTO
    static let mediaSemiGloss = 0x0C
    static let mediaEpsonGlossy = 0x34             // Epson Photo Paper Glossy (L8050 Windows driver setq byte 0)

    private static let blLeft = 36                 // generic Epson borderless bleed at 360 dpi
    private static let blTop = 42
    private static let blExtraW = 72
    private static let blExtraH = 112
    private static let streamStripH = 64

    struct Config {
        var dpi: Int = 360
        var mediaCode: Int = EscprJob.mediaEpsonGlossy
        var qualityCode: Int = 2                   // 0 draft, 1 standard, 2 high
        var borderless: Bool = true
        var l8050Geo: Bool = true
        var sendSetiChku: Bool = true
        var mono: Bool = false
        var brightness: Int = 0
        var red: Int = 0
        var green: Int = 0
        var blue: Int = 0
        var sendSetm: Bool = false
    }

    enum Failure: LocalizedError {
        case invalidImage
        case sheetTooSmall
        var errorDescription: String? {
            switch self {
            case .invalidImage: return "Couldn't read the picture to print."
            case .sheetTooSmall: return "Sheet too small."
            }
        }
    }

    private static func be16(_ v: Int) -> [UInt8] {
        return [UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]
    }

    private static func be32(_ v: Int) -> [UInt8] {
        return [
            UInt8((v >> 24) & 0xFF),
            UInt8((v >> 16) & 0xFF),
            UInt8((v >> 8) & 0xFF),
            UInt8(v & 0xFF)
        ]
    }

    private static func ascii(_ s: String) -> [UInt8] {
        return Array(s.utf8)
    }

    /// Sheet dimensions in 1/360 inch for Epson borderless photo sizes; nil for other sizes.
    static func epsonBorderlessPaper(widthMm: Double, heightMm: Double) -> (Int, Int)? {
        let a = min(widthMm, heightMm)
        let b = max(widthMm, heightMm)
        func near(_ x: Double, _ y: Double) -> Bool {
            return abs(a - x) <= 1.5 && abs(b - y) <= 1.5
        }
        if near(88.9, 127.0) { return (1261, 1800) }       // L / 3R (3.5 x 5 in)
        if near(100.0, 148.0) { return (1417, 2098) }      // 100 x 148 mm
        if near(101.6, 152.4) { return (1440, 2160) }      // 4 x 6 in
        if near(101.6, 180.6) { return (1440, 2560) }      // 16:9 wide (102 x 181 mm)
        if near(127.0, 177.8) { return (1800, 2522) }      // 5 x 7 in
        if near(203.2, 254.0) { return (2880, 3600) }      // 8 x 10 in
        if near(210.0, 297.0) { return (2976, 4209) }      // A4
        if near(215.9, 279.4) { return (3060, 3960) }      // Letter
        return nil
    }

    /// Normalizes a UIImage into an upright CGImage only when orientation != .up (canvas JPEGs are already .up).
    private static func uprightCGImage(_ image: UIImage) -> CGImage? {
        if image.imageOrientation == .up, let cg = image.cgImage {
            return cg
        }
        let fmt = UIGraphicsImageRendererFormat.default()
        fmt.scale = 1.0
        fmt.opaque = true
        let renderer = UIGraphicsImageRenderer(size: image.size, format: fmt)
        let rendered = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
        return rendered.cgImage
    }

    /// Streams one ESC/P-R job in <=64 KB chunks via a 64-row CoreGraphics strip buffer (~0.8 MB at 720 dpi).
    @discardableResult
    static func streamWithConfig(
        jpegData: Data,
        widthMm: Double,
        heightMm: Double,
        cfg: Config,
        writeChunk: ([UInt8], Int) throws -> Void
    ) throws -> Int64 {
        let useDpi = cfg.dpi >= 720 ? 720 : 360
        let scale = useDpi / 360
        let shortMm = min(widthMm, heightMm)
        let longMm = max(widthMm, heightMm)
        let is4x6 = abs(shortMm - 101.6) <= 1.5 && abs(longMm - 152.4) <= 1.5

        let paperW: Int
        let paperH: Int
        let areaW: Int
        let areaH: Int
        let marginTop: Int
        let marginLeft: Int
        let blLeftPx: Int
        let blTopPx: Int
        let useBleed: Bool

        if cfg.borderless && cfg.l8050Geo && is4x6 {
            paperW = 1440 * scale
            paperH = 2160 * scale
            blLeftPx = 38 * scale                          // 76 at 720 dpi, 38 at 360 dpi
            blTopPx = 11 * scale                           // 22 at 720 dpi, 11 at 360 dpi
            areaW = 1516 * scale                           // 3032 at 720 dpi, 1516 at 360 dpi
            areaH = 2200 * scale                           // 4400 at 720 dpi, 2200 at 360 dpi
            marginTop = -blTopPx
            marginLeft = -blLeftPx
            useBleed = true
        } else if cfg.borderless {
            let ep = epsonBorderlessPaper(widthMm: widthMm, heightMm: heightMm)
            let baseW = ep?.0 ?? Int((shortMm / 25.4 * 360.0).rounded())
            let baseH = ep?.1 ?? Int((longMm / 25.4 * 360.0).rounded())
            paperW = baseW * scale
            paperH = baseH * scale
            blLeftPx = blLeft * scale
            blTopPx = blTop * scale
            areaW = (baseW + blExtraW) * scale
            areaH = (baseH + blExtraH) * scale
            marginTop = -blTopPx
            marginLeft = -blLeftPx
            useBleed = true
        } else {
            paperW = Int((shortMm / 25.4 * Double(useDpi)).rounded())
            paperH = Int((longMm / 25.4 * Double(useDpi)).rounded())
            let b = border * scale
            areaW = paperW - 2 * b
            areaH = paperH - 2 * b
            marginTop = b
            marginLeft = b
            blLeftPx = 0
            blTopPx = 0
            useBleed = false
        }
        guard areaW > 0 && areaH > 0 else { throw Failure.sheetTooSmall }

        // Decode with ImageIO subsampling capped to the target print area so low-RAM iPads never allocate oversized bitmaps.
        let srcCG: CGImage = try autoreleasepool {
            let maxPx = max(areaW, areaH)
            if let src = CGImageSourceCreateWithData(jpegData as CFData, nil) {
                let opts: [CFString: Any] = [
                    kCGImageSourceCreateThumbnailFromImageAlways: true,
                    kCGImageSourceCreateThumbnailWithTransform: true,
                    kCGImageSourceShouldCache: false,
                    kCGImageSourceShouldCacheImmediately: true,
                    kCGImageSourceThumbnailMaxPixelSize: maxPx
                ]
                if let thumb = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) {
                    return thumb
                }
            }
            guard let uiImg = UIImage(data: jpegData), let cg = EscprJob.uprightCGImage(uiImg) else {
                throw EscprJob.Failure.invalidImage
            }
            return cg
        }

        let l = useBleed ? max(0, min(blLeftPx, areaW - paperW)) : 0
        let t = useBleed ? max(0, min(blTopPx, areaH - paperH)) : 0
        let dstW = useBleed ? paperW : areaW
        let dstH = useBleed ? paperH : areaH
        let rEdge = l + dstW
        let bEdge = t + dstH

        let srcW = srcCG.width
        let srcH = srcCG.height
        let needsRotate = (srcW > srcH) != (areaW > areaH)

        var chunk = [UInt8](repeating: 0, count: 65536)
        var chunkPos = 0
        var totalBytes: Int64 = 0

        func flushChunk() throws {
            if chunkPos > 0 {
                try writeChunk(chunk, chunkPos)
                totalBytes += Int64(chunkPos)
                chunkPos = 0
            }
        }

        func emit(_ b: [UInt8], _ count: Int? = nil) throws {
            let total = count ?? b.count
            var p = 0
            var rem = total
            while rem > 0 {
                let space = chunk.count - chunkPos
                if space == 0 {
                    try flushChunk()
                    continue
                }
                let n = min(space, rem)
                chunk.replaceSubrange(chunkPos..<(chunkPos + n), with: b[p..<(p + n)])
                chunkPos += n
                p += n
                rem -= n
            }
        }

        // ── job start header ──
        var hdr: [UInt8] = []
        hdr.reserveCapacity(256)
        hdr.append(contentsOf: [0x00, 0x00, 0x00, 0x1B, 0x01])
        hdr.append(contentsOf: ascii("@EJL 1284.4\n@EJL     \n"))
        hdr.append(contentsOf: [0x1B, 0x40])
        hdr.append(contentsOf: [0x1B, 0x28, 0x52, 0x08, 0x00, 0x00])
        hdr.append(contentsOf: ascii("REMOTE1"))
        let dc = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute, .second], from: Date())
        hdr.append(contentsOf: [0x54, 0x49, 0x08, 0x00, 0x00])
        hdr.append(contentsOf: be16(dc.year ?? 2026))
        hdr.append(UInt8(dc.month ?? 1))
        hdr.append(UInt8(dc.day ?? 1))
        hdr.append(UInt8(dc.hour ?? 0))
        hdr.append(UInt8(dc.minute ?? 0))
        hdr.append(UInt8(dc.second ?? 0))
        hdr.append(contentsOf: [0x4A, 0x53, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: [0x4A, 0x48, 0x0E, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: ascii("ESCPRLib"))
        hdr.append(contentsOf: [0x48, 0x44, 0x03, 0x00, 0x00, 0x03, 0x04])
        hdr.append(contentsOf: [0x50, 0x50, 0x03, 0x00, 0x00, 0x01, 0xFF])
        hdr.append(contentsOf: [0x1B, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: [0x1B, 0x28, 0x52, 0x06, 0x00, 0x00])
        hdr.append(contentsOf: ascii("ESCPR"))

        let media = UInt8(max(0, min(0xFF, cfg.mediaCode)))
        let quality = UInt8(max(0, min(2, cfg.qualityCode)))
        // Byte 6 is colorPlane: always 0x00 (EPS_CP_FULLCOLOR 24-bit RGB dsnd scanlines, never 0x03).
        hdr.append(contentsOf: [0x1B, 0x71, 0x09, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: ascii("setq"))
        hdr.append(contentsOf: [media, quality, cfg.mono ? 1 : 0, 0, 0, 0, 0x00, 0x00, 0x00])
        if cfg.borderless && cfg.sendSetiChku {
            hdr.append(contentsOf: [0x1B, 0x71, 0x0A, 0x00, 0x00, 0x00])
            hdr.append(contentsOf: ascii("seti"))
            hdr.append(contentsOf: [UInt8](repeating: 0, count: 10))
            hdr.append(contentsOf: [0x1B, 0x75, 0x02, 0x00, 0x00, 0x00])
            hdr.append(contentsOf: ascii("chku"))
            hdr.append(contentsOf: [0x01, 0x01])
        }
        if cfg.sendSetm && is4x6 {
            hdr.append(contentsOf: [0x1B, 0x6D, 0x01, 0x00, 0x00, 0x00])
            hdr.append(contentsOf: ascii("seti"))
            hdr.append(0x00)
            hdr.append(contentsOf: [0x1B, 0x6D, 0x07, 0x00, 0x00, 0x00])
            hdr.append(contentsOf: ascii("setm"))
            hdr.append(contentsOf: [0x0A, cfg.borderless ? 0x01 : 0x00, 0x00, 0x63, 0x00, 0x00, 0x00])
        }
        let resByte: UInt8 = useDpi >= 720 ? 0x01 : 0x00
        hdr.append(contentsOf: [0x1B, 0x6A, 0x16, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: ascii("setj"))
        hdr.append(contentsOf: be32(paperW))
        hdr.append(contentsOf: be32(paperH))
        hdr.append(contentsOf: be16(marginTop))
        hdr.append(contentsOf: be16(marginLeft))
        hdr.append(contentsOf: be32(areaW))
        hdr.append(contentsOf: be32(areaH))
        hdr.append(contentsOf: [resByte, 0x00])
        hdr.append(contentsOf: [0x1B, 0x70, 0x00, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: ascii("sttp"))
        hdr.append(contentsOf: [0x1B, 0x70, 0x01, 0x00, 0x00, 0x00])
        hdr.append(contentsOf: ascii("setn"))
        hdr.append(0x01)
        try emit(hdr)

        // ── 64-row CoreGraphics strip renderer ──
        let stripH = min(streamStripH, areaH)
        let bytesPerRow = areaW * 4
        var stripRaw = [UInt8](repeating: 0xFF, count: stripH * bytesPerRow)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue

        try stripRaw.withUnsafeMutableBytes { rawBuf in
            guard let basePtr = rawBuf.baseAddress,
                  let ctx = CGContext(
                    data: basePtr,
                    width: areaW,
                    height: stripH,
                    bitsPerComponent: 8,
                    bytesPerRow: bytesPerRow,
                    space: colorSpace,
                    bitmapInfo: bitmapInfo
                  ) else {
                throw Failure.invalidImage
            }
            ctx.interpolationQuality = .high
            let pxPtr = basePtr.assumingMemoryBound(to: UInt8.self)

            // Standard unflipped CoreGraphics context: top of strip (ry = 0) is at cgY = stripH.
            func drawSheetSlice(sheetTopYInStrip: Int, ovTop: Int, ovBot: Int) {
                let cgClipY = CGFloat(stripH - ovBot)
                let cgClipH = CGFloat(ovBot - ovTop)
                let clipRect = CGRect(x: CGFloat(l), y: cgClipY, width: CGFloat(dstW), height: cgClipH)
                ctx.saveGState()
                ctx.clip(to: clipRect)
                ctx.setFillColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0)
                ctx.fill(clipRect)
                let sheetTopCg = CGFloat(stripH - sheetTopYInStrip)
                if needsRotate {
                    ctx.translateBy(x: CGFloat(l), y: sheetTopCg)
                    ctx.rotate(by: -CGFloat.pi / 2.0)
                    ctx.draw(srcCG, in: CGRect(x: 0, y: 0, width: CGFloat(dstH), height: CGFloat(dstW)))
                } else {
                    ctx.draw(srcCG, in: CGRect(x: CGFloat(l), y: sheetTopCg - CGFloat(dstH), width: CGFloat(dstW), height: CGFloat(dstH)))
                }
                ctx.restoreGState()
            }

            func fillHorizBleed(_ lineRgba: inout [UInt8]) {
                guard useBleed else { return }
                let lo = l * 4
                let lr = lineRgba[lo], lg = lineRgba[lo + 1], lb = lineRgba[lo + 2]
                for x in 0..<l {
                    let o = x * 4
                    lineRgba[o] = lr; lineRgba[o + 1] = lg; lineRgba[o + 2] = lb
                }
                let ro = (rEdge - 1) * 4
                let rr = lineRgba[ro], rg = lineRgba[ro + 1], rb = lineRgba[ro + 2]
                for x in rEdge..<areaW {
                    let o = x * 4
                    lineRgba[o] = rr; lineRgba[o + 1] = rg; lineRgba[o + 2] = rb
                }
            }

            var topEdgeRgba: [UInt8]? = nil
            if useBleed && t > 0 {
                drawSheetSlice(sheetTopYInStrip: 0, ovTop: 0, ovBot: 1)
                var topBuf = [UInt8](repeating: 0xFF, count: bytesPerRow)
                topBuf.withUnsafeMutableBytes { dst in
                    dst.baseAddress?.copyMemory(from: UnsafeRawPointer(pxPtr), byteCount: bytesPerRow)
                }
                fillHorizBleed(&topBuf)
                topEdgeRgba = topBuf
            }
            var bottomEdgeRgba = (useBleed && bEdge < areaH) ? [UInt8](repeating: 0xFF, count: bytesPerRow) : [UInt8]()
            let hasBottomEdge = useBleed && bEdge < areaH

            let bClamp = max(-100, min(100, cfg.brightness))
            let bOff = Int(Double(bClamp) * 2.55)
            let rOff = bOff + Int(Double(max(-100, min(100, cfg.red))) * 2.55)
            let gOff = bOff + Int(Double(max(-100, min(100, cfg.green))) * 2.55)
            let bOff2 = bOff + Int(Double(max(-100, min(100, cfg.blue))) * 2.55)
            let hasAdj = (cfg.brightness != 0 || cfg.red != 0 || cfg.green != 0 || cfg.blue != 0)

            var rowRgba = [UInt8](repeating: 0xFF, count: bytesPerRow)
            var rowRgb = [UInt8](repeating: 0, count: areaW * 3)
            var rleBuf = [UInt8](repeating: 0, count: areaW * 3)
            var dsndHdr = [UInt8](repeating: 0, count: 17)
            dsndHdr[0] = 0x1B
            dsndHdr[1] = 0x64
            dsndHdr[6] = 0x64 // 'd'
            dsndHdr[7] = 0x73 // 's'
            dsndHdr[8] = 0x6E // 'n'
            dsndHdr[9] = 0x64 // 'd'
            dsndHdr[10] = 0
            dsndHdr[11] = 0

            func emitRow(_ y: Int, _ rgba: [UInt8]) throws {
                var white = true
                for x in 0..<areaW {
                    let s = x * 4
                    var r = Int(rgba[s])
                    var g = Int(rgba[s + 1])
                    var b = Int(rgba[s + 2])
                    if cfg.mono {
                        let lum = Int(0.299 * Double(r) + 0.587 * Double(g) + 0.114 * Double(b))
                        r = lum; g = lum; b = lum
                    }
                    if hasAdj {
                        r = max(0, min(255, r + rOff))
                        g = max(0, min(255, g + gOff))
                        b = max(0, min(255, b + bOff2))
                    }
                    let o = x * 3
                    rowRgb[o] = UInt8(r)
                    rowRgb[o + 1] = UInt8(g)
                    rowRgb[o + 2] = UInt8(b)
                    if r != 0xFF || g != 0xFF || b != 0xFF { white = false }
                }
                if white { return }
                let rleLen = packBitsInto(rowRgb, bpp: 3, dst: &rleBuf)
                let useRle = rleLen > 0 && rleLen < rowRgb.count
                let dataLen = useRle ? rleLen : rowRgb.count
                let len = 7 + dataLen
                dsndHdr[2] = UInt8(len & 0xFF)
                dsndHdr[3] = UInt8((len >> 8) & 0xFF)
                dsndHdr[4] = UInt8((len >> 16) & 0xFF)
                dsndHdr[5] = UInt8((len >> 24) & 0xFF)
                dsndHdr[12] = UInt8((y >> 8) & 0xFF)
                dsndHdr[13] = UInt8(y & 0xFF)
                dsndHdr[14] = useRle ? 1 : 0
                dsndHdr[15] = UInt8((dataLen >> 8) & 0xFF)
                dsndHdr[16] = UInt8(dataLen & 0xFF)
                try emit(dsndHdr, 17)
                if useRle {
                    try emit(rleBuf, dataLen)
                } else {
                    try emit(rowRgb, dataLen)
                }
            }

            var y0 = 0
            while y0 < areaH {
                let sh = min(stripH, areaH - y0)
                let ovTop = max(0, t - y0)
                let ovBot = min(sh, bEdge - y0)
                if ovTop < ovBot {
                    drawSheetSlice(sheetTopYInStrip: t - y0, ovTop: ovTop, ovBot: ovBot)
                }
                for ry in 0..<sh {
                    let y = y0 + ry
                    if y < t, let top = topEdgeRgba {
                        try emitRow(y, top)
                    } else if y >= bEdge, hasBottomEdge {
                        try emitRow(y, bottomEdgeRgba)
                    } else {
                        let rowPtr = pxPtr.advanced(by: ry * bytesPerRow)
                        rowRgba.withUnsafeMutableBytes { dst in
                            dst.baseAddress?.copyMemory(from: UnsafeRawPointer(rowPtr), byteCount: bytesPerRow)
                        }
                        fillHorizBleed(&rowRgba)
                        if hasBottomEdge && y == bEdge - 1 {
                            bottomEdgeRgba = rowRgba
                        }
                        try emitRow(y, rowRgba)
                    }
                }
                y0 += sh
            }
        }

        // ── page end, job end ──
        var trl: [UInt8] = []
        trl.reserveCapacity(64)
        trl.append(contentsOf: [0x1B, 0x70, 0x01, 0x00, 0x00, 0x00])
        trl.append(contentsOf: ascii("endp"))
        trl.append(0x00)
        trl.append(contentsOf: [0x1B, 0x6A, 0x00, 0x00, 0x00, 0x00])
        trl.append(contentsOf: ascii("endj"))
        trl.append(contentsOf: [0x1B, 0x40])
        trl.append(contentsOf: [0x1B, 0x28, 0x52, 0x08, 0x00, 0x00])
        trl.append(contentsOf: ascii("REMOTE1"))
        trl.append(contentsOf: [0x4A, 0x45, 0x01, 0x00, 0x00])
        trl.append(contentsOf: [0x1B, 0x00, 0x00, 0x00])
        try emit(trl)
        try flushChunk()
        return totalBytes
    }

    /// Zero-allocation PackBits over whole pixels (bpp bytes each); returns -1 if RLE is not smaller.
    private static func packBitsInto(_ row: [UInt8], bpp: Int, dst: inout [UInt8]) -> Int {
        let n = row.count / bpp
        let limit = row.count
        var pos = 0
        func same(_ a: Int, _ b: Int) -> Bool {
            let ia = a * bpp
            let ib = b * bpp
            for k in 0..<bpp {
                if row[ia + k] != row[ib + k] { return false }
            }
            return true
        }
        var i = 0
        while i < n {
            var run = 1
            while i + run < n && run < 128 && same(i, i + run) { run += 1 }
            if run >= 2 {
                if pos + 1 + bpp >= limit { return -1 }
                dst[pos] = UInt8((257 - run) & 0xFF)
                pos += 1
                let srcOff = i * bpp
                for k in 0..<bpp { dst[pos + k] = row[srcOff + k] }
                pos += bpp
                i += run
            } else {
                var lit = 1
                while i + lit < n && lit < 127 && !(i + lit + 1 < n && same(i + lit, i + lit + 1)) {
                    lit += 1
                }
                let litBytes = lit * bpp
                if pos + 1 + litBytes >= limit { return -1 }
                dst[pos] = UInt8(lit - 1)
                pos += 1
                let srcOff = i * bpp
                dst.replaceSubrange(pos..<(pos + litBytes), with: row[srcOff..<(srcOff + litBytes)])
                pos += litBytes
                i += lit
            }
        }
        return pos
    }
}

// MARK: - Synchronous TCP / UDP Helpers (Network.framework)

private final class SyncTcpConn {
    enum ConnError: LocalizedError {
        case connect(String)
        case io(String)
        case timedOut(String)
        var errorDescription: String? {
            switch self {
            case .connect(let m), .io(let m), .timedOut(let m): return m
            }
        }
    }

    private let conn: NWConnection
    private let q: DispatchQueue
    private let lock = NSLock()
    private var readBuf = Data()
    private var eof = false
    private var streamErr: String?
    private var closed = false

    private init(conn: NWConnection, q: DispatchQueue) {
        self.conn = conn
        self.q = q
    }

    static func connect(host: String, port: UInt16, timeout: TimeInterval) throws -> SyncTcpConn {
        guard let nwPort = NWEndpoint.Port(rawValue: port), !host.isEmpty else {
            throw ConnError.connect("Invalid printer address.")
        }
        let params = NWParameters.tcp
        params.prohibitedInterfaceTypes = [.cellular]
        let conn = NWConnection(host: NWEndpoint.Host(host), port: nwPort, using: params)
        let q = DispatchQueue(label: "com.photobooth4u.tcp.\(host).\(port)")
        let client = SyncTcpConn(conn: conn, q: q)

        let sema = DispatchSemaphore(value: 0)
        let stateLock = NSLock()
        var done = false
        var errMsg: String?

        let timer = DispatchWorkItem {
            stateLock.lock()
            let was = done
            done = true
            if !was { errMsg = "Connection timed out." }
            stateLock.unlock()
            if !was {
                conn.cancel()
                sema.signal()
            }
        }
        q.asyncAfter(deadline: .now() + timeout, execute: timer)

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                timer.cancel()
                stateLock.lock()
                let was = done
                done = true
                stateLock.unlock()
                if !was { sema.signal() }
            case .waiting(let nwErr):
                if case .posix(let code) = nwErr,
                   code == .ECONNREFUSED || code == .EHOSTUNREACH || code == .ENETUNREACH || code == .EADDRNOTAVAIL {
                    timer.cancel()
                    stateLock.lock()
                    let was = done
                    done = true
                    if !was { errMsg = nwErr.localizedDescription }
                    stateLock.unlock()
                    if !was {
                        conn.cancel()
                        sema.signal()
                    }
                }
            case .failed(let nwErr):
                timer.cancel()
                stateLock.lock()
                let was = done
                done = true
                if !was { errMsg = nwErr.localizedDescription }
                stateLock.unlock()
                if !was {
                    conn.cancel()
                    sema.signal()
                }
            case .cancelled:
                timer.cancel()
                stateLock.lock()
                let was = done
                done = true
                if !was { errMsg = "Connection cancelled." }
                stateLock.unlock()
                if !was { sema.signal() }
            default:
                break
            }
        }

        conn.start(queue: q)
        sema.wait()
        if let m = errMsg {
            throw ConnError.connect(m)
        }
        return client
    }

    func send(_ data: Data, timeout: TimeInterval = 30.0) throws {
        if data.isEmpty { return }
        let sema = DispatchSemaphore(value: 0)
        let sl = NSLock()
        var done = false
        var errMsg: String?
        let timer = DispatchWorkItem {
            sl.lock()
            let was = done
            done = true
            if !was { errMsg = "Timed out sending print data." }
            sl.unlock()
            if !was { sema.signal() }
        }
        q.asyncAfter(deadline: .now() + timeout, execute: timer)
        conn.send(content: data, completion: .contentProcessed { err in
            timer.cancel()
            sl.lock()
            let was = done
            done = true
            if !was, let e = err { errMsg = e.localizedDescription }
            sl.unlock()
            if !was { sema.signal() }
        })
        sema.wait()
        if let m = errMsg {
            throw ConnError.io(m)
        }
    }

    func sendBytes(_ bytes: [UInt8], count: Int? = nil, timeout: TimeInterval = 30.0) throws {
        let n = count ?? bytes.count
        if n <= 0 { return }
        try send(Data(bytes.prefix(n)), timeout: timeout)
    }

    func finishOutput(timeout: TimeInterval = 10.0) {
        let sema = DispatchSemaphore(value: 0)
        let sl = NSLock()
        var done = false
        let timer = DispatchWorkItem {
            sl.lock(); let was = done; done = true; sl.unlock()
            if !was { sema.signal() }
        }
        q.asyncAfter(deadline: .now() + timeout, execute: timer)
        conn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
            timer.cancel()
            sl.lock(); let was = done; done = true; sl.unlock()
            if !was { sema.signal() }
        })
        sema.wait()
    }

    private func fillBuffer(timeout: TimeInterval) throws {
        lock.lock()
        if !readBuf.isEmpty || eof || streamErr != nil {
            let err = streamErr
            lock.unlock()
            if let err = err { throw ConnError.io(err) }
            return
        }
        lock.unlock()

        let sema = DispatchSemaphore(value: 0)
        let sl = NSLock()
        var done = false
        var timedOut = false
        let timer = DispatchWorkItem {
            sl.lock()
            let was = done
            done = true
            if !was { timedOut = true }
            sl.unlock()
            if !was { sema.signal() }
        }
        q.asyncAfter(deadline: .now() + timeout, execute: timer)

        conn.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, isComplete, error in
            timer.cancel()
            if let self = self {
                self.lock.lock()
                if let d = data, !d.isEmpty { self.readBuf.append(d) }
                if isComplete { self.eof = true }
                if let e = error { self.streamErr = e.localizedDescription }
                self.lock.unlock()
            }
            sl.lock()
            let was = done
            done = true
            sl.unlock()
            if !was { sema.signal() }
        }
        sema.wait()
        if timedOut {
            throw ConnError.timedOut("Timed out waiting for printer reply.")
        }
        lock.lock()
        let err = streamErr
        let emptyEof = readBuf.isEmpty && eof
        lock.unlock()
        if let err = err, !emptyEof {
            throw ConnError.io(err)
        }
    }

    /// Returns 0...255 or -1 on EOF.
    func readByte(timeout: TimeInterval) throws -> Int {
        lock.lock()
        if !readBuf.isEmpty {
            let b = readBuf.removeFirst()
            lock.unlock()
            return Int(b)
        }
        if eof {
            lock.unlock()
            return -1
        }
        lock.unlock()

        try fillBuffer(timeout: timeout)
        lock.lock()
        defer { lock.unlock() }
        if !readBuf.isEmpty {
            return Int(readBuf.removeFirst())
        }
        return -1
    }

    func readAll(maxBytes: Int, timeoutPerRead: TimeInterval) -> Data {
        var out = Data()
        while out.count < maxBytes {
            lock.lock()
            if !readBuf.isEmpty {
                let take = min(maxBytes - out.count, readBuf.count)
                out.append(readBuf.prefix(take))
                readBuf.removeFirst(take)
                lock.unlock()
                continue
            }
            if eof || streamErr != nil {
                lock.unlock()
                break
            }
            lock.unlock()
            do {
                try fillBuffer(timeout: timeoutPerRead)
            } catch {
                break
            }
            lock.lock()
            let stuck = readBuf.isEmpty && (eof || streamErr != nil)
            lock.unlock()
            if stuck { break }
        }
        return out
    }

    func drainQuietly(idleTimeout: TimeInterval, maxTotal: TimeInterval) {
        let until = Date().addingTimeInterval(maxTotal)
        while Date() < until {
            do {
                let b = try readByte(timeout: idleTimeout)
                if b < 0 { break }
            } catch {
                break
            }
        }
    }

    func close() {
        lock.lock()
        let already = closed
        closed = true
        lock.unlock()
        if !already { conn.cancel() }
    }
}

// MARK: - Port Probe, SNMPv1 (:161) & HTTP (:80) Model Lookup

enum PrinterProbe {
    struct PortResult {
        var ippPort: Int = 0
        var rawPort: Int = 0
        var lpdPort: Int = 0
        var anyOpen: Bool { ippPort > 0 || rawPort > 0 || lpdPort > 0 }
    }

    private static let epsonLRegex = try! NSRegularExpression(
        pattern: #"\b(L\s?(2\d\d|3\d\d|5\d\d|8\d\d|[1-8]\d{3}|18050)|ET-?18100)\b"#,
        options: [.caseInsensitive]
    )
    private static let l8050Regex = try! NSRegularExpression(
        pattern: #"(?:^|[^A-Za-z0-9])L8050(?![0-9])"#,
        options: [.caseInsensitive]
    )

    static func isL8050Name(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return l8050Regex.firstMatch(in: s, options: [], range: range) != nil
    }

    static func isEpsonLSeries(_ s: String) -> Bool {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return epsonLRegex.firstMatch(in: s, options: [], range: range) != nil
    }

    static func isPortOpen(ip: String, port: UInt16, timeout: TimeInterval = 1.5) -> Bool {
        guard let c = try? SyncTcpConn.connect(host: ip, port: port, timeout: timeout) else {
            return false
        }
        c.close()
        return true
    }

    static func probePorts(ip: String, timeout: TimeInterval = 1.8) -> PortResult {
        func sweep() -> PortResult {
            var res = PortResult()
            let lock = NSLock()
            let grp = DispatchGroup()
            for port in [631, 9100, 515] {
                grp.enter()
                DispatchQueue.global(qos: .utility).async {
                    let ok = isPortOpen(ip: ip, port: UInt16(port), timeout: timeout)
                    if ok {
                        lock.lock()
                        if port == 631 { res.ippPort = 631 }
                        if port == 9100 { res.rawPort = 9100 }
                        if port == 515 { res.lpdPort = 515 }
                        lock.unlock()
                    }
                    grp.leave()
                }
            }
            grp.wait()
            return res
        }
        var res = sweep()
        if !res.anyOpen {
            // Sleeping Wi-Fi / Wi-Fi Direct printers often wake on the first knock and answer on the second.
            Thread.sleep(forTimeInterval: 0.6)
            res = sweep()
        }
        return res
    }

    private static func cleanModelName(_ s: String) -> String {
        let stripped = s.replacingOccurrences(of: #"[\r\n\t\x00-\x1F]+"#, with: " ", options: .regularExpression)
            .replacingOccurrences(of: #"\s{2,}"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return String(stripped.prefix(64))
    }

    // MARK: SNMPv1 UDP :161

    private static func snmpTlv(_ tag: UInt8, _ body: [UInt8]) -> [UInt8] {
        var out: [UInt8] = [tag]
        let n = body.count
        if n < 0x80 {
            out.append(UInt8(n))
        } else if n < 0x100 {
            out.append(0x81)
            out.append(UInt8(n))
        } else {
            out.append(0x82)
            out.append(UInt8((n >> 8) & 0xFF))
            out.append(UInt8(n & 0xFF))
        }
        out.append(contentsOf: body)
        return out
    }

    private static func snmpEncodeOid(_ arcs: [Int]) -> [UInt8] {
        var out: [UInt8] = [UInt8(arcs[0] * 40 + arcs[1])]
        for i in 2..<arcs.count {
            var v = arcs[i]
            if v < 0x80 {
                out.append(UInt8(v))
            } else {
                var tmp: [UInt8] = [UInt8(v & 0x7F)]
                v >>= 7
                while v > 0 {
                    tmp.append(UInt8((v & 0x7F) | 0x80))
                    v >>= 7
                }
                out.append(contentsOf: tmp.reversed())
            }
        }
        return snmpTlv(0x06, out)
    }

    private static func snmpBuildGet(oid: [Int], reqId: Int) -> Data {
        let vb = snmpTlv(0x30, snmpEncodeOid(oid) + [0x05, 0x00])
        let vbl = snmpTlv(0x30, vb)
        let pduBody: [UInt8] = [
            0x02, 0x01, UInt8(reqId & 0x7F),
            0x02, 0x01, 0x00,
            0x02, 0x01, 0x00
        ] + vbl
        let pdu = snmpTlv(0xA0, pduBody)
        let msgBody: [UInt8] = [
            0x02, 0x01, 0x00,
            0x04, 0x06, 0x70, 0x75, 0x62, 0x6C, 0x69, 0x63 // "public"
        ] + pdu
        return Data(snmpTlv(0x30, msgBody))
    }

    private static func snmpParseOctetString(_ data: Data) -> String {
        let buf = [UInt8](data)
        let len = buf.count
        func readLen(_ pos: Int) -> (Int, Int)? {
            if pos >= len { return nil }
            let b = Int(buf[pos])
            if b < 0x80 { return (b, pos + 1) }
            let cnt = b & 0x7F
            if cnt == 0 || cnt > 2 || pos + 1 + cnt > len { return nil }
            var v = 0
            for i in 0..<cnt { v = (v << 8) | Int(buf[pos + 1 + i]) }
            return (v, pos + 1 + cnt)
        }
        guard len >= 12, buf[0] == 0x30, let top = readLen(1) else { return "" }
        var p = top.1
        let topEnd = min(len, p + top.0)
        while p < topEnd {
            let tag = buf[p]
            guard let lv = readLen(p + 1) else { return "" }
            let vStart = lv.1
            let vEnd = min(topEnd, vStart + lv.0)
            if tag == 0xA2 {
                var q = vStart
                var intsSeen = 0
                while q < vEnd {
                    let t2 = buf[q]
                    guard let lv2 = readLen(q + 1) else { return "" }
                    let s2 = lv2.1
                    let e2 = min(vEnd, s2 + lv2.0)
                    if t2 == 0x02 {
                        intsSeen += 1
                        if intsSeen == 2 && (lv2.0 != 1 || s2 >= e2 || buf[s2] != 0) { return "" }
                    } else if t2 == 0x30 {
                        if s2 < e2 && buf[s2] == 0x30, let lv3 = readLen(s2 + 1) {
                            var r = lv3.1
                            let e3 = min(e2, r + lv3.0)
                            while r < e3 {
                                let t4 = buf[r]
                                guard let lv4 = readLen(r + 1) else { return "" }
                                let s4 = lv4.1
                                let e4 = min(e3, s4 + lv4.0)
                                if t4 == 0x04 && e4 > s4 {
                                    return String(decoding: buf[s4..<e4], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
                                }
                                r = e4
                            }
                        }
                    }
                    q = e2
                }
                return ""
            }
            p = vEnd
        }
        return ""
    }

    private static func udpRoundTrip(ip: String, port: UInt16, payload: Data, timeout: TimeInterval) -> Data? {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return nil }
        let params = NWParameters.udp
        params.prohibitedInterfaceTypes = [.cellular]
        let conn = NWConnection(host: NWEndpoint.Host(ip), port: nwPort, using: params)
        let q = DispatchQueue(label: "com.photobooth4u.snmp.\(ip)")
        let sema = DispatchSemaphore(value: 0)
        let sl = NSLock()
        var done = false
        var reply: Data?

        let timer = DispatchWorkItem {
            sl.lock(); let was = done; done = true; sl.unlock()
            if !was { sema.signal() }
        }
        q.asyncAfter(deadline: .now() + timeout, execute: timer)

        conn.stateUpdateHandler = { state in
            switch state {
            case .ready:
                conn.send(content: payload, completion: .contentProcessed { sendErr in
                    if sendErr != nil {
                        timer.cancel()
                        sl.lock(); let was = done; done = true; sl.unlock()
                        if !was { sema.signal() }
                        return
                    }
                    conn.receiveMessage { data, _, _, _ in
                        timer.cancel()
                        sl.lock()
                        let was = done
                        done = true
                        if !was { reply = data }
                        sl.unlock()
                        if !was { sema.signal() }
                    }
                })
            case .waiting(let err):
                if case .posix(let code) = err,
                   code == .ECONNREFUSED || code == .EHOSTUNREACH || code == .ENETUNREACH {
                    timer.cancel()
                    sl.lock(); let was = done; done = true; sl.unlock()
                    if !was { sema.signal() }
                }
            case .failed, .cancelled:
                timer.cancel()
                sl.lock(); let was = done; done = true; sl.unlock()
                if !was { sema.signal() }
            default:
                break
            }
        }
        conn.start(queue: q)
        sema.wait()
        conn.cancel()
        return reply
    }

    static func snmpQueryModel(ip: String) -> (model: String, vendorHint: String) {
        let oids: [[Int]] = [
            [1, 3, 6, 1, 2, 1, 25, 3, 2, 1, 3, 1],              // hrDeviceDescr.1 -> "EPSON L8050 Series"
            [1, 3, 6, 1, 4, 1, 1248, 1, 2, 2, 1, 1, 1, 2, 1],   // Epson IEEE-1284 Device ID
            [1, 3, 6, 1, 2, 1, 1, 1, 0]                         // sysDescr.0
        ]
        var vendorHint = ""
        var genericModel = ""
        for (idx, oid) in oids.enumerated() {
            let req = snmpBuildGet(oid: oid, reqId: idx + 1)
            guard let pkt = udpRoundTrip(ip: ip, port: 161, payload: req, timeout: 0.5) else {
                if idx == 0 { break }
                continue
            }
            let txt = snmpParseOctetString(pkt)
            if txt.isEmpty { continue }
            if txt.range(of: "epson", options: .caseInsensitive) != nil && vendorHint.isEmpty {
                vendorHint = "EPSON"
            }
            if idx == 0 {
                let cleaned = cleanModelName(txt)
                if !cleaned.isEmpty {
                    if cleaned.range(of: #"\d{3,}"#, options: .regularExpression) != nil {
                        let vh = cleaned.range(of: "epson", options: .caseInsensitive) != nil ? "EPSON" : vendorHint
                        return (cleaned, vh)
                    }
                    genericModel = cleaned
                }
            }
            if idx == 1 {
                let des = firstRegexGroup(txt, #"(?i)(?:DES|DESCRIPTION):([^;]+)"#)
                let mdl = firstRegexGroup(txt, #"(?i)(?:MDL|MODEL):([^;]+)"#)
                let mfg = firstRegexGroup(txt, #"(?i)(?:MFG|MANUFACTURER):([^;]+)"#)
                var picked = ""
                if !des.isEmpty {
                    picked = des
                } else if !mdl.isEmpty {
                    picked = (!mfg.isEmpty && !mdl.lowercased().hasPrefix(mfg.lowercased())) ? "\(mfg) \(mdl)" : mdl
                }
                if !picked.isEmpty {
                    let c = cleanModelName(picked)
                    let vh = c.range(of: "epson", options: .caseInsensitive) != nil ? "EPSON" : vendorHint
                    return (c, vh)
                }
            }
            if idx == 2 && isEpsonLSeries(txt) {
                return (cleanModelName(txt), "EPSON")
            }
        }
        return (genericModel, vendorHint)
    }

    // MARK: HTTP :80 Web Config

    private static func httpGetSimple(ip: String, path: String) -> String {
        guard let conn = try? SyncTcpConn.connect(host: ip, port: 80, timeout: 1.2) else { return "" }
        defer { conn.close() }
        let req = "GET \(path) HTTP/1.1\r\nHost: \(ip)\r\nUser-Agent: photobooth4u\r\nConnection: close\r\n\r\n"
        do {
            try conn.send(Data(req.utf8), timeout: 1.5)
        } catch {
            return ""
        }
        let d = conn.readAll(maxBytes: 32768, timeoutPerRead: 1.5)
        return String(data: d, encoding: .isoLatin1) ?? ""
    }

    static func httpProbeModel(ip: String) -> (model: String, vendorHint: String) {
        var paths = ["/PRESENTATION/HTML/TOP/INDEX.HTML", "/"]
        var visited = Set<String>()
        var vendorHint = ""
        var idx = 0
        let epsonRx = #"(?i)EPSON\s+(?:L\s?\d{3,5}|ET-?\d{3,5}|M\d{3,4}|XP-?\d{3,4}|WF-[A-Z0-9-]+|SC-[A-Z0-9-]+)(?:\s+Series)?"#
        let bareRx = #"(?i)\b(?:L\s?\d{3,5}|ET-?\d{3,5})(?:\s+Series)?\b"#

        while idx < paths.count && visited.count < 3 {
            let path = paths[idx]
            idx += 1
            if !visited.insert(path).inserted { continue }
            let raw = httpGetSimple(ip: ip, path: path)
            if raw.isEmpty { continue }
            let hdrEnd = raw.range(of: "\r\n\r\n")?.lowerBound ?? raw.range(of: "\n\n")?.lowerBound
            let hdrs = hdrEnd.map { String(raw[..<$0]) } ?? String(raw.prefix(1024))
            let body = hdrEnd.map { String(raw[$0...]) } ?? raw
            if hdrs.range(of: "EPSON", options: .caseInsensitive) != nil ||
                hdrs.range(of: "/PRESENTATION/HTML/", options: .caseInsensitive) != nil ||
                body.range(of: "EPSON", options: .caseInsensitive) != nil {
                vendorHint = "EPSON"
            }
            let title = cleanModelName(firstRegexGroup(body, #"(?is)<title[^>]*>\s*([^<]{2,80})\s*</title>"#))
            if !title.isEmpty &&
                title.caseInsensitiveCompare("Web Config") != .orderedSame &&
                !title.hasPrefix("301") && !title.hasPrefix("302") && !title.hasPrefix("404") &&
                title.range(of: "Moved", options: .caseInsensitive) == nil {
                if let eHit = firstRegexMatch(title, epsonRx) {
                    return (cleanModelName(eHit), "EPSON")
                }
                if vendorHint == "EPSON", let bHit = firstRegexMatch(title, bareRx) {
                    let m = cleanModelName(bHit)
                    return (m.lowercased().hasPrefix("epson") ? m : "EPSON \(m)", "EPSON")
                }
            }
            if let bodyHit = firstRegexMatch(body, epsonRx) {
                return (cleanModelName(bodyHit), "EPSON")
            }
            let loc = firstRegexGroup(hdrs, #"(?im)^Location:\s*(\S+)"#)
            if loc.hasPrefix("/") && !visited.contains(loc) {
                paths.append(loc)
            } else if loc.lowercased().hasPrefix("http://\(ip.lowercased())/") {
                let rel = String(loc.dropFirst("http://\(ip)".count))
                if rel.hasPrefix("/") && !visited.contains(rel) { paths.append(rel) }
            }
        }
        return ("", vendorHint)
    }

    static func fetchWebModel(ip: String) -> (model: String, vendorHint: String) {
        let snmp = snmpQueryModel(ip: ip)
        if !snmp.model.isEmpty {
            return (snmp.model, snmp.vendorHint.isEmpty ? snmp.model : snmp.vendorHint)
        }
        let web = httpProbeModel(ip: ip)
        if !web.model.isEmpty {
            return (web.model, web.vendorHint.isEmpty ? web.model : web.vendorHint)
        }
        return ("", web.vendorHint.isEmpty ? snmp.vendorHint : web.vendorHint)
    }

    private static func firstRegexMatch(_ text: String, _ pattern: String) -> String? {
        guard let rx = try? NSRegularExpression(pattern: pattern, options: []) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let m = rx.firstMatch(in: text, options: [], range: range),
              let r = Range(m.range, in: text) else { return nil }
        return String(text[r])
    }

    private static func firstRegexGroup(_ text: String, _ pattern: String) -> String {
        guard let rx = try? NSRegularExpression(pattern: pattern, options: []) else { return "" }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let m = rx.firstMatch(in: text, options: [], range: range), m.numberOfRanges >= 2,
              let r = Range(m.range(at: 1), in: text) else { return "" }
        return String(text[r]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - ESC/P-R LPD (:515) & Raw (:9100) Transport

enum EscprNet {
    enum Failure: LocalizedError {
        case message(String, unreached: Bool)
        var errorDescription: String? {
            if case .message(let m, _) = self { return m }
            return nil
        }
        var unreached: Bool {
            if case .message(_, let u) = self { return u }
            return false
        }
    }

    private static let lpdLock = NSLock()
    private static var lpdSeq = 0

    static func l8050EscprConfig(opts: [String: Any], borderless: Bool, widthMm: Double, heightMm: Double) -> EscprJob.Config {
        let color = (opts["color"] as? String) ?? "color"
        let mono = (color == "mono")
        let mediaStr = ((opts["media"] as? String) ?? "").lowercased()
        let mediaCode: Int
        switch mediaStr {
        case "plain": mediaCode = EscprJob.mediaPlain
        case "matte": mediaCode = EscprJob.mediaMatte
        case "photosg": mediaCode = EscprJob.mediaSemiGloss
        case "photopg": mediaCode = EscprJob.mediaPremiumGlossy
        default: mediaCode = EscprJob.mediaEpsonGlossy
        }
        let qStr = ((opts["quality"] as? String) ?? "").lowercased()
        let is4x6 = abs(min(widthMm, heightMm) - 101.6) <= 1.5 && abs(max(widthMm, heightMm) - 152.4) <= 1.5
        let useDpi = (qStr == "high720" && is4x6) ? 720 : 360
        let qualityCode: Int
        switch qStr {
        case "draft": qualityCode = 0
        case "normal": qualityCode = 1
        default: qualityCode = 2
        }
        return EscprJob.Config(
            dpi: useDpi,
            mediaCode: mediaCode,
            qualityCode: qualityCode,
            borderless: borderless,
            l8050Geo: true,
            sendSetiChku: true,
            mono: mono,
            brightness: (opts["brightness"] as? NSNumber)?.intValue ?? 0,
            red: (opts["red"] as? NSNumber)?.intValue ?? 0,
            green: (opts["green"] as? NSNumber)?.intValue ?? 0,
            blue: (opts["blue"] as? NSNumber)?.intValue ?? 0,
            sendSetm: false
        )
    }

    static func genericEscprConfig(opts: [String: Any], borderless: Bool) -> EscprJob.Config {
        let color = (opts["color"] as? String) ?? "color"
        let qStr = ((opts["quality"] as? String) ?? "").lowercased()
        return EscprJob.Config(
            dpi: 360,
            mediaCode: borderless ? EscprJob.mediaPremiumGlossy : EscprJob.mediaPlain,
            qualityCode: qStr == "draft" ? 0 : 1,
            borderless: borderless,
            l8050Geo: false,
            sendSetiChku: borderless,
            mono: color == "mono",
            brightness: (opts["brightness"] as? NSNumber)?.intValue ?? 0,
            red: (opts["red"] as? NSNumber)?.intValue ?? 0,
            green: (opts["green"] as? NSNumber)?.intValue ?? 0,
            blue: (opts["blue"] as? NSNumber)?.intValue ?? 0,
            sendSetm: false
        )
    }

    /// Streams one ESC/P-R job directly over TCP port 9100 without holding the whole page in RAM.
    static func netRawStream(ip: String, port: UInt16 = 9100, jpegData: Data, widthMm: Double, heightMm: Double, cfg: EscprJob.Config) throws {
        let conn: SyncTcpConn
        do {
            conn = try SyncTcpConn.connect(host: ip, port: port, timeout: 6.0)
        } catch {
            throw Failure.message("Could not reach printer at \(ip) on port \(port): \(error.localizedDescription)", unreached: true)
        }
        defer { conn.close() }
        do {
            _ = try EscprJob.streamWithConfig(jpegData: jpegData, widthMm: widthMm, heightMm: heightMm, cfg: cfg) { buf, len in
                try conn.sendBytes(buf, count: len, timeout: 30.0)
            }
            conn.finishOutput(timeout: 10.0)
        } catch {
            throw Failure.message("Printer at \(ip) stopped answering while receiving photo (\(error.localizedDescription)).", unreached: false)
        }
        conn.drainQuietly(idleTimeout: 3.0, maxTotal: 20.0)
    }

    /// Spools ESC/P-R chunks into a temp file (to obtain exact RFC 1179 byte count) and streams over LPD port 515.
    @discardableResult
    static func netLpdStream(
        ip: String,
        port: UInt16 = 515,
        queueOverride: String = "",
        jpegData: Data,
        widthMm: Double,
        heightMm: Double,
        cfg: EscprJob.Config
    ) throws -> String {
        let tmpDir = FileManager.default.temporaryDirectory
        // Sweep orphaned LPD spools older than 10 minutes.
        if let items = try? FileManager.default.contentsOfDirectory(at: tmpDir, includingPropertiesForKeys: [.contentModificationDateKey], options: []) {
            let cutoff = Date().addingTimeInterval(-600)
            for u in items where u.lastPathComponent.hasPrefix("pb_lpd_") && u.pathExtension == "prn" {
                let mtime = (try? u.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? Date()
                if mtime < cutoff { try? FileManager.default.removeItem(at: u) }
            }
        }

        let tmpUrl = tmpDir.appendingPathComponent("pb_lpd_\(UUID().uuidString).prn")
        FileManager.default.createFile(atPath: tmpUrl.path, contents: nil, attributes: nil)
        defer { try? FileManager.default.removeItem(at: tmpUrl) }

        let fh = try FileHandle(forWritingTo: tmpUrl)
        let totalBytes: Int64
        do {
            totalBytes = try EscprJob.streamWithConfig(jpegData: jpegData, widthMm: widthMm, heightMm: heightMm, cfg: cfg) { buf, len in
                if len > 0 {
                    try autoreleasepool {
                        try fh.write(contentsOf: Data(buf.prefix(len)))
                    }
                }
            }
            try fh.synchronize()
            try fh.close()
        } catch {
            try? fh.close()
            throw error
        }
        guard totalBytes > 0 else {
            throw Failure.message("Empty print job (0 bytes).", unreached: true)
        }
        return try sendLpdFile(ip: ip, port: port, queueOverride: queueOverride, fileUrl: tmpUrl, dataLen: totalBytes)
    }

    private static func sendLpdFile(
        ip: String,
        port: UInt16,
        queueOverride: String,
        fileUrl: URL,
        dataLen: Int64
    ) throws -> String {
        var queues: [String] = []
        func addQ(_ q: String) {
            let t = q.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty && !queues.contains(t) { queues.append(t) }
        }
        addQ(queueOverride)
        addQ("PASSTHRU")
        addQ("LPT1")
        addQ("AUTO")
        addQ("lp")
        addQ("raw")

        var tried: [String] = []
        var lastQueueErr = ""

        for attempt in 0...1 {
            if attempt > 0 {
                Thread.sleep(forTimeInterval: 1.5)
            }
            for queue in queues {
                if !tried.contains(queue) { tried.append(queue) }
                var stage = 0 // 0=connect, 1=queue-ack, 2=sending-job, 3=final-ack
                let conn: SyncTcpConn
                do {
                    conn = try SyncTcpConn.connect(host: ip, port: port, timeout: 6.0)
                } catch {
                    throw Failure.message("Could not reach printer at \(ip) on LPD port \(port): \(error.localizedDescription)", unreached: true)
                }
                defer { conn.close() }

                do {
                    stage = 1
                    var qCmd = Data([0x02])
                    qCmd.append(contentsOf: queue.utf8)
                    qCmd.append(0x0A)
                    try conn.send(qCmd, timeout: 15.0)
                    let qAck = try conn.readByte(timeout: 15.0)
                    if qAck != 0 {
                        lastQueueErr = "queue=\(queue) ack=\(qAck)"
                        continue
                    }

                    stage = 2
                    lpdLock.lock()
                    lpdSeq = (lpdSeq % 999) + 1
                    let jobNum = lpdSeq
                    lpdLock.unlock()
                    let job3 = String(format: "%03d", jobNum)
                    let host = "pb4u"
                    let cfName = "cfA\(job3)\(host)"
                    let dfName = "dfA\(job3)\(host)"
                    // RFC 1179 §7: lowercase 'l' = binary passthrough (leave ESC/P-R bytes untouched).
                    let cfBytes = Data("H\(host)\nPphotobooth\nJ\(host)\nl\(dfName)\nU\(dfName)\nNpb4u.prn\n".utf8)

                    var cfHdr = Data([0x02])
                    cfHdr.append(contentsOf: "\(cfBytes.count) \(cfName)\n".utf8)
                    try conn.send(cfHdr, timeout: 15.0)
                    let cfHdrAck = try conn.readByte(timeout: 15.0)
                    if cfHdrAck != 0 {
                        throw Failure.message("LPD control-file header rejected (ack=\(cfHdrAck)).", unreached: false)
                    }

                    var cfBody = Data(cfBytes)
                    cfBody.append(0x00)
                    try conn.send(cfBody, timeout: 15.0)
                    let cfAck = try conn.readByte(timeout: 15.0)
                    if cfAck != 0 {
                        throw Failure.message("LPD control-file body rejected (ack=\(cfAck)).", unreached: false)
                    }

                    var dfHdr = Data([0x03])
                    dfHdr.append(contentsOf: "\(dataLen) \(dfName)\n".utf8)
                    try conn.send(dfHdr, timeout: 30.0)
                    let dfHdrAck = try conn.readByte(timeout: 30.0)
                    if dfHdrAck != 0 {
                        throw Failure.message("LPD data-file header rejected for \(dataLen) bytes (ack=\(dfHdrAck)).", unreached: false)
                    }

                    let rf = try FileHandle(forReadingFrom: fileUrl)
                    defer { try? rf.close() }
                    while true {
                        let done: Bool = try autoreleasepool {
                            let slice = try rf.read(upToCount: 65536) ?? Data()
                            if slice.isEmpty { return true }
                            try conn.send(slice, timeout: 30.0)
                            return false
                        }
                        if done { break }
                    }
                    try conn.send(Data([0x00]), timeout: 30.0)

                    stage = 3
                    // Epson may finish feeding/printing before sending the final 0x00 ACK (up to ~45s at 720 dpi).
                    let dfAck = try conn.readByte(timeout: 90.0)
                    if dfAck > 0 {
                        throw Failure.message("Printer at \(ip) rejected LPD print data on queue \(queue) (code \(dfAck)).", unreached: false)
                    }
                    return queue
                } catch let f as Failure {
                    if stage == 1 {
                        lastQueueErr = "queue=\(queue) (\(f.localizedDescription))"
                        continue
                    }
                    throw f
                } catch let ce as SyncTcpConn.ConnError {
                    if stage == 1 {
                        lastQueueErr = "queue=\(queue) (\(ce.localizedDescription))"
                        continue
                    }
                    if stage == 3, case .timedOut = ce {
                        throw Failure.message("Printer at \(ip) took too long to answer after receiving LPD photo.", unreached: false)
                    }
                    throw Failure.message("Printer at \(ip) stopped answering while receiving LPD photo (\(ce.localizedDescription)).", unreached: false)
                } catch {
                    if stage == 1 {
                        lastQueueErr = "queue=\(queue) (\(error.localizedDescription))"
                        continue
                    }
                    throw Failure.message("Printer at \(ip) stopped answering while receiving LPD photo (\(error.localizedDescription)).", unreached: false)
                }
            }
        }
        throw Failure.message("Could not reach LPD print queue on \(ip):\(port) (rejected \(tried.joined(separator: ", ")); \(lastQueueErr)).", unreached: false)
    }
}
