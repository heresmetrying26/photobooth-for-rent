package com.photobooth4u.booth

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLExt
import android.opengl.EGLSurface
import android.opengl.GLES11Ext
import android.opengl.GLES20
import android.opengl.GLUtils
import android.opengl.Matrix
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.text.Layout
import android.text.StaticLayout
import android.text.TextPaint
import android.view.Surface
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.UUID
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.roundToLong

/**
 * Hardware-accelerated on-device 360 video composer using MediaExtractor + OpenGL ES + MediaCodec + MediaMuxer.
 * Supports speed presets (Original, Slow-Mo, Super Slow, Speed Ramp, Boomerang),
 * 9:16 / 1:1 / 16:9 aspect ratios, transparent PNG frame overlays, event title text, color looks,
 * and looped background music with smooth end fade-out.
 */
object SpinRenderer {

    enum class MotionPreset(val id: String, val label: String, val shortLabel: String) {
        SLOW_MO("slow", "Slow-Mo (0.5×)", "Slow-Mo"),
        SUPER_SLOW("super", "Super Slow (0.33×)", "Super Slow"),
        SPEED_RAMP("ramp", "Speed Ramp", "Speed Ramp"),
        BOOMERANG("boomerang", "Boomerang", "Boomerang"),
        ORIGINAL("original", "Original (1×)", "Original");

        companion object {
            fun fromId(id: String?): MotionPreset = values().firstOrNull { it.id == id } ?: SLOW_MO
        }
    }

    enum class OutputAspect(val id: String, val label: String, val width: Int, val height: Int) {
        PORTRAIT_9X16("portrait", "9:16 Portrait", 1080, 1920),
        SQUARE_1X1("square", "1:1 Square", 1080, 1080),
        LANDSCAPE_16X9("landscape", "16:9 Landscape", 1920, 1080);

        companion object {
            fun fromId(id: String?): OutputAspect = values().firstOrNull { it.id == id } ?: PORTRAIT_9X16
        }
    }

    enum class ColorLook(val id: String, val label: String) {
        NATURAL("natural", "Natural"),
        GLAM_BW("glam_bw", "Glam B&W"),
        WARM_GLOW("warm_glow", "Warm Glow"),
        VIBRANT("vibrant", "Vibrant Pop");

        companion object {
            fun fromId(id: String?): ColorLook = values().firstOrNull { it.id == id } ?: NATURAL
        }
    }

    data class Options(
        val motion: MotionPreset = MotionPreset.SLOW_MO,
        val aspect: OutputAspect = OutputAspect.PORTRAIT_9X16,
        val colorLook: ColorLook = ColorLook.NATURAL,
        val overlayBitmap: Bitmap? = null,
        val titleText: String = "",
        val subtitleText: String = "",
        val musicFile: File? = null,
        val trimStartSec: Double = 0.25,
        val maxSourceSec: Double = 10.0
    )

    private const val OUT_FPS = 30
    private const val FRAME_US = 1_000_000L / OUT_FPS
    private const val CODEC_TIMEOUT_US = 10_000L
    private val mainHandler = Handler(Looper.getMainLooper())

    fun render(
        ctx: Context,
        sourceFile: File,
        options: Options,
        onProgress: ((Float) -> Unit)? = null,
        onDone: (Result<File>) -> Unit
    ) {
        val appCtx = ctx.applicationContext
        Thread({
            try {
                val out = renderSync(appCtx, sourceFile, options) { p ->
                    if (onProgress != null) mainHandler.post { onProgress(p) }
                }
                mainHandler.post {
                    onProgress?.invoke(1.0f)
                    onDone(Result.success(out))
                }
            } catch (t: Throwable) {
                mainHandler.post { onDone(Result.failure(t)) }
            }
        }, "pb-spin-render").apply { isDaemon = true }.start()
    }

    private fun renderSync(
        ctx: Context,
        sourceFile: File,
        options: Options,
        onProgress: (Float) -> Unit
    ): File {
        onProgress(0.05f)
        if (!sourceFile.exists() || sourceFile.length() <= 0L) {
            throw IllegalStateException("Recorded video is empty.")
        }

        // Probe source geometry, duration & orientation
        var srcWidth = 0
        var srcHeight = 0
        var rotationDeg = 0
        var totalDurSec = 0.0
        val mmr = MediaMetadataRetriever()
        try {
            mmr.setDataSource(sourceFile.absolutePath)
            srcWidth = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            srcHeight = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            rotationDeg = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val durMs = mmr.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            totalDurSec = durMs / 1000.0
        } finally {
            try { mmr.release() } catch (_: Exception) { }
        }

        if (srcWidth <= 0 || srcHeight <= 0 || totalDurSec <= 0.15) {
            throw IllegalStateException("Could not read captured video dimensions.")
        }

        val trimStart = if (totalDurSec > options.trimStartSec + 0.6) options.trimStartSec else 0.0
        val usableLimit = if (options.motion == MotionPreset.BOOMERANG) min(options.maxSourceSec, 3.0) else options.maxSourceSec
        val usableDur = max(0.35, min(usableLimit, totalDurSec - trimStart))
        val trimEnd = trimStart + usableDur

        var outW = options.aspect.width
        var outH = options.aspect.height
        var overlayBmp: Bitmap? = null

        val videoTemp = File(ctx.cacheDir, "pb4u-spin-v-${UUID.randomUUID()}.mp4")
        val finalOut = File(ctx.cacheDir, "pb4u-spin-${UUID.randomUUID()}.mp4")
        try {
            fun runEncode(w: Int, h: Int) {
                overlayBmp?.recycle()
                overlayBmp = renderOverlayBitmap(w, h, options.overlayBitmap, options.titleText, options.subtitleText)
                if (options.motion == MotionPreset.BOOMERANG) {
                    encodeBoomerang(sourceFile, videoTemp, w, h, rotationDeg, options.colorLook, overlayBmp, trimStart, usableDur, onProgress)
                } else {
                    encodeForward(sourceFile, videoTemp, w, h, rotationDeg, options.motion, options.colorLook, overlayBmp, trimStart, usableDur, trimEnd, onProgress)
                }
            }
            try {
                runEncode(outW, outH)
            } catch (_: MediaCodec.CodecException) {
                // Fallback to 720p for budget phones that cap hardware H.264 encoder below 1080p
                val scale = 720.0 / min(outW, outH).toDouble()
                outW = max(2, ((outW * scale).toInt() / 2) * 2)
                outH = max(2, ((outH * scale).toInt() / 2) * 2)
                runEncode(outW, outH)
            }

            if (options.musicFile != null && options.musicFile.exists() && options.musicFile.length() > 0L) {
                onProgress(0.88f)
                val okMusic = attachMusic(videoTemp, options.musicFile, finalOut)
                if (okMusic && finalOut.exists() && finalOut.length() > 1024L) {
                    videoTemp.delete()
                    onProgress(1.0f)
                    return finalOut
                }
            }
            videoTemp.copyTo(finalOut, overwrite = true)
            videoTemp.delete()
            onProgress(1.0f)
            return finalOut
        } catch (t: Throwable) {
            try { videoTemp.delete() } catch (_: Exception) { }
            try { finalOut.delete() } catch (_: Exception) { }
            throw t
        } finally {
            overlayBmp?.recycle()
        }
    }

