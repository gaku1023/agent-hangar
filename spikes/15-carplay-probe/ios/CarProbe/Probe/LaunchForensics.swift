import Foundation

struct LaunchForensics {
    private static func iso(_ t: Double?) -> String {
        guard let t else { return "" }
        return Date(timeIntervalSince1970: t).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    /// 前回の run が cleanExit を残さずに終わっていたら詳細を返す。初回起動（lastBeat なし）は nil。
    static func inspect(defaults: UserDefaults, now: Date) -> [String: String]? {
        if defaults.bool(forKey: "cleanExit") { return nil }
        guard let beat = defaults.object(forKey: "lastBeat") as? Double else { return nil }
        return [
            "prevRun": defaults.string(forKey: "prevRun") ?? "",
            "lastBeat": iso(beat),
            "gapSec": String(Int(now.timeIntervalSince1970 - beat)),
            "lastLockAt": iso(defaults.object(forKey: "lastLockAt") as? Double),
        ]
    }

    /// 起動時に呼ぶ。前回の結果を返し、今回の run を印付けして cleanExit を消す。
    static func beginRun(defaults: UserDefaults, run: String, store: EventStore, now: Date = Date()) -> [String: String]? {
        let r = inspect(defaults: defaults, now: now)
        defaults.set(run, forKey: "prevRun")
        defaults.removeObject(forKey: "cleanExit")
        if let r { Task { await store.record("prevRunEnded", r) } }
        return r
    }

    static func markCleanExit(defaults: UserDefaults) { defaults.set(true, forKey: "cleanExit") }
}
