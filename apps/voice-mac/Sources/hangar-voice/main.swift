import AVFoundation
import Foundation
import VoiceCore

// hangar-voice：hangar のサーバと標準入出力の 1 行 1 JSON で話す、端末の中の声の補助。
// 約束は VoiceCore/Protocol.swift と docs/superpowers/plans/done/2026-11-16-orchestrator-voice-stage2.md。

let helperVersion = "0.1.0"

// 標準出力は約束の行だけに使う。ライブラリの print（tokenizer の生成の知らせなど）が混ざらないよう、
// 元の標準出力を別の番号に移し、1 番は標準エラーに向ける。
let protocolFD = dup(STDOUT_FILENO)
dup2(STDERR_FILENO, STDOUT_FILENO)
let emitLock = NSLock()

func emit(_ e: Event) {
    let data = Array((encodeLine(e) + "\n").utf8)
    emitLock.lock()
    defer { emitLock.unlock() }
    data.withUnsafeBufferPointer { p in
        var off = 0
        while off < p.count {
            let n = write(protocolFD, p.baseAddress! + off, p.count - off)
            if n <= 0 { break }
            off += n
        }
    }
}

func log(_ s: String) {
    FileHandle.standardError.write(Data(("hangar-voice: " + s + "\n").utf8))
}

guard let options = Options.parse(Array(CommandLine.arguments.dropFirst())) else {
    log("usage: hangar-voice [--input-file <wav>] [--speak-to-file <dir>]")
    exit(2)
}

let models = Models()
let recognizer = Recognizer(models: models)
// --input-file のときはマイクに触れない。
let capture: Capture? = options.inputFile == nil ? Capture(recognizer: recognizer) : nil
let speaker = Speaker(
    models: models, capture: options.speakToDir == nil ? capture : nil, outDir: options.speakToDir)
let micUsers = MicUsersWatcher()

func shutdown(_ code: Int32 = 0) -> Never {
    capture?.setListening(false)
    // 認識の途中の仕事を終えてから出る。
    models.queue.sync {}
    exit(code)
}

func handle(_ cmd: Command) {
    switch cmd {
    case .listen(let on):
        if let capture { capture.setListening(on) }
    case .hints(let context): recognizer.setHints(context)
    case .flush: recognizer.flush(emitFlushed: true)
    case .speak(let id, let text, let voice, let speed):
        speaker.speak(id: id, text: text, voice: voice, speed: speed)
    case .stopSpeaking: speaker.stop()
    case .prepare: models.prepare()
    case .voices:
        let os = AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language == "ja-JP" }
            .map { VoiceInfo(id: $0.identifier, name: $0.name) }
        emit(.voices(os: os))
    case .quit: shutdown()
    }
}

emit(.ready(version: helperVersion))
models.announce()
micUsers.start()

Thread.detachNewThread {
    while let line = readLine() {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        guard let cmd = decodeLine(line) else {
            emit(.error(code: "badCommand", message: String(line.prefix(200))))
            continue
        }
        DispatchQueue.main.async { handle(cmd) }
    }
    // サーバが標準入力を閉じたら終わる。ファイルを流している間は、流し終わりを待つ。
    if options.inputFile == nil { DispatchQueue.main.async { shutdown() } }
}

if let path = options.inputFile {
    Thread.detachNewThread {
        do {
            try streamFile(path, models: models, recognizer: recognizer)
        } catch {
            emit(.error(code: "inputFile", message: "\(error)"))
        }
        DispatchQueue.main.async { shutdown() }
    }
}

// AVSpeechSynthesizer の書き出しの知らせを受けるため、主の RunLoop を回す。
RunLoop.main.run()
