import AppIntents

struct StartProbeIntent: AppIntent {
    static let title: LocalizedStringResource = "プローブを開始"
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        let m = ProbeModel.shared
        await m.store.record("intent.start", [:])
        await m.start()
        return .result()
    }
}

struct ProbePingIntent: AppIntent {
    static let title: LocalizedStringResource = "承認の確認"

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        await ProbeModel.shared.store.record("siri.ping", [:])
        return .result(dialog: "受け取りました")
    }
}

struct ProbeShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: ProbePingIntent(), phrases: ["\(.applicationName) で承認", "\(.applicationName) の状況"],
                    shortTitle: "承認", systemImageName: "checkmark.circle")
        AppShortcut(intent: StartProbeIntent(), phrases: ["\(.applicationName) を開始"],
                    shortTitle: "開始", systemImageName: "play.circle")
    }
}
