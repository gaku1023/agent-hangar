# spike 15: 実車の手順（CarPlay の実測）

机の上の予行（実機、iPhone17,1、iOS 27.2）を済ませた版である。

上から順にやれば、項目 ①〜⑨ がすべて埋まる。
イベントの種類（kind）は sink に届くものの名前である。
Claude が sink を見て、各ステップを確かめる。

車に乗るまで確かめられていないこと。
- ハンドルのボタンが、どの `remote.*` になるか。Call 中の操作も含む。
- CarPlay が Call の通話を画面に出すか。「再生中」にタイトルが出るか。
- 車の経路、切断と再接続、CarPlay 接続でのオートメーション。
- 30 分以上のロック、圏外からの復帰、割り込みからの復帰。
- CarPlay の Siri からの呼び出し（⑨）。

## 安全
- 走行中は、iPhone に一切さわらない。画面も見ない。
- 画面の操作は、すべて停車中にやる。駐車場や路肩で、サイドブレーキを引いてから。
- 走行中に使ってよいのは、声とハンドルのボタンだけ。
- 信号待ちでも、スマホは持たない。文例は覚えておくか、同乗者に読んでもらう。
- 無理だと感じたら、その項目は飛ばす。

## 机の上で先にやる（車に乗る前）
最初の起動を車の中でやってはいけない。
1. CarProbe を起動し、マイクと音声認識の許可を両方出す。
2. 画面に「動作中」と出ていれば何も押さない。「停止中」のときだけ「開始」を押す。
3. 「マイク: オン」の状態で何か話し、`speech.final` が 1 件届くことを確かめる。これで ja-JP のモデルも先に入る。
4. 机では読み上げが本体の受話口（Receiver）から出る。AirPods は HFP のマイクを使わない。想定どおりで、不具合ではない。
   - 受話口の音が小さいときは、「机用: スピーカーで鳴らす」をオンにすると本体のスピーカーで鳴る（2 ch）。
   - このスイッチは車ではオフにする。
5. イヤホンがない机では、ロック画面とコントロールセンターの再生操作でも `remote.*` が届く（① の代わり）。
   - skipForward と skipBackward を登録しているため、次へと前への代わりに ±15 秒のボタンが出る。

## 乗る前
1. CarProbe が iPhone に入っている。無料チームの署名は 7 日で切れる。
   - 入れたのは 2026-10-29 である。7 日を過ぎていたら、乗る前に入れ直す。
2. 電波が入る場所で、画面の「送信待ち: N 件」の行が 0 件になる。これで sink に届くと分かる。
3. 「起動したら自動で開始」をオンにする。
4. ショートカット App で、オートメーションを作る。
   - トリガは「CarPlay に接続したとき」。
   - アクションは CarProbe の「プローブを開始」（StartProbeIntent）。
   - 「実行前に確認」をオフにする。「実行時に通知」もオフにする。
5. CarProbe を開き、画面上部の run id を控える。例: `CarProbe  run 3F2A9C1B`。
   - 画面に出るのは先頭 8 文字だけで、sink には完全な UUID が入る。
6. Claude に伝える。run id は起動のたびに変わる。
   - 起動のたびに新しい run になる。Claude は新しい順に run を探す。
7. 「机用: スピーカーで鳴らす」がオフであることを確かめる。
   - 最後の `deskSpeaker` イベントが `on=false` であれば確実である。
   - オンのままだと、車の経路を上書きしてしまう。
8. 「ログを共有」で、最後の保険の書き出しができることも一度確かめる。
9. 今の iPhone は Siri がオフである。⑨ は Siri がオンでないと測れない。
   - 設定で Siri をオンにしてから乗る。
   - オンにしないなら、⑨ は「未測定」と決めて、I を飛ばす。
   - アプリ側の受け口は机で確認済みである。ショートカット App の「承認」で `siri.ping` が届いた。
10. ショートカット App の CarProbe に、短い名前「開始」と「承認」が出ていることを見る。
   - 声の言い方は「CarProbe を開始」「CarProbe で承認」「CarProbe の状況」である。

## 停車中
エンジンをかけ、CarPlay につなぐ。
つないだ直後に、オートメーションが動くか見る。動かなければ、手で CarProbe を開く。

### A. 経路と接続（②⑤）
1. CarPlay につないだ状態にする。画面に「動作中」と出ていれば何も押さない。「停止中」のときだけ「開始」を押す。
   - 見る kind: `route`（ポート、チャンネル数、サンプルレート）、`carplay.connected`。
