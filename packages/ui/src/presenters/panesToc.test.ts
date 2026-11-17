import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { presentPanes } from './panes.ts';

const leaf = (id: string, sessionId: string, toc: boolean) => ({ kind: 'pane' as const, id, sessionId, toc });
const two = (over: Partial<State> = {}, tocPeek: string[] = []): State => ({
  ...initialState(),
  screen: { name: 'session', id: 's1' },
  panes: { root: { kind: 'split', id: 'n1', dir: 'row', ratio: 0.5, a: leaf('p1', 's1', true), b: leaf('p2', 's2', false) }, focus: 'p1', zoom: null, flash: null, tocPeek },
  ...over,
});

describe('分割のペインの右パネル', () => {
  it('柱が閉じていれば、ペインの toc に従う', () => {
    expect(presentPanes(two(), initialStore(), 0)?.toc).toEqual({ p1: true, p2: false });
  });
  it('柱が開いている間は、全部畳み、tocPeek のペインだけ開く', () => {
    expect(presentPanes(two({ orchestratorOpen: true }), initialStore(), 0)?.toc).toEqual({ p1: false, p2: false });
    expect(presentPanes(two({ orchestratorOpen: true }, ['p2']), initialStore(), 0)?.toc).toEqual({ p1: false, p2: true });
  });
});
