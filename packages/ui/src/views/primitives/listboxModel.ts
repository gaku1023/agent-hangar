import type { ProjectStatus } from '@agent-hangar/shared';
import type { IconName } from './Icon.tsx';

/**
 * 一覧の 1 行。sub は 2 段目で、パスは mono、説明文（prose）は地の書体で描く。
 * faceSub は閉じた顔の 2 段目で、無ければ sub を使う。顔は mono で描くので、一覧では説明文、顔ではパスを見せたい行に使う。
 * searchOnly は語があるときだけ並べる行（未登録のフォルダ）、hidden は並べずに選んだときの顔にだけ使う行（作る途中の新しいフォルダ）、tag は行の右の小さな札である。
 */
export type ListboxOption = { value: string; label: string; sub?: string; subKind?: 'path' | 'prose'; faceSub?: string; meta?: string; status?: ProjectStatus; icon?: IconName; danger?: boolean; searchOnly?: boolean; hidden?: boolean; tag?: string };
/** 一覧の下端に置く操作。行ではないので選んでも値にならず、onAction を呼ぶ。 */
export type ListboxAction = { value: string; label: string; sub?: string; icon: IconName };
export type ListboxGroup = { title: string; values: string[] };
/** 描く単位。index は選ばれかけの行を数える通し番号で、群をまたいで続く。 */
export type ListboxSection = { title: string | null; items: { option: ListboxOption; index: number }[] };
export type Segment = { text: string; hit: boolean };
export type Placement = { left: number; width: number; top?: number; bottom?: number; up: boolean };

/** 検索欄を出す件数の下限。これより少ないと、打つより目で探すほうが速い。 */
export const SEARCH_MIN = 8;
const GAP = 6;
const EDGE = 8;

/**
 * 語が行に当たるか。名前と 2 段目を見る。
 * searchOnly の行は名前だけで当てる。2 段目はワークスペースの絶対パスなので、「work」のような語で全部が並び、作る操作から Enter を奪うため。
 */
export function matches(option: ListboxOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (option.label.toLowerCase().includes(q)) return true;
  return !option.searchOnly && (option.sub ?? '').toLowerCase().includes(q);
}

/**
 * 行を節に分けて並べる。
 * 検索で絞っている間は群を解く。一致した行が群ごとに散らばると、どこに当たったかを探し直すことになるため。
 * 群に入っていない行は、取りこぼさないよう最後に見出しなしで置く。
 */
export function arrangeSections(options: ListboxOption[], groups: ListboxGroup[] | undefined, query: string): ListboxSection[] {
  const listed = options.filter((o) => !o.hidden && (!o.searchOnly || query.trim() !== ''));
  const hit = listed.filter((o) => matches(o, query));
  let index = 0;
  const items = (list: ListboxOption[]) => list.map((option) => ({ option, index: index++ }));
  if (!groups || query.trim()) return hit.length ? [{ title: null, items: items(hit) }] : [];
  const byValue = new Map(hit.map((o) => [o.value, o]));
  const placed = new Set<string>();
  const sections: ListboxSection[] = [];
  for (const g of groups) {
    const list = g.values.map((v) => byValue.get(v)).filter((o): o is ListboxOption => o !== undefined && !placed.has(o.value));
    if (!list.length) continue;
    for (const o of list) placed.add(o.value);
    sections.push({ title: g.title, items: items(list) });
  }
  const rest = hit.filter((o) => !placed.has(o.value));
  if (rest.length) sections.push({ title: null, items: items(rest) });
  return sections;
}

/** 最初に一致した部分だけを塗る。空の片は返さない。 */
export function highlight(text: string, query: string): Segment[] {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return [{ text, hit: false }];
  return [{ text: text.slice(0, i), hit: false }, { text: text.slice(i, i + q.length), hit: true }, { text: text.slice(i + q.length), hit: false }].filter((s) => s.text);
}

/** 一覧の高さの下限。これより狭いと、行が 1 つも読めない。 */
export const POPUP_FLOOR = 96;

/** 顔の上、または下に、一覧が使える高さ。顔との隙間と窓の縁を除く。place が上下を決める数と同じである。 */
export function roomFor(face: { top: number; bottom: number }, viewport: { height: number }, up: boolean): number {
  return up ? face.top - GAP - EDGE : viewport.height - face.bottom - GAP - EDGE;
}

/** 開く側の高さに収める一覧の高さ。上限と使える高さの小さいほうだが、下限は割らない（窓が極端に低いときは、はみ出すより読める行を優先する）。 */
export function fitHeight(face: { top: number; bottom: number }, viewport: { height: number }, up: boolean, max: number): number {
  return Math.max(POPUP_FLOOR, Math.min(max, roomFor(face, viewport, up)));
}

/**
 * 一覧を置く位置。顔の直下に置き、下に収まらず上のほうが広ければ上に開く。
 * 上に開くときは bottom で置く。一覧の高さが検索で変わっても、顔から離れないようにするため。
 */
export function place(face: { top: number; bottom: number; left: number; width: number }, popupHeight: number, viewport: { width: number; height: number }, opts: { minWidth?: number; align?: 'start' | 'end' } = {}): Placement {
  const width = Math.max(face.width, opts.minWidth ?? 0);
  const want = opts.align === 'end' ? face.left + face.width - width : face.left;
  const left = Math.max(EDGE, Math.min(want, viewport.width - width - EDGE));
  const below = roomFor(face, viewport, false);
  const above = roomFor(face, viewport, true);
  const up = popupHeight > below && above > below;
  return up ? { left, width, bottom: viewport.height - face.top + GAP, up } : { left, width, top: face.bottom + GAP, up };
}