2. ケーブルを抜く。5 秒待つ。挿し直す。これを 2 回やる。
   - 見る kind: `carplay.disconnected`、`carplay.connected`、`route`。

### B. Media のハンドルボタン（①）
1. モードを「Media」にする。
2. 先に「マイク: オン」を押して「マイク: オフ」にする。マイクは既定でオンである。
   - そのうえで、ハンドルのボタンを押す。次の順に、各 2 回ずつ。
   - 再生と停止、次へ、前へ。
   - 見る kind: `remote.`で始まるもの（例: `remote.play`、`remote.pause`、`remote.togglePlayPause`、`remote.skipForward`、`remote.skipBackward`、`remote.like`）。
   - どのボタンがどの kind になったかを、Claude が表にする。
   - 机では ±15 秒のボタンが出た。車でも、次へと前へが `remote.skipForward` と `remote.skipBackward` で届くかもしれない。
   - 機種によっては `remote.nextTrack`、`remote.previousTrack`、`remote.stop` なども出る。
3. 「マイク: オン」にする。同じボタンを各 2 回ずつ押す。
   - 見る kind: 同じく `remote.*`。加えて `speech.partial`、`speech.final`。
   - `remote.silenceFailed` は、無音ループの起動失敗である。ボタンが届かない印ではない。

### C. Call のハンドルボタン（①）
1. モードを「Call」にする。
   - 見る kind: `mode`、`call.start`、`call.audioActivated`（約 1 秒後）。
   - `call.didBegin` はアプリ起動時（provider の生成時）に出る。モード切替では出ない。
   - 机では、システムの通話操作は出なかった。ロック画面にも、Dynamic Island の長押しにも出ない。緑の通話表示だけが出る。
   - 車では、CarPlay の画面が通話を出すかを見る。出すかどうかを、先に言う。
2. 「マイク: オフ」にして、ハンドルのボタンを各 2 回ずつ押す。
   - 見る kind: `call.setHeld`、`call.setMuted`、`call.end`、`call.answer`、`call.playDTMF` など。`remote.*` が出るかも見る。
   - CarPlay に通話の操作が出ていれば、停車中に、ミュート、保留、終了もそこで押す。
3. 「マイク: オン」で、同じことをもう一度やる。
   - 見る kind: 同じ `call.*`、`speech.partial`、`speech.final`。
4. 通話が切れたら、`call.end`、`call.timedOut`、`call.endError`、`call.reset` を Claude が見る。
5. Media に戻す。`mode` が出て、それ以降に `call.*` が出ないこと。前のモードのハンドラが残っていないか確かめる。
   - `mediaReset` は、システムのリセット時だけ出る。モード切替では出ない。

### D. 「再生中」の文字（④）
1. Media にする。「動作中」と出ていれば何も押さない。「停止中」のときだけ「開始」を押す。
2. CarPlay の「再生中」の画面を見る。タイトルが `Probe 0:42` のような形で、秒が進んでいるか。
3. 見えたタイトルを、声に出して言う。車のマイクを通して聞こえるように、はっきり。
4. 見えなければ「見えない」と言う。サブタイトルに「最後のボタン」が出るかも言う。

### E. 降りて乗り直す（⑦）
1. 降りる前に、オートメーションが設定済みか確かめる（乗る前の 4）。
2. CarProbe を終了する（アプリスイッチャで上にスワイプ）。
3. CarPlay を切り、降りて、ロックして 30 秒待つ。乗り直して CarPlay につなぐ。
   - 見る kind: `launch`、`intent.start`、`carplay.connected`、`heartbeat`。
   - 自動で録音が始まるか。`launch` の `autoStart` の値も見る。
   - 机では、起動が 2 回起きた。Claude は 2 つの run を両方読む。
   - 1 つ目は約 1 秒のバックグラウンド起動で、きれいに終わる。
   - 2 つ目が `intent.start` を受けて、自動で始まる。
   - そのため、オートメーション起動のあとに `prevRunEnded` が出ないのは正常である。
   - 前回が途中で切れていれば `prevRunEnded` が出る。

## 走行中
走り出す前に、「動作中」と出ていれば何も押さない。「停止中」のときだけ「開始」を押す。Media でマイクをオンにして、そのあとロックする。
以後は iPhone にさわらない。

