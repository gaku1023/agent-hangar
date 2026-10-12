import { DEFAULT_LANGUAGE, t, type Language } from '@agent-hangar/shared';

export type InjectionInput = { projectName: string; projectPath: string; todos: { id: string; text: string }[] };

/**
 * 足す段の入り切り。設定の 2 つのスイッチ（askStatusAtEnd、liveHints）から組む。どちらも既定は入りである。
 * askStatusAtEnd は区切りで Done か Paused を聞く段（launch.injection.status）、liveHints はターンの意図と短い手の説明の段（launch.injection.live）である。
 */
export type InjectionParts = { askStatusAtEnd: boolean; liveHints: boolean };
export const DEFAULT_INJECTION_PARTS: InjectionParts = { askStatusAtEnd: true, liveHints: true };

/**
 * --append-system-prompt で渡す短い指示。ファイルや設定は書かず、要約の更新、片付いた TODO の候補、セッションの状態の問い、ターンの意図、短い手の説明を求める。
 * プロジェクトのノートは渡さない。Claude Code は CLAUDE.md と自動メモリを自分で読むので、渡すと同じ役が二重になる。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 * 状態は、頼まれたことが明確に終わったときだけ AskUserQuestion で聞かせる。利用者が選んだものは confirmed: true でそのまま状態になり、答えずに進めたものは候補として画面に残る。
 * attach で開く会話にはこの指示が渡らないので、そちらは事後の要約で拾う。
 *
 * 文は辞書の 3 つの鍵に分けてある。常に足す段（launch.injection.body）、区切りの問いの段（launch.injection.status）、ターンの意図と手の説明の段（launch.injection.live）である。
 * 段の中は行ごとに鍵を分けない。分けると、言語で行の切り方や語順を変えられない。
 * 英語の文は、日本語の指示の意味（何をいつ呼ぶか、条件、してはいけないこと）を 1 つも落とさずに訳す。
 * 言語を渡さなければ日本語で出し、段の入り切りを渡さなければ全部を足す。
 */
export function renderInjection(i: InjectionInput, language: Language = DEFAULT_LANGUAGE, parts: InjectionParts = DEFAULT_INJECTION_PARTS): string {
  const none = t(language, 'launch.injection.none');
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((todo) => `- [${todo.id}] ${todo.text}`).join('\n') : none;
  return [
    t(language, 'launch.injection.body', { projectName: i.projectName, projectPath: i.projectPath, todos: todoText }),
    parts.askStatusAtEnd ? t(language, 'launch.injection.status') : '',
    parts.liveHints ? t(language, 'launch.injection.live') : '',
  ].join('');
}
