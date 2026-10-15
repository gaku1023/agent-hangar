/**
 * デスクトップの殻で、WebKit が右クリックに出す既定のメニューを止める。
 * そのメニューの Back は殻の読み込み画面へ戻り、Reload は鍵のクッキーを送らずに読み直して「認証できていません」の画面になる。
 * 読み直しは ⌘R とメニューバーの Reload が受け持つ。
 * 入力欄とターミナルでは貼り付けに、文字を選んでいるときはコピーに要るので、既定のメニューを残す。
 */

/** contextmenu のうち、ここで読むところ。 */
export type MenuEventLike = Pick<MouseEvent, 'target' | 'preventDefault'>;

/** 既定のメニューを残す場所。xterm の右クリックは隠した textarea を指の下へ動かすので、ターミナルは囲いで見る。 */
const KEEP = 'input, textarea, [contenteditable]:not([contenteditable="false"]), .term-host';

export function suppressNativeMenu(e: MenuEventLike, selectedText: () => string): void {
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest(KEEP) || selectedText() !== '') return;
  e.preventDefault();
}