### F. ロックして 30 分以上（③⑦）
1. 画面をロックして、そのまま走る。30 分以上。
   - 見る kind: `heartbeat`（途切れずに続くか）、`scenePhase`、`speech.final`、`tts.start`、`tts.finish`。
   - 約 50 秒で強制終了されたなら heartbeat が止まる。次に開いたときの `prevRunEnded` で分かる。
2. 圏外に入っても、そのまま走る。つながったあと、`送信待ち` が減って順に届くこと。

### G. 信号待ちの文例（⑧）
信号待ちのたびに、次の文を 1 つずつ、上から順に普通の声で読む。
1. agent-hangar のセッション一覧を教えて
2. PR 42 をマージして
3. Codex のセッションを止めて
4. worktree を作って npm test を回して
5. 研究室の PC に切り替えて
6. Claude Code の最後の返答を要約して
7. main ブランチに rebase して push して
8. CI が落ちた理由を調べて
9. Slurm のジョブを sbatch で投げて
10. TypeScript の型エラーを直してコミットして

- 見る kind: `speech.partial`、`speech.final`、`speech.fallback`、`speech.error`、`tts.start`、`tts.finish`。
- 読んだ番号は、あとで Claude が時刻で突き合わせる。読むたびに「N 番」と声に出して言う。
- 10 個読み終えたら、1 番に戻る。

### H. 割り込み（⑥）
1. ナビの案内が入るように、目的地を乗る前に設定しておく。録音中に案内が流れるのを待つ。
   - 見る kind: `interruption.began`、`interruption.ended`、`interruption.resumeAttempt`、`interruption.noResume`。
   - 案内のあと録音と読み上げが戻るか。`noResume` は、戻らなかった印である。
2. 可能なら、同乗者や別の電話から着信を 1 回受ける。ハンドルのボタンで出て、切る。
   - 見る kind: 同じ `interruption.*`、`route`、そのあとの `speech.final`。

### I. Siri（⑨）
Siri をオンにしていない場合は、この項を「未測定」として飛ばす。
1. CarPlay の Siri を呼ぶ。ハンドルの音声ボタンの長押し。
2. 「CarProbe で承認」と言う。1 回。
3. 返事が「受け取りました」と聞こえるか。
   - 見る kind: `siri.ping`。
4. 通らなかったら、「CarProbe の状況」でもう 1 回。
5. 「CarProbe を開始」も 1 回試す（`intent.start`）。

## 終わったら
1. 停車して、画面を開く。「送信待ち: N 件」が 0 件になるまで待つ。
2. 「停止」を押す。
3. 「ログを共有」で、端末内のログを書き出す（保険）。
4. 見えたものを覚えているうちに Claude に伝える。「再生中」の表示、Siri の返事、音の途切れ、気づいた不具合。

## Claude が見るもの
走行中も停車中も、Claude が sink を読む。書き込みはしない。

まず run を新しい順に並べる。

```
wrangler d1 execute carprobe --remote --command "SELECT run, min(at), max(at), count(*) FROM events GROUP BY run ORDER BY max(at) DESC"
```

画面の 8 文字は、run の先頭である。`LIKE` か完全な UUID で絞る。
`wrangler d1 execute --json` の出力は、detail に引用符が入ると壊れる。
detail を読むときは、下の `GET /e` を使う。

```
wrangler d1 execute carprobe --remote --command "SELECT seq, at, kind, detail FROM events WHERE run LIKE '3F2A9C1B%' ORDER BY seq DESC LIMIT 50"
curl -s -H "Authorization: Bearer <token>" "<sink>/e?run=<完全な UUID>&after=<seq>"
```

- 経過時間は heartbeat の時刻から出す。「生存確認、n 分」の n は、マイクを起動し直すたびに 1 に戻るため使わない。
- `speech.muted` の on と off は、読み上げ（TTS）の前後を挟む。この区間の `speech.*` は、本人の発話として数えない。
- `speech.error` のうち、モード切替、マイクの切替、`interruption.resumeAttempt` の直前直後に出たものは数えない。停止時に出る偽のエラーである。

- 最後の `heartbeat` の時刻で、ロック中の継続（③）を見る。
- kind ごとの件数を数えて、各ボタンが 2 回ずつ届いたかを確かめる（①）。
- `prevRunEnded` と最後の heartbeat から、強制終了の秒数を出す（⑦）。
- 走行中は、結果を運転手に話しかけない。停車してから伝える。
