import { hangarLinkOf, type HangarLink } from './hangarLink.ts';
import { openableUrl } from './terminalLinks.ts';

/**
 * 画面の中の外へのリンク（target="_blank" の a）を、デスクトップ版では殻に開かせる。
 * 殻の窓は新しい窓の求めを受けないので、素のままだと押しても何も起きない（mac の WKWebView も Windows の WebView2 も）。
 * 止まったセッションの返答の Markdown、PR の札、ツールの URL がこれに当たる。ターミナルのリンクは runtime/terminalLinks.ts が別に開く。
 * hangar 自身のリンク（hangarLink.ts）は、target の有無によらず、デスクトップ版でもブラウザで開いた UI でも、アプリの中で開く（hangar に渡す）。
 * 文書の click と auxclick に付ける。ブラウザで開いた UI では shell の open を渡さず、hangar のリンクだけを受ける（ほかの外へのリンクはブラウザが新しいタブで開く）。
 */

/** クリックのうち、ここで読むところ。 */
export type AnchorClick = {
  target: unknown;
  button: number;
  defaultPrevented: boolean;
  preventDefault(): void;
};

type AnchorLike = { href: string; target: string };

/** hangar 自身のリンクなら hangar に、外へのリンクを押したクリックなら open に渡して既定の動きを止め、true を返す。 */
export function openAnchorInShell(e: AnchorClick, open: ((url: string) => void) | null, hangar?: (link: HangarLink) => void): boolean {
  // 左と中のボタンだけ。右は文脈のメニューに使う。
  if (e.defaultPrevented || (e.button !== 0 && e.button !== 1)) return false;
  const el = e.target as { closest?: (sel: string) => AnchorLike | null } | null;
  if (typeof el?.closest !== 'function') return false;
  const a = el.closest('a[href]');
  const mine = a && hangar ? hangarLinkOf(a.href) : null;
  if (mine) {
    e.preventDefault();
    hangar!(mine);
    return true;
  }
  if (!open) return false;
  // target の無いリンクは頁の中の移動（#/session/… など）なので、そのまま通す。
  if (!a || a.target !== '_blank') return false;
  const url = openableUrl(a.href);
  if (!url) return false;
  e.preventDefault();
  open(url);
  return true;
}
