import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import { Root } from './Root.tsx';
import { createApi } from './runtime/api.ts';
import { createRuntime } from './runtime/runtime.ts';
import { createWs } from './runtime/ws.ts';

const api = createApi();
const runtime = createRuntime({
  api,
  ws: (h) => createWs({ url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, ...h }),
  location: { getHash: () => location.hash, setHash: (h) => { location.hash = h; }, onHashChange: (cb) => { window.addEventListener('hashchange', cb); return () => window.removeEventListener('hashchange', cb); } },
  storage: {
    get: (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : undefined; } catch { return undefined; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 容量超過などは無視 */ } },
    keys: () => { try { return Object.keys(localStorage); } catch { return []; } },
  },
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  focus: (t) => { if (t === 'search') document.getElementById('global-search')?.focus(); },
});
runtime.start();
createRoot(document.getElementById('root')!).render(<Root runtime={runtime} api={api} />);
