// ほかの PC から来た文の知らせ（試作 peer-chat の 5B）を、本物の部品で出す頁（撮るとき用）。
// `npm run dev -w @agent-hangar/ui` のあと /preview/peerOrigin.html を開く。本番の bundle には入らない。
// ?only=terminal|sidebar|setting で一つだけ出す（既定は全部）。?lang=en で英語。
// 動かすときは window.__peer.dispatch({ type: 'peerChat.queue', ... }) か、頁のボタンで知らせを送る。例の値は作り物である。
import { useReducer } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/workbench.css';
import '../src/styles/split.css';
import '../src/styles/panes.css';
import '../src/styles/rows.css';
import '../src/styles/home.css';
import '../src/styles/session.css';
import '../src/styles/strip.css';
import '../src/styles/transcript.css';
import '../src/styles/settings.css';
import '../src/styles/configSync.css';
import '../src/styles/cloudMember.css';
import '../src/styles/sync.css';
import '../src/styles/controls.css';
import { translator, type Language, type PeerChatQueued, type ServerEvent, type SettingsDto } from '@agent-hangar/shared';
import { ActionRoot } from '../src/action/chain.tsx';
import { initialState } from '../src/mediator/transition.ts';
import { presentPeerOrigin } from '../src/presenters/peerOrigin.ts';
import { presentSettings } from '../src/presenters/settings.ts';
import type { SessionMenuProps } from '../src/presenters/sessionMenu.ts';
import type { SideLiveGroup, SideLiveProps, SideLiveRow } from '../src/presenters/shell.ts';
import { applyServerEvent, initialStore, type Store } from '../src/store/store.ts';
import { SettingsScreen } from '../src/views/SettingsScreen.tsx';
import { Sidebar } from '../src/views/Sidebar.tsx';
import { TerminalHostContext, TerminalPane } from '../src/views/TerminalPane.tsx';
import { LanguageRoot } from '../src/views/primitives/language.tsx';
import type { TerminalHost } from '../src/runtime/terminals.ts';

const params = new URLSearchParams(location.search);
const only = params.get('only');
const lang: Language = params.get('lang') === 'en' ? 'en' : 'ja';
const t = translator(lang);

const LOG = [
  '● 原因が分かりました。Artifact の行が親より先に届くと、同期が止まります。',
  '  ⎿ Bash(npm test -- sync/apply)',
  '✻ Working… (12s · esc to interrupt)',
];
const LOG_EN = [
  '● Found the cause. When an Artifact row arrives before its parent, sync stops.',
  '  ⎿ Bash(npm test -- sync/apply)',
  '✻ Working… (12s · esc to interrupt)',
];

/** 端末の代わり。本物の xterm は使わず、台本の行を面に書く。 */
const host: TerminalHost = {
  connect() {}, disconnect() {}, fit() {}, focus() {}, paste() {}, zoom() {}, fontSize: () => 13, painted: () => true, subscribe: () => () => {}, dispose() {}, reconnect() {},
  status: () => 'connected', link: () => ({ retryAt: null, dropped: false, gaveUp: false, detached: false }),
  mount(_tab: string, el: HTMLElement) {
    el.style.cssText = 'padding:12px 16px;font:13px/1.6 var(--font-mono);color:var(--term-fg);white-space:pre-wrap';
    el.textContent = `${(lang === 'en' ? LOG_EN : LOG).join('\n')}\n\n> `;
  },
} as unknown as TerminalHost;

const SESSION = 's1';
const who = { deviceId: 'pc-mac', deviceName: 'Mac' };
const who2 = { deviceId: 'pc-win', deviceName: 'Studio' };
const q = (id: string, from = who): PeerChatQueued => ({ queueId: id, from, text: '続きもお願い', images: 0, at: 1, state: 'waiting' });
const menu: SessionMenuProps = { id: SESSION, name: 'n', status: null, resumeHere: null, stop: { runId: 'r', working: true, aside: false, shellTabs: 0 }, moveBlocked: null };

