import UIKit

/// Entry gate for the standalone "360 Arm Cam" iOS app.
///
/// - First launch (unactivated): shows a branded dark-charcoal Activation screen where the operator
///   enters their rental/lifetime code with `-360` (e.g. `PB-XXXX-XXXX-XXXX-360`) to unlock
///   Standalone 360 **without occupying any booth device slot** — or taps "Pair to Laptop 360 Desk"
///   for free companion pairing with no code required.
/// - Subsequent launches (already activated): skips straight into `SpinArmViewController` full-screen
///   so the live 360 camera preview appears immediately.
final class SpinArmGateViewController: UIViewController, UITextFieldDelegate {

    // Exact photobooth4u inverted dark palette
    private let bgCharcoal = UIColor(red: 0x1C / 255.0, green: 0x1A / 255.0, blue: 0x1E / 255.0, alpha: 1.0)
    private let cardSurface = UIColor(red: 0x26 / 255.0, green: 0x23 / 255.0, blue: 0x29 / 255.0, alpha: 1.0)
    private let borderColor = UIColor(red: 0x3A / 255.0, green: 0x35 / 255.0, blue: 0x40 / 255.0, alpha: 1.0)
    private let accentRed = UIColor(red: 0xC9 / 255.0, green: 0x3D / 255.0, blue: 0x27 / 255.0, alpha: 1.0)
    private let creamText = UIColor(red: 0xF5 / 255.0, green: 0xF1 / 255.0, blue: 0xEA / 255.0, alpha: 1.0)
    private let mutedText = UIColor(red: 0xB8 / 255.0, green: 0xB0 / 255.0, blue: 0xA8 / 255.0, alpha: 1.0)
    private let okGreen = UIColor(red: 0x34 / 255.0, green: 0xC7 / 255.0, blue: 0x59 / 255.0, alpha: 1.0)
    private let warnAmber = UIColor(red: 0xF5 / 255.0, green: 0xA6 / 255.0, blue: 0x23 / 255.0, alpha: 1.0)

    private var didAutoOpenCamera = false
    private var isBusy = false

    private let scrollView = UIScrollView()
    private let contentStack = UIStackView()

    // Activation card views
    private let activateCard = UIView()
    private let noticeLabel = UILabel()
    private let codeField = UITextField()
    private let suffixChipBtn = UIButton(type: .system)
    private let activateBtn = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let errorLabel = UILabel()

    // Active status card views (shown when returning from camera via ✕)
    private let activeCard = UIView()
    private let activeBadgeLabel = UILabel()
    private let slotFreePill = UILabel()
    private let activeCodeLabel = UILabel()
    private let activeRenterLabel = UILabel()
    private let warnLabel = UILabel()
    private let openCamBtn = UIButton(type: .system)
    private let deactivateBtn = UIButton(type: .system)

    // Companion shortcut
    private let deskCompanionBtn = UIButton(type: .system)
    private let footerLabel = UILabel()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = bgCharcoal
        buildUI()
        refreshState()

        let tap = UITapGestureRecognizer(target: self, action: #selector(dismissKeyboard))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        refreshState()
        if !didAutoOpenCamera {
            let st = AppLicence.shared.status()
            if st.ok && AppLicence.shared.hasSpin360Entitlement() {
                didAutoOpenCamera = true
                openSpinArmCamera(standaloneAllowed: true, animated: false)
                performBackgroundCheckinIfNeeded()
            }
        }
    }

    func performBackgroundCheckinIfNeeded() {
        let st = AppLicence.shared.status()
        guard st.ok else { return }
        AppLicence.shared.checkin(force: false) { [weak self] result in
            guard let self = self else { return }
            if result == "revoked" {
                if let presented = self.presentedViewController as? SpinArmViewController {
                    presented.dismiss(animated: true) { [weak self] in
                        self?.refreshState()
                    }
                } else {
                    self.refreshState()
                }
            } else {
                self.refreshState()
            }
        }
    }

    // MARK: - UI Construction