    // MARK: - Speed Mapping (Seconds)

    private data class OutSegment(val outDurSec: Double, val srcStartSec: Double, val srcEndSec: Double)

    private fun buildSegments(preset: MotionPreset, usableDur: Double): Pair<List<OutSegment>, Double> {
        val segs = mutableListOf<OutSegment>()
        when (preset) {
            MotionPreset.ORIGINAL -> {
                segs.add(OutSegment(usableDur, 0.0, usableDur))
            }
            MotionPreset.SLOW_MO -> {
                segs.add(OutSegment(usableDur * 2.0, 0.0, usableDur))
            }
            MotionPreset.SUPER_SLOW -> {
                segs.add(OutSegment(usableDur * 3.0, 0.0, usableDur))
            }
            MotionPreset.SPEED_RAMP -> {
                if (usableDur < 1.2) {
                    segs.add(OutSegment(usableDur * 2.0, 0.0, usableDur))
                } else {
                    val t1 = usableDur * 0.25
                    val t2 = usableDur * 0.72
                    val d1 = t1 / 2.0        // 2x fast entry
                    val d2 = (t2 - t1) / 0.30 // 0.3x hero slow-mo
                    val d3 = (usableDur - t2) / 2.0 // 2x fast exit
                    segs.add(OutSegment(d1, 0.0, t1))
                    segs.add(OutSegment(d2, t1, t2))
                    segs.add(OutSegment(d3, t2, usableDur))
                }
            }
            MotionPreset.BOOMERANG -> {
                segs.add(OutSegment(usableDur, 0.0, usableDur))
            }
        }
        val totalOut = segs.sumOf { it.outDurSec }
        return Pair(segs, totalOut)
    }

    private fun mapOutToRelSrcSec(outSec: Double, segs: List<OutSegment>): Double {
        var acc = 0.0
        for (s in segs) {
            if (outSec <= acc + s.outDurSec || s === segs.last()) {
                val frac = if (s.outDurSec > 0.0001) ((outSec - acc) / s.outDurSec).coerceIn(0.0, 1.0) else 0.0
                return s.srcStartSec + (s.srcEndSec - s.srcStartSec) * frac
            }
            acc += s.outDurSec
        }
        return segs.last().srcEndSec
    }

    // MARK: - Forward Retimed Render