let store: Store = initialStore();
store.settings = { workspaceRoot: '/w', claudeDir: '/c', tmuxPath: null, terminalApp: 'terminal', language: lang } as unknown as SettingsDto;
store.sync = { state: 'idle', url: 'https://hangar.example', lastPushAt: null, lastPullAt: Date.now() - 180_000, pending: 0, error: null, deviceCount: 2, limitedUntil: null, paused: false, skipped: [], sweepPending: null, oncePass: false, diskShort: null } as never;
store.devices = [{ id: 'me', name: 'Studio', platform: 'win32', lastSeenAt: Date.now(), self: true }, { id: 'pc-mac', name: 'Mac', platform: 'darwin', lastSeenAt: Date.now() - 60_000, self: false }] as never;
let rerender: () => void = () => {};
const dispatch = (ev: ServerEvent) => { store = applyServerEvent(store, ev); rerender(); };
(window as unknown as { __peer: unknown }).__peer = { dispatch, queue: (n: number, from = who) => dispatch({ type: 'peerChat.queue', sessionId: SESSION, queued: Array.from({ length: n }, (_, i) => q(`q${i}`, from)) }), mixed: () => dispatch({ type: 'peerChat.queue', sessionId: SESSION, queued: [q('a'), q('b', who2)] }), delivered: () => dispatch({ type: 'peerChat.delivered', sessionId: SESSION, from: who, at: Date.now() }) };

const frame = { background: 'var(--surface)', borderRadius: 14, boxShadow: 'var(--surface-shadow)', padding: 16 } as const;

function Page() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  rerender = bump;
  const origin = presentPeerOrigin(store, SESSION, t);
  const mk = (id: string, name: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: { ...menu, id }, ...over });
  const rows = [mk(SESSION, '同期の親子の順序を直す', { current: true, peerIn: origin, agent: 'claude-code' }), mk('s2', 'README の画像を撮り直す', { agent: 'claude-code' }), mk('s3', 'リリースノートの下書き', { live: 'waiting', waited: '2 分', agent: 'claude-code' })];
  const group: SideLiveGroup = { key: 'web', name: 'agent-hangar', open: true, waiting: 1, rows };
  const live: SideLiveProps = { count: rows.length, ids: rows.map((r) => r.id), rows, groups: [group], pins: [] };
  const settings = presentSettings({ ...initialState(), screen: { name: 'settings', at: 'cloud' } }, store, Date.now());
  const show = (k: string) => only === null || only === k;
  return (
    <LanguageRoot language={lang}>
      <ActionRoot onAction={(a) => { if (a.type === 'settings.update' && 'peerChatAcceptFromPeers' in a.patch) { store = { ...store, settings: { ...store.settings!, ...a.patch } as SettingsDto }; bump(); } }}>
        <div style={{ display: 'grid', gridTemplateColumns: show('sidebar') && show('terminal') ? '280px 1fr' : '1fr', gap: 20, padding: 20, alignItems: 'start' }}>
          {show('sidebar') && (
            <div className="shell" data-sidebar="open" style={{ ...frame, padding: 8, display: 'block', minHeight: 0, height: 'auto' }}>
              <Sidebar nav={[]} foot={[]} collapsed={false} live={live} />
            </div>
          )}
          {show('terminal') && (
            <div style={{ height: 300, display: 'flex', flexDirection: 'column' }} className="c-main">
              <TerminalHostContext.Provider value={host}>
                <TerminalPane tabId="t1" hint={null} live="busy" agent peer={origin} />
              </TerminalHostContext.Provider>
            </div>
          )}
          {show('setting') && (
            <div style={{ ...frame, gridColumn: '1 / -1', maxWidth: 760 }}>
              <SettingsScreen {...settings} />
            </div>
          )}
        </div>
      </ActionRoot>
    </LanguageRoot>
  );
}

createRoot(document.getElementById('root')!).render(<Page />);
