import Foundation

final class ServerProcess {
    private var process: Process?
    private var buffer = ""
    private var log = ""
    private var secret = ""
    private var stopping = false
    let project: URL
    private(set) var baseURL: URL?

    var onReady: ((URL) -> Void)?
    var onExit: ((String) -> Void)?

    init(project: URL) {
        self.project = project
    }

    func start() {
        stopping = false
        buffer = ""
        log = ""
        guard let node = Self.nodeExecutable() else {
            onExit?("Node was not found. Install Node and open Downloads Triage again.")
            return
        }
        let tsx = project.appendingPathComponent("node_modules/tsx/dist/cli.mjs")
        guard FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: tsx.path) else {
            onExit?("The project dependencies are missing. Run npm install in the project, then open the app again.")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [tsx.path, "server/index.ts"]
        process.currentDirectoryURL = project
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = Self.launchPath()
        environment["PORT"] = "8787"
        if let saved = SettingsStore.load(), saved.hasSavedKey {
            environment["TYPESAFE_API_KEY"] = saved.typesafeApiKey ?? ""
            secret = saved.typesafeApiKey ?? ""
        } else {
            secret = SettingsStore.envValue(named: "TYPESAFE_API_KEY", in: project.appendingPathComponent(".env")) ?? ""
        }
        process.environment = environment

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else { return }
            DispatchQueue.main.async {
                self?.consume(text)
            }
        }
        process.terminationHandler = { [weak self] exited in
            DispatchQueue.main.async {
                guard let self, self.process === exited else { return }
                self.process = nil
                self.baseURL = nil
                if self.stopping { return }
                let detail = self.log.trimmingCharacters(in: .whitespacesAndNewlines)
                self.onExit?(detail.isEmpty ? "The local server stopped." : detail)
            }
        }

        do {
            try process.run()
            self.process = process
        } catch {
            onExit?("The local server could not start.")
        }
    }

    func stop(completion: @escaping () -> Void) {
        stopping = true
        guard let process, process.isRunning else {
            completion()
            return
        }
        process.terminationHandler = { _ in
            DispatchQueue.main.async(execute: completion)
        }
        process.interrupt()
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
            if process.isRunning {
                process.terminate()
            }
        }
    }

    private func consume(_ text: String) {
        log.append(redacted(text))
        if log.count > 4000 {
            log = String(log.suffix(4000))
        }
        buffer.append(text)
        while let newline = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newline])
            buffer = String(buffer[buffer.index(after: newline)...])
            guard line.hasPrefix("ready http://127.0.0.1:"),
                  let url = URL(string: line.dropFirst("ready ".count).trimmingCharacters(in: .whitespaces)) else { continue }
            baseURL = url
            onReady?(url)
        }
    }

    private func redacted(_ text: String) -> String {
        guard !secret.isEmpty else { return text }
        return text.replacingOccurrences(of: secret, with: "•••")
    }

    static func nodeExecutable() -> String? {
        for directory in launchDirectories() {
            let candidate = directory + "/node"
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    static func launchPath() -> String {
        launchDirectories().joined(separator: ":")
    }

    private static func launchDirectories() -> [String] {
        var directories: [String] = []
        if let path = ProcessInfo.processInfo.environment["PATH"] {
            directories.append(contentsOf: path.split(separator: ":").map(String.init))
        }
        directories.append("/opt/homebrew/bin")
        directories.append("/usr/local/bin")
        directories.append("/usr/bin")
        let nvm = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".nvm/versions/node").path
        if let versions = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            directories.append(contentsOf: versions.sorted().reversed().map { nvm + "/" + $0 + "/bin" })
        }
        var seen = Set<String>()
        return directories.filter { seen.insert($0).inserted }
    }
}
