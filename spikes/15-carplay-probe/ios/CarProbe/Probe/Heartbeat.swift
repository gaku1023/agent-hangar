import Foundation
import UIKit

@MainActor
final class Heartbeat {
    private let store: EventStore
    private let defaults: UserDefaults
    private let center: NotificationCenter
    private let interval: TimeInterval
    private var task: Task<Void, Never>?
    private var tokens: [NSObjectProtocol] = []

    init(store: EventStore, defaults: UserDefaults = .standard, center: NotificationCenter = .default, interval: TimeInterval = 15) {
        self.store = store
        self.defaults = defaults
        self.center = center
        self.interval = interval
    }

    func tick(now: Date = Date()) {
        defaults.set(now.timeIntervalSince1970, forKey: "lastBeat")
        let s = store
        Task { await s.record("heartbeat", [:]) }
    }

    func start() {
        stop()
        tick()
        let interval = interval
        task = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(interval))
                if Task.isCancelled { break }
                self?.tick()
            }
        }
        observeLock()
    }

    func stop() {
        task?.cancel()
        task = nil
        tokens.forEach { center.removeObserver($0) }
        tokens = []
    }

    func observeLock() {
        let pairs: [(Notification.Name, String)] = [
            (UIApplication.protectedDataWillBecomeUnavailableNotification, "lock.willLock"),
            (UIApplication.protectedDataDidBecomeAvailableNotification, "lock.didUnlock"),
        ]
        for (name, kind) in pairs {
            tokens.append(center.addObserver(forName: name, object: nil, queue: nil) { @Sendable [weak self] _ in
                Task { @MainActor in self?.lockEvent(kind) }
            })
        }
    }

    func lockEvent(_ kind: String) {
        if kind == "lock.willLock" { defaults.set(Date().timeIntervalSince1970, forKey: "lastLockAt") }
        let s = store
        Task { await s.record(kind, [:]) }
    }

    func scenePhase(_ phase: String) {
        let s = store
        Task { await s.record("scenePhase", ["phase": phase]) }
    }
}
