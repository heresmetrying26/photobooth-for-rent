package com.photobooth4u.booth

import android.app.AlertDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

/**
 * Entry gate for the standalone "360 Arm Cam" Android app (com.photobooth4u.spinarm).
 *
 * - First launch (unactivated): shows a branded dark-charcoal Activation screen where the operator
 *   enters their rental/lifetime code with `-360` (e.g. `PB-XXXX-XXXX-XXXX-360`) to unlock
 *   Standalone 360 without occupying any booth device slot — or taps "Pair to Laptop 360 Desk"
 *   for free companion pairing with no code required.
 * - Subsequent launches (already activated): launches straight into `SpinArmActivity` immediately
 *   so the live 360 camera appears right away, keeping this gate beneath so pressing ✕ / Back
 *   lets the operator check status or switch/deactivate codes cleanly.
 */
class SpinArmGateActivity : AppCompatActivity() {

    companion object {
        private const val BG_CHARCOAL = 0xFF1C1A1E.toInt()
        private const val CARD_SURFACE = 0xFF262329.toInt()
        private const val BORDER_COL = 0xFF3A3540.toInt()
        private const val ACCENT_RED = 0xFFC93D27.toInt()
        private const val CREAM_TEXT = 0xFFF5F1EA.toInt()
        private const val MUTED_TEXT = 0xFFB8B0A8.toInt()
        private const val OK_GREEN = 0xFF34C759.toInt()
        private const val WARN_AMBER = 0xFFF5A623.toInt()
        private const val ERR_RED = 0xFFFF7361.toInt()
    }

    private lateinit var lic: AppLicence
    private var isBusy = false
    private var didAutoOpenCamera = false

    // Activation card views
    private lateinit var activateCard: LinearLayout
    private lateinit var noticeLabel: TextView
    private lateinit var codeField: EditText
    private lateinit var suffixChipBtn: Button
    private lateinit var errorLabel: TextView
    private lateinit var activateBtn: Button

    // Active status card views
    private lateinit var activeCard: LinearLayout
    private lateinit var slotFreePill: TextView
    private lateinit var activeCodeLabel: TextView
    private lateinit var activeRenterLabel: TextView
    private lateinit var warnLabel: TextView
    private lateinit var openCamBtn: Button
    private lateinit var deactivateBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = BG_CHARCOAL
        window.navigationBarColor = BG_CHARCOAL

        lic = AppLicence(applicationContext)
        setContentView(buildUi())
        refreshState()

        val st = lic.status()
        if (st.ok && lic.hasSpin360Entitlement()) {
            didAutoOpenCamera = true
            openSpinArmCamera(standaloneAllowed = true, immediate = true)
            runBackgroundCheckin()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshState()
        if (didAutoOpenCamera && lic.status().ok) {
            runBackgroundCheckin()
        }
    }

    private fun runBackgroundCheckin() {
        lic.checkin(force = false) { res ->
            if (!isFinishing && !isDestroyed) {
                refreshState()
                if (res == "revoked") {
                    didAutoOpenCamera = false
                }
            }
        }
    }

