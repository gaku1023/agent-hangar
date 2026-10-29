import SwiftUI

@main
struct CarProbeApp: App {
    @Environment(\.scenePhase) private var phase
    private let model = ProbeModel.shared

    var body: some Scene {
        WindowGroup {
            ProbeView(model: model)
        }
        .onChange(of: phase, initial: true) { _, new in
            model.appActive = (new == .active)
            model.heartbeat.scenePhase("\(new)")
        }
    }
}
