/**
 * 変換中の文字（xterm の .composition-view）を、ターミナルの右端で折り返す（試作の 2A）。
 *
 * xterm.js 6 の箱は white-space: nowrap の 1 行で、確定せずに長く打つと右端を超えて伸び、外の箱が横に送られる。
 * iTerm と同じく、1 行目はカーソルから右端まで、2 行目からはターミナルの左端から続ける。
 *
 * xterm が置く left と top はそのまま使う。
 * 箱の幅をターミナルの幅にし、margin-left で左端まで戻し、text-indent で 1 行目だけカーソルの位置まで字下げする。
 * 箱そのものの背景を塗ると、1 行目のカーソルより左（打ってある文字）を隠すので、文字は 1 つの span に入れ、span だけを塗る（base.css）。
 * 折り返しと高さ（xterm は 1 行分の高さを直に書く）は base.css が受け持つ。
 *
 * xterm の内側に頼るのは、公開の CSS にもある .composition-view と .xterm-screen の名前と、xterm が left を直に書くことだけである。
 * 知らせの順（xterm の compositionupdate の後か前か）に頼らないよう、箱の変化を MutationObserver で見て、そのたびに当て直す。
 * 返す関数で見張りを止める。
 */
export function wrapComposition(root: HTMLElement): () => void {
  const view = root.querySelector<HTMLElement>('.composition-view');
  if (!view) return () => {};
  const screen = root.querySelector<HTMLElement>('.xterm-screen');
  const set = (prop: 'width' | 'marginLeft' | 'textIndent', value: string) => { if (view.style[prop] !== value) view.style[prop] = value; };
  const apply = () => {
    // 文字を span に入れる。xterm は textContent を差し替えるので、そのたびに入れ直す。
    const only = view.childNodes.length === 1 ? view.firstChild : null;
    const wrapped = only instanceof HTMLElement && only.classList.contains('composition-text');
    const text = view.textContent ?? '';
    if (!wrapped && text !== '') {
      const span = view.ownerDocument.createElement('span');
      span.className = 'composition-text';
      span.textContent = text;
      view.replaceChildren(span);
    }
    const width = screen?.offsetWidth || root.clientWidth;
    if (!(width > 0)) return;
    const left = Math.min(Math.max(parseFloat(view.style.left) || 0, 0), width);
    set('width', `${width}px`);
    set('marginLeft', `${-left}px`);
    set('textIndent', `${left}px`);
  };
  const mo = new MutationObserver(apply);
  mo.observe(view, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  return () => mo.disconnect();
}