    private func buildUI() {
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.alwaysBounceVertical = true
        scrollView.keyboardDismissMode = .interactive
        view.addSubview(scrollView)

        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(container)

        contentStack.axis = .vertical
        contentStack.spacing = 16
        contentStack.alignment = .fill
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(contentStack)

        NSLayoutConstraint.activate([
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scrollView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),

            container.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor),
            container.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor),
            container.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor),
            container.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor),

            contentStack.topAnchor.constraint(equalTo: container.topAnchor, constant: 28),
            contentStack.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            contentStack.widthAnchor.constraint(lessThanOrEqualToConstant: 440),
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: container.leadingAnchor, constant: 20),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: container.trailingAnchor, constant: -20),
            contentStack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -28)
        ])
        let prefWidth = contentStack.widthAnchor.constraint(equalTo: container.widthAnchor, constant: -40)
        prefWidth.priority = .defaultHigh
        prefWidth.isActive = true

        // Brand Header
        contentStack.addArrangedSubview(buildHeader())

        // Activation Card (shown when not activated)
        buildActivateCard()
        contentStack.addArrangedSubview(activateCard)

        // Active Licence Card (shown when activated and user tapped ✕ from camera)
        buildActiveCard()
        contentStack.addArrangedSubview(activeCard)

        // Divider + Free Laptop 360 Desk Companion shortcut
        let divRow = UIStackView()
        divRow.axis = .horizontal
        divRow.alignment = .center
        divRow.spacing = 10
        let leftLine = makeLine()
        let rightLine = makeLine()
        let orLbl = UILabel()
        orLbl.text = "or pair with a laptop"
        orLbl.font = .systemFont(ofSize: 12, weight: .medium)
        orLbl.textColor = mutedText
        divRow.addArrangedSubview(leftLine)
        divRow.addArrangedSubview(orLbl)
        divRow.addArrangedSubview(rightLine)
        leftLine.widthAnchor.constraint(equalTo: rightLine.widthAnchor).isActive = true
        contentStack.addArrangedSubview(divRow)

        deskCompanionBtn.setTitle("Pair to Laptop 360 Desk (No Code Needed)", for: .normal)
        deskCompanionBtn.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        deskCompanionBtn.setTitleColor(creamText, for: .normal)
        deskCompanionBtn.backgroundColor = cardSurface
        deskCompanionBtn.layer.cornerRadius = 14
        deskCompanionBtn.layer.borderWidth = 1
        deskCompanionBtn.layer.borderColor = borderColor.cgColor
        deskCompanionBtn.contentEdgeInsets = UIEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        deskCompanionBtn.addTarget(self, action: #selector(didTapDeskCompanion), for: .touchUpInside)
        contentStack.addArrangedSubview(deskCompanionBtn)

        footerLabel.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        footerLabel.textColor = mutedText.withAlphaComponent(0.75)
        footerLabel.textAlignment = .center
        footerLabel.numberOfLines = 2
        footerLabel.text = "Device ID: \(AppLicence.shared.machineId())  ·  v\(AppLicence.shared.appVersion())"
        contentStack.addArrangedSubview(footerLabel)
    }

    private func buildHeader() -> UIView {
        let stack = UIStackView()
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 8

        let badge = UIView()
        badge.translatesAutoresizingMaskIntoConstraints = false
        badge.backgroundColor = accentRed
        badge.layer.cornerRadius = 20
        badge.layer.borderWidth = 2
        badge.layer.borderColor = creamText.withAlphaComponent(0.22).cgColor
        NSLayoutConstraint.activate([
            badge.widthAnchor.constraint(equalToConstant: 72),
            badge.heightAnchor.constraint(equalToConstant: 72)
        ])

        let badgeLbl = UILabel()
        badgeLbl.text = "360°"
        badgeLbl.font = .systemFont(ofSize: 24, weight: .heavy)
        badgeLbl.textColor = creamText
        badgeLbl.translatesAutoresizingMaskIntoConstraints = false
        badge.addSubview(badgeLbl)
        NSLayoutConstraint.activate([
            badgeLbl.centerXAnchor.constraint(equalTo: badge.centerXAnchor),
            badgeLbl.centerYAnchor.constraint(equalTo: badge.centerYAnchor)
        ])

        let title = UILabel()
        title.text = "360 Arm Cam"
        title.font = .systemFont(ofSize: 28, weight: .bold)
        title.textColor = creamText
        title.textAlignment = .center

        let sub = UILabel()
        sub.text = "Standalone 360 Booth & Arm Camera · photobooth4u"
        sub.font = .systemFont(ofSize: 13, weight: .medium)
        sub.textColor = mutedText
        sub.textAlignment = .center
        sub.numberOfLines = 0

        stack.addArrangedSubview(badge)
        stack.addArrangedSubview(title)
        stack.addArrangedSubview(sub)
        return stack
    }

    private func buildActivateCard() {
        activateCard.backgroundColor = cardSurface
        activateCard.layer.cornerRadius = 18
        activateCard.layer.borderWidth = 1
        activateCard.layer.borderColor = borderColor.cgColor

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        activateCard.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: activateCard.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: activateCard.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: activateCard.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: activateCard.bottomAnchor, constant: -18)
        ])

        let title = UILabel()
        title.text = "Activate Standalone 360"
        title.font = .systemFont(ofSize: 18, weight: .bold)
        title.textColor = creamText
        stack.addArrangedSubview(title)

        let hint = UILabel()
        hint.text = "Enter your regular photobooth4u access code (e.g. PB-XXXX-XXXX-XXXX). Activating in 360 Arm Cam automatically uses 0 device slots on your account."
        hint.font = .systemFont(ofSize: 13, weight: .regular)
        hint.textColor = mutedText
        hint.numberOfLines = 0
        stack.addArrangedSubview(hint)

        noticeLabel.font = .systemFont(ofSize: 13, weight: .medium)
        noticeLabel.textColor = warnAmber
        noticeLabel.numberOfLines = 0
        noticeLabel.isHidden = true
        stack.addArrangedSubview(noticeLabel)

        codeField.delegate = self
        codeField.placeholder = "PB-XXXX-XXXX-XXXX"
        codeField.attributedPlaceholder = NSAttributedString(
            string: "PB-XXXX-XXXX-XXXX",
            attributes: [.foregroundColor: mutedText.withAlphaComponent(0.55)]
        )
        codeField.font = .monospacedSystemFont(ofSize: 16, weight: .semibold)
        codeField.textColor = creamText
        codeField.backgroundColor = bgCharcoal
        codeField.layer.cornerRadius = 12
        codeField.layer.borderWidth = 1
        codeField.layer.borderColor = borderColor.cgColor
        codeField.autocapitalizationType = .allCharacters
        codeField.autocorrectionType = .no
        codeField.spellCheckingType = .no
        codeField.returnKeyType = .go
        codeField.clearButtonMode = .whileEditing
        codeField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 14, height: 1))
        codeField.leftViewMode = .always
        codeField.heightAnchor.constraint(equalToConstant: 48).isActive = true
        codeField.addTarget(self, action: #selector(codeFieldChanged), for: .editingChanged)
        stack.addArrangedSubview(codeField)

        suffixChipBtn.setTitle("+ Add -360 (uses 0 device slots)", for: .normal)
        suffixChipBtn.titleLabel?.font = .systemFont(ofSize: 12, weight: .semibold)
        suffixChipBtn.setTitleColor(creamText, for: .normal)
        suffixChipBtn.backgroundColor = accentRed.withAlphaComponent(0.18)
        suffixChipBtn.layer.cornerRadius = 10
        suffixChipBtn.layer.borderWidth = 1
        suffixChipBtn.layer.borderColor = accentRed.withAlphaComponent(0.55).cgColor
        suffixChipBtn.contentEdgeInsets = UIEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        suffixChipBtn.contentHorizontalAlignment = .left
        suffixChipBtn.addTarget(self, action: #selector(didTapSuffixChip), for: .touchUpInside)
        stack.addArrangedSubview(suffixChipBtn)

        errorLabel.font = .systemFont(ofSize: 13, weight: .medium)
        errorLabel.textColor = UIColor(red: 1.0, green: 0.45, blue: 0.38, alpha: 1.0)
        errorLabel.numberOfLines = 0
        errorLabel.isHidden = true
        stack.addArrangedSubview(errorLabel)

        activateBtn.setTitle("Activate & Open Camera", for: .normal)
        activateBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        activateBtn.setTitleColor(creamText, for: .normal)
        activateBtn.backgroundColor = accentRed
        activateBtn.layer.cornerRadius = 13
        activateBtn.heightAnchor.constraint(equalToConstant: 50).isActive = true
        activateBtn.addTarget(self, action: #selector(didTapActivate), for: .touchUpInside)

        spinner.color = creamText
        spinner.hidesWhenStopped = true
        spinner.translatesAutoresizingMaskIntoConstraints = false
        activateBtn.addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerYAnchor.constraint(equalTo: activateBtn.centerYAnchor),
            spinner.trailingAnchor.constraint(equalTo: activateBtn.trailingAnchor, constant: -16)
        ])
        stack.addArrangedSubview(activateBtn)
    }

    private func buildActiveCard() {
        activeCard.backgroundColor = cardSurface
        activeCard.layer.cornerRadius = 18
        activeCard.layer.borderWidth = 1
        activeCard.layer.borderColor = okGreen.withAlphaComponent(0.45).cgColor

        let stack = UIStackView()
        stack.axis = .vertical
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        activeCard.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: activeCard.topAnchor, constant: 18),
            stack.leadingAnchor.constraint(equalTo: activeCard.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: activeCard.trailingAnchor, constant: -18),
            stack.bottomAnchor.constraint(equalTo: activeCard.bottomAnchor, constant: -18)
        ])

        let pillRow = UIStackView()
        pillRow.axis = .horizontal
        pillRow.spacing = 8
        pillRow.alignment = .center

        activeBadgeLabel.text = "✓ Standalone 360 Active"
        activeBadgeLabel.font = .systemFont(ofSize: 13, weight: .bold)
        activeBadgeLabel.textColor = okGreen

        slotFreePill.text = "0 slots used"
        slotFreePill.font = .systemFont(ofSize: 11, weight: .bold)
        slotFreePill.textColor = creamText
        slotFreePill.backgroundColor = accentRed.withAlphaComponent(0.28)
        slotFreePill.layer.cornerRadius = 8
        slotFreePill.layer.masksToBounds = true
        slotFreePill.textAlignment = .center
        slotFreePill.widthAnchor.constraint(greaterThanOrEqualToConstant: 84).isActive = true
        slotFreePill.heightAnchor.constraint(equalToConstant: 22).isActive = true

        pillRow.addArrangedSubview(activeBadgeLabel)
        pillRow.addArrangedSubview(UIView())
        pillRow.addArrangedSubview(slotFreePill)
        stack.addArrangedSubview(pillRow)

        activeCodeLabel.font = .monospacedSystemFont(ofSize: 17, weight: .bold)
        activeCodeLabel.textColor = creamText
        stack.addArrangedSubview(activeCodeLabel)

        activeRenterLabel.font = .systemFont(ofSize: 13, weight: .regular)
        activeRenterLabel.textColor = mutedText
        activeRenterLabel.numberOfLines = 0
        stack.addArrangedSubview(activeRenterLabel)

        warnLabel.font = .systemFont(ofSize: 12, weight: .medium)
        warnLabel.textColor = warnAmber
        warnLabel.numberOfLines = 0
        warnLabel.isHidden = true
        stack.addArrangedSubview(warnLabel)

        openCamBtn.setTitle("Open 360 Arm Cam", for: .normal)
        openCamBtn.titleLabel?.font = .systemFont(ofSize: 16, weight: .bold)
        openCamBtn.setTitleColor(creamText, for: .normal)
        openCamBtn.backgroundColor = accentRed
        openCamBtn.layer.cornerRadius = 13
        openCamBtn.heightAnchor.constraint(equalToConstant: 50).isActive = true
        openCamBtn.addTarget(self, action: #selector(didTapOpenActiveCamera), for: .touchUpInside)
        stack.addArrangedSubview(openCamBtn)

        deactivateBtn.setTitle("Switch or Deactivate Code", for: .normal)
        deactivateBtn.titleLabel?.font = .systemFont(ofSize: 14, weight: .semibold)
        deactivateBtn.setTitleColor(mutedText, for: .normal)
        deactivateBtn.backgroundColor = bgCharcoal
        deactivateBtn.layer.cornerRadius = 12
        deactivateBtn.layer.borderWidth = 1
        deactivateBtn.layer.borderColor = borderColor.cgColor
        deactivateBtn.heightAnchor.constraint(equalToConstant: 44).isActive = true
        deactivateBtn.addTarget(self, action: #selector(didTapDeactivate), for: .touchUpInside)
        stack.addArrangedSubview(deactivateBtn)
    }

    private func makeLine() -> UIView {
        let v = UIView()
        v.backgroundColor = borderColor
        v.heightAnchor.constraint(equalToConstant: 1).isActive = true
        return v
    }

    // MARK: - State & Helpers

    private func refreshState() {
        let st = AppLicence.shared.status()
        let entitled = st.ok && AppLicence.shared.hasSpin360Entitlement()

        activateCard.isHidden = entitled
        activeCard.isHidden = !entitled

        if entitled, let p = st.payload {
            let maskedCode = (p["code"] as? String) ?? "Activated"
            let renter = (p["renter"] as? String) ?? ""
            let feat = p["feat"] as? [String: Any]
            let isSlotFree = (feat?["spin360Only"] as? NSNumber)?.boolValue ?? false
            activeCodeLabel.text = maskedCode
            activeRenterLabel.text = renter.isEmpty ? "Standalone 360 & Laptop Desk ready." : "\(renter) · Standalone 360 ready."
            slotFreePill.isHidden = !isSlotFree
            warnLabel.text = st.warn
            warnLabel.isHidden = st.warn.isEmpty
        } else {
            if st.ok && !AppLicence.shared.hasSpin360Entitlement() {
                noticeLabel.text = "Your current code does not have 360 Video Booth enabled. Activate a code with 360 enabled (add -360 for zero device slots), or pair to Laptop 360 Desk below."
                noticeLabel.isHidden = false
            } else if !st.message.isEmpty && st.reason != "none" {
                noticeLabel.text = st.message
                noticeLabel.isHidden = false
            } else {
                noticeLabel.isHidden = true
            }
            updateSuffixChipTitle()
        }
    }

    private func has360Suffix(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        return trimmed.hasSuffix("-360")
    }

    private func updateSuffixChipTitle() {
        suffixChipBtn.setTitle("✓ Automatically uses 0 device slots (no -360 needed)", for: .normal)
        suffixChipBtn.setTitleColor(okGreen, for: .normal)
        suffixChipBtn.backgroundColor = okGreen.withAlphaComponent(0.14)
        suffixChipBtn.layer.borderColor = okGreen.withAlphaComponent(0.5).cgColor
        suffixChipBtn.isUserInteractionEnabled = false
    }

    private func configureSpinContext(standaloneAllowed: Bool) {
        var ctx = PBLocal.SpinCloudContext()
        ctx.standaloneAllowed = standaloneAllowed
        if standaloneAllowed {
            let st = AppLicence.shared.status()
            if let p = st.payload {
                let renter = (p["renter"] as? String) ?? ""
                let feat = p["feat"] as? [String: Any]
                let fk = (feat?["folderKey"] as? String) ?? (feat?["folderPrefix"] as? String) ?? renter
                ctx.folderKey = fk
                ctx.eventName = renter
            }
            ctx.licence = AppLicence.shared.currentLicenceString() ?? ""
            ctx.mid = AppLicence.shared.machineId()
        }
        PBLocal.shared.spinContext = ctx
    }

    private func openSpinArmCamera(standaloneAllowed: Bool, animated: Bool) {
        guard presentedViewController == nil else { return }
        configureSpinContext(standaloneAllowed: standaloneAllowed)
        _ = LocalShareServer.shared.start()
        let vc = SpinArmViewController()
        vc.modalPresentationStyle = .fullScreen
        vc.onDismiss = { [weak self] in
            self?.refreshState()
        }
        present(vc, animated: animated)
    }

    // MARK: - Actions

    @objc private func dismissKeyboard() {
        view.endEditing(true)
    }

    @objc private func codeFieldChanged() {
        errorLabel.isHidden = true
        updateSuffixChipTitle()
    }

    @objc private func didTapSuffixChip() {
        let raw = (codeField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if raw.isEmpty {
            codeField.becomeFirstResponder()
            return
        }
        if !raw.hasSuffix("-360") {
            let cleaned = raw.hasSuffix("-") ? String(raw.dropLast()) : raw
            codeField.text = cleaned + "-360"
        }
        errorLabel.isHidden = true
        updateSuffixChipTitle()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        didTapActivate()
        return true
    }

    @objc private func didTapActivate() {
        guard !isBusy else { return }
        view.endEditing(true)
        let code = (codeField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !code.isEmpty else {
            errorLabel.text = "Enter your activation code first."
            errorLabel.isHidden = false
            return
        }

        isBusy = true
        errorLabel.isHidden = true
        activateBtn.isEnabled = false
        activateBtn.setTitle("Activating…", for: .normal)
        spinner.startAnimating()

        AppLicence.shared.activate(code: code, spin360Companion: true) { [weak self] ok, err in
            guard let self = self else { return }
            self.isBusy = false
            self.activateBtn.isEnabled = true
            self.activateBtn.setTitle("Activate & Open Camera", for: .normal)
            self.spinner.stopAnimating()

            if !ok {
                self.errorLabel.text = err ?? "Activation failed. Check your code and Wi-Fi."
                self.errorLabel.isHidden = false
                return
            }

            self.refreshState()
            if AppLicence.shared.hasSpin360Entitlement() {
                self.didAutoOpenCamera = true
                self.openSpinArmCamera(standaloneAllowed: true, animated: true)
            } else {
                self.errorLabel.text = "360 Video Booth isn't enabled on this code yet."
                self.errorLabel.isHidden = false
            }
        }
    }

    @objc private func didTapOpenActiveCamera() {
        openSpinArmCamera(standaloneAllowed: true, animated: true)
    }

    @objc private func didTapDeskCompanion() {
        view.endEditing(true)
        didAutoOpenCamera = true
        openSpinArmCamera(standaloneAllowed: false, animated: true)
    }

    @objc private func didTapDeactivate() {
        let ac = UIAlertController(
            title: "Deactivate 360 Arm Cam?",
            message: "This removes the active code from this device so you can enter another code.",
            preferredStyle: .alert
        )
        ac.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        ac.addAction(UIAlertAction(title: "Deactivate", style: .destructive) { [weak self] _ in
            guard let self = self else { return }
            self.deactivateBtn.isEnabled = false
            self.deactivateBtn.setTitle("Deactivating…", for: .normal)
            AppLicence.shared.deactivate { [weak self] ok, err in
                guard let self = self else { return }
                self.deactivateBtn.isEnabled = true
                self.deactivateBtn.setTitle("Switch or Deactivate Code", for: .normal)
                if !ok {
                    let errAc = UIAlertController(title: "Could not deactivate", message: err ?? "Try again.", preferredStyle: .alert)
                    errAc.addAction(UIAlertAction(title: "OK", style: .default))
                    self.present(errAc, animated: true)
                    return
                }
                self.codeField.text = ""
                self.refreshState()
            }
        })
        present(ac, animated: true)
    }
}
