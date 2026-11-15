import Foundation
import VoiceCore

// Task 2 で本体を入れる。今は ready を出して、標準入力の quit で終わるだけ。
print(encodeLine(.ready(version: "0.0.0")))
fflush(stdout)
while let line = readLine() {
    if case .quit? = decodeLine(line) { break }
}
