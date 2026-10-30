import { DEFAULT_CODEX_INJECTION, DEFAULT_LANGUAGE, DEFAULT_NOTIFY_RULES, DEFAULT_OPENCODE_INJECTION, localDate, localTime, notifyOsLabel, notifyRulesLine, osName, t, translator, type CodexInjection, type Language, type NotifyRules, type OpencodeInjection } from '@agent-hangar/shared';
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
  /** 利用者に見てほしい出力を出したとき notify_user で知らせる段（launch.injection.notify）。設定の notifyUser。省けば入りとして読む。 */
  notifyUser?: boolean;
  /**
   * 知らせ方（notify の段の続き）。rules は起動のときの設定から notifyRulesOf で作った今の決まり、decided は設定 notifyPreference が決まっているか。
   * decided が真でなければ、最初のターンの終わりに知らせ方を 1 度聞く段（notifyAsk）を足す。platform は出し先の名前（Mac か Windows）を決める OS で、省けば process.platform。
   */
  notify?: { rules?: NotifyRules; decided?: boolean; platform?: string };
  /** opencode に足す量（設定の opencodeInjection）。省けば既定の最小限。Claude には効かない。 */
  opencode?: OpencodeInjection;
  /** Codex に足す量（設定の codexInjection）。省けば既定の最小限。Claude と opencode には効かない。 */
  codex?: CodexInjection;
};
export const DEFAULT_INJECTION_PARTS: InjectionParts = { askStatusAtEnd: true, liveHints: true, notifyUser: true };

type Agent = '' | 'opencode.' | 'codex.';

/**
 * notify の段の続き。保存の段（notifySave）は常に、未設定のときだけ聞く段（notifyAsk）を足す。
 * 今の決まりは起動のときの設定から、OS の名前は platform から差し込む。
 */
function notifyFollowEntries(language: Language, parts: InjectionParts, agent: Agent): InjectionEntry[] {
  const n = parts.notify ?? {};
  const os = notifyOsLabel(n.platform ?? process.platform);
  const rules = notifyRulesLine(translator(language), n.rules ?? DEFAULT_NOTIFY_RULES);
  const entries: InjectionEntry[] = [{ key: 'notifySave', text: t(language, `launch.injection.${agent}notifySave` as 'launch.injection.notifySave', { os, rules }) }];
  if (!n.decided) entries.push({ key: 'notifyAsk', text: t(language, `launch.injection.${agent}notifyAsk` as 'launch.injection.notifyAsk', { os }) });
  return entries;
}

/**
 * エージェントに渡す短い指示を、段ごとに組む。ファイルや設定は書かず、要約の更新、片付いた TODO の候補、セッションの状態の問い、ターンの意図、短い手の説明を求める。
 * どのエージェントにも通じる形（agent/types.ts の InjectionEntry）で返し、どう渡すかは driver が決める（Claude は段をつないで --append-system-prompt に渡す）。
 * プロジェクトのノートは渡さない。Claude Code は CLAUDE.md と自動メモリを自分で読むので、渡すと同じ役が二重になる。
 * TODO は ID を添えて渡す。ID が無いと、候補を出す前に get_project を呼んで引く一手が要るためである。
 * 状態は、頼まれたことが明確に終わったときだけ AskUserQuestion で聞かせる。利用者が選んだものは confirmed: true でそのまま状態になり、答えずに進めたものは候補として画面に残る。
 * attach で開く会話にはこの指示が渡らないので、そちらは事後の要約で拾う。
 *
 * 段は辞書の鍵に分けてある。常に足す段（body、launch.injection.body）、notify_user で知らせる段（notify、launch.injection.notify）、区切りの問いの段（status、launch.injection.status）、ターンの意図と手の説明の段（live、launch.injection.live）である。
 * notify の段は本文の直後に置く。後ろに置くと、ほかの段に埋もれて hangar の道具を丸ごと飛ばす回があった（docs/design.md「指示の注入」）。
 * notify の段の直後に、知らせ方を保存する段（notifySave、launch.injection.notifySave）と、知らせ方が未設定のときだけ最初のターンの終わりに聞く段（notifyAsk）を置く。
 * PC をまたぐ会話には、引き継ぎの段（handover、launch.injection.handover）と、複数の PC で使うプロジェクトの 1 文（multiDevice、launch.injection.multiDevice）を、notify の段の後に足す。
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
  if (parts.notifyUser !== false) entries.push({ key: 'notify', text: t(language, 'launch.injection.notify') }, ...notifyFollowEntries(language, parts, ''));
  if (i.handover) entries.push({ key: 'handover', text: renderHandover(i.handover, language) });
  if ((i.deviceCount ?? 0) >= 2) entries.push({ key: 'multiDevice', text: t(language, 'launch.injection.multiDevice', { deviceCount: String(i.deviceCount) }) });
  if (parts.askStatusAtEnd) entries.push({ key: 'status', text: t(language, 'launch.injection.status') });
  if (parts.liveHints) entries.push({ key: 'live', text: t(language, 'launch.injection.live') });
  return entries;
}

/**
 * opencode に足す段（docs/design.md「opencode の起動」）。量は設定の opencodeInjection で選ぶ。
 * minimal（既定）は hangar の MCP の使い方の段と、状態の段である（決定 6 の (a) に状態を足した）。
 * 本文には、利用者が Done か Paused にしてと言ったら confirmed: true で propose_session_status を呼ぶことを常に書く。
 * Code Mode の目録は道具の一部しか見せず、propose_session_status が隠れていると、モデルは set_session_summary の state で済ませてしまうためである。
 * 状態の段（askStatusAtEnd で入り切り）は、区切りで confirmed なしの提案だけを出させる。フォームで聞かせないのは、聞かずに confirmed: true を渡すモデルがあったためである（RESULT.md の (b)）。
 * 文は Claude 向けのものを流用せず、意図を呼ぶ時機を「各ターンの最初の一手で、他のツールより先に」と書き、Code Mode の呼び方（`tools.hangar.…`）を添える。
 * opencode 2.1.4 で 4 つのモデルを試し、ターンの始めの意図がどれも 3/3 になった書き方である（検証の条件 d）。
 * claude は Claude に足すのと同じ段で、意図の段だけ時機を同じ書き方に替える（条件 g）。段の入り切りの設定も Claude と同じく効く。
 * none は何も足さない。
 */
