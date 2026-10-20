import AppKit

final class OnboardingView: NSView, NSTextFieldDelegate {
    private let field = NSSecureTextField()
    private let continueButton = ThemeButton(title: "Continue", role: .primary)
    private let onContinue: (String) -> Void
    private let onSkip: () -> Void

    private let ink = NSColor(srgbRed: 0.129, green: 0.110, blue: 0.086, alpha: 1)
    private let muted = NSColor(srgbRed: 0.431, green: 0.396, blue: 0.357, alpha: 1)
    private let card = NSColor(srgbRed: 0.969, green: 0.957, blue: 0.933, alpha: 1)
    private let line = NSColor(srgbRed: 0.847, green: 0.816, blue: 0.765, alpha: 1)
    private let background = NSColor(srgbRed: 0.906, green: 0.882, blue: 0.839, alpha: 1)

    init(initialKey: String = "", onContinue: @escaping (String) -> Void, onSkip: @escaping () -> Void) {
        self.onContinue = onContinue
        self.onSkip = onSkip
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        wantsLayer = true
        layer?.backgroundColor = background.cgColor

        let title = NSTextField(labelWithString: "Downloads Triage")
        title.font = NSFont(name: "Palatino-Roman", size: 36) ?? NSFont.systemFont(ofSize: 36, weight: .medium)
        title.textColor = ink
        title.translatesAutoresizingMaskIntoConstraints = false

        let intro = body("This app reads the Downloads folder on this Mac. Nothing is deleted until you confirm.")
        let jev = body("Jev is optional. Without a key, documents stay in Review. With a key, documents can be classified.")
        let whereTo = body("Create a key at typesafe.ai, then paste it here. The key stays on this Mac.")

        let link = ThemeButton(title: "Create a key", role: .link)
        link.target = self
        link.action = #selector(openKeyPage(_:))
        link.setAccessibilityIdentifier("onboarding-create-key")

        field.placeholderString = "Paste your Jev key"
        field.isBordered = false
        field.drawsBackground = true
        field.backgroundColor = card
        field.textColor = ink
        field.font = NSFont.systemFont(ofSize: 14)
        field.focusRingType = .none
        field.delegate = self
        field.translatesAutoresizingMaskIntoConstraints = false
        field.wantsLayer = true
        field.layer?.cornerRadius = 12
        field.layer?.borderWidth = 1
        field.layer?.borderColor = line.cgColor
        field.stringValue = initialKey
        field.setAccessibilityIdentifier("onboarding-key")

        continueButton.target = self
        continueButton.action = #selector(continueTapped(_:))
        continueButton.keyEquivalent = "\r"
        continueButton.isEnabled = !initialKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        continueButton.setAccessibilityIdentifier("onboarding-continue")

        let skip = ThemeButton(title: "Skip for now", role: .quiet)
        skip.target = self
        skip.action = #selector(skipTapped(_:))
        skip.setAccessibilityIdentifier("onboarding-skip")

        let actions = NSStackView(views: [skip, continueButton])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.distribution = .equalSpacing
        actions.translatesAutoresizingMaskIntoConstraints = false

        let column = NSStackView(views: [title, intro, jev, whereTo, link, field, actions])
        column.orientation = .vertical
        column.alignment = .leading
        column.spacing = 10
        column.setCustomSpacing(22, after: title)
        column.setCustomSpacing(18, after: whereTo)
        column.setCustomSpacing(14, after: link)
        column.setCustomSpacing(18, after: field)
        column.translatesAutoresizingMaskIntoConstraints = false

        let panel = NSView()
        panel.wantsLayer = true
        panel.layer?.backgroundColor = card.cgColor
        panel.layer?.cornerRadius = 18
        panel.layer?.borderWidth = 1
        panel.layer?.borderColor = line.cgColor
        panel.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(column)
        addSubview(panel)

        NSLayoutConstraint.activate([
            panel.centerXAnchor.constraint(equalTo: centerXAnchor),
            panel.centerYAnchor.constraint(equalTo: centerYAnchor),
            panel.widthAnchor.constraint(equalToConstant: 440),
            column.topAnchor.constraint(equalTo: panel.topAnchor, constant: 28),
            column.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -24),
            column.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 28),
            column.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -28),
            field.widthAnchor.constraint(equalTo: column.widthAnchor),
            field.heightAnchor.constraint(equalToConstant: 36),
            actions.widthAnchor.constraint(equalTo: column.widthAnchor),
        ])
    }

    required init?(coder: NSCoder) { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.backgroundColor = background
    }

    func controlTextDidChange(_ obj: Notification) {
        continueButton.isEnabled = !field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    @objc private func openKeyPage(_ sender: Any?) {
        NSWorkspace.shared.open(URL(string: "https://typesafe.ai")!)
    }

    @objc private func continueTapped(_ sender: Any?) {
        let key = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { return }
        onContinue(key)
    }

    @objc private func skipTapped(_ sender: Any?) {
        onSkip()
    }

    private func body(_ text: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: text)
        label.font = NSFont.systemFont(ofSize: 14)
        label.textColor = muted
        label.preferredMaxLayoutWidth = 384
        label.translatesAutoresizingMaskIntoConstraints = false
        return label
    }
}

