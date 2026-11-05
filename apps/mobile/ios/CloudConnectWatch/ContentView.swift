// watchOS companion: recent calls, voicemail summaries, call back via the paired iPhone (WatchConnectivity).
// Calls placed from the watch are handed to the iPhone app, which starts them through CallKit.
import SwiftUI
import WatchConnectivity

final class PhoneLink: NSObject, ObservableObject, WCSessionDelegate {
  @Published var recents: [[String: String]] = []
  override init() { super.init(); if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() } }
  func session(_ s: WCSession, activationDidCompleteWith st: WCSessionActivationState, error: Error?) {}
  func session(_ s: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
    DispatchQueue.main.async { self.recents = ctx["recents"] as? [[String: String]] ?? [] }
  }
  func call(_ number: String) { WCSession.default.sendMessage(["action": "call", "number": number], replyHandler: nil) }
}

struct ContentView: View {
  @StateObject var link = PhoneLink()
  var body: some View {
    List(link.recents, id: \.self) { r in
      Button { link.call(r["number"] ?? "") } label: {
        VStack(alignment: .leading) { Text(r["name"] ?? r["number"] ?? "").font(.headline); Text(r["summary"] ?? "").font(.caption2).foregroundStyle(.secondary) }
      }
    }.navigationTitle("CloudConnect")
  }
}
