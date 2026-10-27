import { describe, expect, it } from 'vitest';
import type { PaneOps } from '../tmux/pane.ts';
import { RunManager, type RunManagerDeps } from './manager.ts';

/** 画面の口だけを持つ RunManager。readScreen と sendInput は、それ以外の依存に触れない。 */
function make(over: Partial<PaneOps> & { names?: string[] | null } = {}) {
  const log: string[][] = [];
  const panes: PaneOps = {
    open: () => {}, close: () => {}, list: () => (over.names === undefined ? ['hangar-a'] : over.names),
    capture: (n) => `screen of ${n}`,
    sendText: (n, t) => { log.push(['text', n, t]); },
    sendKey: (n, k) => { log.push(['key', n, k]); },
    pasteText: (n, t) => { log.push(['paste', n, t]); },
    prepareForOutsideTerminals: () => {},
    ...over,
  };
  return { rm: new RunManager({ panes, accounts: {} } as unknown as RunManagerDeps), log };
}

describe('RunManager.readScreen', () => {
  it('在る画面は読み、無い画面は null を返す', () => {
    const { rm } = make();
    expect(rm.readScreen('hangar-a')).toBe('screen of hangar-a');
    expect(rm.readScreen('hangar-zzz')).toBeNull();
  });
  it('一覧が観測できなかったときは確かめずに読む', () => {
    expect(make({ names: null }).rm.readScreen('hangar-a')).toBe('screen of hangar-a');
  });
});

describe('RunManager.sendInput', () => {
  it('貼り付けで届け、submit なら少し置いて Enter を送る', async () => {
    const { rm, log } = make();
    await rm.sendInput('hangar-a', 'one\ntwo', true);
    expect(log).toEqual([['paste', 'hangar-a', 'one\ntwo'], ['key', 'hangar-a', 'enter']]);
  });
  it('submit が false なら Enter は送らない', async () => {
    const { rm, log } = make();
    await rm.sendInput('hangar-a', 'x', false);
    expect(log).toEqual([['paste', 'hangar-a', 'x']]);
  });
  it('無い画面には送らず投げる', async () => {
    const { rm, log } = make();
    await expect(rm.sendInput('hangar-zzz', 'x', true)).rejects.toThrow('pane not found');
    expect(log).toEqual([]);
  });
  it('貼れない裏では、1 行は素の文字で打ち、複数行は投げる（行ごとに確定させない）', async () => {
    const failing = { pasteText: () => { throw new Error('paste-buffer failed'); } };
    const a = make(failing);
    await a.rm.sendInput('hangar-a', 'one line', true);
    expect(a.log).toEqual([['text', 'hangar-a', 'one line'], ['key', 'hangar-a', 'enter']]);
    const b = make(failing);
    await expect(b.rm.sendInput('hangar-a', 'one\ntwo', true)).rejects.toThrow('paste-buffer failed');
    expect(b.log).toEqual([]);
  });
  it('貼り付けの口が無い裏でも、複数行は投げる', async () => {
    const { rm } = make({ pasteText: undefined });
    await expect(rm.sendInput('hangar-a', 'a\nb', true)).rejects.toThrow('paste');
  });
});