    private fun encodeForward(
        sourceFile: File,
        outFile: File,
        outW: Int,
        outH: Int,
        rotationDeg: Int,
        preset: MotionPreset,
        look: ColorLook,
        overlayBmp: Bitmap?,
        trimStart: Double,
        usableDur: Double,
        trimEnd: Double,
        onProgress: (Float) -> Unit
    ) {
        val (segs, totalOutSec) = buildSegments(preset, usableDur)
        val totalOutFrames = max(2, (totalOutSec * OUT_FPS).roundToInt())

        val extractor = MediaExtractor()
        extractor.setDataSource(sourceFile.absolutePath)
        val trackIdx = selectVideoTrack(extractor)
        if (trackIdx < 0) {
            extractor.release()
            throw IllegalStateException("No video track found.")
        }
        extractor.selectTrack(trackIdx)
        val inFmt = extractor.getTrackFormat(trackIdx)
        val rawW = inFmt.getInteger(MediaFormat.KEY_WIDTH)
        val rawH = inFmt.getInteger(MediaFormat.KEY_HEIGHT)
        if (inFmt.containsKey(MediaFormat.KEY_ROTATION)) {
            inFmt.setInteger(MediaFormat.KEY_ROTATION, 0)
        }
        val mime = inFmt.getString(MediaFormat.KEY_MIME) ?: MediaFormat.MIMETYPE_VIDEO_AVC

        val encInfo = createVideoEncoder(outW, outH)
        val encoder = encInfo.codec
        val encSurface = encInfo.inputSurface
        val gl = SpinGlPipeline(encSurface, outW, outH, rawW, rawH, rotationDeg, look, overlayBmp)

        val muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxTrack = -1
        var muxStarted = false

        val decoder = MediaCodec.createDecoderByType(mime)
        decoder.configure(inFmt, gl.decoderSurface, null, 0)
        decoder.start()

        val startUs = (trimStart * 1_000_000.0).toLong()
        val endUs = (trimEnd * 1_000_000.0).toLong()
        if (startUs > 0L) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

        try {
            val inInfo = MediaCodec.BufferInfo()
            val outInfo = MediaCodec.BufferInfo()
            var extractorAtEnd = false
            var extDone = false
            var decDone = false
            var encDone = false

            var currentOutFrame = 0
            var hasRenderedFrame = false
            var lastDecodedPtsUs = startUs
            var prevDecodedPtsUs = Long.MIN_VALUE

            fun nextTargetSrcUs(): Long {
                val outSec = currentOutFrame.toDouble() / OUT_FPS.toDouble()
                return startUs + (mapOutToRelSrcSec(outSec, segs) * 1_000_000.0).roundToLong()
            }

            fun drainEncoder(endOfStream: Boolean) {
                if (endOfStream) encoder.signalEndOfInputStream()
                var eosTries = 0
                while (true) {
                    val idx = encoder.dequeueOutputBuffer(outInfo, CODEC_TIMEOUT_US)
                    if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                        if (!endOfStream || ++eosTries > 250) break
                    } else if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        if (!muxStarted) {
                            muxTrack = muxer.addTrack(encoder.outputFormat)
                            muxer.start()
                            muxStarted = true
                        }
                    } else if (idx >= 0) {
                        eosTries = 0
                        val buf = encoder.getOutputBuffer(idx)
                        if (buf != null && (outInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && outInfo.size > 0 && muxStarted) {
                            buf.position(outInfo.offset)
                            buf.limit(outInfo.offset + outInfo.size)
                            muxer.writeSampleData(muxTrack, buf, outInfo)
                        }
                        val eos = (outInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                        encoder.releaseOutputBuffer(idx, false)
                        if (eos) {
                            encDone = true
                            break
                        }
                    }
                }
            }

            while (!encDone && (!decDone || currentOutFrame < totalOutFrames)) {
                if (!extDone) {
                    val inIdx = decoder.dequeueInputBuffer(CODEC_TIMEOUT_US)
                    if (inIdx >= 0) {
                        if (extractorAtEnd) {
                            decoder.queueInputBuffer(inIdx, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                            extDone = true
                        } else {
                            val ib = decoder.getInputBuffer(inIdx)!!
                            val sz = extractor.readSampleData(ib, 0)
                            if (sz < 0) {
                                decoder.queueInputBuffer(inIdx, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                extDone = true
                            } else {
                                val pts = extractor.sampleTime
                                decoder.queueInputBuffer(inIdx, 0, sz, pts, 0)
                                extractor.advance()
                                if (pts > endUs + 250_000L) extractorAtEnd = true
                            }
                        }
                    }
                }

                if (!decDone) {
                    val outIdx = decoder.dequeueOutputBuffer(inInfo, CODEC_TIMEOUT_US)
                    if (outIdx >= 0) {
                        val eos = (inInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                        val pts = inInfo.presentationTimeUs
                        val wantRender = inInfo.size > 0 && pts >= startUs - 50_000L
                        decoder.releaseOutputBuffer(outIdx, wantRender)
                        if (wantRender && pts >= prevDecodedPtsUs) {
                            prevDecodedPtsUs = pts
                            gl.awaitDecoderFrame()
                            hasRenderedFrame = true
                            lastDecodedPtsUs = pts
                            while (currentOutFrame < totalOutFrames && nextTargetSrcUs() <= lastDecodedPtsUs + 16_000L) {
                                gl.drawToEncoder(currentOutFrame * FRAME_US * 1000L)
                                currentOutFrame++
                                drainEncoder(false)
                                onProgress(0.08f + 0.78f * (currentOutFrame.toFloat() / totalOutFrames))
                            }
                        }
                        if (eos) decDone = true
                    }
                } else if (hasRenderedFrame && currentOutFrame < totalOutFrames) {
                    while (currentOutFrame < totalOutFrames) {
                        gl.drawToEncoder(currentOutFrame * FRAME_US * 1000L)
                        currentOutFrame++
                        drainEncoder(false)
                        onProgress(0.08f + 0.78f * (currentOutFrame.toFloat() / totalOutFrames))
                    }
                } else {
                    break
                }
            }
            if (!hasRenderedFrame) {
                throw IllegalStateException("No video frames decoded in selected range.")
            }
            drainEncoder(true)
        } finally {
            try { decoder.stop() } catch (_: Exception) { }
            try { decoder.release() } catch (_: Exception) { }
            try { encoder.stop() } catch (_: Exception) { }
            try { encoder.release() } catch (_: Exception) { }
            try { if (muxStarted) muxer.stop() } catch (_: Exception) { }
            try { muxer.release() } catch (_: Exception) { }
            try { extractor.release() } catch (_: Exception) { }
            gl.release()
        }
    }

    // MARK: - Chunked Memory-Safe Boomerang Render

    private fun encodeBoomerang(
        sourceFile: File,
        outFile: File,
        outW: Int,
        outH: Int,
        rotationDeg: Int,
        look: ColorLook,
        overlayBmp: Bitmap?,
        trimStart: Double,
        usableDur: Double,
        onProgress: (Float) -> Unit
    ) {
        val extractor = MediaExtractor()
        extractor.setDataSource(sourceFile.absolutePath)
        val trackIdx = selectVideoTrack(extractor)
        if (trackIdx < 0) {
            extractor.release()
            throw IllegalStateException("No video track found.")
        }
        extractor.selectTrack(trackIdx)
        val inFmt = extractor.getTrackFormat(trackIdx)
        val rawW = inFmt.getInteger(MediaFormat.KEY_WIDTH)
        val rawH = inFmt.getInteger(MediaFormat.KEY_HEIGHT)
        if (inFmt.containsKey(MediaFormat.KEY_ROTATION)) {
            inFmt.setInteger(MediaFormat.KEY_ROTATION, 0)
        }
        val mime = inFmt.getString(MediaFormat.KEY_MIME) ?: MediaFormat.MIMETYPE_VIDEO_AVC

        val encInfo = createVideoEncoder(outW, outH)
        val encoder = encInfo.codec
        val encSurface = encInfo.inputSurface
        val gl = SpinGlPipeline(encSurface, outW, outH, rawW, rawH, rotationDeg, look, overlayBmp)

        // Cap reverse capture buffer to max 720px short edge so peak RAM stays <= ~55 MB on any phone
        val revScale = min(1.0, 720.0 / min(outW, outH).toDouble())
        val revW = max(2, ((outW * revScale).toInt() / 2) * 2)
        val revH = max(2, ((outH * revScale).toInt() / 2) * 2)
        gl.initReverseFbo(revW, revH)

        val muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        var muxTrack = -1
        var muxStarted = false
        val outInfo = MediaCodec.BufferInfo()
        var outFrameIdx = 0

        fun drainEncoder(endOfStream: Boolean) {
            if (endOfStream) encoder.signalEndOfInputStream()
            var eosTries = 0
            while (true) {
                val idx = encoder.dequeueOutputBuffer(outInfo, CODEC_TIMEOUT_US)
                if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) {
                    if (!endOfStream || ++eosTries > 250) break
                } else if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    if (!muxStarted) {
                        muxTrack = muxer.addTrack(encoder.outputFormat)
                        muxer.start()
                        muxStarted = true
                    }
                } else if (idx >= 0) {
                    eosTries = 0
                    val buf = encoder.getOutputBuffer(idx)
                    if (buf != null && (outInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && outInfo.size > 0 && muxStarted) {
                        buf.position(outInfo.offset)
                        buf.limit(outInfo.offset + outInfo.size)
                        muxer.writeSampleData(muxTrack, buf, outInfo)
                    }
                    val eos = (outInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                    encoder.releaseOutputBuffer(idx, false)
                    if (eos) break
                }
            }
        }

        val startUs = (trimStart * 1_000_000.0).toLong()
        val endUs = ((trimStart + usableDur) * 1_000_000.0).toLong()
        val totalFwdFrames = max(2, (usableDur * OUT_FPS).roundToInt())

        // Pass 1: Forward clip (normal speed)
        try {
            val dec = MediaCodec.createDecoderByType(mime)
            dec.configure(inFmt, gl.decoderSurface, null, 0)
            dec.start()
            if (startUs > 0L) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
            val info = MediaCodec.BufferInfo()
            var extAtEnd = false
            var extDone = false
            var decDone = false
            var prevPts = Long.MIN_VALUE
            var fwdOutCount = 0
            try {
                while (!decDone && fwdOutCount < totalFwdFrames) {
                    if (!extDone) {
                        val ii = dec.dequeueInputBuffer(CODEC_TIMEOUT_US)
                        if (ii >= 0) {
                            if (extAtEnd) {
                                dec.queueInputBuffer(ii, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                extDone = true
                            } else {
                                val ib = dec.getInputBuffer(ii)!!
                                val sz = extractor.readSampleData(ib, 0)
                                if (sz < 0) {
                                    dec.queueInputBuffer(ii, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    extDone = true
                                } else {
                                    val pts = extractor.sampleTime
                                    dec.queueInputBuffer(ii, 0, sz, pts, 0)
                                    extractor.advance()
                                    if (pts > endUs + 200_000L) extAtEnd = true
                                }
                            }
                        }
                    }
                    val oi = dec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                    if (oi >= 0) {
                        val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                        val pts = info.presentationTimeUs
                        val want = info.size > 0 && pts >= startUs - 50_000L && pts <= endUs + 30_000L
                        dec.releaseOutputBuffer(oi, want)
                        if (want && pts >= prevPts) {
                            prevPts = pts
                            gl.awaitDecoderFrame()
                            val targetTarget = startUs + ((fwdOutCount.toDouble() / OUT_FPS) * 1_000_000.0).roundToLong()
                            while (fwdOutCount < totalFwdFrames && targetTarget <= pts + 16_000L) {
                                gl.drawToEncoder(outFrameIdx * FRAME_US * 1000L)
                                outFrameIdx++
                                fwdOutCount++
                                drainEncoder(false)
                                onProgress(0.08f + 0.36f * (fwdOutCount.toFloat() / totalFwdFrames))
                            }
                        }
                        if (eos) decDone = true
                    }
                }
            } finally {
                try { dec.stop() } catch (_: Exception) { }
                try { dec.release() } catch (_: Exception) { }
            }

            // Pass 2: Chunked reverse pass in small 0.45s batches (max ~14 buffers)
            val chunkDurUs = 450_000L
            val maxBatch = 14
            val frameBytes = revW * revH * 4
            val pool = ArrayList<ByteBuffer>(maxBatch)
            var cursorEnd = endUs
            while (cursorEnd > startUs + 20_000L) {
                val cursorStart = max(startUs, cursorEnd - chunkDurUs)
                val decRev = MediaCodec.createDecoderByType(mime)
                decRev.configure(inFmt, gl.decoderSurface, null, 0)
                decRev.start()
                extractor.seekTo(cursorStart, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
                val captured = mutableListOf<ByteBuffer>()
                try {
                    val info = MediaCodec.BufferInfo()
                    var eAtEnd = false
                    var eDone = false
                    var dDone = false
                    var lastPts = Long.MIN_VALUE
                    while (!dDone && captured.size < maxBatch) {
                        if (!eDone) {
                            val ii = decRev.dequeueInputBuffer(CODEC_TIMEOUT_US)
                            if (ii >= 0) {
                                if (eAtEnd) {
                                    decRev.queueInputBuffer(ii, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    eDone = true
                                } else {
                                    val ib = decRev.getInputBuffer(ii)!!
                                    val sz = extractor.readSampleData(ib, 0)
                                    if (sz < 0) {
                                        decRev.queueInputBuffer(ii, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                        eDone = true
                                    } else {
                                        val pts = extractor.sampleTime
                                        decRev.queueInputBuffer(ii, 0, sz, pts, 0)
                                        extractor.advance()
                                        if (pts >= cursorEnd + 150_000L) eAtEnd = true
                                    }
                                }
                            }
                        }
                        val oi = decRev.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                        if (oi >= 0) {
                            val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                            val pts = info.presentationTimeUs
                            val want = info.size > 0 && pts >= cursorStart - 20_000L && pts < cursorEnd + 5_000L
                            decRev.releaseOutputBuffer(oi, want)
                            if (want && pts > lastPts + 15_000L) {
                                lastPts = pts
                                gl.awaitDecoderFrame()
                                val buf = if (pool.isNotEmpty()) pool.removeAt(pool.lastIndex)
                                    else ByteBuffer.allocateDirect(frameBytes).order(ByteOrder.nativeOrder())
                                buf.clear()
                                gl.captureRenderedToBuffer(buf)
                                captured.add(buf)
                            }
                            if (eos) dDone = true
                        }
                    }
                } finally {
                    try { decRev.stop() } catch (_: Exception) { }
                    try { decRev.release() } catch (_: Exception) { }
                }

                for (k in captured.indices.reversed()) {
                    val buf = captured[k]
                    gl.drawCapturedBufferToEncoder(buf, outFrameIdx * FRAME_US * 1000L)
                    outFrameIdx++
                    drainEncoder(false)
                    pool.add(buf)
                }
                captured.clear()
                val fracDone = ((endUs - cursorStart).toFloat() / max(1L, endUs - startUs).toFloat()).coerceIn(0f, 1f)
                onProgress(0.45f + 0.40f * fracDone)
                cursorEnd = cursorStart
            }
            drainEncoder(true)
        } finally {
            try { encoder.stop() } catch (_: Exception) { }
            try { encoder.release() } catch (_: Exception) { }
            try { if (muxStarted) muxer.stop() } catch (_: Exception) { }
            try { muxer.release() } catch (_: Exception) { }
            try { extractor.release() } catch (_: Exception) { }
            gl.release()
        }
    }

    // MARK: - Background Music Mux + Linear Fade-Out

    private fun attachMusic(silentVideo: File, musicFile: File, outFile: File): Boolean {
        val vExt = MediaExtractor()
        val aExt = MediaExtractor()
        var muxer: MediaMuxer? = null
        var muxStarted = false
        try {
            vExt.setDataSource(silentVideo.absolutePath)
            val vTrack = selectVideoTrack(vExt)
            if (vTrack < 0) return false
            vExt.selectTrack(vTrack)
            val vFmt = vExt.getTrackFormat(vTrack)
            val vDurUs = if (vFmt.containsKey(MediaFormat.KEY_DURATION)) vFmt.getLong(MediaFormat.KEY_DURATION) else 0L

            aExt.setDataSource(musicFile.absolutePath)
            var aTrack = -1
            for (i in 0 until aExt.trackCount) {
                val fmt = aExt.getTrackFormat(i)
                if ((fmt.getString(MediaFormat.KEY_MIME) ?: "").startsWith("audio/")) {
                    aTrack = i
                    break
                }
            }
            if (aTrack < 0) return false
            aExt.selectTrack(aTrack)
            val aFmt = aExt.getTrackFormat(aTrack)
            val sampleRate = if (aFmt.containsKey(MediaFormat.KEY_SAMPLE_RATE)) aFmt.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 44100
            val channels = min(2, max(1, if (aFmt.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) aFmt.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2))

            // Decode music to PCM, loop & apply end fade-out, encode clean AAC alongside video
            val pcmFile = File(outFile.parentFile, "pb4u-pcm-${UUID.randomUUID()}.raw")
            try {
                val decoded = decodeAudioToPcm(aExt, aFmt, pcmFile, vDurUs, sampleRate, channels)
                if (!decoded) return false

                val aacMime = MediaFormat.MIMETYPE_AUDIO_AAC
                val aacFmt = MediaFormat.createAudioFormat(aacMime, sampleRate, channels).apply {
                    setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                    setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
                    setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16384)
                }
                val aEnc = MediaCodec.createEncoderByType(aacMime)
                aEnc.configure(aacFmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                aEnc.start()

                muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                val outVTrack = muxer.addTrack(vFmt)
                var outATrack = -1

                // First drive audio encoder output format so both tracks register before MediaMuxer.start()
                val aBufInfo = MediaCodec.BufferInfo()
                val pcmStream = pcmFile.inputStream().buffered()
                val frameBytes = 1024 * channels * 2
                val pcmChunk = ByteArray(frameBytes)
                var pcmDone = false
                var audioEos = false
                var audioSampleCount = 0L

                val encodedAudioFrames = mutableListOf<Pair<ByteArray, MediaCodec.BufferInfo>>()
                try {
                    while (!audioEos) {
                        if (!pcmDone) {
                            val inIdx = aEnc.dequeueInputBuffer(CODEC_TIMEOUT_US)
                            if (inIdx >= 0) {
                                val ib = aEnc.getInputBuffer(inIdx)!!
                                var readTotal = 0
                                while (readTotal < frameBytes) {
                                    val r = pcmStream.read(pcmChunk, readTotal, frameBytes - readTotal)
                                    if (r <= 0) break
                                    readTotal += r
                                }
                                if (readTotal <= 0) {
                                    aEnc.queueInputBuffer(inIdx, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                    pcmDone = true
                                } else {
                                    ib.clear()
                                    ib.put(pcmChunk, 0, readTotal)
                                    val ptsUs = audioSampleCount * 1_000_000L / sampleRate
                                    audioSampleCount += (readTotal / (channels * 2))
                                    aEnc.queueInputBuffer(inIdx, 0, readTotal, ptsUs, 0)
                                }
                            }
                        }
                        val oi = aEnc.dequeueOutputBuffer(aBufInfo, CODEC_TIMEOUT_US)
                        if (oi == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                            if (outATrack < 0) outATrack = muxer.addTrack(aEnc.outputFormat)
                        } else if (oi >= 0) {
                            val ob = aEnc.getOutputBuffer(oi)
                            if (ob != null && (aBufInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0 && aBufInfo.size > 0) {
                                ob.position(aBufInfo.offset)
                                val copy = ByteArray(aBufInfo.size)
                                ob.get(copy)
                                val bi = MediaCodec.BufferInfo()
                                bi.set(0, copy.size, aBufInfo.presentationTimeUs, aBufInfo.flags)
                                encodedAudioFrames.add(Pair(copy, bi))
                            }
                            if ((aBufInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) audioEos = true
                            aEnc.releaseOutputBuffer(oi, false)
                        }
                    }
                } finally {
                    try { pcmStream.close() } catch (_: Exception) { }
                    try { aEnc.stop() } catch (_: Exception) { }
                    try { aEnc.release() } catch (_: Exception) { }
                }

                if (outATrack < 0 || encodedAudioFrames.isEmpty()) return false
                muxer.start()
                muxStarted = true

                val vBuf = ByteBuffer.allocate(512 * 1024)
                val vInfo = MediaCodec.BufferInfo()
                while (true) {
                    val sz = vExt.readSampleData(vBuf, 0)
                    if (sz < 0) break
                    vInfo.offset = 0
                    vInfo.size = sz
                    vInfo.presentationTimeUs = vExt.sampleTime
                    vInfo.flags = vExt.sampleFlags
                    muxer.writeSampleData(outVTrack, vBuf, vInfo)
                    vExt.advance()
                }
                for ((bytes, bi) in encodedAudioFrames) {
                    muxer.writeSampleData(outATrack, ByteBuffer.wrap(bytes), bi)
                }
                return true
            } finally {
                try { pcmFile.delete() } catch (_: Exception) { }
            }
        } catch (_: Throwable) {
            return false
        } finally {
            try { if (muxStarted) muxer?.stop() } catch (_: Exception) { }
            try { muxer?.release() } catch (_: Exception) { }
            try { vExt.release() } catch (_: Exception) { }
            try { aExt.release() } catch (_: Exception) { }
        }
    }

    private fun decodeAudioToPcm(
        ext: MediaExtractor,
        fmt: MediaFormat,
        pcmOut: File,
        targetDurUs: Long,
        sampleRate: Int,
        channels: Int
    ): Boolean {
        val mime = fmt.getString(MediaFormat.KEY_MIME) ?: return false
        val totalSamplesTarget = max(1L, (targetDurUs * sampleRate) / 1_000_000L)
        val fadeSamples = if (totalSamplesTarget > (sampleRate * 0.8)) {
            min((sampleRate * 0.6).toLong(), (totalSamplesTarget * 0.15).toLong())
        } else 0L

        val dec = MediaCodec.createDecoderByType(mime)
        dec.configure(fmt, null, null, 0)
        dec.start()
        val info = MediaCodec.BufferInfo()
        val out = pcmOut.outputStream().buffered()
        var samplesWritten = 0L

        try {
            var loopGuard = 0
            while (samplesWritten < totalSamplesTarget && loopGuard < 20) {
                loopGuard++
                ext.seekTo(0L, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                dec.flush()
                var extDone = false
                var decDone = false
                var producedThisPass = 0L
                while (!decDone && samplesWritten < totalSamplesTarget) {
                    if (!extDone) {
                        val ii = dec.dequeueInputBuffer(CODEC_TIMEOUT_US)
                        if (ii >= 0) {
                            val ib = dec.getInputBuffer(ii)!!
                            val sz = ext.readSampleData(ib, 0)
                            if (sz < 0) {
                                dec.queueInputBuffer(ii, 0, 0, 0L, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                                extDone = true
                            } else {
                                dec.queueInputBuffer(ii, 0, sz, ext.sampleTime, 0)
                                ext.advance()
                            }
                        }
                    }
                    val oi = dec.dequeueOutputBuffer(info, CODEC_TIMEOUT_US)
                    if (oi >= 0) {
                        val ob = dec.getOutputBuffer(oi)
                        if (ob != null && info.size > 0) {
                            ob.position(info.offset)
                            ob.limit(info.offset + info.size)
                            val raw = ByteArray(info.size)
                            ob.get(raw)
                            val decChannels = max(1, if (dec.outputFormat.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) dec.outputFormat.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else channels)
                            val srcFrames = raw.size / (decChannels * 2)
                            val keepFrames = min(srcFrames.toLong(), totalSamplesTarget - samplesWritten).toInt()
                            val shortIn = ByteBuffer.wrap(raw).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                            val outBytes = ByteArray(keepFrames * channels * 2)
                            val shortOut = ByteBuffer.wrap(outBytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                            for (f in 0 until keepFrames) {
                                val fadeIdx = samplesWritten + f
                                val gain = if (fadeSamples > 0 && fadeIdx >= totalSamplesTarget - fadeSamples) {
                                    ((totalSamplesTarget - fadeIdx).toFloat() / fadeSamples.toFloat()).coerceIn(0f, 1f)
                                } else 1f
                                if (channels == 1) {
                                    val s = (shortIn.get(f * decChannels) * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort()
                                    shortOut.put(f, s)
                                } else {
                                    val l = shortIn.get(f * decChannels)
                                    val r = if (decChannels >= 2) shortIn.get(f * decChannels + 1) else l
                                    shortOut.put(f * 2, (l * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
                                    shortOut.put(f * 2 + 1, (r * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt()).toShort())
                                }
                            }
                            out.write(outBytes)
                            samplesWritten += keepFrames
                            producedThisPass += keepFrames
                        }
                        val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
                        dec.releaseOutputBuffer(oi, false)
                        if (eos) decDone = true
                    }
                }
                if (producedThisPass == 0L) break
            }
            return samplesWritten > 0L
        } finally {
            try { out.close() } catch (_: Exception) { }
            try { dec.stop() } catch (_: Exception) { }
            try { dec.release() } catch (_: Exception) { }
        }
    }

    // MARK: - Overlay + Title Bitmap Compositor

    private fun renderOverlayBitmap(
        width: Int,
        height: Int,
        overlay: Bitmap?,
        titleText: String,
        subtitleText: String
    ): Bitmap? {
        val t1 = titleText.trim()
        val t2 = subtitleText.trim()
        if (overlay == null && t1.isEmpty() && t2.isEmpty()) return null

        val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bmp)
        if (overlay != null && !overlay.isRecycled) {
            val dest = RectF(0f, 0f, width.toFloat(), height.toFloat())
            val p = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
            canvas.drawBitmap(overlay, null, dest, p)
        }

        if (t1.isNotEmpty() || t2.isNotEmpty()) {
            val padX = width * 0.08f
            val maxW = max(60, (width - padX * 2).toInt())
            var curBottom = height * 0.935f

            if (t2.isNotEmpty()) {
                val subPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.argb(235, 255, 255, 255)
                    textSize = min(width, height) * 0.030f
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    setShadowLayer(12f, 0f, 3f, Color.argb(185, 0, 0, 0))
                }
                @Suppress("DEPRECATION")
                val layout = StaticLayout(t2, subPaint, maxW, Layout.Alignment.ALIGN_CENTER, 1.0f, 0f, false)
                curBottom -= layout.height.toFloat()
                canvas.save()
                canvas.translate(padX, curBottom)
                layout.draw(canvas)
                canvas.restore()
                curBottom -= 8f
            }

            if (t1.isNotEmpty()) {
                val mainPaint = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
                    color = Color.WHITE
                    textSize = min(width, height) * 0.052f
                    typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
                    setShadowLayer(14f, 0f, 4f, Color.argb(195, 0, 0, 0))
                }
                @Suppress("DEPRECATION")
                val layout = StaticLayout(t1, mainPaint, maxW, Layout.Alignment.ALIGN_CENTER, 1.0f, 0f, false)
                curBottom -= layout.height.toFloat()
                canvas.save()
                canvas.translate(padX, curBottom)
                layout.draw(canvas)
                canvas.restore()
            }
        }
        return bmp
    }

    // MARK: - MediaCodec / Extractor Helpers

    private data class EncoderHolder(val codec: MediaCodec, val inputSurface: Surface)

    private fun createVideoEncoder(width: Int, height: Int): EncoderHolder {
        val fmt = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
            setInteger(MediaFormat.KEY_BIT_RATE, 12_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, OUT_FPS)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
        val surf = enc.createInputSurface()
        enc.start()
        return EncoderHolder(enc, surf)
    }

    private fun selectVideoTrack(ext: MediaExtractor): Int {
        for (i in 0 until ext.trackCount) {
            val fmt = ext.getTrackFormat(i)
            val mime = fmt.getString(MediaFormat.KEY_MIME) ?: continue
            if (mime.startsWith("video/")) return i
        }
        return -1
    }

    // MARK: - Hardware OpenGL ES 2.0 Pipeline (Crop + Rotate + Color Look + Overlay)

    private class SpinGlPipeline(
        encSurface: Surface,
        private val outW: Int,
        private val outH: Int,
        rawW: Int,
        rawH: Int,
        rotationDeg: Int,
        private val look: ColorLook,
        overlayBmp: Bitmap?
    ) {
        private val waitThread = HandlerThread("SpinGlWait").apply { start() }
        private val frameLock = Object()
        private var frameAvailable = false

        private val eglDisplay: EGLDisplay
        private val eglContext: EGLContext
        private val eglSurface: EGLSurface
        private val eglConfig: EGLConfig

        private val oesTexId: Int
        private val surfaceTexture: SurfaceTexture
        val decoderSurface: Surface
        private val overlayTexId: Int

        private val oesProg: Int
        private val tex2dProg: Int

        private val posBuf: FloatBuffer
        private val uvVideoBuf: FloatBuffer
        private val uvOverlayBuf: FloatBuffer
        private val uvFboUpBuf: FloatBuffer
        private val stMatrix = FloatArray(16)
        private val cropRotMatrix = FloatArray(16)

        private var revFbo = 0
        private var revTex = 0
        private var revW = 0
        private var revH = 0

        init {
            eglDisplay = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
            if (eglDisplay == EGL14.EGL_NO_DISPLAY) throw RuntimeException("Unable to get EGL14 display")
            val ver = IntArray(2)
            if (!EGL14.eglInitialize(eglDisplay, ver, 0, ver, 1)) throw RuntimeException("Unable to init EGL14")

            val cfgAttrs = intArrayOf(
                EGL14.EGL_RED_SIZE, 8,
                EGL14.EGL_GREEN_SIZE, 8,
                EGL14.EGL_BLUE_SIZE, 8,
                EGL14.EGL_ALPHA_SIZE, 8,
                EGL14.EGL_RENDERABLE_TYPE, EGL14.EGL_OPENGL_ES2_BIT,
                0x3142, 1, // EGL_RECORDABLE_ANDROID
                EGL14.EGL_NONE
            )
            val configs = arrayOfNulls<EGLConfig>(1)
            val numCfg = IntArray(1)
            EGL14.eglChooseConfig(eglDisplay, cfgAttrs, 0, configs, 0, 1, numCfg, 0)
            eglConfig = configs[0] ?: throw RuntimeException("No matching EGLConfig")

            eglContext = EGL14.eglCreateContext(
                eglDisplay, eglConfig, EGL14.EGL_NO_CONTEXT,
                intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 2, EGL14.EGL_NONE), 0
            )
            eglSurface = EGL14.eglCreateWindowSurface(eglDisplay, eglConfig, encSurface, intArrayOf(EGL14.EGL_NONE), 0)
            EGL14.eglMakeCurrent(eglDisplay, eglSurface, eglSurface, eglContext)

            posBuf = floatBuf(floatArrayOf(-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f))
            uvVideoBuf = floatBuf(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))
            // Bitmaps loaded via GLUtils have row 0 at uv.y=0, so screen top (+1) maps to uv.y=0
            uvOverlayBuf = floatBuf(floatArrayOf(0f, 1f, 1f, 1f, 0f, 0f, 1f, 0f))
            // FBO glReadPixels outputs bottom row first -> GLUtils upload places bottom row at uv.y=0
            uvFboUpBuf = floatBuf(floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))

            val texIds = IntArray(2)
            GLES20.glGenTextures(2, texIds, 0)
            oesTexId = texIds[0]
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexId)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)

            surfaceTexture = SurfaceTexture(oesTexId)
            surfaceTexture.setOnFrameAvailableListener({
                synchronized(frameLock) {
                    frameAvailable = true
                    frameLock.notifyAll()
                }
            }, Handler(waitThread.looper))
            decoderSurface = Surface(surfaceTexture)

            overlayTexId = if (overlayBmp != null) {
                val oid = texIds[1]
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, oid)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
                GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
                GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, overlayBmp, 0)
                oid
            } else {
                0
            }

            computeCropRotMatrix(rawW, rawH, rotationDeg, outW, outH)
            oesProg = linkProgram(VS_QUAD, fsOes(look, overlayTexId != 0))
            tex2dProg = linkProgram(VS_QUAD, FS_PASSTHROUGH_2D)
        }

        private fun computeCropRotMatrix(rawW: Int, rawH: Int, rotDeg: Int, dstW: Int, dstH: Int) {
            val swap = (rotDeg == 90 || rotDeg == 270)
            val effW = (if (swap) rawH else rawW).toFloat()
            val effH = (if (swap) rawW else rawH).toFloat()
            val effRatio = effW / max(1f, effH)
            val dstRatio = dstW.toFloat() / max(1f, dstH.toFloat())

            // Aspect-fill UV crop box inside upright [0,1]^2
            val cropScaleX = if (effRatio > dstRatio) dstRatio / effRatio else 1.0f
            val cropScaleY = if (effRatio < dstRatio) effRatio / dstRatio else 1.0f

            // Map upright output UV -> crop centered -> rotate -> raw decoder UV
            val m = FloatArray(16)
            Matrix.setIdentityM(m, 0)
            Matrix.translateM(m, 0, 0.5f, 0.5f, 0f)
            if (rotDeg != 0) Matrix.rotateM(m, 0, rotDeg.toFloat(), 0f, 0f, 1f)
            Matrix.scaleM(m, 0, cropScaleX, cropScaleY, 1f)
            Matrix.translateM(m, 0, -0.5f, -0.5f, 0f)
            System.arraycopy(m, 0, cropRotMatrix, 0, 16)
        }

        fun awaitDecoderFrame() {
            synchronized(frameLock) {
                val deadline = System.currentTimeMillis() + 600L
                while (!frameAvailable) {
                    val left = deadline - System.currentTimeMillis()
                    if (left <= 0) break
                    frameLock.wait(left)
                }
                frameAvailable = false
            }
            surfaceTexture.updateTexImage()
            surfaceTexture.getTransformMatrix(stMatrix)
        }

        fun drawToEncoder(ptsNs: Long) {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
            GLES20.glViewport(0, 0, outW, outH)
            renderOesQuad()
            EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs)
            EGL14.eglSwapBuffers(eglDisplay, eglSurface)
        }

        fun initReverseFbo(w: Int, h: Int) {
            revW = w
            revH = h
            val t = IntArray(1)
            GLES20.glGenTextures(1, t, 0)
            revTex = t[0]
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, revTex)
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_RGBA, w, h, 0, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, null)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
            GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
            val f = IntArray(1)
            GLES20.glGenFramebuffers(1, f, 0)
            revFbo = f[0]
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, revFbo)
            GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, revTex, 0)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        }

        fun captureRenderedToBuffer(buf: ByteBuffer) {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, revFbo)
            GLES20.glViewport(0, 0, revW, revH)
            renderOesQuad()
            buf.position(0)
            GLES20.glReadPixels(0, 0, revW, revH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf)
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
        }

        fun drawCapturedBufferToEncoder(buf: ByteBuffer, ptsNs: Long) {
            GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
            GLES20.glViewport(0, 0, outW, outH)
            GLES20.glUseProgram(tex2dProg)

            val ident = FloatArray(16).apply { Matrix.setIdentityM(this, 0) }
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(tex2dProg, "uTexM"), 1, false, ident, 0)
            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, revTex)
            buf.position(0)
            GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, revW, revH, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, buf)
            GLES20.glUniform1i(GLES20.glGetUniformLocation(tex2dProg, "uTex"), 0)

