// Siri Shortcuts via App Intents: "Call voicemail with CloudConnect", "Set my CloudConnect status".
// Phone-number calls from Siri/CarPlay go through CallKit's INStartCallIntent (handled by callkeep).
import AppIntents

struct OpenVoicemailIntent: AppIntent {
  static var title: LocalizedStringResource = "Check voicemail"
  static var openAppWhenRun = true
  func perform() async throws -> some IntentResult {
    await UIApplication.shared.open(URL(string: "cloudconnect://voicemail")!)
    return .result()
  }
}

enum PresenceOption: String, AppEnum {
  case available, busy, dnd, away
  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Status"
  static var caseDisplayRepresentations: [PresenceOption: DisplayRepresentation] = [.available: "Available", .busy: "Busy", .dnd: "Do not disturb", .away: "Away"]
}

struct SetPresenceIntent: AppIntent {
  static var title: LocalizedStringResource = "Set CloudConnect status"
  @Parameter(title: "Status") var status: PresenceOption
  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let token = UserDefaults(suiteName: "group.ai.cloudconnect")?.string(forKey: "accessToken") else { return .result(dialog: "Open CloudConnect to sign in first.") }
    var req = URLRequest(url: URL(string: "https://api.cloudconnect.ai/v1/me/presence")!)
    req.httpMethod = "PUT"; req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization"); req.setValue("application/json", forHTTPHeaderField: "Content-Type")
    req.httpBody = try JSONEncoder().encode(["status": status.rawValue])
    _ = try await URLSession.shared.data(for: req)
    return .result(dialog: "Your status is now \(status.rawValue).")
  }
}

struct CloudConnectShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(intent: OpenVoicemailIntent(), phrases: ["Check voicemail in \(.applicationName)"], shortTitle: "Voicemail", systemImageName: "recordingtape")
    AppShortcut(intent: SetPresenceIntent(), phrases: ["Set my \(.applicationName) status"], shortTitle: "Set status", systemImageName: "person.crop.circle.badge")
  }
}
