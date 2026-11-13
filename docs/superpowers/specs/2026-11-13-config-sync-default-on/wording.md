# 設定の同期の画面の新しい文言（Gemini 校閲用）

新しく足した日本語と英語の鍵。`{n}` などは差し込みの名前で、そのまま残す。
既存の文言は変えていない。

| 鍵 | ja | en | どこに出るか |
|---|---|---|---|
| `configKindsUi.kind.transcript` | トランスクリプト | Conversation text | 設定の同期の節、種類の行（先頭） |
| `configKindsUi.bundle.instr` | 指示 | Instructions | 設定の同期の節、束の見出し（束のつまみの左） |
| `configKindsUi.bundle.skill` | スキルとコマンド | Skills and commands | 設定の同期の節、束の見出し（束のつまみの左） |
| `configKindsUi.bundle.mem` | 記憶 | Memory | 設定の同期の節、束の見出し（束のつまみの左） |
| `configKindsUi.bundle.conf` | 設定 | Settings | 設定の同期の節、束の見出し（束のつまみの左） |
| `configKindsUi.bundle.exec` | 自動で走るコード | Code that runs automatically | 設定の同期の節、束の見出し（束のつまみの左） |
| `configKindsUi.mode.off` | 切 | Off | 切、確認、自動のつまみの語（行と束の見出し） |
| `configKindsUi.mode.confirm` | 確認 | Ask | 切、確認、自動のつまみの語（行と束の見出し） |
| `configKindsUi.mode.auto` | 自動 | Auto | 切、確認、自動のつまみの語（行と束の見出し） |
| `configKindsUi.links.label` | リンクのため同期しない {n} 件 | {n} left out as links | 種類の行の、リンクで外した件数のチップ（読み上げと title） |
| `configKindsUi.exec.warn` | 他の PC から受信した {name} は、確認なしでこの PC で実行されます。 | {name} from your other PCs will run on this PC without asking. | 自動で走るコードを自動にするときに行の下へ開く 1 文の帯 |
| `configKindsUi.exec.cancel` | キャンセル | Cancel | 同じ帯のボタン |
| `configKindsUi.exec.ok` | 自動にする | Make it automatic | 同じ帯のボタン（帯の読み上げ名も兼ねる） |
| `configKindsUi.inbox.title` | 受信したもの | Received | 右の列の見出し |
| `configKindsUi.inbox.ask` | 確認 | To review | 右の列、確認の見出し |
| `configKindsUi.inbox.apply` | 適用 | Apply | 右の列、確認の「適用」ボタン（承認のダイアログを開く） |
| `configKindsUi.inbox.conflict` | 競合 | Conflicts | 右の列、競合の見出し |
| `configKindsUi.inbox.decide` | 決める | Decide | 右の列、競合の「決める」ボタン |
| `configKindsUi.inbox.mine` | この PC | Mine | 右の列、競合の手元、相手のつまみ |
| `configKindsUi.inbox.remote` | 他の PC | Theirs | 右の列、競合の手元、相手のつまみ |
| `configKindsUi.inbox.autoError` | 自動の適用に失敗しました（{time}）{message} | Automatic apply failed ({time}): {message} | 右の列の上、自動の適用が失敗したときの帯 |
| `configKindsUi.history.toggle` | {when} {from} | {when} {from} | 右の列、履歴 1 回分の見出しボタンの読み上げ名 |
| `configKindsUi.history.undoBatch` | まとめて戻す | Undo all | 右の列、開いた履歴の「まとめて戻す」 |
| `configKindsUi.history.undoItem` | {name} を戻す | Undo {name} | 右の列、1 項目の戻すボタンの読み上げ名 |
| `configKindsUi.badge.ask` | 確認が必要な設定が {n} 件あります | {n} settings need your review | ヘッダの札（確認の件数）の読み上げと title |
| `configKindsUi.badge.quiet` | 自動で入った設定が {n} 回あります | {n} automatic updates arrived | ヘッダの札（自動で入った件数）の読み上げと title |
| `configKindsUi.first.write` | この PC に追加する | Add to this PC | 競合のダイアログ（初回の突き合わせ）、片方にしか無いものの件数 |
| `configKindsUi.first.links` | リンクのため同期しない | Left out as links | 同じダイアログ、リンクで外した件数 |
| `configKindsUi.first.allMine` | すべてこの PC | All mine | 同じダイアログ、全部の行を手元にそろえる |
| `configKindsUi.first.allRemote` | すべて他の PC | All theirs | 同じダイアログ、全部の行を相手にそろえる |
| `sync.configNotice.title` | Hangar | Hangar | OS の通知の題（設定の同期の確認、競合、失敗。T6 の仮の文言） |
| `sync.configNotice.ask` | 確認が必要な設定が {count} 件届きました | {count} settings changes need your confirmation | OS とスマホの通知の本文（T6 の仮の文言） |
| `sync.configNotice.conflict` | 設定の競合が {count} 件あります | {count} settings conflicts need your decision | 同上 |
| `sync.configNotice.autoFailed` | 設定の自動の適用に失敗しました | Automatic settings sync failed to apply | 同上 |

## 校閲のあと（2026-11-13）

Gemini の校閲で直した最終の文言は、`packages/shared/src/i18n/{ja,en}/configKindsUi.ts` と `sync.ts` にある。
札の数は「件」にそろえ、英語の Mine と Theirs は This PC と Other PCs にした。
