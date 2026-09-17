# spike 08: Tauri v2 のシェル

判定: 合格
実施日: 2026-09-17

## 確かめたこと
- `npm create tauri-app`（vanilla-ts）の雛形に deep-link プラグインを足し、`setup` で Node のサーバ（Task 1 の中継サーバ）を子プロセスとして起動、`RunEvent::Exit` で kill する形が動いた。
- ビルドした `.app` を `open` で起動すると、Node を候補パスから探して（`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`~/.nvm/versions/node/*/bin/node` の順、nvm は新しい版を優先）サーバが立ち、ウィンドウに Task 1 の画面が出た。ポート 4190 は子プロセスが応答した（事前に単独のサーバは止めてある）。
- `open 'hangar://session/abc'` でアプリにディープリンクのイベントが届き、URL が解析された（host が `session`、path が `/abc`）。
- AppleScript の `quit` で終了すると `Exit` イベントで子プロセスが kill され、`pgrep` でも消えていた。

## 計測値
- `cargo check`：27 秒。リリースビルド（lto あり）：73 秒。`.app` のサイズ：4.0MB。
- 起動からサーバ応答まで：約 1 秒未満（ログの時刻差 7 ミリ秒で spawn、8 秒後の確認で 200）。

## 設計への影響
- Node の探索は PATH に依存せず候補パスの走査で足りる。Settings に Node のパスを明示できる欄も置く（見つからないときの救済）。
- 終了時の kill は `RunEvent::Exit` で行う。SIGTERM で殺された場合の孤児化は未検証なので、サーバ側でも親 pid を監視して親が消えたら自ら終了する保険を入れる。
- ディープリンクは `tauri-plugin-deep-link` の `on_open_url` で受け、`hangar://<種別>/<id>` を UI の経路へ変換する。設計文書の URL 形と一致する。
- ビルドは 1 分強で終わるので、GitHub Actions の macOS ランナーで Releases に載せる方針に無理はない。

## 残った疑問
- Dock アイコンと `productName` の表示、コード署名なしで配布したときの Gatekeeper の警告（「開発元を確認できません」）。家族に渡すときは右クリックで開く手順か、Apple Developer の署名が要る。フェーズ 5 で決める。
