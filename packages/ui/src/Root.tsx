import { useEffect, useReducer, useState, type ReactNode } from 'react';
import { useRuntime } from './hooks/useRuntime.ts';
import { IntentRoot } from './intent/chain.tsx';
import { defaultSessionView } from './mediator/sessionView.ts';
import { presentHome } from './presenters/home.ts';
import { presentNewSession } from './presenters/newSession.ts';
import { presentPalette } from './presenters/palette.ts';
import { presentProject } from './presenters/project.ts';
import { presentProjects } from './presenters/projects.ts';
import { presentPromote, presentPromoted } from './presenters/promote.ts';
import { presentSession } from './presenters/session.ts';
import { presentSessions } from './presenters/sessions.ts';
import { presentSettings } from './presenters/settings.ts';
import { presentShell } from './presenters/shell.ts';
import { createApi, type ApiClient } from './runtime/api.ts';
import type { Runtime } from './runtime/runtime.ts';
import type { TerminalHost } from './runtime/terminals.ts';
import { currentRunOf, tabsOf } from './store/store.ts';
import { CommandPalette } from './views/CommandPalette.tsx';
import { HomeScreen } from './views/HomeScreen.tsx';
import { NewSessionDialog } from './views/NewSessionDialog.tsx';
import { ProjectScreen } from './views/ProjectScreen.tsx';
import { ProjectsScreen } from './views/ProjectsScreen.tsx';
import { PromoteDialog, PromotedDialog } from './views/PromoteDialog.tsx';
import { ResolveProjectDialog } from './views/ResolveProjectDialog.tsx';
import { SessionScreen } from './views/SessionScreen.tsx';
import { SessionsScreen } from './views/SessionsScreen.tsx';
import { SettingsScreen } from './views/SettingsScreen.tsx';
import { Shell } from './views/Shell.tsx';
import { TerminalHostContext } from './views/TerminalPane.tsx';
import { ToastStack } from './views/ToastStack.tsx';

/** 相対時刻のために現在時刻を一定間隔で更新する。 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

/** TerminalHost の状態が変わるたびに再描画する。接続の状態は React の外にあるからである。 */
function useTerminalHost(host: TerminalHost): void {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => host.subscribe(force), [host]);
}

