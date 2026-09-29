import type { Screen, State } from '../mediator/types.ts';

/**
 * 状態の変化を画面へ出す（RuntimeDeps.present）。
 * 画面が替わるときと、⌘K パレットが閉じるときだけ、View Transitions で包んで描き替える。
 * 一覧の行か Home の実行中の札からセッションを開くと、その行がセッション画面の上段へ広がる（決めの動き）。
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
};

/** 行とセッション画面の上段に、遷移の間だけ付ける名前。 */
export const SESSION_MORPH = 'session-morph';
/** パレットと検索欄の錠剤に、閉じる遷移の間だけ付ける名前。 */
export const PALETTE_MORPH = 'palette-morph';

type Pair = { name: string; from: () => HTMLElement | null; to: () => HTMLElement | null };

// 画面の同一性は名前と id で見る。Sessions の検索語（q）はハッシュに載るが、画面は替わっていない。
const screenKey = (s: Screen) => ('id' in s ? `${s.name}:${s.id}` : s.name);
const rowOf = (id: string) => `[data-morph-id="${id.replace(/["\\]/g, '\\$&')}"]`;

export function createPresent(env: PresentEnv): (commit: () => void, prev: State, next: State) => void {
  const q = (sel: string) => env.root.querySelector<HTMLElement>(sel);
  // 開いた行。押した要素、フォーカスのある札、フォーカスのある一覧のカーソルの行の順に探す。
  // どれでもなければ（パレットやキーボードの近道から開いたとき）広げず、ふつうの画面遷移にする。
  // 同じセッションが実行中の札と最近の行の両方にあっても、名前は 1 つにしか付けない。2 つあると遷移ごと捨てられる。
  const opened = (id: string): HTMLElement | null => {
    const sel = rowOf(id);
    const hit = env.pressed()?.closest<HTMLElement>(sel) ?? env.focused()?.closest<HTMLElement>(sel);
    if (hit) return hit;
    return env.focused()?.closest('.rows-host')?.querySelector<HTMLElement>(`${sel}[data-cursor="true"]`) ?? null;
  };
  return (commit, prev, next) => {
    const screenChanged = prev.screen.name !== 'booting' && screenKey(prev.screen) !== screenKey(next.screen);
    const paletteClosed = prev.overlay.kind === 'palette' && next.overlay.kind !== 'palette';
    const start = env.startViewTransition;
    if ((!screenChanged && !paletteClosed) || !start || env.reducedMotion()) { commit(); return; }
    const pairs: Pair[] = [];
    const to = next.screen;
    const from = prev.screen;
    if (screenChanged && to.name === 'session' && from.name !== 'session') pairs.push({ name: SESSION_MORPH, from: () => opened(to.id), to: () => q('[data-morph-hero]') });
    if (screenChanged && from.name === 'session' && to.name !== 'session') pairs.push({ name: SESSION_MORPH, from: () => q('[data-morph-hero]'), to: () => q(rowOf(from.id)) });
    if (paletteClosed) pairs.push({ name: PALETTE_MORPH, from: () => q('.palette'), to: () => q('#global-search') });
    // 出る側に名前を付けてから写しを取らせる。
    const froms = pairs.map((p) => p.from());
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
