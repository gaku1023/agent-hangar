export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: string[] };

const NONE = '（なし）';

/** --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新だけを求める。 */
export function renderInjection(i: InjectionInput): string {
  const memo = i.memo?.trim() ? [...i.memo.trim()].slice(0, 500).join('') : NONE;
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((t) => `- ${t}`).join('\n') : NONE;
  return [
    'あなたは agent-hangar から起動されたセッションです。',
    `プロジェクト：${i.projectName}（${i.projectPath}）`,
    `プロジェクトのメモの要約：${memo}`,
    `未完の TODO：${todoText}`,
    '過去のセッションは MCP ツール search_sessions と get_transcript で参照できます。',
    '依頼を完了したとき、方針が大きく変わったとき、作業を中断するときは、',
    'set_session_summary で題名、2〜3 文の要約、状態、次の一手を更新してください。',
    '',
  ].join('\n');
}
