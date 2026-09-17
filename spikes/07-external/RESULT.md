# spike 07: iTerm2 と VS Code の外部連携

判定: 合格（初回に自動化の許可が必要）
実施日: 2026-09-17

## 確かめたこと
- AppleScript（`tell application "iTerm" ... create window with default profile command`）は、iTerm2 が未起動の状態から呼ぶと iTerm2 は起動するが AppleEvent が 120 秒でタイムアウトした（-1712）。Terminal.app への `do script` も同じくタイムアウトした。アプリ固有ではなく、呼び出し元プロセスに対する macOS の自動化（Automation）許可が未承認のまま応答待ちになっている挙動と一致する。
- **`.command` ファイルを `open -g -a Terminal` で開く経路は、AppleEvent を使わず 75 ミリ秒で tmux に attach できた**（`tmux list-clients` に Terminal のクライアントが現れた）。
- `open -a iTerm <file.command>` では attach されなかった。iTerm2 は `.command` の実行を受け付けないか、初回起動の状態で止まっている。
- `code <dir>` は即時に返り、VS Code が起動した。

## 計測値
- `open -a Terminal`：75 ミリ秒で復帰、3 秒後に attach 済み。
- AppleScript：2 回とも 120 秒（既定のタイムアウト）で失敗。

## 設計への影響
- 「ターミナルで開く」の既定は **Terminal.app と `.command` ファイル**にする。許可ダイアログが無く、Tauri から呼んでも同じ。
- iTerm2 で開きたい場合は AppleScript が必要で、初回に macOS の自動化許可（「hangar が iTerm を制御することを許可しますか」）を利用者が承認する。Tauri の Info.plist に `NSAppleEventsUsageDescription` を入れ、Settings の「iTerm2 を使う」を有効にしたときに一度だけ許可を促す。AppleScript には `with timeout of 10 seconds` を付け、失敗したら Terminal.app の経路に落とす。
- `.command` で開いたウィンドウは detach 後に「[Process completed]」のまま残る。ファイルの末尾で `exit` する、または Terminal の「シェルが終了したら閉じる」設定に頼らず、`tmux attach; exit` と書く。

## 追記（許可承認後）
- 利用者が macOS の自動化許可ダイアログを承認した後、同じ AppleScript は 290 ミリ秒で通り、iTerm2 の新規ウィンドウが tmux に attach した（クライアント数が増えた）。タイムアウトの原因は許可待ちで確定。

## 残った疑問
- なし。