private final class ThemeButton: NSButton {
    enum Role { case primary, quiet, link }
    private let role: Role

    init(title: String, role: Role) {
        self.role = role
        super.init(frame: .zero)
        self.title = title
        isBordered = false
        wantsLayer = true
        translatesAutoresizingMaskIntoConstraints = false
        font = NSFont.systemFont(ofSize: role == .link ? 14 : 13, weight: role == .primary ? .semibold : .regular)
        setButtonType(.momentaryChange)
        if role == .primary {
            heightAnchor.constraint(equalToConstant: 34).isActive = true
            widthAnchor.constraint(greaterThanOrEqualToConstant: 108).isActive = true
        }
    }

    required init?(coder: NSCoder) { nil }

    override func draw(_ dirtyRect: NSRect) {
        let ink = NSColor(srgbRed: 0.129, green: 0.110, blue: 0.086, alpha: 1)
        let keep = NSColor(srgbRed: 0.141, green: 0.329, blue: 0.263, alpha: 1)
        let label: String
        switch role {
        case .primary:
            let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: rect, xRadius: rect.height / 2, yRadius: rect.height / 2)
            keep.withAlphaComponent(isEnabled ? 1 : 0.4).setFill()
            path.fill()
            label = title
            drawTitle(label, color: NSColor(srgbRed: 0.957, green: 0.980, blue: 0.965, alpha: 1), in: bounds)
        case .quiet:
            label = title
            drawTitle(label, color: ink.withAlphaComponent(0.72), in: bounds)
        case .link:
            let text = NSAttributedString(string: title, attributes: [
                .font: font as Any,
                .foregroundColor: keep,
                .underlineStyle: NSUnderlineStyle.single.rawValue,
            ])
            let size = text.size()
            text.draw(at: NSPoint(x: 0, y: (bounds.height - size.height) / 2))
        }
    }

    private func drawTitle(_ text: String, color: NSColor, in rect: NSRect) {
        let attributed = NSAttributedString(string: text, attributes: [
            .font: font as Any,
            .foregroundColor: color,
        ])
        let size = attributed.size()
        let origin = NSPoint(x: (rect.width - size.width) / 2, y: (rect.height - size.height) / 2)
        attributed.draw(at: origin)
    }

    override var intrinsicContentSize: NSSize {
        let size = (title as NSString).size(withAttributes: [.font: font as Any])
        if role == .link { return NSSize(width: size.width, height: 20) }
        if role == .quiet { return NSSize(width: size.width + 4, height: 34) }
        return NSSize(width: max(108, size.width + 36), height: 34)
    }
}
