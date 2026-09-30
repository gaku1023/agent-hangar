import type { SearchParamsDto } from '@agent-hangar/shared';
import { agentTabStep } from './sessionView.ts';
import type { Effect, Input, Overlay, State, Step } from './types.ts';

/**
 * サーバに問い合わせるか。
 * キーワードがあるときと、触ったファイルで絞るときである。触ったファイルは手元のセッションに無い情報だからである。
 * それ以外の絞り込みは、手元のセッションで絞る。
 */
export function usesServerSearch(search: State['search']): boolean {
  return search.text !== '' || !!search.filter.file;
}

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
    let next: State = { ...state, screen: route, overlay: closeTransient(state), focusOnOpen: null };
    // 見ていないセッションの接続は残さない。
    // xterm とバッファは残るので、戻れば tmux attach が現在の画面を描き直す。
    const left = state.screen.name === 'session' ? state.screen.id : null;
    if (left && !(route.name === 'session' && route.id === left)) effects.push({ kind: 'terminal.disconnectSession', sessionId: left });
    if (route.name === 'session') effects.push({ kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0 }, { kind: 'terminal.connect', sessionId: route.id, tabId: null });
    // 「ターミナルで答える」で開いた画面なら、つないだ端末にそのままフォーカスする。
    if (route.name === 'session' && state.focusOnOpen === route.id) effects.push({ kind: 'focus', target: 'terminal' });
    if (route.name === 'project') effects.push({ kind: 'api.loadMemo', projectId: route.id });
    if (route.name === 'settings') effects.push({ kind: 'api.loadSettingsExtras' });
    if (route.name === 'sessions') {
      const text = route.q ?? '';
      next = { ...next, search: { ...state.search, text } };
      if (usesServerSearch(next.search)) effects.push({ kind: 'api.search', params: searchParams(next) });
    }
    return { state: next, effects };
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'nav.go': return { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: i.to }] };
    // 行き先はブラウザの履歴が決めるので、ここでは動かす向きだけを出す。戻った先は hash.changed で入ってくる。
    case 'nav.back': return { state, effects: [{ kind: 'history.go', delta: -1 }] };
    case 'nav.forward': return { state, effects: [{ kind: 'history.go', delta: 1 }] };
    case 'project.open': return { state: { ...state, overlay: closeTransient(state) }, effects: [{ kind: 'navigate', route: { name: 'project', id: i.id } }] };
    case 'session.open': {
      const overlay = closeTransient(state);
      if (i.focus !== 'terminal') return { state: { ...state, overlay, focusOnOpen: null }, effects: [{ kind: 'navigate', route: { name: 'session', id: i.id } }] };
      // 答える先は Claude のタブなので、シェルのタブを選んでいたら戻す。
      // もうその画面にいればハッシュは変わらないので、戻した Claude のタブをつないでからフォーカスだけを出す。
      if (state.screen.name === 'session' && state.screen.id === i.id) {
        const back = agentTabStep(state, i.id);
        const connect: Effect[] = back ? [...back.effects, { kind: 'terminal.connect', sessionId: i.id, tabId: null }] : [];
        return { state: { ...(back?.state ?? state), overlay }, effects: [...connect, { kind: 'focus', target: 'terminal' }] };
      }
      const back = agentTabStep(state, i.id) ?? { state, effects: [] };
      return { state: { ...back.state, overlay, focusOnOpen: i.id }, effects: [...back.effects, { kind: 'navigate', route: { name: 'session', id: i.id } }] };
    }
    case 'search.query': {
      const next = { ...state, overlay: closeTransient(state), search: { ...state.search, text: i.text } };
      return { state: next, effects: [{ kind: 'navigate', route: i.text ? { name: 'sessions', q: i.text } : { name: 'sessions' } }] };
    }
    case 'search.filter': {
      const next = { ...state, search: { ...state.search, filter: { ...state.search.filter, ...i.patch } } };
      const effects: Effect[] = state.screen.name === 'sessions' && usesServerSearch(next.search) ? [{ kind: 'api.search', params: searchParams(next) }] : [];
      return { state: next, effects };
    }
    case 'search.more': {
      const effects: Effect[] = state.screen.name === 'sessions' && usesServerSearch(state.search) ? [{ kind: 'api.search', params: { ...searchParams(state), offset: i.offset } }] : [];
      return { state, effects };
    }
    default: return null;
  }
}
