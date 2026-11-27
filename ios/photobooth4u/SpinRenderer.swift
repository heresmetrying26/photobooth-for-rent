import Foundation
import UIKit
import AVFoundation
import CoreImage
import Metal

/// Hardware-accelerated on-device 360 video composer using AVFoundation + CoreImage (Metal).
/// Supports speed modes (original, slow-mo, super slow, speed ramp, boomerang),
/// transparent PNG frame overlays, event title text, color looks, and background music.
final class SpinRenderer {

    enum MotionPreset: String, CaseIterable {
        case slowMo = "slow"
        case superSlow = "super"
        case speedRamp = "ramp"
        case boomerang = "boomerang"
        case original = "original"

        var label: String {
            switch self {
            case .slowMo: return "Slow-Mo (0.5×)"
            case .superSlow: return "Super Slow (0.33×)"
            case .speedRamp: return "Speed Ramp"
            case .boomerang: return "Boomerang"
            case .original: return "Original (1×)"
            }
        }

        var shortLabel: String {
            switch self {
            case .slowMo: return "Slow-Mo"
            case .superSlow: return "Super Slow"
            case .speedRamp: return "Speed Ramp"
            case .boomerang: return "Boomerang"
            case .original: return "Original"
            }
        }
    }

    enum OutputAspect: String, CaseIterable {
        case portrait9x16 = "portrait"
        case square1x1 = "square"
        case landscape16x9 = "landscape"

        var label: String {
            switch self {
            case .portrait9x16: return "9:16 Portrait"
            case .square1x1: return "1:1 Square"
            case .landscape16x9: return "16:9 Landscape"
            }
        }

        var renderSize: CGSize {
            switch self {
            case .portrait9x16: return CGSize(width: 1080, height: 1920)
            case .square1x1: return CGSize(width: 1080, height: 1080)
            case .landscape16x9: return CGSize(width: 1920, height: 1080)
            }
        }
    }

    enum ColorLook: String, CaseIterable {
        case natural = "natural"
        case glamBW = "glam_bw"
        case warmGlow = "warm_glow"
        case vibrant = "vibrant"

        var label: String {
            switch self {
            case .natural: return "Natural"
            case .glamBW: return "Glam B&W"
            case .warmGlow: return "Warm Glow"
            case .vibrant: return "Vibrant Pop"
            }
        }
    }

    struct Options {
        var motion: MotionPreset = .slowMo
        var aspect: OutputAspect = .portrait9x16
        var colorLook: ColorLook = .natural
        var overlayImage: UIImage? = nil
        var titleText: String = ""
        var subtitleText: String = ""
        var musicURL: URL? = nil
        var trimStartSec: Double = 0.25
        var maxSourceSec: Double = 10.0
    }

    private static let sharedCIContext: CIContext = {
        if let dev = MTLCreateSystemDefaultDevice() {
            return CIContext(mtlDevice: dev, options: [.useSoftwareRenderer: false])
        }
        return CIContext(options: nil)
    }()

    /// Renders a recorded 360 clip into an .mp4 file on a background queue.
    static func render(
        sourceURL: URL,
        options: Options,
        progress: ((Float) -> Void)? = nil,
        completion: @escaping (Result<URL, Error>) -> Void
    ) {
        DispatchQueue.global(qos: .userInitiated).async {
            renderSync(sourceURL: sourceURL, options: options, progress: progress, completion: completion)
        }
    }

