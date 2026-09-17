import type { SearchParamsDto } from '@agent-hangar/shared';
import type { Effect, Input, State, Step } from './types.ts';

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

/** screen 領域：どの画面にいるか。URL のハッシュが正で、Intent は navigate 効果を出すだけ。 */
export function screenStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime' && input.event.type === 'hash.changed') {
    const route = input.event.route;
    const effects: Effect[] = [];
    let next: State = { ...state, screen: route };
    if (route.name === 'session') effects.push({ kind: 'api.loadEvents', sessionId: route.id, fromSeq: 0 });
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
    case 'nav.go': return { state, effects: [{ kind: 'navigate', route: i.to }] };
    case 'project.open': return { state, effects: [{ kind: 'navigate', route: { name: 'project', id: i.id } }] };
    case 'session.open': return { state, effects: [{ kind: 'navigate', route: { name: 'session', id: i.id } }] };
    case 'search.query': {
      const next = { ...state, search: { ...state.search, text: i.text } };
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