export function Root(props: { runtime: Runtime; api?: ApiClient; terminals: TerminalHost }) {
  const rt = props.runtime;
  const { state, store } = useRuntime(rt);
  const now = useNow();
  useTerminalHost(props.terminals);
  const [projectFilter, setProjectFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [candidates, setCandidates] = useState<string[]>([]);

  // トーストは 5 秒で消す。
  useEffect(() => {
    if (state.toasts.length === 0) return;
    const t = setTimeout(() => rt.emit({ type: 'toast.dismiss', id: state.toasts[0]!.id }), 5000);
    return () => clearTimeout(t);
  }, [state.toasts, rt]);

  // 未解決ダイアログの候補は Root が API を直接引く。
  // Presenter に通す値ではなく、ダイアログの中だけで使う一時データだからである。
  const overlay = state.overlay;
  const unresolvedId = overlay.kind === 'resolveProject' ? overlay.projectId : null;
  const queryCandidates = (name: string) => { if (unresolvedId) (props.api ?? apiFromRuntime(rt)).candidates(unresolvedId, name).then(setCandidates).catch(() => setCandidates([])); };
  useEffect(() => { if (unresolvedId) queryCandidates(store.projects[unresolvedId]?.name ?? ''); else setCandidates([]); }, [unresolvedId]);   // eslint-disable-line react-hooks/exhaustive-deps

  // パレットの入力の文字は Root が持つ。
  // ダイアログの外へ出ない一時の値なので、Mediator には入れない。
  const overlayKind = overlay.kind;
  const paletteOpen = overlayKind === 'palette';
  const [paletteQuery, setPaletteQuery] = useState('');
  useEffect(() => { if (!paletteOpen) setPaletteQuery(''); }, [paletteOpen]);

  // ショートカットの対象になる、いま見ているセッションのタブ。
  const sessionId = state.screen.name === 'session' ? state.screen.id : null;
  const shortcutRun = sessionId ? currentRunOf(store, sessionId) : null;
  const shortcutTabs = shortcutRun ? tabsOf(store, shortcutRun.id) : [];
  const shortcutView = sessionId ? state.sessionView[sessionId] ?? defaultSessionView() : null;
  const selectedTabId = shortcutView?.selectedTab ?? shortcutTabs[0]?.id ?? null;
  // TabStrip の分割ボタンと同じ条件で、タブが 2 つ無いときは ⌘\ を出さない。
  const canSplit = shortcutTabs.length >= 2;

  // キーボード。
  // xterm の入力欄は TEXTAREA なので、ターミナルに打った / を横取りしない。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      // ターミナルにフォーカスがあるときは、⌘ を含む組み合わせだけを hangar が処理する。
      // それ以外は preventDefault せずに xterm へ渡す。
      const inTerminal = !!el?.closest?.('.term-host');
      if (inTerminal && !e.metaKey) return;
      const digit = /^[1-9]$/.test(e.key) ? Number(e.key) : 0;
      if (digit && (e.metaKey || (e.ctrlKey && e.altKey))) {
        e.preventDefault();
        const t = shortcutTabs[digit - 1];
        if (t) rt.emit({ type: 'tab.select', tabId: t.id });
        return;
      }
      if (e.metaKey && e.key === 'w') {
        e.preventDefault();
        const t = shortcutTabs.find((x) => x.id === selectedTabId);
        if (t && t.kind === 'shell') rt.emit({ type: 'tab.close', tabId: t.id });
        return;
      }
      if (e.metaKey && e.key === '\\') { e.preventDefault(); if (canSplit) rt.emit({ type: 'split.toggle' }); return; }
      if (e.metaKey && e.key === 'j') { e.preventDefault(); rt.emit({ type: 'transcript.toggle' }); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); rt.emit({ type: 'palette.open' }); return; }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'n' || e.key === 'N')) { e.preventDefault(); rt.emit({ type: 'session.new.open', scratch: e.shiftKey }); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === ',') { e.preventDefault(); rt.emit({ type: 'nav.go', to: { name: 'settings' } }); return; }
      // Esc はオーバーレイを閉じる。
      // 未解決のプロジェクトだけは決めてもらうまで閉じない。
      // 入力欄にフォーカスがあるときは、その入力欄を持つダイアログが自分で Esc を処理するので二重に出さない。
      if (e.key === 'Escape' && !typing && overlayKind !== 'none' && overlayKind !== 'resolveProject') {
        rt.emit(overlayKind === 'palette' ? { type: 'palette.close' } : { type: 'overlay.close' });
        return;
      }
      if (e.key === '/' && !typing) { e.preventDefault(); document.getElementById('global-search')?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt, overlayKind, shortcutTabs, selectedTabId, canSplit]);

  const shell = presentShell(state, store, now);
  let body: ReactNode;
  if (!store.bootstrapped || state.screen.name === 'booting') body = <div className="empty">読み込んでいます</div>;
  else switch (state.screen.name) {
    case 'home': body = <HomeScreen {...presentHome(state, store, now)} />; break;
    case 'projects': body = <ProjectsScreen {...presentProjects(state, store, now, projectFilter, showArchived)} filter={projectFilter} showArchived={showArchived} onFilter={setProjectFilter} onShowArchived={setShowArchived} />; break;
    case 'project': body = <ProjectScreen {...presentProject(state, store, now, state.screen.id)} />; break;
    case 'session': {
      const p = presentSession(state, store, now, state.screen.id);
      body = <SessionScreen {...p} terminalStatus={p.selectedTab ? props.terminals.status(p.selectedTab) : null} />;
      break;
    }
    // 検索欄は defaultValue なので、外からの文言リセットで作り直せるように key を付ける。
    case 'sessions': body = <SessionsScreen key={state.search.text} {...presentSessions(state, store, now)} />; break;
    case 'settings': body = <SettingsScreen {...presentSettings(state, store)} />; break;
  }

  // 起動ダイアログはプロジェクトが変わったら作り直す。入力欄が非制御で、defaultValue を作り直しでしか変えられないからである。
  const newSession = presentNewSession(state, store);
  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog projectId={unresolvedId} name={store.projects[unresolvedId]?.name ?? unresolvedId} path={store.projects[unresolvedId]?.path ?? null} candidates={candidates} onQueryCandidates={queryCandidates} />}
      {newSession && <NewSessionDialog key={newSession.projectId ?? ''} {...newSession} />}
      {overlay.kind === 'palette' && <CommandPalette {...presentPalette(state, store, paletteQuery)!} onQuery={setPaletteQuery} />}
      {overlay.kind === 'promote' && <PromoteDialog {...presentPromote(state, store)!} />}
      {overlay.kind === 'promoted' && <PromotedDialog {...presentPromoted(state, store)!} />}
      <ToastStack toasts={state.toasts} />
    </>
  );

  return (
    <IntentRoot onIntent={rt.emit}>
      <TerminalHostContext.Provider value={props.terminals}>
        <Shell {...shell} overlays={overlays}>{body}</Shell>
      </TerminalHostContext.Provider>
    </IntentRoot>
  );
}

const apiCache = new WeakMap<Runtime, ApiClient>();
function apiFromRuntime(rt: Runtime): ApiClient {
  let a = apiCache.get(rt);
  if (!a) { a = createApi(); apiCache.set(rt, a); }
  return a;
}
