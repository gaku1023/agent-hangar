import { useEffect, useState, type ReactNode } from 'react';
import { useRuntime } from './hooks/useRuntime.ts';
import { IntentRoot } from './intent/chain.tsx';
import { presentHome } from './presenters/home.ts';
import { presentProject } from './presenters/project.ts';
import { presentProjects } from './presenters/projects.ts';
import { presentSession } from './presenters/session.ts';
import { presentSessions } from './presenters/sessions.ts';
import { presentSettings } from './presenters/settings.ts';
import { presentShell } from './presenters/shell.ts';
import { createApi, type ApiClient } from './runtime/api.ts';
import type { Runtime } from './runtime/runtime.ts';
import { HomeScreen } from './views/HomeScreen.tsx';
import { ProjectScreen } from './views/ProjectScreen.tsx';
import { ProjectsScreen } from './views/ProjectsScreen.tsx';
import { ResolveProjectDialog } from './views/ResolveProjectDialog.tsx';
import { SessionScreen } from './views/SessionScreen.tsx';
import { SessionsScreen } from './views/SessionsScreen.tsx';
import { SettingsScreen } from './views/SettingsScreen.tsx';
import { Shell } from './views/Shell.tsx';
import { ToastStack } from './views/ToastStack.tsx';

/** 相対時刻のために現在時刻を一定間隔で更新する。 */
function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), intervalMs); return () => clearInterval(t); }, [intervalMs]);
  return now;
}

export function Root(props: { runtime: Runtime; api?: ApiClient }) {
  const rt = props.runtime;
  const { state, store } = useRuntime(rt);
  const now = useNow();
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

  // キーボード。
  // / で検索欄にフォーカスし、⌘K か Ctrl+K でパレットを開き、Esc はパレットだけを閉じる。
  const paletteOpen = overlay.kind === 'palette';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === '/' && !typing) { e.preventDefault(); document.getElementById('global-search')?.focus(); }
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); rt.emit({ type: 'palette.open' }); }
      if (e.key === 'Escape' && paletteOpen) rt.emit({ type: 'palette.close' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rt, paletteOpen]);

  const shell = presentShell(state, store);
  let body: ReactNode;
  if (!store.bootstrapped || state.screen.name === 'booting') body = <div className="empty">読み込んでいます</div>;
  else switch (state.screen.name) {
    case 'home': body = <HomeScreen {...presentHome(state, store, now)} />; break;
    case 'projects': body = <ProjectsScreen {...presentProjects(state, store, now, projectFilter, showArchived)} filter={projectFilter} showArchived={showArchived} onFilter={setProjectFilter} onShowArchived={setShowArchived} />; break;
    case 'project': body = <ProjectScreen {...presentProject(state, store, now, state.screen.id)} />; break;
    case 'session': body = <SessionScreen {...presentSession(state, store, now, state.screen.id)} terminalStatus={null} />; break;
    // 検索欄は defaultValue なので、外からの文言リセットで作り直せるように key を付ける。
    case 'sessions': body = <SessionsScreen key={state.search.text} {...presentSessions(state, store, now)} />; break;
    case 'settings': body = <SettingsScreen {...presentSettings(state, store)} />; break;
  }

  const overlays = (
    <>
      {unresolvedId && <ResolveProjectDialog projectId={unresolvedId} name={store.projects[unresolvedId]?.name ?? unresolvedId} path={store.projects[unresolvedId]?.path ?? null} candidates={candidates} onQueryCandidates={queryCandidates} />}
      {overlay.kind === 'palette' && <div className="overlay" onClick={() => rt.emit({ type: 'palette.close' })}><div className="dialog" onClick={(e) => e.stopPropagation()}><b>コマンドパレット</b><div className="faint">次のフェーズで使えるようになります。Esc か外側のクリックで閉じます。</div></div></div>}
      <ToastStack toasts={state.toasts} />
    </>
  );

  return <IntentRoot onIntent={rt.emit}><Shell {...shell} overlays={overlays}>{body}</Shell></IntentRoot>;
}

const apiCache = new WeakMap<Runtime, ApiClient>();
function apiFromRuntime(rt: Runtime): ApiClient {
  let a = apiCache.get(rt);
  if (!a) { a = createApi(); apiCache.set(rt, a); }
  return a;
}
