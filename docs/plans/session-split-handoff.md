# 画面分割（別セッションを並べる）の引き継ぎ

2026-10-27 時点の現状と、次にやること。
枝は `worktree-session-split`（worktree は `.claude/worktrees/session-split`、`npm ci` 済み）。
手本の試作は同じ枝の `docs/plans/session-split-proto.html`（ブラウザで開く。動きの層は末尾の 2 つ目の script）。

## 決まったこと

- サイドバーの行を本体へドラッグして、別のセッションを並べる。HTML5 DnD は Tauri が横取りするので、サイドバーの並べ替えと同じポインタイベントで作る。
- ドロップ先は四辺＋中央。近い辺で分割、中央は置き換え。予告の枠が辺から辺へ滑る。
- 並べる数は上限なし（入れ子の木）。
- 操作中のペインは青い 2px の枠。
- 分割中は右パネルを既定で隠し、ペインの見出しの ☰ でペインごとに開閉する。タブ（Claude・シェル）は残す。
- 開いているセッションをもう一度落としたら、新しく開かず、表示中のペインへ移って光らせる。
- 右クリック（サイドバーの行と一覧の行）は「右に分割して開く」「下に分割して開く」の 2 つ。
- 並びは再起動後も残す。
- 今のセッション内のタブ分割（⌘\、「横に並べる」）はそのまま残す。
- 1 つのときは今の大きな見出し。分割中は大きな見出しを隠し、ペインの小さな見出しに、ステータスの札・主の操作・⋯・ⓘ を小さく並べる（案 A）。狭いときは一言、ボタンの文字の順に畳み、さらに狭いと主の操作と ⓘ を ⋯ へ入れる。
- 見出しに最大化のボタンは置かない。最大化は ⌘⇧↩ と右クリックだけで、最大化中だけ解除のボタンを出す。
- キー：⌘D 右に空のペイン、⌘⇧D 下、⌘⇧W 分割から外す、⌘⌥矢印で隣へ移動、⌘⇧↩ 最大化と解除、⌥クリックで右に分割。⌘\ と ⌘W は今のまま。Windows の割り当ては実装のときに既存のキーとぶつからないよう決める。

## 動き（試作の動きの層）

長さと曲線は motionKit のトークン（--dur 420ms、--ease-out）にそろえる。

- 1 つ → 分割：大きな見出しが高さ 0 へ畳まれる。名前の札が、見出しから、そのセッションのペインの見出しへ、位置と文字の大きさを補間しながら降りる（行き先は毎こま測り直す）。ペインの見出しは高さ 0 から伸び、部品が 25ms ずつずれて出る。新しいペインはぼかしと縮小から出る。
- 分割 → 1 つ：閉じるペインが薄れて縮むのと同じ拍で、大きな見出しが開き、残ったペインの名前の札が見出しへ上がる。一言と操作は 30ms ずつずれて下から出る。
- 1 つのまま中身が替わる：名前と操作を下から出し直す。
- ドロップの予告：最初の 1 回はその場で拡大しながら出る（左上から滑らせない）。
- ドラッグの札：落としたら入る場所へ吸い込まれ、やめたら元の行へ戻る。
- 入れ替えと最大化：FLIP で元の位置から動く。
- 右パネルを閉じるときは幅を畳みながら消す。サイドバーの番号は新しく出たものだけ弾む。空のペインの一覧は 30ms ずつずれて出る。境目の線は乗せると伸びる。
- reduced motion では全部止める。

## 文言（Gemini に当てて決めた）

用語集とぶつかった所は用語集を優先した（☰ は「右パネルを開く／閉じる」）。