            val aPos = GLES20.glGetAttribLocation(tex2dProg, "aPos")
            val aUv = GLES20.glGetAttribLocation(tex2dProg, "aUv")
            val aOvUv = GLES20.glGetAttribLocation(tex2dProg, "aOvUv")
            GLES20.glEnableVertexAttribArray(aPos)
            GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, posBuf)
            GLES20.glEnableVertexAttribArray(aUv)
            GLES20.glVertexAttribPointer(aUv, 2, GLES20.GL_FLOAT, false, 0, uvFboUpBuf)
            if (aOvUv >= 0) {
                GLES20.glEnableVertexAttribArray(aOvUv)
                GLES20.glVertexAttribPointer(aOvUv, 2, GLES20.GL_FLOAT, false, 0, uvFboUpBuf)
            }
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

            EGLExt.eglPresentationTimeANDROID(eglDisplay, eglSurface, ptsNs)
            EGL14.eglSwapBuffers(eglDisplay, eglSurface)
        }

        private fun renderOesQuad() {
            GLES20.glUseProgram(oesProg)
            val combined = FloatArray(16)
            Matrix.multiplyMM(combined, 0, stMatrix, 0, cropRotMatrix, 0)
            GLES20.glUniformMatrix4fv(GLES20.glGetUniformLocation(oesProg, "uTexM"), 1, false, combined, 0)

            GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, oesTexId)
            GLES20.glUniform1i(GLES20.glGetUniformLocation(oesProg, "uVideoTex"), 0)

            if (overlayTexId != 0) {
                GLES20.glActiveTexture(GLES20.GL_TEXTURE1)
                GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, overlayTexId)
                GLES20.glUniform1i(GLES20.glGetUniformLocation(oesProg, "uOverlayTex"), 1)
            }

            val aPos = GLES20.glGetAttribLocation(oesProg, "aPos")
            val aUv = GLES20.glGetAttribLocation(oesProg, "aUv")
            val aOvUv = GLES20.glGetAttribLocation(oesProg, "aOvUv")
            GLES20.glEnableVertexAttribArray(aPos)
            GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, posBuf)
            GLES20.glEnableVertexAttribArray(aUv)
            GLES20.glVertexAttribPointer(aUv, 2, GLES20.GL_FLOAT, false, 0, uvVideoBuf)
            if (aOvUv >= 0) {
                GLES20.glEnableVertexAttribArray(aOvUv)
                GLES20.glVertexAttribPointer(aOvUv, 2, GLES20.GL_FLOAT, false, 0, uvOverlayBuf)
            }
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        }

        fun release() {
            try { decoderSurface.release() } catch (_: Exception) { }
            try { surfaceTexture.release() } catch (_: Exception) { }
            try { waitThread.quitSafely() } catch (_: Exception) { }
            try {
                if (revFbo != 0) GLES20.glDeleteFramebuffers(1, intArrayOf(revFbo), 0)
                if (revTex != 0) GLES20.glDeleteTextures(1, intArrayOf(revTex), 0)
                if (overlayTexId != 0) GLES20.glDeleteTextures(1, intArrayOf(overlayTexId), 0)
                GLES20.glDeleteTextures(1, intArrayOf(oesTexId), 0)
            } catch (_: Exception) { }
            try {
                EGL14.eglMakeCurrent(eglDisplay, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_SURFACE, EGL14.EGL_NO_CONTEXT)
                EGL14.eglDestroySurface(eglDisplay, eglSurface)
                EGL14.eglDestroyContext(eglDisplay, eglContext)
                EGL14.eglTerminate(eglDisplay)
            } catch (_: Exception) { }
        }

        private fun floatBuf(arr: FloatArray): FloatBuffer =
            ByteBuffer.allocateDirect(arr.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().apply {
                put(arr); position(0)
            }

        private fun linkProgram(vs: String, fs: String): Int {
            val v = compile(GLES20.GL_VERTEX_SHADER, vs)
            val f = compile(GLES20.GL_FRAGMENT_SHADER, fs)
            val p = GLES20.glCreateProgram()
            GLES20.glAttachShader(p, v)
            GLES20.glAttachShader(p, f)
            GLES20.glLinkProgram(p)
            GLES20.glDeleteShader(v)
            GLES20.glDeleteShader(f)
            return p
        }

        private fun compile(type: Int, src: String): Int {
            val s = GLES20.glCreateShader(type)
            GLES20.glShaderSource(s, src)
            GLES20.glCompileShader(s)
            return s
        }

        companion object {
            private const val VS_QUAD = """
                attribute vec2 aPos;
                attribute vec2 aUv;
                attribute vec2 aOvUv;
                uniform mat4 uTexM;
                varying vec2 vUv;
                varying vec2 vOvUv;
                void main() {
                    gl_Position = vec4(aPos, 0.0, 1.0);
                    vUv = (uTexM * vec4(aUv, 0.0, 1.0)).xy;
                    vOvUv = aOvUv;
                }
            """

            private const val FS_PASSTHROUGH_2D = """
                precision mediump float;
                uniform sampler2D uTex;
                varying vec2 vUv;
                void main() {
                    gl_FragColor = texture2D(uTex, vUv);
                }
            """

            private fun fsOes(look: ColorLook, hasOverlay: Boolean): String {
                val colorFn = when (look) {
                    ColorLook.NATURAL -> ""
                    ColorLook.GLAM_BW -> """
                        float luma = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                        c.rgb = vec3(clamp((luma - 0.5) * 1.16 + 0.52, 0.0, 1.0));
                    """
                    ColorLook.WARM_GLOW -> """
                        c.r = clamp(c.r * 1.08 + 0.02, 0.0, 1.0);
                        c.g = clamp(c.g * 1.02 + 0.005, 0.0, 1.0);
                        c.b = clamp(c.b * 0.90, 0.0, 1.0);
                        float lumaW = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                        c.rgb = clamp(mix(vec3(lumaW), c.rgb, 1.24), 0.0, 1.0);
                    """
                    ColorLook.VIBRANT -> """
                        float lumaV = dot(c.rgb, vec3(0.299, 0.587, 0.114));
                        c.rgb = clamp(mix(vec3(lumaV), c.rgb, 1.26), 0.0, 1.0);
                        c.rgb = clamp((c.rgb - 0.5) * 1.08 + 0.5, 0.0, 1.0);
                    """
                }
                val ovCode = if (hasOverlay) """
                    vec4 ov = texture2D(uOverlayTex, vOvUv);
                    c.rgb = clamp(c.rgb * (1.0 - ov.a) + ov.rgb, 0.0, 1.0);
                """ else ""
                val ovDecl = if (hasOverlay) "uniform sampler2D uOverlayTex;" else ""

                return """
                    #extension GL_OES_EGL_image_external : require
                    precision mediump float;
                    uniform samplerExternalOES uVideoTex;
                    $ovDecl
                    varying vec2 vUv;
                    varying vec2 vOvUv;
                    void main() {
                        vec4 c = texture2D(uVideoTex, vUv);
                        $colorFn
                        $ovCode
                        gl_FragColor = vec4(c.rgb, 1.0);
                    }
                """
            }
        }
    }
}
