import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/workbench.css';
import './styles/split.css';
import './styles/rows.css';
import './styles/home.css';
import './styles/session.css';
import './styles/palette.css';
import './styles/settings.css';
import './styles/readiness.css';
import './styles/sync.css';
import './styles/controls.css';
import { Root } from './Root.tsx';
import { createApi } from './runtime/api.ts';
import { stripEntryToken } from './runtime/entryToken.ts';
import { createHashLocation } from './runtime/hashLocation.ts';
import { createRuntime } from './runtime/runtime.ts';
import { createDesktopBridge } from './runtime/desktop.ts';
import { FONT_SIZE_KEY, createTerminalHost } from './runtime/terminals.ts';
import { createWs } from './runtime/ws.ts';
import { createXterm } from './runtime/xterm.ts';
import { FOCUS_IDS, focusSoon } from './runtime/focusSoon.ts';
import { clickThrough } from './runtime/clickThrough.ts';
import { createPresent } from './runtime/present.ts';
import { FILE_DROP_EVENT, handleFileDrop } from './runtime/fileDrop.ts';

// 鍵付きの URL で開かれたときは、サーバがもうクッキーを配り終えている。
// 履歴に鍵を残さないよう、ここで URL から消す。ハッシュの経路は残す。
stripEntryToken(location.href, (u) => history.replaceState(null, '', u));

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const api = createApi();
// ターミナルの接続は React の外で持つ。
// 画面を行き来してもバッファとスクロール位置が残る。
// 文字の大きさは端末ごとの一時の好みなので、この端末の localStorage に置き、同期しない。読み書きの失敗は TerminalHost が吸う。
const terminals = createTerminalHost({
  wsUrl: (tab) => `${wsProto}://${location.host}/ws/pty?tab=${encodeURIComponent(tab)}`,
  createTerminal: createXterm,
  fontSize: { load: () => JSON.parse(localStorage.getItem(FONT_SIZE_KEY) ?? 'null'), save: (px) => localStorage.setItem(FONT_SIZE_KEY, JSON.stringify(px)) },
});
// Hangar.app に落としたファイルは、落とした位置の端末にパスとして渡す。
window.addEventListener(FILE_DROP_EVENT, (e) => { handleFileDrop((e as CustomEvent).detail, { hit: (x, y) => document.elementFromPoint(x, y), paste: terminals.paste, focus: terminals.focus }); });
// 直前に押した要素。行を開いたときに、どの行から広げるかを決めるのに使う。
// 前の押下で広げないように、押してから短い間だけ有効にする。
const PRESS_FRESH_MS = 1000;
let pressed: { el: Element; at: number } | null = null;
window.addEventListener('pointerdown', (e) => { if (e.target instanceof Element) pressed = { el: e.target, at: performance.now() }; }, true);
// 行が見えているか。.main の枠のうち、浮いているヘッダと切断の帯より下を見える範囲とする。
// 仮想の一覧は先読みの行を枠の外にも描くので、一覧のスクロールの枠とも重ねて見る。
const visibleInMain = (el: Element): boolean => {
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const main = document.querySelector('.main');
  if (!main) return true;
  const box = main.getBoundingClientRect();
  let top = box.top;
  for (const cover of document.querySelectorAll('.header, .conn-banner')) top = Math.max(top, cover.getBoundingClientRect().bottom);
  let bottom = box.bottom;
  const list = el.closest('.list-scroll');
  if (list) { const lr = list.getBoundingClientRect(); top = Math.max(top, lr.top); bottom = Math.min(bottom, lr.bottom); }
  return r.bottom > top && r.top < bottom && r.right > box.left && r.left < box.right;
};
const present = createPresent({
  startViewTransition: typeof document.startViewTransition === 'function' ? (update) => document.startViewTransition(update) : undefined,
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  flushSync,
  root: document,
  pressed: () => (pressed && performance.now() - pressed.at < PRESS_FRESH_MS ? pressed.el : null),
  focused: () => document.activeElement,
  visible: visibleInMain,
});
// 遷移の写しに当たったクリックは、遷移を終わらせて下の部品へ通す。
document.addEventListener('click', (e) => clickThrough(e, { root: document.documentElement, skip: present.skip, hit: (x, y) => document.elementFromPoint(x, y) }), true);
const runtime = createRuntime({
  api,
  ws: (h) => createWs({ url: `${wsProto}://${location.host}/ws`, ...h }),
  location: createHashLocation(history, location, (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); }),
  storage: {
    get: (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量超過などは無視 */ } },
    keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  terminals,
  // ダイアログは状態が変わった次の描画で現れる。画面の移り変わりで包むと描き替えがさらに遅れるので、現れるまで次の描画ごとに探す。
  focus: (t) => focusSoon(() => document.getElementById(FOCUS_IDS[t]), (cb) => { requestAnimationFrame(cb); }),
  // 窓に戻ってきたら他端末の変更を引く。間引きはサーバ側で行う。
  onWindowFocus: (cb) => { window.addEventListener('focus', cb); return () => window.removeEventListener('focus', cb); },
  present,
  // デスクトップの殻の中なら、ログを開くと再起動を殻に頼める。ブラウザでは null になる。
  desktop: createDesktopBridge(window),
});
runtime.start();
createRoot(document.getElementById('root')!).render(<Root runtime={runtime} api={api} terminals={terminals} />);