| キー | 文言 | 英語 |
|---|---|---|
| menu.splitRight / splitDown | 右に分割して開く / 下に分割して開く | Split Right / Split Down |
| menu.goToPane | 表示中のペインへ移動 | Go to Pane |
| menu.unsplit | 分割から外す | Remove Pane |
| pane.newRight / newDown | 右に空のペインを開く / 下に空のペインを開く | New Empty Pane Right / Down |
| pane.equalize | ペインのサイズを均等にする | Equalize Pane Sizes |
| pane.closeOthers | ほかのペインを外す | Remove Other Panes |
| pane.zoom / unzoom | ペインを最大化 / 最大化を解除 | Maximize Pane / Restore |
| pane.toc | 右パネルを開く / 右パネルを閉じる | Open right panel / Close right panel |
| pane.status | ステータス | Status |
| drop.* | 左に分割・右に分割・上に分割・下に分割・ここで開く・位置を入れ替える | Split Left など / Open Here / Swap Panes |
| drop.self | 同じ位置には配置できません | Cannot drop on same pane |
| empty.title / lead / hint | 空のペイン / このペインで開くセッションを選択してください / サイドバーからドラッグ＆ドロップもできます | Empty Pane / Select a session to open in this pane / Or drag a session from the sidebar |
| toast.alreadyOpen | このセッションは既に表示されています | This session is already open |
| toast.lastPane | 最後のペインは外せません | Cannot remove the last pane |
| sidebar.paneBadge | ペイン {n} | Pane {n} |
| divider.title | ドラッグでサイズ変更 / ダブルクリックで均等化 | Drag to resize / Double-click to equalize |
| shortcuts | 右に空のペインを開く、下に空のペインを開く、分割から外す、隣のペインへ移動、ペインの最大化・解除、右に分割して開く | |

## 今のコードの前提（調べた結果）

- 本体は `Root.tsx` の switch で 1 画面だけを出し、セッションは `presentSession(state, store, now, state.screen.id)` の 1 つが前提。
- 端末は `runtime/terminals.ts` の Host が tabId ごとに xterm と WS を 1 つ持つ。別セッションなら並べられる。同じセッションを 2 か所に出すのはしない。
- 既存のタブ分割は `mediator/sessionView.ts` の split と `views/SplitPane.tsx`（比率は保存しない）。
- サイドバーのドラッグは `views/Sidebar.tsx` の RowList（pointerdown、DRAG_SLOP、setPointerCapture）。保存は `mediator/sidebar.ts`（localStorage）。
- 右クリックの項目は `presenters/sessionMenu.ts` の sessionMenuEntries の 1 か所で、サイドバーと一覧の両方に効く。
- 見出しの部品は `views/SessionScreen.tsx` の header（PageHeading、StatusSelect、主の操作、MenuButton、InfoPopover）。
- キーは `keys.ts` の一覧と `packages/shared/src/i18n/{ja,en,keys}/shortcuts.ts`。
- 動きの部品は `views/primitives/motionKit.ts`（growIn、collapseOut、resizeFrom、fadeIn）、`usePresence`、`layoutMotion.ts`（境目のドラッグ中は xterm の寸法合わせを止める）。

## 次にやること

1. `docs/plans/session-split.md` に計画を書く。インタフェース、受け入れの試験、タスクの分け方だけにし、コードは書かない。
2. タスクの案：
   - T1 状態：分割の木（葉はセッション id）、操作中・最大化、保存と読み込み、消えたセッションの刈り込み、画面の移り（session 画面と木の関係）。mediator の純関数と試験。
   - T2 描画：分割の本体、ペインの見出し（案 A と畳み方）、境目、右パネルのペインごとの開閉、1 つのときの大きな見出しとの切り替え。
   - T3 ドラッグ：サイドバーの行と、ペインの見出しのドラッグ、ドロップ先の判定と予告、Esc でやめる。
   - T4 右クリックとキー：sessionMenuEntries の 2 項目、ペインの右クリック、⌥クリック、キーと一覧、空のペインの選び方。
   - T5 動き：上の「動き」の節を motionKit で。
   - T6 文書：`docs/design.md` の節、i18n（ja・en・keys）、用語集に「ペイン」「分割」の行を足す。
3. implementer（sonnet）にタスクを 1 本ずつ渡す。そのあとは CLAUDE.local.md の流れ（確かめ、build 3 本、PR、CI、マージ、入れ替え）。
