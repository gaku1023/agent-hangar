import { describe, expect, it } from 'vitest';
import { emptyPanes, type PanesState } from '../mediator/panes.ts';
import { paneKeyAction } from './paneKeys.ts';

const leaf = (id: string, sessionId: string) => ({ kind: 'pane' as const, id, sessionId, toc: false });
const two = (): PanesState => ({ ...emptyPanes(), root: { kind: 'split', id: 'n1', dir: 'row', ratio: 0.5, a: leaf('p1', 's1'), b: leaf('p2', 's2') }, focus: 'p2' });
const one = (): PanesState => ({ ...emptyPanes(), root: leaf('p1', 's1'), focus: 'p1' });
const ctx = (panes: PanesState, over: Partial<Parameters<typeof paneKeyAction>[1]> = {}) => ({ panes, onSession: true, key: '', neighbor: () => null, ...over });

describe('分割のキーと ⌘J の向き先（paneKeyAction）', () => {
  it('⌘J は、ペインが 2 つ以上なら操作中のペインの右パネル（pane.toc）へ向ける', () => {
    expect(paneKeyAction('transcript.toggle', ctx(two()))).toEqual({ type: 'pane.toc', pane: 'p2' });
  });
  it('⌘J は、ペインが 1 つか、セッション画面の外なら今までの transcript.toggle のまま（null を返して呼び出し側に任せる）', () => {
    expect(paneKeyAction('transcript.toggle', ctx(one()))).toBeNull();
    expect(paneKeyAction('transcript.toggle', ctx(two(), { onSession: false }))).toBeNull();
    expect(paneKeyAction('transcript.toggle', ctx(emptyPanes()))).toBeNull();
  });
  it('⌘D と ⌘⇧D は操作中のペインの右と下に空のペインを開く', () => {
    expect(paneKeyAction('pane.splitRight', ctx(one()))).toEqual({ type: 'pane.openEmpty', side: 'right' });
    expect(paneKeyAction('pane.splitDown', ctx(one()))).toEqual({ type: 'pane.openEmpty', side: 'down' });
  });
  it('⌘⇧W と ⌘⇧↩ は操作中のペインを外す、最大化する', () => {
    expect(paneKeyAction('pane.remove', ctx(two()))).toEqual({ type: 'pane.remove', pane: 'p2' });
    expect(paneKeyAction('pane.zoom', ctx(two()))).toEqual({ type: 'pane.zoom', pane: 'p2' });
  });
  it('⌘⌥矢印は、隣を求める関数が返したペインへ pane.focus を出す。隣が無ければ打鍵を取らない', () => {
    const seen: unknown[] = [];
    const neighbor = (from: string, dir: string) => { seen.push([from, dir]); return dir === 'left' ? 'p1' : null; };
    expect(paneKeyAction('pane.focusDir', ctx(two(), { key: 'ArrowLeft', neighbor }))).toEqual({ type: 'pane.focus', pane: 'p1' });
    expect(paneKeyAction('pane.focusDir', ctx(two(), { key: 'ArrowRight', neighbor }))).toBe('none');
    expect(seen).toEqual([['p2', 'left'], ['p2', 'right']]);
  });
  it('セッション画面の外では、分割のキーは何も出さず、打鍵も取らない', () => {
    for (const id of ['pane.splitRight', 'pane.splitDown', 'pane.remove', 'pane.zoom', 'pane.focusDir'] as const) {
      expect(paneKeyAction(id, ctx(two(), { onSession: false, key: 'ArrowLeft', neighbor: () => 'p1' }))).toBe('none');
    }
  });
  it('分割に関係の無いキーは null', () => {
    expect(paneKeyAction('tab.close', ctx(two()))).toBeNull();
  });
});
