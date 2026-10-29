import SwiftUI

struct ProbeView: View {
    let model: ProbeModel
    @State private var shareURL: URL?
    @State private var showShare = false
    @AppStorage("deskSpeaker") private var deskSpeaker = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("CarProbe  run \(model.runId)").font(.title.bold())
                Text(model.status).font(.largeTitle.bold())
                    .foregroundStyle(model.running ? .green : .secondary)
                Picker("モード", selection: Binding(get: { model.mode }, set: { m in Task { await model.switchMode(m) } })) {
                    Text("Media").tag(ProbeMode.media)
                    Text("Call").tag(ProbeMode.call)
                }.pickerStyle(.segmented).controlSize(.large)
                HStack(spacing: 12) {
                    Button(model.running ? "停止" : "開始") {
                        Task { model.running ? await model.stop() : await model.start() }
                    }.buttonStyle(.borderedProminent).font(.title2.bold())
                    Button(model.micOn ? "マイク: オン" : "マイク: オフ") {
                        Task { await model.toggleMic() }
                    }.buttonStyle(.bordered).font(.title2.bold())
                }
                Toggle("起動したら自動で開始", isOn: Binding(get: { model.autoStart }, set: { model.autoStart = $0 })).font(.title3)
                Toggle("机用: スピーカーで鳴らす", isOn: $deskSpeaker).font(.title3)
                    .onChange(of: deskSpeaker) { _, _ in model.audio.applyDeskSpeaker() }
                Text("送信待ち: \(model.pendingCount) 件").font(.title2)
                Button("ログを共有") {
                    Task { shareURL = await model.store.exportURL(); showShare = true }
                }.buttonStyle(.bordered).font(.title3)
                Text("読み上げる文").font(.title3.bold())
                ForEach(Array(Phrases.all.enumerated()), id: \.offset) { i, p in
                    Text("\(i + 1). \(p)").font(.title3)
                }
                Text("直近のイベント").font(.title3.bold())
                ForEach(Array(model.events.enumerated()), id: \.offset) { _, e in
                    Text("\(e.at.formatted(date: .omitted, time: .standard)) \(e.kind) \(e.detail.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " "))")
                        .font(.system(.body, design: .monospaced))
                }
            }.padding()
        }
        .sheet(isPresented: $showShare) {
            if let shareURL { ShareSheet(url: shareURL) }
        }
        .task {
            if model.autoStart { await model.start() }
        }
    }
}

struct ShareSheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ vc: UIActivityViewController, context: Context) {}
}
