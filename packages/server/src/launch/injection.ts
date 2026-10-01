export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: { id: string; text: string }[] };

const NONE = '（なし）';

/**
 * --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新、片付いた TODO の候補、ターンの意図、日本語の手の説明を求める。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 */
export function renderInjection(i: InjectionInput): string {
  const memo = i.memo?.trim() ? [...i.memo.trim()].slice(0, 500).join('') : NONE;
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((t) => `- [${t.id}] ${t.text}`).join('\n') : NONE;
  return [
    'あなたは agent-hangar から起動されたセッションです。',
    `プロジェクト：${i.projectName}（${i.projectPath}）`,
    `プロジェクトのメモの要約：${memo}`,
    `未完の TODO：${todoText}`,
    '過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。',
    '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、',
    'set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。',
    'TODO を片付けたと判断したら、update_project の propose_done に TODO の ID と根拠の一文を渡してください。',
    '完了にするのは利用者です。確かめられていないものは出さないでください。',
    'ターンを始めたときと方針を変えたときは、set_turn_intent に、このターンで何のために何をするかを 1〜2 文で書いてください。',
    'Bash と Agent の description は日本語で 20 字以内にしてください。',
    '',
  ].join('\n');
}
