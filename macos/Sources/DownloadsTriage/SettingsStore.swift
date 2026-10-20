import Foundation

struct AppSettings: Codable {
    var typesafeApiKey: String?
    var hasSavedKey: Bool
    var onboardingComplete: Bool

    private enum CodingKeys: String, CodingKey {
        case typesafeApiKey
        case onboardingComplete
    }

    init(typesafeApiKey: String?, hasSavedKey: Bool, onboardingComplete: Bool) {
        self.typesafeApiKey = typesafeApiKey
        self.hasSavedKey = hasSavedKey
        self.onboardingComplete = onboardingComplete
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if container.contains(.typesafeApiKey) {
            typesafeApiKey = try container.decode(String.self, forKey: .typesafeApiKey)
            hasSavedKey = true
        } else {
            typesafeApiKey = nil
            hasSavedKey = false
        }
        onboardingComplete = try container.decodeIfPresent(Bool.self, forKey: .onboardingComplete) ?? hasSavedKey
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if hasSavedKey {
            try container.encode(typesafeApiKey ?? "", forKey: .typesafeApiKey)
        }
        try container.encode(onboardingComplete, forKey: .onboardingComplete)
    }
}

enum SettingsStore {
    static var fileURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/downloads-triage/settings.json")
    }

    static func load() -> AppSettings? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        return try? JSONDecoder().decode(AppSettings.self, from: data)
    }

    static func needsOnboarding() -> Bool {
        guard let saved = load() else { return true }
        return !saved.onboardingComplete
    }

    static func save(_ settings: AppSettings) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let data = try JSONEncoder().encode(settings)
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    /// Key shown in Settings. A saved key wins. Otherwise the project `.env` is used so a clone keeps working.
    static func keyForDisplay(project: URL) -> String {
        if let saved = load(), saved.hasSavedKey { return saved.typesafeApiKey ?? "" }
        return envValue(named: "TYPESAFE_API_KEY", in: project.appendingPathComponent(".env")) ?? ""
    }

    static func envValue(named key: String, in file: URL) -> String? {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return nil }
        for line in text.split(whereSeparator: \.isNewline) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            guard let eq = trimmed.firstIndex(of: "=") else { continue }
            let name = trimmed[..<eq].trimmingCharacters(in: .whitespaces)
            if name != key { continue }
            var value = String(trimmed[trimmed.index(after: eq)...].trimmingCharacters(in: .whitespaces))
            if value.count >= 2 {
                let quote = value.first
                if (quote == "\"" || quote == "'"), value.last == quote {
                    value = String(value.dropFirst().dropLast())
                }
            }
            return value
        }
        return nil
    }
}
