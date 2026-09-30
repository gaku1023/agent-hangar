# 起きたら決めてほしいこと（2026-10-01 夜）

利用者が寝ている間、推奨の案で進めた。
ここには、推奨で仮に決めたもののうち見直してほしいものと、利用者でなければ決められないものを並べる。
上ほど急ぐ。

## 利用者の手が要ること

1. **①（UX の直し 1）の実機の確認と、main への取り込み。**
   手順は末尾の「①の確かめ方」。
   済んだら `/Applications/Hangar.app` の入れ替えと main への取り込みを `!` で打ってもらう（コマンドは報告に書く）。

1b. **セッション画面の組み直しの案を選ぶ（`session-layout-v2.html`）。**
   今の main の見出しと、幅の上限なし（案 b）で描き直した。
   おすすめは A1（主ボタン 1 つと「…」）、C1（名前は見出しだけ）、B1（線の下に 1 行）、E1（終わった画面の右欄に積む）、F1（中央のカードと全幅の帯）。
   案 b で検索欄がどれだけ動くかも見られる（開いた帯で 1440px なら 12px、1680px なら 132px、1920px なら 252px）。
   動く幅を見てから案 b を改めるなら、それも言ってほしい。
   これは live-explainer の後に作るので急がない。

## 推奨で仮に決めたもの（見直してほしい）

2. **試作に「おすすめ」の印が無かった 5 本の案は、私が選んだ。**
   `2026-10-01-ux-refresh-2-design.md` の 4 から 8 の表がそれで、検索 A1・B1・C1・D1、設定 A1・B1・C1・D1・E2、ホーム A1・B1・C1・E1・F1・G1・H1、初回 A1・B1・C1、ダイアログ A1・B1・C1・D1・E1。
   どれも各軸の 1 番目で、QA の言葉にいちばん近いものを採った。
   違うと思う軸があれば、試作の記号で言ってもらえれば差し替える。
3. **本文の表示のツール名の札の色は、試作 K1 ではなく live-explainer の色に合わせた。**
   試作 K1 は読む＝青、書く＝緑だったが、live-explainer の設計は読む＝灰、書く＝藍、走らせる＝杏、コミット＝緑、失敗＝赤である。
   同じアプリの中で同じ種類が違う色になるのを避けるため、live-explainer の側にそろえた。
   手の種類の規則（`packages/shared/src/steps.ts`）も、live-explainer の作業中のものを一字一句そのまま写して使っている。
4. **main から入った保持期間の帯とダイアログは「会話」と言っている。**
   用語表では会話の記録を「本文」と呼ぶが、「会話」を禁じてはいないので、そのまま残した。
   「本文」にそろえるかどうかを決めてほしい。
5. **入力待ちの通知の許可。**
   デスクトップでは既定で通知を受け取る（OS の許可ダイアログが出る）、ブラウザでは受け取らない、を仮の既定にしている（実装の報告で変わりうる）。

## ①の確かめ方

ビルド済みの `.app` は `/Users/satog/workspace/agent-hangar/.claude/worktrees/ux-fixes-1/apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app`（ブランチ `worktree-ux-fixes-1`、push 済み）。
入れ替えは次の 1 行（`!` を付けて打つ）。

```sh
osascript -e 'tell application "Hangar" to quit'; sleep 2; rm -rf /Applications/Hangar.app && ditto /Users/satog/workspace/agent-hangar/.claude/worktrees/ux-fixes-1/apps/desktop/src-tauri/target/release/bundle/macos/Hangar.app /Applications/Hangar.app && open /Applications/Hangar.app
```

確かめること（数分）。

1. Claude のタブで Shift+Enter を押すと改行が入り、送信されない。Enter では送信される。日本語の変換中の Shift+Enter は確定だけ。
2. シェルタブ（zsh）で Shift+Enter を押すと、実行されずに改行が入る。
3. Claude のタブで Option を押しながらドラッグすると選べ、⌘C の後に他のアプリへ貼れる。Option の短いクリックで履歴が動かない。JIS 配列の Option+¥ でバックスラッシュが入る。
4. シェルタブで Option なしにドラッグして離すと、他のアプリへ貼れる。
5. セッション画面で ⌘+、⌘−、⌘0 で全部のタブの文字が変わり、再起動しても残る。
6. Claude のタブで ⌘W を押しても窓が閉じない。シェルタブでは閉じる。
7. 作業中のセッションで「停止」を押すと確認が出る。
8. 入力待ちのセッションがあるとき、⌘I で開いて端末にフォーカスする。
9. ヘッダーのゲージに「5 時間」「週」が出て、乗せると戻る時刻が出る。
10. 窓の幅 860、1280、1680px で、ヘッダーの部品が重ならない（main の見出しの改修と合わせたので）。

よければ main へ入れる（`!` を付けて打つ）。

```sh
git -C /Users/satog/workspace/agent-hangar merge --no-ff worktree-ux-fixes-1 && git -C /Users/satog/workspace/agent-hangar push origin main
```
