/**
 * ヘッダーの右の列を、窓の幅に合わせて畳む仕組み。
 * 決め打ちの幅で畳むと、同期の文や件数のように長さの変わる中身に追いつかず、隣の部品に重なって描かれる。
 * そこで、段ごとに実際に要る幅を測り、収まる最初の段を選ぶ。
 * ここには、どこまで畳むかを決める純関数と、段に応じて部品に印を付ける関数を置く。
 * 測ってこの 2 つを呼ぶのは useHeaderFold.ts である。
 */

/**
 * 畳む部品の組を、優先度の低い順に並べたもの。
 * 段 n では、先頭から n 組を畳む。
 * 部品は data-fold-at に、ここでの位置（foldAt）を持つ。
 */
export const FOLD_STEPS = [
  // 使用率の古さは、ゲージの title からも読める。
  'gauge-updated',
  // 索引の進みは一時的な表示で、同じものが設定の画面にもある。
  'progress',
  // 同期の操作は、同期の文（リンク）から設定の画面へ行けば押せる。
  'sync-actions',
  // 未送信の件数は、同期の文の title に残す。送れなかった本文は誤りなので畳まない。
  'sync-counts',
  // 棒を畳んでも、見出しと数字で割合は読める。
  'gauge-bars',
  // 錠剤は虫眼鏡だけになる。名前は読み上げに残す。
  'search-label',
  // 同期の文は状態の点だけになる。点はリンクの中にあり、押せば設定へ行ける。
  'sync-label',
  // 新しいセッションは「＋」だけになる。名前は aria-label に残す。
  'new-session-label',
  // ゲージは見出しと数字ごと畳む。見出しの無い数字は、何の割合か読めないからである。
  'gauges',
] as const;

export type FoldStep = (typeof FOLD_STEPS)[number];

/** いちばん奥の段。すべての組を畳んだ段である。 */
export const FOLD_LEVELS = FOLD_STEPS.length;

/** 部品の data-fold-at に書く値。 */
export function foldAt(step: FoldStep): number {
  return FOLD_STEPS.indexOf(step);
}

/**
 * どこまで畳むかを決める。
 * need(段) はその段で右の列に要る幅で、段が進むほど小さくなる。
 * 収まる最初の段が今の段より奥なら、そこまで進む。
 * 今の段より手前で収まるなら、slack の分のゆとりを持って収まる段までだけ戻す。
 * ちょうどの幅で戻すと、1px の揺れで進んだり戻ったりして、見た目がぴくぴくするからである。
 * need は測るたびにレイアウトを組み直すので、答えを決めるのに要る段だけを呼ぶ。
 * 使える幅が 0 以下のとき（隠れている間や、配置を測れない環境）は、今の段を保つ。
 */
export function chooseFoldLevel(input: { need: (level: number) => number; levels: number; available: number; current: number; slack: number }): number {
  const { need, levels, available, current, slack } = input;
  if (!(available > 0)) return current;
  let fit = levels;
  for (let level = 0; level < levels; level++) {
    if (need(level) <= available) { fit = level; break; }
  }
  if (fit >= current) return fit;
  for (let level = fit; level < current; level++) {
    if (need(level) + slack <= available) return level;
  }
  return current;
}

/**
 * 段に応じて、root の中の部品に畳んだ印（data-folded）を付け外しする。
 * 見た目は base.css が印を見て決める。
 */
export function applyFold(root: HTMLElement, level: number): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-fold-at]')) {
    if (Number(el.dataset.foldAt) < level) el.setAttribute('data-folded', '');
    else el.removeAttribute('data-folded');
  }
}
