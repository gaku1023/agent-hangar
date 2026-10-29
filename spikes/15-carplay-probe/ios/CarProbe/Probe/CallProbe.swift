import Foundation
import CallKit
import AVFoundation

@MainActor
final class CallProbe {
    private let delegate: Delegate
    private let provider: CXProvider
    private let controller = CXCallController()
    private var uuid: UUID?
    var lastCommand: (name: String, at: Date?) { delegate.lastCommand }
    func resetLastCommand() { delegate.resetLast() }

    init(store: EventStore) {
        let cfg = CXProviderConfiguration()
        cfg.includesCallsInRecents = false
        cfg.supportsVideo = false
        provider = CXProvider(configuration: cfg)
        delegate = Delegate(store: store)
        provider.setDelegate(delegate, queue: nil)
    }

    func startCall() {
        let id = UUID()
        uuid = id
        delegate.setReallyEnd(false)
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: "Hangar"))
        let d = delegate
        controller.request(CXTransaction(action: action)) { err in
            if let err { d.record("call.startError", ["error": "\(err)"]) }
        }
    }

    func endCall() {
        guard let id = uuid else { return }
        delegate.setReallyEnd(true)
        let d = delegate
        controller.request(CXTransaction(action: CXEndCallAction(call: id))) { err in
            if let err { d.record("call.endError", ["error": "\(err)"]) }
        }
    }

    /// provider のキューで呼ばれるので、MainActor には載せない。
    final class Delegate: NSObject, CXProviderDelegate, @unchecked Sendable {
        private let store: EventStore
        private let lock = NSLock()
        private var reallyEnd = false
        private var last = "-"
        private var lastAt: Date?
        var lastCommand: (name: String, at: Date?) { lock.lock(); defer { lock.unlock() }; return (last, lastAt) }
        func resetLast() { lock.lock(); last = "-"; lastAt = nil; lock.unlock() }

        init(store: EventStore) { self.store = store }

        func setReallyEnd(_ v: Bool) { lock.lock(); reallyEnd = v; lock.unlock() }
        private func getReallyEnd() -> Bool { lock.lock(); defer { lock.unlock() }; return reallyEnd }

        func record(_ kind: String, _ detail: [String: String] = [:]) {
            // ボタン由来の操作だけを「最後のボタン」に数える。
            if ["call.end", "call.setHeld", "call.setMuted", "call.setGroup", "call.playDTMF"].contains(kind) {
                lock.lock(); last = kind; lastAt = Date(); lock.unlock()
            }
            let s = store
            Task { await s.record(kind, detail) }
        }

        func providerDidReset(_ provider: CXProvider) { record("call.reset") }
        func providerDidBegin(_ provider: CXProvider) { record("call.didBegin") }

        func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
            record("call.start")
            let u = CXCallUpdate()
            u.remoteHandle = CXHandle(type: .generic, value: "Hangar")
            u.localizedCallerName = "Hangar"
            u.supportsHolding = false
            u.supportsGrouping = false
            u.supportsUngrouping = false
            u.supportsDTMF = false
            u.hasVideo = false
            provider.reportCall(with: action.callUUID, updated: u)
            provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: nil)
            provider.reportOutgoingCall(with: action.callUUID, connectedAt: nil)
            action.fulfill()
        }

        func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
            record("call.answer"); action.fulfill()
        }

        func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
            let real = getReallyEnd()
            record("call.end", ["ended": real ? "true" : "false"])
            if real { action.fulfill() } else { action.fail() }
        }

        func provider(_ provider: CXProvider, perform action: CXSetHeldCallAction) {
            record("call.setHeld", ["onHold": String(action.isOnHold)]); action.fulfill()
        }

        func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
            record("call.setMuted", ["muted": String(action.isMuted)]); action.fulfill()
        }

        func provider(_ provider: CXProvider, perform action: CXSetGroupCallAction) {
            record("call.setGroup"); action.fulfill()
        }

        func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
            record("call.playDTMF", ["digits": action.digits]); action.fulfill()
        }

        func provider(_ provider: CXProvider, timedOutPerforming action: CXAction) {
            record("call.timedOut", ["action": "\(type(of: action))"])
        }

        func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) { record("call.audioActivated") }
        func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) { record("call.audioDeactivated") }
    }
}
