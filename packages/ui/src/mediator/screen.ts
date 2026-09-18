import type { SearchParamsDto } from '@agent-hangar/shared';
import type { Effect, Input, Overlay, State, Step } from './types.ts';

export function searchParams(state: State): SearchParamsDto {
  const f = state.search.filter;
  const p: SearchParamsDto = { q: state.search.text };
  if (f.projectId) p.projectId = f.projectId;
  if (f.since !== undefined) p.since = f.since;
  if (f.until !== undefined) p.until = f.until;
  if (f.running !== undefined) p.running = f.running;
  if (f.file) p.file = f.file;
  return p;
}

/**
 * 画面を移るときに消えてよいオーバーレイを閉じる。
 * 昇格の完了ダイアログは読んで終わりなので、画面から離れたら残さない。
 * 未解決プロジェクトのダイアログはキューを持ち、決めるまで閉じない種類なのでここでは触らない。
 */
function closeTransient(state: State): Overlay {
  return state.overlay.kind === 'promoted' ? { kind: 'none' } : state.overlay;
}

/** screen 領域：どの画面にいるか。URL のハッシュが正で、Intent は navigate 効果を出すだけ。 */
export function screenStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'hash.changed') {
    const route = input.event.route;
    const effects: Effect[] = [];
    let next: State = { ...state, screen: route, overlay: closeTransient(state) };
    // 見ていないセッションの接続は残さない。
    // xterm とバッファは残るので、戻れば tmux attach が現在の画面を描き直す。
    const left = state.screen.name === 'session' ? state.screen.id : null;
    if (left && !(route.name === 'session' && route.id === left)) effects.push({ kind: 'terminal.disconnectSession', sessionId: left });
    if (route.name === 'session') effects.push({ kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0 }, { kind: 'terminal.connect', sessionId: route.id, tabId: null });
    if (route.name === 'project') effects.push({ kind: 'api.loadMemo', projectId: route.id });
    if (route.name === 'settings') effects.push({ kind: 'api.loadSettingsExtras' });
    if (route.name === 'sessions') {
      const text = route.q ?? '';
      next = { ...next, search: { ...state.search, text } };
      if (text) effects.push({ kind: 'api.search', params: searchParams(next) });
    }
    return { state: next, effects };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'nav.go': return { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: i.to }] };
    case 'project.open': return { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: { name: 'project', id: i.id } }] };
    case 'session.open': return { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: { name: 'session', id: i.id } }] };
    case 'search.query': {
      const next = { ...state, overlay: closeTransient(state), search: { ...state.search, text: i.text } };
      return { state: next, effects: [{ kind: 'navigate', route: i.text ? { name: 'sessions', q: i.text } : { name: 'sessions' } }] };
    }
    case 'search.filter': {
      const next = { ...state, search: { ...state.search, filter: { ...state.search.filter, ...i.patch } } };
      const effects: Effect[] = state.screen.name === 'sessions' && next.search.text ? [{ kind: 'api.search', params: searchParams(next) }] : [];
      return { state: next, effects };
    }
    default: return null;
  }
}
