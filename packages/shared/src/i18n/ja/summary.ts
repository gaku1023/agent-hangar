import type { summaryKeys } from '../keys/summary.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const summaryJa: AreaDictionary<typeof summaryKeys> = {
  'summary.claude.missing': 'claude が見つかりません',
  'summary.claude.exited': 'claude が {code} で終了しました: {detail}',
  'summary.claude.notJson': '出力が JSON ではありません',
  'summary.claude.noStructuredOutput': '出力に structured_output がありません',
  'summary.claude.badStructuredOutput': 'structured_output がスキーマの形ではありません',
  'summary.lmstudio.noModel': 'LM Studio にモデルがありません',
  'summary.lmstudio.unreachable': 'LM Studio に接続できません: {reason}',
  'summary.lmstudio.redirected': '要約器の宛先がリダイレクトを返しました。飛ばし先へは送りません。設定の「{label}」を確かめてください',
  'summary.lmstudio.badStatus': 'LM Studio が {status} を返しました',
  'summary.lmstudio.emptyContent': '本文が空でした（思考モデルの可能性があります）',
  'summary.lmstudio.notJson': '本文が JSON ではありません',
  'summary.lmstudio.badShape': '本文がスキーマの形ではありません',
  'summary.engine.unavailable': '使えません（接続できないか、上限に達しています）',
  'summary.error.noTranscript': 'トランスクリプトがありません',
  'summary.error.noEngine': '要約器がありません',
  'summary.input.omitted': '[... {n} 件を省略 ...]',
  'summary.input.running': 'このセッションは現在も実行中です。',
  'summary.canned.text': '[user] README の導入手順が古いので、Node 22 と npm workspaces 前提に書き直して。\n[assistant] 現状の README を読み、setup 節と開発の節を書き直します。\n[tool] Read README.md\n[tool] Edit README.md\n[assistant] 導入手順を Node 22、npm ci、npm run dev の 3 手順にし、pnpm の記述を消しました。CI の節も同じ前提に揃えました。\n[user] ありがとう。CONTRIBUTING.md も同じ前提で直しておいて。\n[tool] Edit CONTRIBUTING.md\n[assistant] CONTRIBUTING.md の開発環境の節を直しました。他に古い記述は見つかりませんでした。',
  'summary.prompt.system': "以下はコーディングエージェントのセッションログの抜粋です。日本語で、指定の JSON だけを返してください。\ntitle は名詞句（40 字まで）、one_liner は 1 文（80 字まで）、body は 2〜3 文、next_steps は具体的な行動（5 件まで）。\nstate の判定：最後の発言がアシスタントの問いかけや確認で終わっていれば in_progress。依頼が果たされていれば done。\nエラーや権限や情報の不足で進めなくなっていれば blocked。途中で打ち切られていれば abandoned。\n先頭に「このセッションは現在も実行中」とあれば、完了と断定せず in_progress を選ぶ。\nproposed_status の判定：頼まれたことが終わり、確かめることも残っていなければ done。終わったが確かめることが残っていれば paused。まだ途中なら none。\nproposed_note は判定の根拠を 1 文で（200 字まで）。paused なら何を確かめに戻るかを書く。none なら空文字にする。\nproposed_return_in_days は paused のとき戻るまでの日数（1〜14）。paused でなければ 0。\n先頭に「このセッションは現在も実行中」とあれば、proposed_status は none を選ぶ。",
};
