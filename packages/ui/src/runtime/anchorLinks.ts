import { openableUrl } from './terminalLinks.ts';

/**
 * 画面の中の外へのリンク（target="_blank" の a）を、デスクトップ版では殻に開かせる。
 * 殻の窓は新しい窓の求めを受けないので、素のままだと押しても何も起きない（mac の WKWebView も Windows の WebView2 も）。
 * 止まったセッションの返答の Markdown、PR の札、ツールの URL がこれに当たる。ターミナルのリンクは runtime/terminalLinks.ts が別に開く。
 * 文書の click と auxclick に付ける。ブラウザで開いた UI では付けない（ブラウザが新しいタブで開く）。
 */

/** クリックのうち、ここで読むところ。 */
export type AnchorClick = {
  target: unknown;
  button: number;
  defaultPrevented: boolean;
  preventDefault(): void;
};

type AnchorLike = { href: string; target: string };

/** 外へのリンクを押したクリックなら、既定の動きを止めて open に渡し、true を返す。 */
export function openAnchorInShell(e: AnchorClick, open: (url: string) => void): boolean {
  // 左と中のボタンだけ。右は文脈のメニューに使う。
  if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return false;
  const el = e.target as { closest?: (sel: string) => AnchorLike | null } | null;
  if (typeof el?.closest !== 'function') return false;
  const a = el.closest('a[href]');
  // target の無いリンクは頁の中の移動（#/session/… など）なので、そのまま通す。
  if (!a || a.target !== '_blank') return false;
  const url = openableUrl(a.href);
  if (!url) return false;
  e.preventDefault();
  open(url);
  return true;
}
