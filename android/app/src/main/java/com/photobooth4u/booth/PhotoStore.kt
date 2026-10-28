package com.photobooth4u.booth

import android.content.Context
import android.os.Environment
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.SecureRandom
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Event folders on the tablet (same shape as desktop/lib/photos.mjs).
 * Photos live in app storage under Pictures/photobooth4u/.
 */
class PhotoStore(context: Context) {
    private val root: File = File(
        context.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: context.filesDir,
        "photobooth4u"
    )
    private val indexFile = File(context.filesDir, "folders.json")
    private val folders = LinkedHashMap<String, Folder>()
    private val lock = Any()

    data class Folder(
        val slug: String,
        val id: String,
        val name: String,
        val sub: String,
        val rootPath: String
    ) {
        fun dir(): File {
            val base = File(rootPath, name)
            return if (sub.isNotEmpty()) File(base, sub) else base
        }

        fun displayName(): String = if (sub.isNotEmpty()) "$name / $sub" else name
    }

    init {
        root.mkdirs()
        loadIndex()
    }

    fun folder(slug: String): Folder? = synchronized(lock) { folders[slug] }

    fun photosIn(dir: File): List<File> {
        val names = dir.listFiles() ?: return emptyList()
        return names.filter { it.isFile && IMG_RE.matches(it.name) && !it.name.startsWith(".") }
            .sortedByDescending { it.lastModified() }
    }

    fun driveRequest(rawJson: String): String {
        return try {
            val body = JSONObject(rawJson)
            val result = synchronized(lock) { handle(body) }
            result.toString()
        } catch (e: Exception) {
            JSONObject().put("ok", false).put("error", e.message ?: "Bad request").toString()
        }
    }

    private fun handle(body: JSONObject): JSONObject {
        val folderKey = body.optString("folderKey", "")
        val subfolder = body.optString("subfolder", "")
        val f = folderFor(folderKey, subfolder)
        val folderUrl = "pb4u-local:" + f.slug
        if (body.optBoolean("resolveOnly")) {
            return JSONObject()
                .put("ok", true)
                .put("folderUrl", folderUrl)
                .put("folderName", f.displayName())
                .put("nextSessionNumber", nextSession(f.dir()))
                .put("folderPath", f.dir().absolutePath)
        }
        val b64 = body.optString("imageBase64", "")
        if (!BASE64_RE.matches(b64.replace("\\s".toRegex(), ""))) {
            return JSONObject().put("ok", false).put("error", "No photo")
        }
        var name = safeName(body.optString("filename", "")).ifEmpty { "photo-${System.currentTimeMillis()}.jpg" }
        name = File(name).name
        if (!IMG_RE.matches(name)) name += ".jpg"
        val dir = f.dir()
        dir.mkdirs()
        var out = name
        var i = 2
        while (File(dir, out).exists()) {
            out = name.replace(Regex("(\\.[a-zA-Z0-9]+)$"), " ($i)$1")
            i++
        }
        val bytes = Base64.decode(b64, Base64.DEFAULT)
        File(dir, out).writeBytes(bytes)
        return JSONObject()
            .put("ok", true)
            .put("fileId", f.slug + "/" + out)
            .put("downloadUrl", "pb4u-local:" + f.slug + "/" + out)
            .put("folderUrl", folderUrl)
            .put("folderName", f.displayName())
            .put("folderPath", dir.absolutePath)
    }

    private fun folderFor(folderKey: String, subfolder: String): Folder {
        val name = safeName(folderKey).ifEmpty { "Photobooth " + today() }
        val sub = safeName(subfolder)
        val id = (name + if (sub.isNotEmpty()) "/$sub" else "").lowercase(Locale.US)
        val existing = folders.values.find { it.id == id && it.rootPath == root.absolutePath }
        if (existing != null) {
            existing.dir().mkdirs()
            return existing
        }
        val slug = randomSlug()
        val f = Folder(slug, id, name, sub, root.absolutePath)
        folders[slug] = f
        saveIndex()
        f.dir().mkdirs()
        return f
    }

    private fun nextSession(dir: File): Int {
        var max = 0
        for (file in photosIn(dir)) {
            val m = SESSION_RE.find(file.name) ?: continue
            max = maxOf(max, m.groupValues[1].toInt())
        }
        return max + 1
    }

    private fun loadIndex() {
        if (!indexFile.exists()) return
        try {
            val obj = JSONObject(indexFile.readText())
            val map = obj.optJSONObject("folders") ?: return
            val keys = map.keys()
            while (keys.hasNext()) {
                val slug = keys.next()
                val f = map.getJSONObject(slug)
                folders[slug] = Folder(
                    slug = slug,
                    id = f.optString("id"),
                    name = f.optString("name"),
                    sub = f.optString("sub"),
                    rootPath = f.optString("root", root.absolutePath)
                )
            }
        } catch (_: Exception) { /* start empty */ }
    }

    private fun saveIndex() {
        val map = JSONObject()
        for ((slug, f) in folders) {
            map.put(
                slug,
                JSONObject()
                    .put("id", f.id)
                    .put("name", f.name)
                    .put("sub", f.sub)
                    .put("root", f.rootPath)
                    .put("at", System.currentTimeMillis())
            )
        }
        indexFile.writeText(JSONObject().put("folders", map).toString())
    }

    companion object {
        private val IMG_RE = Regex(".*\\.(jpe?g|png|webp|gif|mp4|webm)$", RegexOption.IGNORE_CASE)
        private val BASE64_RE = Regex("^[A-Za-z0-9+/=]+$")
        private val SESSION_RE = Regex("^(?:BONUS_)?(\\d+)_")

        private fun today(): String = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())

        private fun safeName(v: String): String {
            return v.replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001f]"), " ")
                .replace(Regex("\\s+"), " ")
                .trim()
                .trim('.', ' ')
                .take(80)
        }

        private fun randomSlug(): String {
            val bytes = ByteArray(8)
            SecureRandom().nextBytes(bytes)
            return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
                .replace("-", "x")
                .replace("_", "x")
        }
    }
}