    private static func renderSync(
        sourceURL: URL,
        options: Options,
        progress: ((Float) -> Void)?,
        completion: @escaping (Result<URL, Error>) -> Void
    ) {
        let baseAsset = AVURLAsset(url: sourceURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let baseVideoTrack = baseAsset.tracks(withMediaType: .video).first else {
            DispatchQueue.main.async {
                completion(.failure(makeError("No video track found in recording.")))
            }
            return
        }

        let totalSec = CMTimeGetSeconds(baseAsset.duration)
        guard totalSec.isFinite && totalSec > 0.2 else {
            DispatchQueue.main.async {
                completion(.failure(makeError("Recording was too short to render.")))
            }
            return
        }

        // Trim minor initial motor start jitter if clip is long enough
        let safeTrim = (totalSec > 2.2) ? min(max(0.0, options.trimStartSec), totalSec * 0.15) : 0.0
        let availSec = max(0.3, totalSec - safeTrim)
        let usedSec = min(availSec, max(1.0, options.maxSourceSec))

        let workingTrack: AVAssetTrack = baseVideoTrack
        let workStartSec = safeTrim
        let workDurSec = usedSec
        var tempReverseURL: URL? = nil

        if options.motion == .boomerang {
            let boomWindow = min(usedSec, 3.2)
            let boomStart = safeTrim + max(0.0, (usedSec - boomWindow) * 0.5)
            let range = CMTimeRange(
                start: CMTime(seconds: boomStart, preferredTimescale: 600),
                duration: CMTime(seconds: boomWindow, preferredTimescale: 600)
            )
            if let revURL = buildReversedClip(asset: baseAsset, videoTrack: baseVideoTrack, timeRange: range) {
                tempReverseURL = revURL
            }
        }

        let composition = AVMutableComposition()
        guard let compVideo = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            cleanup(tempReverseURL)
            DispatchQueue.main.async {
                completion(.failure(makeError("Could not initialize video composition.")))
            }
            return
        }

        let timescale: CMTimeScale = 600
        let startTime = CMTime(seconds: workStartSec, preferredTimescale: timescale)
        let durTime = CMTime(seconds: workDurSec, preferredTimescale: timescale)

        do {
            switch options.motion {
            case .original:
                let r = CMTimeRange(start: startTime, duration: durTime)
                try compVideo.insertTimeRange(r, of: workingTrack, at: .zero)
                if let srcAudio = baseAsset.tracks(withMediaType: .audio).first, options.musicURL == nil,
                   let compAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                    try? compAudio.insertTimeRange(r, of: srcAudio, at: .zero)
                }

            case .slowMo:
                let clampedDur = min(workDurSec, 7.5)
                let srcRange = CMTimeRange(start: startTime, duration: CMTime(seconds: clampedDur, preferredTimescale: timescale))
                try compVideo.insertTimeRange(srcRange, of: workingTrack, at: .zero)
                let inserted = CMTimeRange(start: .zero, duration: srcRange.duration)
                let targetDur = CMTime(seconds: min(16.0, clampedDur * 2.0), preferredTimescale: timescale)
                compVideo.scaleTimeRange(inserted, toDuration: targetDur)

            case .superSlow:
                let clampedDur = min(workDurSec, 5.5)
                let srcRange = CMTimeRange(start: startTime, duration: CMTime(seconds: clampedDur, preferredTimescale: timescale))
                try compVideo.insertTimeRange(srcRange, of: workingTrack, at: .zero)
                let inserted = CMTimeRange(start: .zero, duration: srcRange.duration)
                let targetDur = CMTime(seconds: min(16.5, clampedDur * 3.0), preferredTimescale: timescale)
                compVideo.scaleTimeRange(inserted, toDuration: targetDur)

            case .speedRamp:
                if workDurSec < 2.0 {
                    let r = CMTimeRange(start: startTime, duration: durTime)
                    try compVideo.insertTimeRange(r, of: workingTrack, at: .zero)
                    compVideo.scaleTimeRange(CMTimeRange(start: .zero, duration: durTime), toDuration: CMTime(seconds: workDurSec * 1.8, preferredTimescale: timescale))
                } else {
                    let p1Dur = workDurSec * 0.28
                    let p2Dur = workDurSec * 0.44
                    let p3Dur = max(0.2, workDurSec - p1Dur - p2Dur)

                    let t1 = startTime
                    let t2 = CMTime(seconds: workStartSec + p1Dur, preferredTimescale: timescale)
                    let t3 = CMTime(seconds: workStartSec + p1Dur + p2Dur, preferredTimescale: timescale)

                    // Segment 1: Fast intro (1.6×)
                    let r1 = CMTimeRange(start: t1, duration: CMTime(seconds: p1Dur, preferredTimescale: timescale))
                    try compVideo.insertTimeRange(r1, of: workingTrack, at: .zero)
                    compVideo.scaleTimeRange(CMTimeRange(start: .zero, duration: r1.duration), toDuration: CMTime(seconds: p1Dur / 1.6, preferredTimescale: timescale))

                    // Segment 2: Hero slow-mo middle (0.45×)
                    let cursor2 = composition.duration
                    let r2 = CMTimeRange(start: t2, duration: CMTime(seconds: p2Dur, preferredTimescale: timescale))
                    try compVideo.insertTimeRange(r2, of: workingTrack, at: cursor2)
                    compVideo.scaleTimeRange(CMTimeRange(start: cursor2, duration: r2.duration), toDuration: CMTime(seconds: p2Dur * 2.2, preferredTimescale: timescale))

                    // Segment 3: Fast outro (1.6×)
                    let cursor3 = composition.duration
                    let r3 = CMTimeRange(start: t3, duration: CMTime(seconds: p3Dur, preferredTimescale: timescale))
                    try compVideo.insertTimeRange(r3, of: workingTrack, at: cursor3)
                    compVideo.scaleTimeRange(CMTimeRange(start: cursor3, duration: r3.duration), toDuration: CMTime(seconds: p3Dur / 1.6, preferredTimescale: timescale))
                }

            case .boomerang:
                let boomWindow = min(workDurSec, 3.2)
                let boomStart = workStartSec + max(0.0, (workDurSec - boomWindow) * 0.5)
                let fwdRange = CMTimeRange(start: CMTime(seconds: boomStart, preferredTimescale: timescale), duration: CMTime(seconds: boomWindow, preferredTimescale: timescale))
                try compVideo.insertTimeRange(fwdRange, of: workingTrack, at: .zero)
                compVideo.scaleTimeRange(CMTimeRange(start: .zero, duration: fwdRange.duration), toDuration: CMTime(seconds: boomWindow * 1.15, preferredTimescale: timescale))

                if let revURL = tempReverseURL {
                    let revAsset = AVURLAsset(url: revURL, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
                    if let revTrack = revAsset.tracks(withMediaType: .video).first {
                        let revDur = revAsset.duration
                        let cursor = composition.duration
                        try compVideo.insertTimeRange(CMTimeRange(start: .zero, duration: revDur), of: revTrack, at: cursor)
                        let revSec = CMTimeGetSeconds(revDur)
                        compVideo.scaleTimeRange(CMTimeRange(start: cursor, duration: revDur), toDuration: CMTime(seconds: revSec * 1.15, preferredTimescale: timescale))
                    }
                }
            }
        } catch {
            cleanup(tempReverseURL)
            DispatchQueue.main.async { completion(.failure(error)) }
            return
        }

        // Preserve original source preferredTransform for the composition video track
        compVideo.preferredTransform = baseVideoTrack.preferredTransform

        // Attach background music (trimmed/looped to match composition duration)
        var audioMix: AVMutableAudioMix? = nil
        if let musicURL = options.musicURL {
            audioMix = attachMusic(url: musicURL, to: composition)
        }

        // Pre-render PNG overlay + text once into a transparent CIImage at exact renderSize
        let renderSize = options.aspect.renderSize
        let overlayImage = renderOverlayUIImage(
            size: renderSize,
            overlay: options.overlayImage,
            titleText: options.titleText,
            subtitleText: options.subtitleText
        )
        let overlayCI: CIImage? = overlayImage.flatMap { ui in
            if let cg = ui.cgImage {
                return CIImage(cgImage: cg)
            }
            return CIImage(image: ui)
        }

        let colorLook = options.colorLook
        let videoComp = AVMutableVideoComposition(asset: composition) { request in
            let src = request.sourceImage
            let ext = src.extent
            guard ext.width > 0, ext.height > 0 else {
                request.finish(with: src, context: sharedCIContext)
                return
            }

            // Aspect-fill source frame to target renderSize
            let sx = renderSize.width / ext.width
            let sy = renderSize.height / ext.height
            let scale = max(sx, sy)
            let tx = (renderSize.width - ext.width * scale) * 0.5 - ext.origin.x * scale
            let ty = (renderSize.height - ext.height * scale) * 0.5 - ext.origin.y * scale
            let xform = CGAffineTransform(a: scale, b: 0, c: 0, d: scale, tx: tx, ty: ty)

            var outImg = src.transformed(by: xform).cropped(to: CGRect(origin: .zero, size: renderSize))
            outImg = applyColorLook(colorLook, to: outImg)

            if let ov = overlayCI {
                outImg = ov.composited(over: outImg).cropped(to: CGRect(origin: .zero, size: renderSize))
            }

            request.finish(with: outImg, context: sharedCIContext)
        }
        videoComp.renderSize = renderSize
        videoComp.frameDuration = CMTime(value: 1, timescale: 30)

        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("pb4u-360-render-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outURL)

        let preset = AVAssetExportSession.allExportPresets().contains(AVAssetExportPresetHighestQuality)
            ? AVAssetExportPresetHighestQuality
            : AVAssetExportPresetMediumQuality

        guard let exporter = AVAssetExportSession(asset: composition, presetName: preset) else {
            cleanup(tempReverseURL)
            DispatchQueue.main.async {
                completion(.failure(makeError("Could not create video exporter.")))
            }
            return
        }
        exporter.outputURL = outURL
        exporter.outputFileType = .mp4
        exporter.shouldOptimizeForNetworkUse = true
        exporter.videoComposition = videoComp
        if let am = audioMix {
            exporter.audioMix = am
        }

        let progQueue = DispatchQueue(label: "com.photobooth4u.spinrender.prog")
        let timer = DispatchSource.makeTimerSource(queue: progQueue)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.12)
        timer.setEventHandler {
            let p = exporter.progress
            DispatchQueue.main.async { progress?(p) }
        }
        timer.resume()

        exporter.exportAsynchronously {
            timer.cancel()
            cleanup(tempReverseURL)
            DispatchQueue.main.async {
                progress?(1.0)
                if exporter.status == .completed {
                    completion(.success(outURL))
                } else {
                    try? FileManager.default.removeItem(at: outURL)
                    completion(.failure(exporter.error ?? makeError("Video export failed.")))
                }
            }
        }
    }

