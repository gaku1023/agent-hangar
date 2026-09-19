import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/workbench.css';
import './styles/split.css';
import './styles/rows.css';
import './styles/palette.css';
import './styles/settings.css';
import './styles/sync.css';
import { Root } from './Root.tsx';
import { createApi } from './runtime/api.ts';
import { stripEntryToken } from './runtime/entryToken.ts';
import { createRuntime } from './runtime/runtime.ts';
import { createTerminalHost } from './runtime/terminals.ts';
import { createWs } from './runtime/ws.ts';
import { createXterm } from './runtime/xterm.ts';

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
const runtime = createRuntime({
  api,
  ws: (h) => createWs({ url: `${wsProto}://${location.host}/ws`, ...h }),
  location: { getHash: () => location.hash, setHash: (h) => { location.hash = h; }, onHashChange: (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); } },
  storage: {
    get: (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量超過などは無視 */ } },
    keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  terminals,
  // ダイアログは状態が変わった次の描画で現れるので、フォーカスは次のフレームで当てる。
  focus: (t) => { requestAnimationFrame(() => document.getElementById(FOCUS_IDS[t])?.focus()); },
  // 窓に戻ってきたら他端末の変更を引く。間引きはサーバ側で行う。
  onWindowFocus: (cb) => { window.addEventListener('focus', cb); return () => window.removeEventListener('focus', cb); },
});
runtime.start();
createRoot(document.getElementById('root')!).render(<Root runtime={runtime} api={api} terminals={terminals} />);
