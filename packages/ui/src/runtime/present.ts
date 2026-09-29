import type { Screen, State } from '../mediator/types.ts';

/**
 * 状態の変化を画面へ出す（RuntimeDeps.present）。
 * 画面が替わるときと、⌘K パレットが閉じて何も上に残らないときだけ、View Transitions で包んで描き替える。
 * 一覧の行か Home の実行中の札からセッションを開くと、その行がセッション画面の上段へ広がる（決めの動き）。
 * 名前と状態の点は、行の中の場所から上段の場所へそれぞれ動く。
 * 戻ると、上段が元の行へ縮んで帰る。
 * 出る画面と入る画面の重ね合わせは base.css の ::view-transition の規則が、入る画面の動きは .screen の enter が受け持つ。
 * View Transitions が無い環境（macOS 13 と 14 の WKWebView）と reduced motion では、包まずにその場で描く。
 */

/** 見た目の移り変わりに要る、ブラウザの受け口。試験が差し替える。 */
export type PresentEnv = {
  /** document.startViewTransition。無い環境では undefined。 */
  startViewTransition?: (update: () => void) => { ready: Promise<unknown>; finished: Promise<unknown> };
  reducedMotion(): boolean;
  /** react-dom の flushSync。包んだ中で React の描画を同期させ、入る画面の写しに間に合わせる。 */
  flushSync(fn: () => void): void;
  root: ParentNode;
  /** 直前に押された要素と、いまフォーカスのある要素。どの行から広げるかを決めるのに使う。 */
  pressed(): Element | null;
  focused(): Element | null;
  /** 要素が、ヘッダの下の見えている中身の範囲に掛かっているか。
   * 写しは祖先に切り取られないので、見えていない行に名前を付けると、一覧の外に影が描かれる。 */
  visible(el: Element): boolean;
};

/** 行とセッション画面の上段に、遷移の間だけ付ける名前。器、状態の点、名前の 3 組である。 */
export const SESSION_MORPH = 'session-morph';
export const SESSION_MORPH_DOT = 'session-morph-dot';
export const SESSION_MORPH_NAME = 'session-morph-name';
/** パレットと検索欄の錠剤に、閉じる遷移の間だけ付ける名前。 */
export const PALETTE_MORPH = 'palette-morph';

type Pair = { name: string; from: HTMLElement | null; to: () => HTMLElement | null };
/** 器と、その中の状態の点と名前。 */
type Parts = { box: HTMLElement; dot: HTMLElement | null; name: HTMLElement | null };
/** 行の種類。一覧の行と Home の実行中の札を分ける。 */
type Kind = 'row' | 'card';

// 画面の同一性は名前と id で見る。Sessions の検索語（q）はハッシュに載るが、画面は替わっていない。
const screenKey = (s: Screen) => ('id' in s ? `${s.name}:${s.id}` : s.name);
const rowOf = (id: string) => `[data-morph-id="${id.replace(/["\\]/g, '\\$&')}"]`;
const kindOf = (el: Element): Kind => (el.classList.contains('live-card') ? 'card' : 'row');
const rowParts = (el: HTMLElement): Parts => ({ box: el, dot: el.querySelector<HTMLElement>('.dot'), name: el.querySelector<HTMLElement>('.row-name, .live-name') });
const heroParts = (el: HTMLElement): Parts => ({ box: el, dot: el.querySelector<HTMLElement>('.dot'), name: el.querySelector<HTMLElement>('.session-name') });
// 器の組と、点の組と、名前の組。行き先は描き替えの後にしか無いので、関数で遅らせて探す。
const morph = (src: Parts, dst: () => Parts | null): Pair[] => [
  { name: SESSION_MORPH, from: src.box, to: () => dst()?.box ?? null },
  { name: SESSION_MORPH_DOT, from: src.dot, to: () => dst()?.dot ?? null },
  { name: SESSION_MORPH_NAME, from: src.name, to: () => dst()?.name ?? null },
];