    // MARK: - Overlay + Text Compositor

    private static func renderOverlayUIImage(
        size: CGSize,
        overlay: UIImage?,
        titleText: String,
        subtitleText: String
    ) -> UIImage? {
        let t1 = titleText.trimmingCharacters(in: .whitespacesAndNewlines)
        let t2 = subtitleText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard overlay != nil || !t1.isEmpty || !t2.isEmpty else { return nil }

        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1.0
        fmt.opaque = false
        let renderer = UIGraphicsImageRenderer(size: size, format: fmt)

        return renderer.image { _ in
            let rect = CGRect(origin: .zero, size: size)
            if let ov = overlay {
                // Draw custom Canva / PNG frame filling the output canvas
                ov.draw(in: rect)
            }

            if !t1.isEmpty || !t2.isEmpty {
                let padX = size.width * 0.08
                let maxW = size.width - padX * 2
                let bottomMargin = size.height * 0.065

                let shadow = NSShadow()
                shadow.shadowColor = UIColor(white: 0, alpha: 0.72)
                shadow.shadowBlurRadius = 12
                shadow.shadowOffset = CGSize(width: 0, height: 3)

                let para = NSMutableParagraphStyle()
                para.alignment = .center
                para.lineBreakMode = .byWordWrapping

                let mainFontSize = round(min(size.width, size.height) * 0.052)
                let subFontSize = round(min(size.width, size.height) * 0.030)

                var curBottom = size.height - bottomMargin

                if !t2.isEmpty {
                    let subAttrs: [NSAttributedString.Key: Any] = [
                        .font: UIFont.systemFont(ofSize: subFontSize, weight: .semibold),
                        .foregroundColor: UIColor(white: 1.0, alpha: 0.92),
                        .paragraphStyle: para,
                        .shadow: shadow
                    ]
                    let subStr = NSAttributedString(string: t2, attributes: subAttrs)
                    let subBox = subStr.boundingRect(with: CGSize(width: maxW, height: size.height * 0.2), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
                    curBottom -= ceil(subBox.height)
                    subStr.draw(in: CGRect(x: padX, y: curBottom, width: maxW, height: ceil(subBox.height)))
                    curBottom -= 8
                }

                if !t1.isEmpty {
                    let mainAttrs: [NSAttributedString.Key: Any] = [
                        .font: UIFont.systemFont(ofSize: mainFontSize, weight: .heavy),
                        .foregroundColor: UIColor.white,
                        .paragraphStyle: para,
                        .shadow: shadow
                    ]
                    let mainStr = NSAttributedString(string: t1, attributes: mainAttrs)
                    let mainBox = mainStr.boundingRect(with: CGSize(width: maxW, height: size.height * 0.25), options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil)
                    curBottom -= ceil(mainBox.height)
                    mainStr.draw(in: CGRect(x: padX, y: curBottom, width: maxW, height: ceil(mainBox.height)))
                }
            }
        }
    }

    // MARK: - Color Looks (Metal GPU)

    private static func applyColorLook(_ look: ColorLook, to image: CIImage) -> CIImage {
        switch look {
        case .natural:
            return image
        case .glamBW:
            let mono = CIFilter(name: "CIPhotoEffectNoir", parameters: [kCIInputImageKey: image])?.outputImage ?? image
            return CIFilter(name: "CIColorControls", parameters: [
                kCIInputImageKey: mono,
                kCIInputContrastKey: 1.12,
                kCIInputBrightnessKey: 0.02
            ])?.outputImage ?? mono
        case .warmGlow:
            let temp = CIFilter(name: "CITemperatureAndTint", parameters: [
                kCIInputImageKey: image,
                "inputNeutral": CIVector(x: 6500, y: 0),
                "inputTargetNeutral": CIVector(x: 5600, y: 0)
            ])?.outputImage ?? image
            return CIFilter(name: "CIVibrance", parameters: [
                kCIInputImageKey: temp,
                "inputAmount": 0.28
            ])?.outputImage ?? temp
        case .vibrant:
            return CIFilter(name: "CIColorControls", parameters: [
                kCIInputImageKey: image,
                kCIInputSaturationKey: 1.24,
                kCIInputContrastKey: 1.08
            ])?.outputImage ?? image
        }
    }

    // MARK: - Background Music

    private static func attachMusic(url: URL, to composition: AVMutableComposition) -> AVMutableAudioMix? {
        let mAsset = AVURLAsset(url: url)
        guard let srcAudio = mAsset.tracks(withMediaType: .audio).first,
              let compAudio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            return nil
        }
        let targetDur = composition.duration
        let mDur = mAsset.duration
        guard CMTimeGetSeconds(mDur) > 0.1, CMTimeGetSeconds(targetDur) > 0.1 else { return nil }

        var cursor = CMTime.zero
        while CMTimeCompare(cursor, targetDur) < 0 {
            let remaining = CMTimeSubtract(targetDur, cursor)
            let chunk = CMTimeCompare(mDur, remaining) <= 0 ? mDur : remaining
            do {
                try compAudio.insertTimeRange(CMTimeRange(start: .zero, duration: chunk), of: srcAudio, at: cursor)
            } catch {
                break
            }
            cursor = CMTimeAdd(cursor, chunk)
        }

        let totalSec = CMTimeGetSeconds(targetDur)
        if totalSec > 0.8 {
            let fadeDur = min(0.6, totalSec * 0.15)
            let fadeStart = CMTime(seconds: totalSec - fadeDur, preferredTimescale: 600)
            let params = AVMutableAudioMixInputParameters(track: compAudio)
            params.setVolumeRamp(fromStartVolume: 1.0, toEndVolume: 0.0, timeRange: CMTimeRange(start: fadeStart, duration: CMTime(seconds: fadeDur, preferredTimescale: 600)))
            let mix = AVMutableAudioMix()
            mix.inputParameters = [params]
            return mix
        }
        return nil
    }

