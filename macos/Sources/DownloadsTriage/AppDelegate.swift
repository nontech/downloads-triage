import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var webView: AppWebView!
    private var statusLabel: NSTextField!
    private var server: ServerProcess?
    private let bridge = MenuBridge()
    private var menuState = TriageState()
    private var scanItem: NSMenuItem!
    private var trashItem: NSMenuItem!
    private var undoItem: NSMenuItem!
    private var pileItems: [String: NSMenuItem] = [:]

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        NSApp.activate(ignoringOtherApps: true)
        if SettingsStore.needsOnboarding() {
            showOnboarding()
        } else {
            launchServer()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server else { return .terminateNow }
        server.stop {
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }

    private func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1120, height: 780),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Downloads Triage"
        window.minSize = NSSize(width: 960, height: 640)
        window.collectionBehavior = [.fullScreenPrimary, .managed]
        window.isReleasedWhenClosed = false
        window.delegate = self
        if !window.setFrameAutosaveName("MainWindow") {
            window.center()
        }

        let content = NSView()
        window.contentView = content

        statusLabel = NSTextField(wrappingLabelWithString: "Starting…")
        statusLabel.alignment = .center
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(statusLabel)

        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(bridge, name: "triage")
        bridge.onState = { [weak self] body in
            self?.applyMenuState(body)
        }
        bridge.onOpenSettings = { [weak self] in
            self?.showSettings(nil)
        }
        webView = AppWebView(frame: .zero, configuration: configuration)
        webView.owner = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true
        content.addSubview(webView)

        NSLayoutConstraint.activate([
            statusLabel.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            statusLabel.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            statusLabel.widthAnchor.constraint(lessThanOrEqualTo: content.widthAnchor, constant: -48),
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
        window.makeKeyAndOrderFront(nil)
    }

    @objc private func showOnboardingAgain(_ sender: Any?) {
        if window.contentView?.subviews.contains(where: { $0 is OnboardingView }) == true { return }
        showOnboarding()
    }

    private func showOnboarding() {
        statusLabel.isHidden = true
        webView.isHidden = true
        let existingKey = Self.projectDirectory().map { SettingsStore.keyForDisplay(project: $0) } ?? ""
        let view = OnboardingView(
            initialKey: existingKey,
            onContinue: { [weak self] key in self?.finishOnboarding(key: key) },
            onSkip: { [weak self] in self?.finishOnboarding(key: nil) }
        )
        guard let content = window.contentView else { return }
        content.addSubview(view)
        NSLayoutConstraint.activate([
            view.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            view.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            view.topAnchor.constraint(equalTo: content.topAnchor),
            view.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        ])
    }

    private func finishOnboarding(key: String?) {
        let existing = SettingsStore.load()
        let settings = AppSettings(
            typesafeApiKey: key ?? existing?.typesafeApiKey,
            hasSavedKey: key != nil || (existing?.hasSavedKey ?? false),
            onboardingComplete: true
        )
        do {
            try SettingsStore.save(settings)
        } catch {
            showStatus("The key could not be saved.")
            return
        }
        window.contentView?.subviews.compactMap { $0 as? OnboardingView }.forEach { $0.removeFromSuperview() }
        let keyChanged = key != nil && (existing?.hasSavedKey != true || existing?.typesafeApiKey != key)
        if keyChanged || server?.baseURL == nil {
            if let server {
                server.stop { [weak self] in self?.launchServer() }
            } else {
                launchServer()
            }
        } else {
            webView.isHidden = false
            statusLabel.isHidden = true
        }
    }

    private func launchServer() {
        guard let project = Self.projectDirectory() else {
            showStatus("Downloads Triage.app needs to stay in the project folder.")
            return
        }
        webView.isHidden = true
        showStatus("Starting…")
        menuState = TriageState()
        let server = ServerProcess(project: project)
        server.onReady = { [weak self] url in
            self?.webView.isHidden = false
            self?.statusLabel.isHidden = true
            self?.webView.load(URLRequest(url: url))
        }
        server.onExit = { [weak self] message in
            self?.webView.isHidden = true
            self?.showStatus(message)
        }
        self.server = server
        server.start()
    }

    private func showStatus(_ message: String) {
        statusLabel.stringValue = message
        statusLabel.isHidden = false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if url?.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        if url?.host == "127.0.0.1" {
            decisionHandler(.allow)
            return
        }
        if navigationAction.navigationType == .linkActivated, let url, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    private func applyMenuState(_ body: [String: Any]) {
        menuState.ready = true
        menuState.scanning = body["scanning"] as? Bool ?? false
        menuState.canTrash = body["canTrash"] as? Bool ?? false
        menuState.canUndo = body["canUndo"] as? Bool ?? false
        menuState.pile = body["pile"] as? String ?? menuState.pile
        for (pile, item) in pileItems {
            item.state = pile == menuState.pile ? .on : .off
        }
    }

    @objc func scanDownloads(_ sender: Any?) {
        guard !menuState.scanning else { return }
        webView.evaluateJavaScript("window.__triage && window.__triage.scan()")
    }

    @objc func undoTrash(_ sender: Any?) {
        guard menuState.canUndo else { return }
        webView.evaluateJavaScript("window.__triage && window.__triage.undo()")
    }

    @objc func moveToTrash(_ sender: Any?) {
        guard menuState.canTrash else { return }
        webView.evaluateJavaScript("window.__triage && window.__triage.trash()")
    }

    func showPile(_ pile: String) {
        guard pile == "trash" || pile == "review" || pile == "keep" else { return }
        let script = "window.__triage && window.__triage.showPile('\(pile)')"
        webView.evaluateJavaScript(script)
        menuState.pile = pile
        for (name, item) in pileItems {
            item.state = name == pile ? .on : .off
        }
    }

    @objc private func showTrashPile(_ sender: Any?) { showPile("trash") }
    @objc private func showReviewPile(_ sender: Any?) { showPile("review") }
    @objc private func showKeepPile(_ sender: Any?) { showPile("keep") }

    @objc func showSettings(_ sender: Any?) {
        showOnboardingAgain(sender)
    }

    @objc private func showHelp(_ sender: Any?) {
        let alert = NSAlert()
        alert.messageText = "Downloads Triage"
        alert.informativeText = "This window reads the Downloads folder on this Mac. Nothing is deleted until you choose Move to Trash, and Finder can put those files back. Your Jev key stays on this Mac."
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window)
    }

    @objc private func showAbout(_ sender: Any?) {
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: "Downloads Triage",
            .applicationVersion: "0.1.0",
            .credits: NSAttributedString(string: "Scans the Downloads folder on this Mac. Nothing is deleted until you confirm."),
        ])
    }

    @objc func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        if menuItem === scanItem { return menuState.ready && !menuState.scanning }
        if menuItem === trashItem { return menuState.canTrash }
        if menuItem === undoItem { return menuState.canUndo }
        return true
    }

    private func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "Downloads Triage")
        let about = appMenu.addItem(withTitle: "About Downloads Triage", action: #selector(showAbout(_:)), keyEquivalent: "")
        about.target = self
        appMenu.addItem(.separator())
        let settings = appMenu.addItem(withTitle: "Settings…", action: #selector(showSettings(_:)), keyEquivalent: ",")
        settings.target = self
        appMenu.addItem(.separator())
        let services = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
        let servicesMenu = NSMenu()
        services.submenu = servicesMenu
        appMenu.addItem(services)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Downloads Triage", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Downloads Triage", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        NSApp.servicesMenu = servicesMenu

        let fileItem = NSMenuItem()
        let fileMenu = NSMenu(title: "File")
        scanItem = fileMenu.addItem(withTitle: "Scan Downloads", action: #selector(scanDownloads(_:)), keyEquivalent: "r")
        scanItem.target = self
        undoItem = fileMenu.addItem(withTitle: "Undo Trash", action: #selector(undoTrash(_:)), keyEquivalent: "z")
        undoItem.target = self
        trashItem = fileMenu.addItem(withTitle: "Move to Trash", action: #selector(moveToTrash(_:)), keyEquivalent: "\u{7f}")
        trashItem.target = self
        fileItem.submenu = fileMenu
        main.addItem(fileItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        pileItems["trash"] = viewMenu.addItem(withTitle: "Suggested trash", action: #selector(showTrashPile(_:)), keyEquivalent: "1")
        pileItems["review"] = viewMenu.addItem(withTitle: "Review", action: #selector(showReviewPile(_:)), keyEquivalent: "2")
        pileItems["keep"] = viewMenu.addItem(withTitle: "Keep in Downloads", action: #selector(showKeepPile(_:)), keyEquivalent: "3")
        for item in pileItems.values { item.target = self }
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.zoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Bring All to Front", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        let helpItem = NSMenuItem()
        let helpMenu = NSMenu(title: "Help")
        let help = helpMenu.addItem(withTitle: "Downloads Triage Help", action: #selector(showHelp(_:)), keyEquivalent: "?")
        help.keyEquivalentModifierMask = [.command, .shift]
        help.target = self
        helpItem.submenu = helpMenu
        main.addItem(helpItem)

        NSApp.mainMenu = main
    }

    static func projectDirectory() -> URL? {
        let candidates = [
            Bundle.main.bundleURL.deletingLastPathComponent(),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath).deletingLastPathComponent(),
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("package.json").path) }
    }
}

private struct TriageState {
    var ready = false
    var scanning = false
    var canTrash = false
    var canUndo = false
    var pile = "trash"
}

private final class MenuBridge: NSObject, WKScriptMessageHandler {
    var onState: (([String: Any]) -> Void)?
    var onOpenSettings: (() -> Void)?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        DispatchQueue.main.async { [weak self] in
            if body["openSettings"] as? Bool == true {
                self?.onOpenSettings?()
                return
            }
            self?.onState?(body)
        }
    }
}

final class AppWebView: WKWebView {
    weak var owner: AppDelegate?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        let command = flags.contains(.command) && !flags.contains(.option) && !flags.contains(.control)
        guard command, let owner else { return super.performKeyEquivalent(with: event) }
        switch event.charactersIgnoringModifiers?.lowercased() {
        case "r":
            owner.scanDownloads(nil)
            return true
        case "1":
            owner.showPile("trash")
            return true
        case "2":
            owner.showPile("review")
            return true
        case "3":
            owner.showPile("keep")
            return true
        case "z" where !flags.contains(.shift):
            owner.undoTrash(nil)
            return true
        case ",":
            owner.showSettings(nil)
            return true
        default:
            break
        }
        if event.keyCode == 51 || event.keyCode == 117 {
            owner.moveToTrash(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}
