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
 * 箱の下端がターミナル（.xterm-screen）の下端を超えるなら、超えた行の数だけ margin-top で箱を上へずらす（iTerm と同じ）。
 * 入力欄はターミナルの下の方にあるので、下へ伸びた行は .term-host の clip で切れて読めなくなるためである。
 * xterm が置く top は書き換えないので、xterm が次に置き直しても、ずらしは置いた位置から計り直せる。
 * ターミナルの高さより行が多いときは、箱の下端をターミナルの下端に合わせ、末尾（いま打っている所）を見せる。
 *
 * xterm の内側に頼るのは、公開の CSS にもある .composition-view と .xterm-screen の名前と、xterm が left、top、line-height を直に書くことと、変換中に active の組を付けることだけである。
 * 知らせの順（xterm の compositionupdate の後か前か）に頼らないよう、箱の変化を MutationObserver で見て、そのたびに当て直す。
 * 変換中にターミナルの大きさが変わったとき（窓や分割の変更）は、.xterm-screen を ResizeObserver で見て当て直す。
 * 箱が文書から外れたら（ターミナルを捨てたら）、次の知らせで ResizeObserver を外す。
 * 返す関数で見張りを止める。
 */
export function wrapComposition(root: HTMLElement): () => void {
  const view = root.querySelector<HTMLElement>('.composition-view');
  if (!view) return () => {};
  const screen = root.querySelector<HTMLElement>('.xterm-screen');
  const set = (prop: 'width' | 'marginLeft' | 'textIndent' | 'marginTop', value: string) => { if (view.style[prop] !== value) view.style[prop] = value; };
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
    // 幅を当てた後で高さを計る（折り返した行の数が決まるのはここ）。
    set('marginTop', `${-overflowBelow()}px`);
  };
  /** 箱の下端がターミナルの下端を超える分（行の高さの倍数に切り上げる）。超えなければ 0。 */
  const overflowBelow = () => {
    const bottom = screen?.offsetHeight || root.clientHeight;
    if (!(bottom > 0)) return 0;
    const over = (parseFloat(view.style.top) || 0) + view.offsetHeight - bottom;
    if (!(over > 0)) return 0;
    const line = parseFloat(view.style.lineHeight) || 0;
    return line > 0 ? Math.ceil(over / line - 1e-6) * line : over;
  };
  const mo = new MutationObserver(apply);
  mo.observe(view, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  let ro: ResizeObserver | null = null;
  const stop = () => { mo.disconnect(); ro?.disconnect(); ro = null; };
  if (screen && typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      if (!view.isConnected) { stop(); return; }
      if (view.classList.contains('active')) apply();
    });
    ro.observe(screen);
  }
  return stop;
}