export function createPresent(env: PresentEnv): (commit: () => void, prev: State, next: State) => void {
  const q = (sel: string) => env.root.querySelector<HTMLElement>(sel);
  const shown = (el: HTMLElement | null | undefined) => (el && env.visible(el) ? el : null);
  // どの種類の行から開いたか。戻るときは同じ種類の行を好んで縮む。
  let origin: { id: string; kind: Kind } | null = null;
  // 開いた行。押した要素、フォーカスのある札、フォーカスのある一覧のカーソルの行の順に探す。
  // どれでもなければ（パレットやキーボードの近道から開いたとき）広げず、ふつうの画面遷移にする。
  // 同じセッションが実行中の札と最近の行の両方にあっても、名前は 1 つにしか付けない。2 つあると遷移ごと捨てられる。
  const opened = (id: string): HTMLElement | null => {
    const sel = rowOf(id);
    const hit = env.pressed()?.closest<HTMLElement>(sel) ?? env.focused()?.closest<HTMLElement>(sel);
    if (hit) return shown(hit);
    return shown(env.focused()?.closest('.rows-host')?.querySelector<HTMLElement>(`${sel}[data-cursor="true"]`));
  };
  // 縮んで帰る行。見えている行だけを候補にし、開いたときと同じ種類の行を好む。
  // Home では実行中の札が DOM の先に来るので、最近の行から開いたのに札へ縮むことがある。
  const returnTo = (id: string): HTMLElement | null => {
    const all = [...env.root.querySelectorAll<HTMLElement>(rowOf(id))].filter((el) => env.visible(el));
    const kind = origin?.id === id ? origin.kind : null;
    return all.find((el) => kindOf(el) === kind) ?? all[0] ?? null;
  };
  return (commit, prev, next) => {
    const screenChanged = prev.screen.name !== 'booting' && screenKey(prev.screen) !== screenKey(next.screen);
    // 錠剤へ戻るのは、パレットが閉じて何も上に残らないときだけにする。
    // 別のダイアログへ移るとき（パレットから新規セッションを開くときなど）は、そのダイアログが自分で現れる。
    const paletteClosed = prev.overlay.kind === 'palette' && next.overlay.kind === 'none';
    const start = env.startViewTransition;
    if ((!screenChanged && !paletteClosed) || !start || env.reducedMotion()) { commit(); return; }
    const pairs: Pair[] = [];
    const to = next.screen;
    const from = prev.screen;
    if (screenChanged && to.name === 'session' && from.name !== 'session') {
      const src = opened(to.id);
      origin = src ? { id: to.id, kind: kindOf(src) } : null;
      if (src) pairs.push(...morph(rowParts(src), () => { const el = q('[data-morph-hero]'); return el ? heroParts(el) : null; }));
    }
    if (screenChanged && from.name === 'session' && to.name !== 'session') {
      const src = q('[data-morph-hero]');
      if (src) pairs.push(...morph(heroParts(src), () => { const el = returnTo(from.id); return el ? rowParts(el) : null; }));
    }
    if (paletteClosed) pairs.push({ name: PALETTE_MORPH, from: q('.palette'), to: () => q('#global-search') });
    // 出る側に名前を付けてから写しを取らせる。
    const froms = pairs.map((p) => p.from);
    froms.forEach((el, i) => { if (el) el.style.viewTransitionName = pairs[i]!.name; });
    const named: HTMLElement[] = [];
    const t = start(() => {
      // 同じ名前が 2 つあると遷移ごと捨てられるので、入る側に付ける前に出る側から外す。
      for (const el of froms) if (el) el.style.viewTransitionName = '';
      env.flushSync(commit);
      // 出る側が無かった組は、入る側にも付けない。片方だけの組は、その場で唐突に現れて見えるからである。
      pairs.forEach((p, i) => {
        if (!froms[i]) return;
        const el = p.to();
        if (el) { el.style.viewTransitionName = p.name; named.push(el); }
      });
    });
    // 次の遷移に割り込まれると ready と finished は拒否される。描き替えは済んでいるので、拒否は捨てて名前だけ外す。
    t.ready.catch(() => {});
    t.finished.catch(() => {}).then(() => { for (const el of named) el.style.viewTransitionName = ''; });
  };
}