export function renderOpencodeInjectionEntries(i: InjectionInput, language: Language = DEFAULT_LANGUAGE, parts: InjectionParts = DEFAULT_INJECTION_PARTS, choice: OpencodeInjection = DEFAULT_OPENCODE_INJECTION): InjectionEntry[] {
  if (choice === 'none') return [];
  if (choice === 'minimal') {
    const entries: InjectionEntry[] = [{ key: 'body', text: t(language, 'launch.injection.opencode.minimal') }];
    if (parts.notifyUser !== false) entries.push({ key: 'notify', text: t(language, 'launch.injection.opencode.notify') }, ...notifyFollowEntries(language, parts, 'opencode.'));
    if (parts.askStatusAtEnd) entries.push({ key: 'status', text: t(language, 'launch.injection.opencode.status') });
    return entries;
  }
  const follow = notifyFollowEntries(language, parts, 'opencode.');
  return renderInjectionEntries(i, language, parts).flatMap((e) => (e.key === 'live' ? [{ key: 'live', text: t(language, 'launch.injection.opencode.live') }] : e.key === 'notify' ? [{ key: 'notify', text: t(language, 'launch.injection.opencode.notify') }, ...follow] : e.key === 'notifySave' || e.key === 'notifyAsk' ? [] : [e]));
}

/**
 * Codex に足す段（docs/design.md「Codex の起動（ベータ）」）。量は設定の codexInjection で選ぶ。
 * minimal（既定）は hangar の MCP の使い方の段と、状態の段で、opencode の最小限の段を Codex 向けに書き直したものである。
 * opencode の文は Code Mode の呼び方（`tools.hangar.…`）を添えているが、Codex は道具の呼び方を自分で決めるので、道具は名前だけで指す。
 * 既定の量は、段 B の B6 で本物のモデルで比べて決める（それまでは最小限）。
 * claude は Claude に足すのと同じ段、none は何も足さない。
 */
export function renderCodexInjectionEntries(i: InjectionInput, language: Language = DEFAULT_LANGUAGE, parts: InjectionParts = DEFAULT_INJECTION_PARTS, choice: CodexInjection = DEFAULT_CODEX_INJECTION): InjectionEntry[] {
  if (choice === 'none') return [];
  if (choice === 'claude') return renderInjectionEntries(i, language, parts);
  const entries: InjectionEntry[] = [{ key: 'body', text: t(language, 'launch.injection.codex.minimal') }];
  if (parts.notifyUser !== false) entries.push({ key: 'notify', text: t(language, 'launch.injection.codex.notify') }, ...notifyFollowEntries(language, parts, 'codex.'));
  if (parts.askStatusAtEnd) entries.push({ key: 'status', text: t(language, 'launch.injection.codex.status') });
  return entries;
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
