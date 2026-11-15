import CoreAudio
import Foundation
import VoiceCore

/// マイクを使っているプロセスを 1 秒ごとに見て、変わったときだけ micUsers を出す。権限は要らない。
final class MicUsersWatcher {
    private let queue = DispatchQueue(label: "hangar-voice.micusers")
    private var timer: DispatchSourceTimer?
    private var gate = ChangeGate<[String]>()

    func start() {
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now(), repeating: 1.0)
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    private func tick() {
        let bundles = micUserBundles(readAudioProcesses(), selfPID: getpid())
        if let changed = gate.update(bundles) { emit(.micUsers(bundles: changed)) }
    }
}

private func address(_ sel: AudioObjectPropertySelector) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(
        mSelector: sel, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
}

private func readScalar<T: FixedWidthInteger>(_ obj: AudioObjectID, _ sel: AudioObjectPropertySelector, _ def: T) -> T {
    var a = address(sel)
    var v = def
    var size = UInt32(MemoryLayout<T>.size)
    let st = AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &v)
    return st == noErr ? v : def
}

private func readBundleID(_ obj: AudioObjectID) -> String? {
    var a = address(kAudioProcessPropertyBundleID)
    var s: Unmanaged<CFString>?
    var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
    let st = AudioObjectGetPropertyData(obj, &a, 0, nil, &size, &s)
    guard st == noErr, let s else { return nil }
    return s.takeRetainedValue() as String
}

/// CoreAudio のプロセスの一覧（macOS 14 以上）。
func readAudioProcesses() -> [AudioProcessInfo] {
    let system = AudioObjectID(kAudioObjectSystemObject)
    var a = address(kAudioHardwarePropertyProcessObjectList)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(system, &a, 0, nil, &size) == noErr, size > 0 else { return [] }
    var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
    guard AudioObjectGetPropertyData(system, &a, 0, nil, &size, &ids) == noErr else { return [] }
    return ids.map { id in
        AudioProcessInfo(
            pid: readScalar(id, kAudioProcessPropertyPID, pid_t(0)),
            bundleID: readBundleID(id),
            runningInput: readScalar(id, kAudioProcessPropertyIsRunningInput, UInt32(0)) != 0)
    }
}
