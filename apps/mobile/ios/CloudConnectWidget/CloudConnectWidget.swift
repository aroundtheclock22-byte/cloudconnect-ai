// WidgetKit extension: missed calls & unread voicemail on the Home/Lock Screen.
// The app writes a snapshot to the shared App Group ("group.ai.cloudconnect") after each sync.
import WidgetKit
import SwiftUI

struct Snapshot: Codable { let missedCalls: Int; let unreadVoicemail: Int; let unreadMessages: Int; let updatedAt: Date }

struct Provider: TimelineProvider {
  func load() -> Snapshot {
    let d = UserDefaults(suiteName: "group.ai.cloudconnect")?.data(forKey: "widgetSnapshot")
    return d.flatMap { try? JSONDecoder().decode(Snapshot.self, from: $0) } ?? Snapshot(missedCalls: 0, unreadVoicemail: 0, unreadMessages: 0, updatedAt: .now)
  }
  func placeholder(in context: Context) -> Entry { Entry(date: .now, s: Snapshot(missedCalls: 2, unreadVoicemail: 1, unreadMessages: 3, updatedAt: .now)) }
  func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now, s: load())) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
    completion(Timeline(entries: [Entry(date: .now, s: load())], policy: .after(.now.addingTimeInterval(15 * 60))))
  }
}
struct Entry: TimelineEntry { let date: Date; let s: Snapshot }

struct WidgetView: View {
  let entry: Entry
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("\(entry.s.missedCalls) missed", systemImage: "phone.arrow.down.left").foregroundStyle(.red)
      Label("\(entry.s.unreadVoicemail) voicemail", systemImage: "recordingtape")
      Label("\(entry.s.unreadMessages) messages", systemImage: "message")
    }.font(.caption).widgetURL(URL(string: "cloudconnect://voicemail"))
     .containerBackground(.fill.tertiary, for: .widget)
  }
}

@main
struct CloudConnectWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "CloudConnectWidget", provider: Provider()) { WidgetView(entry: $0) }
      .configurationDisplayName("CloudConnect").description("Missed calls, voicemail and messages.")
      .supportedFamilies([.systemSmall, .accessoryRectangular])
  }
}
