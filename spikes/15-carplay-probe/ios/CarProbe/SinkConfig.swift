import Foundation

enum SinkConfig {
    static var url: URL? {
        (Bundle.main.object(forInfoDictionaryKey: "SinkURL") as? String).flatMap(URL.init(string:))
    }
    static var token: String {
        Bundle.main.object(forInfoDictionaryKey: "SinkToken") as? String ?? ""
    }
}
