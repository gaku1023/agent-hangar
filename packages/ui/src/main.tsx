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
import './styles/sync.css';
import { Root } from './Root.tsx';
import { createApi } from './runtime/api.ts';
import { stripEntryToken } from './runtime/entryToken.ts';
import { createHashLocation } from './runtime/hashLocation.ts';
import { createRuntime } from './runtime/runtime.ts';
import { createTerminalHost } from './runtime/terminals.ts';
import { createWs } from './runtime/ws.ts';
import { createXterm } from './runtime/xterm.ts';
import { focusSoon } from './runtime/focusSoon.ts';
import { createPresent } from './runtime/present.ts';

// フォーカスの対象と、それを持つ要素の id の対応。
// ターミナルは DOM の id では掴めないので、TerminalHost が別に受け持つ。
const FOCUS_IDS = { search: 'global-search', newSessionName: 'new-session-name', palette: 'palette-input', promoteName: 'promote-name', todoInput: 'todo-input' } as const;

// 鍵付きの URL で開かれたときは、サーバがもうクッキーを配り終えている。
// 履歴に鍵を残さないよう、ここで URL から消す。ハッシュの経路は残す。
stripEntryToken(location.href, (u) => history.replaceState(null, '', u));

const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
const api = createApi();
// ターミナルの接続は React の外で持つ。
// 画面を行き来してもバッファとスクロール位置が残る。
const terminals = createTerminalHost({ wsUrl: (tab) => `${wsProto}://${location.host}/ws/pty?tab=${encodeURIComponent(tab)}`, createTerminal: createXterm });
// 直前に押した要素。行を開いたときに、どの行から広げるかを決めるのに使う。
// 前の押下で広げないように、押してから短い間だけ有効にする。
const PRESS_FRESH_MS = 1000;
let pressed: { el: Element; at: number } | null = null;
window.addEventListener('pointerdown', (e) => { if (e.target instanceof Element) pressed = { el: e.target, at: performance.now() }; }, true);
const present = createPresent({
  startViewTransition: typeof document.startViewTransition === 'function' ? (update) => document.startViewTransition(update) : undefined,
  reducedMotion: () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  flushSync,
  root: document,
  pressed: () => (pressed && performance.now() - pressed.at < PRESS_FRESH_MS ? pressed.el : null),
  focused: () => document.activeElement,
});
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
});
runtime.start();
createRoot(document.getElementById('root')!).render(<Root runtime={runtime} api={api} terminals={terminals} />);