    private fun dp(v: Int): Int = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics
    ).toInt()

    private fun roundedBg(fill: Int, stroke: Int = Color.TRANSPARENT, strokeDp: Int = 1, radiusDp: Int = 14): GradientDrawable {
        return GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(radiusDp).toFloat()
            setColor(fill)
            if (stroke != Color.TRANSPARENT) {
                setStroke(dp(strokeDp), stroke)
            }
        }
    }

    private fun buildUi(): View {
        val scroll = ScrollView(this).apply {
            setBackgroundColor(BG_CHARCOAL)
            isFillViewport = true
        }

        val outer = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(dp(20), dp(28), dp(20), dp(28))
        }

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply {
                val maxW = dp(440)
                if (resources.displayMetrics.widthPixels > maxW + dp(40)) {
                    width = maxW
                }
            }
        }

        // Brand Header
        column.addView(buildHeader())

        // Activation Card
        activateCard = buildActivateCard()
        column.addView(activateCard, topMarginParams(18))

        // Active Licence Card
        activeCard = buildActiveCard()
        column.addView(activeCard, topMarginParams(18))

        // Divider
        val divRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        val leftLine = View(this).apply {
            setBackgroundColor(BORDER_COL)
            layoutParams = LinearLayout.LayoutParams(0, dp(1), 1f)
        }
        val orLbl = TextView(this).apply {
            text = "  or pair with a laptop  "
            setTextColor(MUTED_TEXT)
            textSize = 12f
        }
        val rightLine = View(this).apply {
            setBackgroundColor(BORDER_COL)
            layoutParams = LinearLayout.LayoutParams(0, dp(1), 1f)
        }
        divRow.addView(leftLine)
        divRow.addView(orLbl)
        divRow.addView(rightLine)
        column.addView(divRow, topMarginParams(18))

        // Free Laptop 360 Desk Companion shortcut
        val deskBtn = Button(this).apply {
            text = "Pair to Laptop 360 Desk (No Code Needed)"
            isAllCaps = false
            setTextColor(CREAM_TEXT)
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBg(CARD_SURFACE, BORDER_COL, 1, 14)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setOnClickListener {
                hideKeyboard()
                didAutoOpenCamera = true
                openSpinArmCamera(standaloneAllowed = false, immediate = false)
            }
        }
        column.addView(deskBtn, topMarginParams(14))

        // Device ID footer
        val footer = TextView(this).apply {
            text = "Device ID: ${lic.machineId()}  ·  v${lic.appVersion()}"
            setTextColor(0xB8B8B0A8.toInt())
            textSize = 11f
            typeface = Typeface.MONOSPACE
            gravity = Gravity.CENTER
        }
        column.addView(footer, topMarginParams(18))

        outer.addView(column)
        scroll.addView(outer)
        return scroll
    }

    private fun buildHeader(): View {
        val header = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val badge = TextView(this).apply {
            text = "360°"
            setTextColor(CREAM_TEXT)
            textSize = 23f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            background = roundedBg(ACCENT_RED, 0x38F5F1EA, 2, 20)
            layoutParams = LinearLayout.LayoutParams(dp(72), dp(72))
        }
        header.addView(badge)

        val title = TextView(this).apply {
            text = "360 Arm Cam"
            setTextColor(CREAM_TEXT)
            textSize = 27f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
        }
        header.addView(title, topMarginParams(10))

        val sub = TextView(this).apply {
            text = "Standalone 360 Booth & Arm Camera · photobooth4u"
            setTextColor(MUTED_TEXT)
            textSize = 13f
            gravity = Gravity.CENTER
        }
        header.addView(sub, topMarginParams(4))

        return header
    }

    private fun buildActivateCard(): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(CARD_SURFACE, BORDER_COL, 1, 18)
            setPadding(dp(18), dp(18), dp(18), dp(18))
        }

        val title = TextView(this).apply {
            text = "Activate Standalone 360"
            setTextColor(CREAM_TEXT)
            textSize = 18f
            typeface = Typeface.DEFAULT_BOLD
        }
        card.addView(title)

        val hint = TextView(this).apply {
            text = "Enter your photobooth4u code with -360 at the end (e.g. PB-XXXX-XXXX-XXXX-360) so this phone does not use a device slot on your account."
            setTextColor(MUTED_TEXT)
            textSize = 13f
        }
        card.addView(hint, topMarginParams(8))

        noticeLabel = TextView(this).apply {
            setTextColor(WARN_AMBER)
            textSize = 13f
            visibility = View.GONE
        }
        card.addView(noticeLabel, topMarginParams(10))

        codeField = EditText(this).apply {
            setHint("PB-XXXX-XXXX-XXXX-360")
            setHintTextColor(0x88B8B0A8.toInt())
            setTextColor(CREAM_TEXT)
            textSize = 16f
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_GO
            isSingleLine = true
            background = roundedBg(BG_CHARCOAL, BORDER_COL, 1, 12)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            setOnEditorActionListener { _, actionId, _ ->
                if (actionId == EditorInfo.IME_ACTION_GO || actionId == EditorInfo.IME_ACTION_DONE) {
                    submitActivation()
                    true
                } else {
                    false
                }
            }
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {
                    errorLabel.visibility = View.GONE
                    updateSuffixChip()
                }
                override fun afterTextChanged(s: Editable?) {}
            })
        }
        card.addView(codeField, topMarginParams(12))

        suffixChipBtn = Button(this).apply {
            isAllCaps = false
            textSize = 12f
            typeface = Typeface.DEFAULT_BOLD
            gravity = Gravity.START or Gravity.CENTER_VERTICAL
            setPadding(dp(12), dp(8), dp(12), dp(8))
            setOnClickListener {
                val raw = (codeField.text?.toString() ?: "").trim().uppercase()
                if (raw.isEmpty()) {
                    codeField.requestFocus()
                    return@setOnClickListener
                }
                if (!raw.endsWith("-360")) {
                    val clean = if (raw.endsWith("-")) raw.dropLast(1) else raw
                    codeField.setText("$clean-360")
                    codeField.setSelection(codeField.text.length)
                }
                errorLabel.visibility = View.GONE
                updateSuffixChip()
            }
        }
        card.addView(suffixChipBtn, topMarginParams(10))

        errorLabel = TextView(this).apply {
            setTextColor(ERR_RED)
            textSize = 13f
            visibility = View.GONE
        }
        card.addView(errorLabel, topMarginParams(8))

        activateBtn = Button(this).apply {
            text = "Activate & Open Camera"
            isAllCaps = false
            setTextColor(CREAM_TEXT)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBg(ACCENT_RED, Color.TRANSPARENT, 0, 13)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setOnClickListener { submitActivation() }
        }
        card.addView(activateBtn, topMarginParams(12))

        updateSuffixChip()
        return card
    }

    private fun buildActiveCard(): LinearLayout {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedBg(CARD_SURFACE, 0x7334C759, 1, 18)
            setPadding(dp(18), dp(18), dp(18), dp(18))
            visibility = View.GONE
        }

        val topRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val activeBadge = TextView(this).apply {
            text = "✓ Standalone 360 Active"
            setTextColor(OK_GREEN)
            textSize = 13f
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        }
        slotFreePill = TextView(this).apply {
            text = "0 slots used"
            setTextColor(CREAM_TEXT)
            textSize = 11f
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBg(0x47C93D27, Color.TRANSPARENT, 0, 8)
            setPadding(dp(10), dp(4), dp(10), dp(4))
        }
        topRow.addView(activeBadge)
        topRow.addView(slotFreePill)
        card.addView(topRow)

        activeCodeLabel = TextView(this).apply {
            setTextColor(CREAM_TEXT)
            textSize = 17f
            typeface = Typeface.MONOSPACE
        }
        card.addView(activeCodeLabel, topMarginParams(10))

        activeRenterLabel = TextView(this).apply {
            setTextColor(MUTED_TEXT)
            textSize = 13f
        }
        card.addView(activeRenterLabel, topMarginParams(4))

        warnLabel = TextView(this).apply {
            setTextColor(WARN_AMBER)
            textSize = 12f
            visibility = View.GONE
        }
        card.addView(warnLabel, topMarginParams(8))

        openCamBtn = Button(this).apply {
            text = "Open 360 Arm Cam"
            isAllCaps = false
            setTextColor(CREAM_TEXT)
            textSize = 16f
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBg(ACCENT_RED, Color.TRANSPARENT, 0, 13)
            setPadding(dp(16), dp(14), dp(16), dp(14))
            setOnClickListener {
                openSpinArmCamera(standaloneAllowed = true, immediate = false)
            }
        }
        card.addView(openCamBtn, topMarginParams(14))

        deactivateBtn = Button(this).apply {
            text = "Switch or Deactivate Code"
            isAllCaps = false
            setTextColor(MUTED_TEXT)
            textSize = 14f
            typeface = Typeface.DEFAULT_BOLD
            background = roundedBg(BG_CHARCOAL, BORDER_COL, 1, 12)
            setPadding(dp(14), dp(12), dp(14), dp(12))
            setOnClickListener { confirmDeactivate() }
        }
        card.addView(deactivateBtn, topMarginParams(10))

        return card
    }

    private fun topMarginParams(dpTop: Int): LinearLayout.LayoutParams {
        return LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            LinearLayout.LayoutParams.WRAP_CONTENT
        ).apply {
            topMargin = dp(dpTop)
        }
    }

    private fun updateSuffixChip() {
        val txt = (codeField.text?.toString() ?: "").trim().uppercase()
        if (txt.endsWith("-360")) {
            suffixChipBtn.text = "✓ -360 suffix added · uses 0 device slots"
            suffixChipBtn.setTextColor(OK_GREEN)
            suffixChipBtn.background = roundedBg(0x2434C759, 0x8034C759.toInt(), 1, 10)
        } else {
            suffixChipBtn.text = "+ Add -360 (uses 0 device slots)"
            suffixChipBtn.setTextColor(CREAM_TEXT)
            suffixChipBtn.background = roundedBg(0x2EC93D27, 0x8CC93D27.toInt(), 1, 10)
        }
    }

    private fun refreshState() {
        val st = lic.status()
        val entitled = st.ok && lic.hasSpin360Entitlement()

        activateCard.visibility = if (entitled) View.GONE else View.VISIBLE
        activeCard.visibility = if (entitled) View.VISIBLE else View.GONE

        if (entitled && st.payload != null) {
            val p = st.payload
            val masked = p.optString("code", "Activated")
            val renter = p.optString("renter", "")
            val isSlotFree = p.optJSONObject("feat")?.optBoolean("spin360Only", false) == true
            activeCodeLabel.text = masked
            activeRenterLabel.text = if (renter.isBlank()) "Standalone 360 & Laptop Desk ready." else "$renter · Standalone 360 ready."
            slotFreePill.visibility = if (isSlotFree) View.VISIBLE else View.GONE
            if (st.warn.isNotBlank()) {
                warnLabel.text = st.warn
                warnLabel.visibility = View.VISIBLE
            } else {
                warnLabel.visibility = View.GONE
            }
        } else {
            if (st.ok && !lic.hasSpin360Entitlement()) {
                noticeLabel.text = "Your current code does not have 360 Video Booth enabled. Activate a code with 360 enabled (add -360 for zero device slots), or pair to Laptop 360 Desk below."
                noticeLabel.visibility = View.VISIBLE
            } else if (st.message.isNotBlank() && st.reason != "none") {
                noticeLabel.text = st.message
                noticeLabel.visibility = View.VISIBLE
            } else {
                noticeLabel.visibility = View.GONE
            }
            updateSuffixChip()
        }
    }

    private fun configureSpinContext(standaloneAllowed: Boolean) {
        if (!standaloneAllowed) {
            PBLocal.spinContext = PBLocal.SpinCloudContext(standaloneAllowed = false)
            return
        }
        val st = lic.status()
        val p = st.payload
        val renter = p?.optString("renter", "") ?: ""
        val feat = p?.optJSONObject("feat")
        val fk = feat?.optString("folderKey", "")?.takeIf { it.isNotBlank() && it != "null" }
            ?: feat?.optString("folderPrefix", "")?.takeIf { it.isNotBlank() && it != "null" }
            ?: renter
        PBLocal.spinContext = PBLocal.SpinCloudContext(
            folderKey = fk,
            eventName = renter,
            licence = lic.currentLicenceString() ?: "",
            mid = lic.machineId(),
            standaloneAllowed = true
        )
    }

    private fun openSpinArmCamera(standaloneAllowed: Boolean, immediate: Boolean) {
        configureSpinContext(standaloneAllowed)
        PBLocal.ensureActive(applicationContext)
        startActivity(Intent(this, SpinArmActivity::class.java))
        if (immediate) {
            @Suppress("DEPRECATION")
            overridePendingTransition(0, 0)
        }
    }

    private fun hideKeyboard() {
        val imm = getSystemService(INPUT_METHOD_SERVICE) as? InputMethodManager ?: return
        val v = currentFocus ?: window.decorView
        imm.hideSoftInputFromWindow(v.windowToken, 0)
    }

    private fun submitActivation() {
        if (isBusy) return
        hideKeyboard()
        val code = (codeField.text?.toString() ?: "").trim()
        if (code.isEmpty()) {
            errorLabel.text = "Enter your activation code first (add -360 to use 0 device slots)."
            errorLabel.visibility = View.VISIBLE
            return
        }

        isBusy = true
        errorLabel.visibility = View.GONE
        activateBtn.isEnabled = false
        activateBtn.text = "Activating…"

        lic.activate(code, spin360Companion = true) { ok, err ->
            if (isFinishing || isDestroyed) return@activate
            isBusy = false
            activateBtn.isEnabled = true
            activateBtn.text = "Activate & Open Camera"

            if (!ok) {
                errorLabel.text = err ?: "Activation failed. Check your code and Wi-Fi."
                errorLabel.visibility = View.VISIBLE
                return@activate
            }

            refreshState()
            if (lic.hasSpin360Entitlement()) {
                didAutoOpenCamera = true
                openSpinArmCamera(standaloneAllowed = true, immediate = false)
            } else {
                errorLabel.text = "360 Video Booth isn’t enabled on this code yet."
                errorLabel.visibility = View.VISIBLE
            }
        }
    }

    private fun confirmDeactivate() {
        AlertDialog.Builder(this)
            .setTitle("Deactivate 360 Arm Cam?")
            .setMessage("This removes the active code from this device so you can enter another code.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Deactivate") { _, _ ->
                deactivateBtn.isEnabled = false
                deactivateBtn.text = "Deactivating…"
                lic.deactivate { ok, err ->
                    if (isFinishing || isDestroyed) return@deactivate
                    deactivateBtn.isEnabled = true
                    deactivateBtn.text = "Switch or Deactivate Code"
                    if (!ok) {
                        AlertDialog.Builder(this)
                            .setTitle("Could not deactivate")
                            .setMessage(err ?: "Try again.")
                            .setPositiveButton("OK", null)
                            .show()
                        return@deactivate
                    }
                    codeField.setText("")
                    didAutoOpenCamera = false
                    refreshState()
                }
            }
            .show()
    }
}
