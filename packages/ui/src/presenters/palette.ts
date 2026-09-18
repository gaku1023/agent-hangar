import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';

/** 最後の活動が新しい順。時刻が同じか無いものは id の順にして、並びを決定的にする。 */
const byRecency = <T extends { id: string; lastActivityAt: number | null }>(items: T[]): T[] =>
  [...items].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.id.localeCompare(b.id));

export type PaletteItem = { id: string; label: string; hint: string; kind: 'command' | 'project' | 'session' };
export type PaletteProps = { query: string; items: PaletteItem[] };

/** パレットから直に実行できる操作。
 * ここに並ぶのはショートカットを覚えていなくても辿り着けるべきものだけで、画面の中にしか無い操作は載せない。
 */
const COMMANDS: PaletteItem[] = [
  { id: 'cmd:new-session', label: '新規セッション', hint: '⌘N', kind: 'command' },
  { id: 'cmd:new-scratch', label: 'スクラッチで始める', hint: '⌘⇧N', kind: 'command' },
  { id: 'cmd:settings', label: '設定', hint: '⌘,', kind: 'command' },
  { id: 'cmd:rebuild-index', label: '索引を作り直す', hint: '', kind: 'command' },
];

const KIND_ORDER: Record<PaletteItem['kind'], number> = { command: 0, project: 1, session: 2 };

/** 表示できる上限。これを超える分は切り捨てる。 */
const LIMIT = 30;

/**
 * 部分列の一致に点を付ける。
 * 入力の各文字が同じ順に現れれば一致とみなし、前にあるほど、直前の文字と連続しているほど高い点にする。
 * 一致しなければ 0 を返す。
 * 入力が空のときは 1 を返し、すべての項目が同じ点で並ぶようにする。
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let score = 0;
  let at = 0;
  let prev = -2;
  for (const ch of q) {
    const i = t.indexOf(ch, at);
    if (i < 0) return 0;
    score += 10 + Math.max(0, 20 - i) + (i === prev + 1 ? 15 : 0);
    prev = i;
    at = i + 1;
  }
  return score;
}

/** パレットの項目。overlay がパレットでなければ null を返す。入力欄の文字は Root が持ち、引数で渡す。 */
export function presentPalette(state: State, store: Store, query: string): PaletteProps | null {
  if (state.overlay.kind !== 'palette') return null;
  const scored: { item: PaletteItem; score: number; at: number }[] = [];
  const push = (item: PaletteItem, text: string) => {
    const s = fuzzyScore(query, text);
    if (s > 0) scored.push({ item, score: s, at: scored.length });
  };
  for (const c of COMMANDS) push(c, c.label);
  // スクラッチの擬似プロジェクトはカードに出さないので、ここがその画面への唯一の入口になる。
  for (const p of byRecency(Object.values(store.projects))) push({ id: `project:${p.id}`, label: p.name, hint: p.path ?? 'この端末にパスがありません', kind: 'project' }, p.name);
  for (const s of byRecency(Object.values(store.sessions))) {
    const label = s.name ?? '（名前なし）';
    const hint = s.summary?.oneLiner ?? s.firstPrompt ?? '';
    push({ id: `session:${s.id}`, label, hint, kind: 'session' }, `${label} ${hint}`);
  }
  // 点が同じときは種類の順に並べ、それも同じなら積んだ順のままにする。
  // 入力が空のときはすべてが同じ点なので、コマンドの並びは上の宣言の順、
  // プロジェクトとセッションの並びは最後の活動が新しい順になる。
  // 辞書に入った順で積むと、後から session.upsert で届いた新しいセッションが 30 件の枠から落ちるので、積む前に並べ替える。
  scored.sort((a, b) => b.score - a.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.at - b.at);
  return { query, items: scored.slice(0, LIMIT).map((s) => s.item) };
}
