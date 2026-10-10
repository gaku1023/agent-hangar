import type { launchKeys } from '../keys/launch.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const launchJa: AreaDictionary<typeof launchKeys> = {
  'launch.injection.none': '（なし）',
  'launch.injection.body': "あなたは agent-hangar から起動されたセッションです。\nプロジェクト：{projectName}（{projectPath}）\nプロジェクトのノートの要約：{memo}\n未完の TODO：{todos}\n過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。\n依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、\nset_session_summary で題名、2〜3 文の要約、進捗、次のステップを更新してください。\nTODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。\n完了にするのは利用者です。確認できていないものは出さないでください。\n頼まれたことを終えたと判断したターンの終わりに、AskUserQuestion で「このセッションをどうしますか」と聞いてください。選択肢は「Done にする」「Paused · <リマインダーの日付。時刻に意味があれば時刻も>（理由。何を確認しに戻るか）」「まだ続ける」です。\n利用者が Done か Paused を選んだら、propose_session_status に confirmed: true で渡してください。答えずに次の指示へ進んだら、confirmed なしで提案だけ出してください。\nPaused のリマインダーの日付は return_on（YYYY-MM-DD）に、確認する時刻が決まっているときは return_time（HH:MM、手元の時刻）にも渡してください。時刻を note の文だけに書かないでください。\n途中のターンでは聞かないでください。\nターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。\nBash と Agent の description は日本語で 20 字以内にしてください。\n",
  'launch.mcpConfig.badId': 'この id は設定ファイルの名前に使えません',
  'launch.add.label': '札を足す',
  'launch.chip.account': 'アカウント',
  'launch.chip.addDirs': '追加ディレクトリ',
  'launch.chip.effort': 'effort レベル',
  'launch.chip.model': 'モデル',
  'launch.chip.name': '名前',
  'launch.chip.worktree': 'worktree',
  'launch.chips.label': '起動の設定',
  'launch.edit.addDirsHint': '1 行に 1 つ',
  'launch.edit.modelOther': 'ほかのモデルの名前',
  'launch.edit.namePlaceholder': '一覧での表示名',
  'launch.edit.worktreePlaceholder': '空なら通常の作業ディレクトリ',
  'launch.permission.label': '権限モード',
  'launch.permission.previous': '前回',
  'launch.value.default': '既定',
  'launch.value.dirCount': '{n} 件',
  'launch.value.none': 'なし',
};
