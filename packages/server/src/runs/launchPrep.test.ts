import { describe, expect, it } from 'vitest';
import type { LaunchPrepDto } from '@agent-hangar/shared';
import { LaunchPrepAsked, LaunchPrepCancelled, LaunchPreps } from './launchPrep.ts';

const hub = () => {
  const sent: LaunchPrepDto[] = [];
  let t = 1000;
  const preps = new LaunchPreps({ broadcast: (ev) => { sent.push(structuredClone(ev.prep)); }, now: () => t++ });
  return { sent, preps };
};

describe('LaunchPreps', () => {
  it('段の無い準備は何も配らない（Claude や、ローカルのモデルを使わない会話）', () => {
    const { sent, preps } = hub();
    const p = preps.begin('key-0001');
    p.finish();
    expect(sent).toEqual([]);
    expect(preps.has('key-0001')).toBe(false);
  });

  it('会話の ID を渡されたら進みに載せる。画面が、自分で起こしていない準備（MCP の起動）を会話に結び付けるため', () => {
    const { sent, preps } = hub();
    preps.begin('key-0009', 'sess-1').step('command', 'gpu', 'run');
    expect(sent.at(-1)).toMatchObject({ key: 'key-0009', sessionId: 'sess-1' });
    preps.begin('key-0010').step('command', 'gpu', 'run');
    expect(sent.at(-1)!.sessionId ?? null).toBeNull();
  });

  it('段が動くたびに鍵ごとの全体を配り、終わったら ready にする', () => {
    const { sent, preps } = hub();
    const p = preps.begin('key-0002');
    const s = p.step('local-model', 'qwen', 'check');
    s.update({ action: 'reload', fromContext: 8192, toContext: 65536 });
    s.done();
    p.finish();
    expect(sent.map((x) => x.phase)).toEqual(['running', 'running', 'running', 'ready']);
    expect(sent.at(-1)!.steps).toEqual([expect.objectContaining({ kind: 'local-model', target: 'qwen', action: 'reload', state: 'done', fromContext: 8192, toContext: 65536 })]);
    expect(sent.at(-1)!.endedAt).not.toBeNull();
  });

  it('問いは asking で配って LaunchPrepAsked を投げる', () => {
    const { sent, preps } = hub();
    const p = preps.begin('key-0003');
    const ask = { kind: 'unload-manual' as const, model: 'qwen', want: 65536, blocking: [] };
    expect(() => p.ask(ask)).toThrow(LaunchPrepAsked);
    expect(sent.at(-1)).toMatchObject({ phase: 'asking', ask });
  });

  it('やめると signal が切れ、段は LaunchPrepCancelled を投げる。cancelled を 1 度配る', () => {
    const { sent, preps } = hub();
    const p = preps.begin('key-0004');
    p.step('command', 'my-gpu', 'run');
    expect(preps.cancel('key-0004')).toBe(true);
    expect(p.signal.aborted).toBe(true);
    expect(() => p.throwIfCancelled()).toThrow(LaunchPrepCancelled);
    expect(sent.at(-1)!.phase).toBe('cancelled');
    p.finish();
    expect(sent.at(-1)!.phase).toBe('cancelled');
    expect(preps.cancel('key-0004')).toBe(false);
  });

  it('失敗は理由の長さを切って配る', () => {
    const { sent, preps } = hub();
    const p = preps.begin('key-0005');
    p.step('local-model', 'qwen', 'load').fail('x'.repeat(1000));
    p.fail('y'.repeat(1000));
    expect(sent.at(-1)!.phase).toBe('failed');
    expect(sent.at(-1)!.reason!.length).toBeLessThanOrEqual(300);
    expect(sent.at(-1)!.steps[0]!.reason!.length).toBeLessThanOrEqual(300);
  });

  it('鍵が無いか形が違えば、hangar が作った鍵で動く', () => {
    const { preps } = hub();
    expect(preps.begin(undefined).key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(preps.begin('bad key!').key).not.toBe('bad key!');
  });
});
