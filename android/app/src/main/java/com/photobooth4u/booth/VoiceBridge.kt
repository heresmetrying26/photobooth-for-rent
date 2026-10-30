package com.photobooth4u.booth

import android.content.Context
import android.os.Bundle
import android.speech.tts.TextToSpeech
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale

/**
 * The spoken countdown ("Get ready... Three, Two, One... Smile!") for the booth page (window.__PBVoice).
 *
 * The WebView's own speech support is unreliable (often no voices), so the page asks the tablet's
 * text-to-speech engine through here. It works offline when the tablet has the voice downloaded
 * (Settings > System > Languages > Text-to-speech output).
 */
class VoiceBridge(ctx: Context) {

    companion object {
        private const val TAG = "VoiceBridge"
    }

    @Volatile
    private var ready = false
    private var tts: TextToSpeech? = null
    private var currentVoice = ""

    init {
        try {
            tts = TextToSpeech(ctx.applicationContext) { status ->
                ready = status == TextToSpeech.SUCCESS
                if (!ready) Log.w(TAG, "Text-to-speech is not available (status $status)")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not start text-to-speech", e)
        }
    }

    /** Is the tablet's text-to-speech engine up? */
    @JavascriptInterface
    fun available(): Boolean = ready

    /** The installed voices for a language ("en" or "fil"), as JSON: [{name, lang, local}]. */
    @JavascriptInterface
    fun voices(lang: String?): String {
        val engine = tts
        val arr = JSONArray()
        if (!ready || engine == null) return arr.toString()
        val want = (lang ?: "en").lowercase(Locale.ROOT)
        try {
            val list = engine.voices ?: return arr.toString()
            for (v in list) {
                val l = v.locale.language.lowercase(Locale.ROOT)
                val match = if (want == "fil") (l == "fil" || l == "tl") else l == "en"
                if (!match) continue
                if (v.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true) continue
                arr.put(
                    JSONObject()
                        .put("name", v.name)
                        .put("lang", v.locale.toLanguageTag())
                        .put("local", !v.isNetworkConnectionRequired)
                )
            }
        } catch (e: Exception) {
            Log.w(TAG, "Could not list the voices", e)
        }
        return arr.toString()
    }

    /** Says [text] now (anything still being said is cut off). [volume] is 0 to 1. */
    @JavascriptInterface
    fun speak(text: String?, voice: String?, volume: Double): Boolean {
        val engine = tts
        if (!ready || engine == null || text.isNullOrBlank()) return false
        return try {
            if (!voice.isNullOrEmpty() && voice != currentVoice) {
                val v = engine.voices?.firstOrNull { it.name == voice }
                if (v != null) {
                    engine.setVoice(v)
                    currentVoice = voice
                }
            }
            val params = Bundle()
            params.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.coerceIn(0.0, 1.0).toFloat())
            engine.speak(text, TextToSpeech.QUEUE_FLUSH, params, "pb" + System.nanoTime()) == TextToSpeech.SUCCESS
        } catch (e: Exception) {
            Log.w(TAG, "Could not speak", e)
            false
        }
    }

    /** Stops whatever is being said. */
    @JavascriptInterface
    fun stop() {
        try { tts?.stop() } catch (e: Exception) { Log.w(TAG, "Could not stop", e) }
    }

    fun shutdown() {
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (e: Exception) {
            Log.w(TAG, "Could not shut text-to-speech down", e)
        }
        tts = null
        ready = false
    }
}