    // MARK: - Chunked Reversal for Boomerang (Memory-Safe)

    private static func buildReversedClip(asset: AVAsset, videoTrack: AVAssetTrack, timeRange: CMTimeRange) -> URL? {
        let outURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("pb4u-rev-\(UUID().uuidString).mp4")
        try? FileManager.default.removeItem(at: outURL)

        let natSize = videoTrack.naturalSize
        let w = max(2, (Int(natSize.width) / 2) * 2)
        let h = max(2, (Int(natSize.height) / 2) * 2)
        guard w > 0, h > 0 else { return nil }

        guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { return nil }
        let vSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: w,
            AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 12_000_000,
                AVVideoExpectedSourceFrameRateKey: 30
            ]
        ]
        let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: vSettings)
        writerInput.expectsMediaDataInRealTime = false
        writerInput.transform = videoTrack.preferredTransform

        let attrs: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
            kCVPixelBufferWidthKey as String: w,
            kCVPixelBufferHeightKey as String: h
        ]
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: writerInput, sourcePixelBufferAttributes: attrs)
        guard writer.canAdd(writerInput) else { return nil }
        writer.add(writerInput)
        guard writer.startWriting() else { return nil }
        writer.startSession(atSourceTime: .zero)

        let totalSec = CMTimeGetSeconds(timeRange.duration)
        let startSec = CMTimeGetSeconds(timeRange.start)
        let batchSec = 0.5
        var cursorOut = CMTime.zero
        var prevOrigTime: CMTime? = nil

        // Walk timeRange in small chunks backwards so peak memory stays low on iPhone
        var chunkEnd = startSec + totalSec
        while chunkEnd > startSec + 0.01 {
            let chunkStart = max(startSec, chunkEnd - batchSec)
            let chunkRange = CMTimeRange(
                start: CMTime(seconds: chunkStart, preferredTimescale: 600),
                duration: CMTime(seconds: chunkEnd - chunkStart, preferredTimescale: 600)
            )
            chunkEnd = chunkStart

            guard let reader = try? AVAssetReader(asset: asset) else { break }
            reader.timeRange = chunkRange
            let output = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)
            ])
            output.alwaysCopiesSampleData = true
            guard reader.canAdd(output) else { break }
            reader.add(output)
            guard reader.startReading() else { break }

            var batch: [(CVPixelBuffer, CMTime)] = []
            while let sample = output.copyNextSampleBuffer() {
                if let pb = CMSampleBufferGetImageBuffer(sample) {
                    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
                    batch.append((pb, pts))
                }
            }
            reader.cancelReading()

            for (pb, pts) in batch.reversed() {
                while !writerInput.isReadyForMoreMediaData {
                    Thread.sleep(forTimeInterval: 0.005)
                }
                if let prev = prevOrigTime {
                    let delta = CMTimeSubtract(prev, pts)
                    let safeDelta = CMTimeGetSeconds(delta) > 0.001 ? delta : CMTime(value: 1, timescale: 30)
                    cursorOut = CMTimeAdd(cursorOut, safeDelta)
                }
                prevOrigTime = pts
                adaptor.append(pb, withPresentationTime: cursorOut)
            }
            batch.removeAll()
        }

        writerInput.markAsFinished()
        let sem = DispatchSemaphore(value: 0)
        writer.finishWriting { sem.signal() }
        _ = sem.wait(timeout: .now() + 20)
        if writer.status == .completed {
            return outURL
        }
        try? FileManager.default.removeItem(at: outURL)
        return nil
    }

    private static func cleanup(_ url: URL?) {
        if let u = url {
            try? FileManager.default.removeItem(at: u)
        }
    }

    private static func makeError(_ msg: String) -> NSError {
        return NSError(domain: "SpinRenderer", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
    }
}
