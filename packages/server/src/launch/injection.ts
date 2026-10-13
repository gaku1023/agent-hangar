import { DEFAULT_LANGUAGE, localDate, localTime, osName, t, translator, type Language } from '@agent-hangar/shared';
import type { HandoverFacts } from '../runs/handover.ts';

/**
 * 指示に埋める事実。
 * handover はほかの PC で進めた会話をこの PC で起こすときの事実（runs/handover.ts の handoverFacts）で、あれば引き継ぎの段を足す。
 * deviceCount はプロジェクトを使っている PC の数で、2 以上なら弱い 1 文を足す。どちらも同期を使わない人には出ない。
 */
export type InjectionInput = { projectName: string; projectPath: string; todos: { id: string; text: string }[]; handover?: HandoverFacts | null; deviceCount?: number };

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
 * 文は辞書の鍵に分けてある。常に足す段（launch.injection.body）、区切りの問いの段（launch.injection.status）、ターンの意図と手の説明の段（launch.injection.live）である。
 * PC をまたぐ会話には、引き継ぎの段（launch.injection.handover）と、複数の PC で使うプロジェクトの 1 文（launch.injection.multiDevice）を、常に足す段の直後に足す。
 * この 2 つはスイッチを持たず、DB の事実で決める。
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
    i.handover ? renderHandover(i.handover, language) : '',
    (i.deviceCount ?? 0) >= 2 ? t(language, 'launch.injection.multiDevice', { deviceCount: String(i.deviceCount) }) : '',
    parts.askStatusAtEnd ? t(language, 'launch.injection.status') : '',
    parts.liveHints ? t(language, 'launch.injection.live') : '',
  ].join('');
}

/**
 * 引き継ぎの段。分からない値は「なし」の語で埋める。
 * 無いファイルは 1 行に 1 つで並べ、並べきれなかった分は「- …」の 1 行で省いたことを示す。
 */
function renderHandover(h: HandoverFacts, language: Language): string {
  const none = t(language, 'launch.injection.none');
  const os = (p: string | null) => osName(translator(language), p) ?? none;
  const files = h.missing.map((f) => `\n- ${f}`).join('') + (h.missingCount > h.missing.length ? '\n- …' : '');
  return t(language, 'launch.injection.handover', {
    prevDevice: h.prevDevice ?? none, prevOs: os(h.prevPlatform),
    lastAt: h.lastAt === null ? none : `${localDate(h.lastAt)} ${localTime(h.lastAt)}`,
    prevPath: h.prevPath, device: h.device ?? none, os: os(h.platform), path: h.path,
    branch: h.branch ?? none, editedCount: String(h.editedCount),
    missing: h.missingCount === 0 ? none : t(language, 'launch.injection.missing', { n: String(h.missingCount), files }),
  });
}
