import { DEFAULT_LANGUAGE, t, type Language } from '@agent-hangar/shared';

export type InjectionInput = { projectName: string; projectPath: string; memo: string | null; todos: { id: string; text: string }[] };

/**
 * --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新、片付いた TODO の候補、セッションの状態の問い、ターンの意図、短い手の説明を求める。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 * 状態は、依頼を終えた区切りでだけ AskUserQuestion で聞かせる。利用者が選んだものは confirmed: true でそのまま状態になり、答えずに進めたものは候補として画面に残る。
 * attach で開く会話にはこの指示が渡らないので、そちらは事後の要約で拾う。
 *
 * 文は辞書の 1 つの鍵（launch.injection.body）にまとめてある。行ごとに鍵を分けると、言語で行の切り方や語順を変えられない。
 * 英語の文は、日本語の指示の意味（何をいつ呼ぶか、条件、してはいけないこと）を 1 つも落とさずに訳す。
 * 言語を渡さなければ日本語で出す。
 */
export function renderInjection(i: InjectionInput, language: Language = DEFAULT_LANGUAGE): string {
  const none = t(language, 'launch.injection.none');
  const memo = i.memo?.trim() ? [...i.memo.trim()].slice(0, 500).join('') : none;
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((todo) => `- [${todo.id}] ${todo.text}`).join('\n') : none;
  return t(language, 'launch.injection.body', { projectName: i.projectName, projectPath: i.projectPath, memo, todos: todoText });
}
