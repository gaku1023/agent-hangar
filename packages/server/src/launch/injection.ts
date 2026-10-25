import { DEFAULT_LANGUAGE, DEFAULT_OPENCODE_INJECTION, localDate, localTime, osName, t, translator, type Language, type OpencodeInjection } from '@agent-hangar/shared';
import type { InjectionEntry } from '../agent/types.ts';
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
export type InjectionParts = {
  askStatusAtEnd: boolean;
  liveHints: boolean;
  /** opencode に足す量（設定の opencodeInjection）。省けば既定の最小限。Claude には効かない。 */
  opencode?: OpencodeInjection;
};
export const DEFAULT_INJECTION_PARTS: InjectionParts = { askStatusAtEnd: true, liveHints: true };

/**
 * エージェントに渡す短い指示を、段ごとに組む。ファイルや設定は書かず、要約の更新、片付いた TODO の候補、セッションの状態の問い、ターンの意図、短い手の説明を求める。
 * どのエージェントにも通じる形（agent/types.ts の InjectionEntry）で返し、どう渡すかは driver が決める（Claude は段をつないで --append-system-prompt に渡す）。
 * プロジェクトのノートは渡さない。Claude Code は CLAUDE.md と自動メモリを自分で読むので、渡すと同じ役が二重になる。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 * 状態は、頼まれたことが明確に終わったときだけ AskUserQuestion で聞かせる。利用者が選んだものは confirmed: true でそのまま状態になり、答えずに進めたものは候補として画面に残る。
 * attach で開く会話にはこの指示が渡らないので、そちらは事後の要約で拾う。
 *
 * 段は辞書の鍵に分けてある。常に足す段（body、launch.injection.body）、区切りの問いの段（status、launch.injection.status）、ターンの意図と手の説明の段（live、launch.injection.live）である。
 * PC をまたぐ会話には、引き継ぎの段（handover、launch.injection.handover）と、複数の PC で使うプロジェクトの 1 文（multiDevice、launch.injection.multiDevice）を、常に足す段の直後に足す。
 * この 2 つはスイッチを持たず、DB の事実で決める。
 * 足さない段は入れない。段の文は末尾の改行まで含むので、区切りを足さずにつなげば 1 つの指示になる。
 * 段の中は行ごとに鍵を分けない。分けると、言語で行の切り方や語順を変えられない。
 * 英語の文は、日本語の指示の意味（何をいつ呼ぶか、条件、してはいけないこと）を 1 つも落とさずに訳す。
 * 言語を渡さなければ日本語で出し、段の入り切りを渡さなければ全部を足す。
 */
export function renderInjectionEntries(i: InjectionInput, language: Language = DEFAULT_LANGUAGE, parts: InjectionParts = DEFAULT_INJECTION_PARTS): InjectionEntry[] {
  const none = t(language, 'launch.injection.none');
  const todos = i.todos.slice(0, 10);
  const todoText = todos.length ? '\n' + todos.map((todo) => `- [${todo.id}] ${todo.text}`).join('\n') : none;
  const entries: InjectionEntry[] = [{ key: 'body', text: t(language, 'launch.injection.body', { projectName: i.projectName, projectPath: i.projectPath, todos: todoText }) }];
  if (i.handover) entries.push({ key: 'handover', text: renderHandover(i.handover, language) });
  if ((i.deviceCount ?? 0) >= 2) entries.push({ key: 'multiDevice', text: t(language, 'launch.injection.multiDevice', { deviceCount: String(i.deviceCount) }) });
  if (parts.askStatusAtEnd) entries.push({ key: 'status', text: t(language, 'launch.injection.status') });
  if (parts.liveHints) entries.push({ key: 'live', text: t(language, 'launch.injection.live') });
  return entries;
}

/**
 * opencode に足す段（docs/design.md「opencode の起動」）。量は設定の opencodeInjection で選ぶ。
 * minimal（既定）は hangar の MCP の使い方だけの 1 段である（決定 6 の (a)）。
 * 文は Claude 向けのものを流用せず、意図を呼ぶ時機を「各ターンの最初の一手で、他のツールより先に」と書き、Code Mode の呼び方（`tools.hangar.…`）を添える。
 * opencode 2.1.4 で 4 つのモデルを試し、ターンの始めの意図がどれも 3/3 になった書き方である（検証の条件 d）。
 * claude は Claude に足すのと同じ段で、意図の段だけ時機を同じ書き方に替える（条件 g）。段の入り切りの設定も Claude と同じく効く。
 * none は何も足さない。
 */
export function renderOpencodeInjectionEntries(i: InjectionInput, language: Language = DEFAULT_LANGUAGE, parts: InjectionParts = DEFAULT_INJECTION_PARTS, choice: OpencodeInjection = DEFAULT_OPENCODE_INJECTION): InjectionEntry[] {
  if (choice === 'none') return [];
  if (choice === 'minimal') return [{ key: 'body', text: t(language, 'launch.injection.opencode.minimal') }];
  return renderInjectionEntries(i, language, parts).map((e) => (e.key === 'live' ? { key: 'live', text: t(language, 'launch.injection.opencode.live') } : e));
}

/** 段を区切りを足さずにつないだ 1 つの指示。Claude の --append-system-prompt に渡す文と同じである。 */
export function renderInjection(i: InjectionInput, language: Language = DEFAULT_LANGUAGE, parts: InjectionParts = DEFAULT_INJECTION_PARTS): string {
  return renderInjectionEntries(i, language, parts).map((e) => e.text).join('');
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
