import { describe, expect, it } from 'vitest';
import type { VoiceMode } from '@agent-hangar/shared';
import { addressee, initialAddrState, isWindowOpen, matchCall, type AddrInput, type AddrOutput, type AddrState } from './addressee.ts';

type Cfg = { mode: VoiceMode; callReading: string; speaking: boolean };
const always: Cfg = { mode: 'always', callReading: 'はんがー', speaking: false };

/** 入力を順に流し、出力を全部返す。 */
function run(inputs: AddrInput[], cfg: Cfg | ((i: number) => Cfg) = always, start: AddrState = initialAddrState()): { state: AddrState; outs: AddrOutput[] } {
  let state = start;
  const outs: AddrOutput[] = [];
  inputs.forEach((input, i) => {
    const [next, out] = addressee(state, input, typeof cfg === 'function' ? cfg(i) : cfg);
    state = next;
    outs.push(out);
  });
  return { state, outs };
}

const seg = (text: string, at: number): AddrInput => ({ kind: 'segment', text, at });
const sends = (outs: AddrOutput[]) => outs.flatMap((o) => (o.send ? [o.send] : []));

describe('addressee', () => {
  it('ambient speech is never sent', () => {
    const { outs } = run([seg('今日の晩ご飯どうする', 0), seg('ハンガーにかけといて', 1000), seg('はい', 2000), { kind: 'tick', at: 3000 }]);
    expect(sends(outs)).toEqual([]);
    expect(outs.every((o) => o.phase === 'ambient')).toBe(true);
  });

  it('ambient speech is not sent in off and toggle modes without a hold or toggle', () => {
    for (const mode of ['off', 'toggle'] as const) {
      const { outs } = run([seg('ねえはんがー、状況を教えて', 0), seg('こんにちは', 100)], { ...always, mode });
      expect(sends(outs)).toEqual([]);
      expect(outs[1]?.phase).toBe('off');
    }
  });

  it('call word with rest sends voice-called without the call word', () => {
    const { outs } = run([seg('ねえ、ハンガー。いまの状況を教えて', 0)]);
    expect(sends(outs)).toEqual([{ text: 'いまの状況を教えて', origin: 'voice-called' }]);
  });

  it('call word alone opens 8s then next segment is voice-called', () => {
    const a = run([seg('ねえハンガー', 0), seg('テストの結果は', 7999)]);
    expect(a.outs[0]?.send).toBeUndefined();
    expect(a.outs[0]?.phase).toBe('listening');
    expect(sends(a.outs)).toEqual([{ text: 'テストの結果は', origin: 'voice-called' }]);
    // 呼ばれた後の 1 区間だけ。次は常に聞くに戻る。
    const a2 = run([seg('ねえハンガー', 0), seg('テストの結果は', 1000), seg('それと', 2000)]);
    expect(sends(a2.outs)).toHaveLength(1);

    const b = run([seg('ねえハンガー', 0), seg('テストの結果は', 8000)]);
    expect(sends(b.outs)).toEqual([]);

    const c = run([seg('ねえハンガー', 0), { kind: 'tick', at: 8000 }, seg('テストの結果は', 8001)]);
    expect(c.outs[1]?.phase).toBe('ambient');
    expect(sends(c.outs)).toEqual([]);
  });

  it('accepts ねぇ and ねー variants and katakana for the call word', () => {
    expect(matchCall('ねぇ、はんがー', 'はんがー')).toBe('');
    expect(matchCall('ねーハンガー', 'はんがー')).toBe('');
    expect(matchCall('ねえ ハンガー、PR を見て', 'はんがー')).toBe('PR を見て');
    const { outs } = run([seg('ねぇ、はんがー', 0), seg('ねーハンガー止めて', 100)]);
    expect(outs[0]?.phase).toBe('listening');
    expect(sends(outs)).toEqual([{ text: '止めて', origin: 'voice-called' }]);
  });

  it('ハンガーにかけといて is not a call', () => {
    expect(matchCall('ハンガーにかけといて', 'はんがー')).toBeNull();
    expect(matchCall('ねえ、それハンガーにかけといて', 'はんがー')).toBeNull();
    expect(matchCall('ねえはんがー', '')).toBeNull();
  });

  it('window opens only after a strong turn reply and lasts 10s', () => {
    const base: AddrInput[] = [seg('ねえハンガー、状況を教えて', 0)];
    // 返答の前は窓は無い。
    const before = run([...base, seg('ついでにテストも', 500)]);
    expect(sends(before.outs)).toHaveLength(1);

    const a = run([...base, { kind: 'replied', at: 1000 }, seg('じゃあそれで', 10999)]);
    expect(a.outs[1]?.phase).toBe('window');
    expect(isWindowOpen(run([...base, { kind: 'replied', at: 1000 }]).state, 5000)).toBe(true);
    expect(sends(a.outs)).toEqual([
      { text: '状況を教えて', origin: 'voice-called' },
      { text: 'じゃあそれで', origin: 'voice-window' },
    ]);

    const b = run([...base, { kind: 'replied', at: 1000 }, seg('じゃあそれで', 11000)]);
    expect(sends(b.outs)).toHaveLength(1);

    const c = run([...base, { kind: 'replied', at: 1000 }, { kind: 'tick', at: 11000 }]);
    expect(c.outs[2]?.phase).toBe('ambient');

    // 統括が自分から話した返答（強い送りの無い返答）では開かない。
    const d = run([{ kind: 'replied', at: 0 }, seg('じゃあそれで', 100)]);
    expect(d.outs[0]?.phase).toBe('ambient');
    expect(sends(d.outs)).toEqual([]);

    // 窓は返答 1 回につき 1 回だけ開く。
    const e = run([...base, { kind: 'replied', at: 1000 }, { kind: 'tick', at: 12000 }, { kind: 'replied', at: 13000 }, seg('じゃあそれで', 14000)]);
    expect(sends(e.outs)).toHaveLength(1);
  });

  it('window does not open outside always mode', () => {
    const toggle: Cfg = { ...always, mode: 'off' };
    const { outs } = run([{ kind: 'holdStart', at: 0 }, seg('状況を教えて', 100), { kind: 'holdEnd', at: 200 }, { kind: 'replied', at: 1000 }, seg('じゃあそれで', 2000)], toggle);
    expect(sends(outs)).toEqual([{ text: '状況を教えて', origin: 'voice-held' }]);
    expect(outs[3]?.phase).toBe('off');
  });

  it('leaving always mode drops an open window and a pending call', () => {
    const modes: VoiceMode[] = ['always', 'always', 'off', 'always'];
    const a = run([seg('ねえハンガー、状況を教えて', 0), { kind: 'replied', at: 1000 }, { kind: 'tick', at: 1100 }, seg('じゃあそれで', 1200)], (i) => ({ ...always, mode: modes[i]! }));
    expect(sends(a.outs)).toHaveLength(1);
    const b = run([seg('ねえハンガー', 0), { kind: 'tick', at: 100 }, seg('これも', 200)], (i) => ({ ...always, mode: (['always', 'toggle', 'always'] as const)[i]! }));
    expect(sends(b.outs)).toEqual([]);
  });

  it('no window after a window turn reply', () => {
    const { outs } = run([
      seg('ねえハンガー、状況を教えて', 0),
      { kind: 'replied', at: 1000 },
      seg('じゃあそれで', 2000),
      seg('あともう一つ', 2500),
      { kind: 'replied', at: 3000 },
      seg('ありがとう', 4000),
    ]);
    expect(sends(outs)).toEqual([
      { text: '状況を教えて', origin: 'voice-called' },
      { text: 'じゃあそれで', origin: 'voice-window' },
    ]);
    expect(outs[4]?.phase).toBe('ambient');
  });

  it('meeting closes an open window and ignores call word', () => {
    const { outs, state } = run([
      seg('ねえハンガー、状況を教えて', 0),
      { kind: 'replied', at: 1000 },
      { kind: 'meeting', on: true, at: 1500 },
      seg('じゃあそれで', 2000),
      seg('ねえハンガー、議事録を取って', 2500),
      seg('ねえハンガー', 3000),
      seg('これも', 3500),
    ]);
    expect(outs[2]?.phase).toBe('meeting');
    expect(isWindowOpen(state, 2000)).toBe(false);
    expect(sends(outs)).toEqual([{ text: '状況を教えて', origin: 'voice-called' }]);

    // 会議が明けても、閉じた窓は戻らない。
    const after = run([{ kind: 'meeting', on: false, at: 4000 }, seg('じゃあそれで', 4500)], always, state);
    expect(after.outs[0]?.phase).toBe('ambient');
    expect(sends(after.outs)).toEqual([]);

    // 呼ばれた直後に会議が始まったら、待ちも消える。
    const called = run([seg('ねえハンガー', 0), { kind: 'meeting', on: true, at: 100 }, { kind: 'meeting', on: false, at: 200 }, seg('これも', 300)]);
    expect(sends(called.outs)).toEqual([]);

    // 会議中の返答でも窓は開かない。
    const reply = run([seg('ねえハンガー、状況を教えて', 0), { kind: 'meeting', on: true, at: 100 }, { kind: 'replied', at: 1000 }, { kind: 'meeting', on: false, at: 1100 }, seg('じゃあそれで', 1200)]);
    expect(sends(reply.outs)).toHaveLength(1);
  });

  it('meeting keeps hold and toggle', () => {
    const held = run([{ kind: 'meeting', on: true, at: 0 }, { kind: 'holdStart', at: 100 }, seg('状況を教えて', 200), { kind: 'holdEnd', at: 300 }]);
    expect(held.outs[1]?.phase).toBe('listening');
    expect(sends(held.outs)).toEqual([{ text: '状況を教えて', origin: 'voice-held' }]);
    const toggled = run([{ kind: 'meeting', on: true, at: 0 }, { kind: 'toggleOn', at: 100 }, seg('状況を教えて', 200)], { ...always, mode: 'toggle' });
    expect(sends(toggled.outs)).toEqual([{ text: '状況を教えて', origin: 'voice-toggle-first' }]);
  });

  it('held joins segments in order and sends once', () => {
    for (const mode of ['off', 'toggle', 'always'] as const) {
      const { outs, state } = run(
        [{ kind: 'holdStart', at: 0 }, seg('ねえハンガー', 100), seg('テストを', 1000), seg('流して', 2000), { kind: 'tick', at: 2500 }, { kind: 'holdEnd', at: 3000 }],
        { ...always, mode },
      );
      expect(outs.slice(0, 5).every((o) => o.send === undefined && o.phase === 'listening')).toBe(true);
      expect(sends(outs)).toEqual([{ text: 'ねえハンガー テストを 流して', origin: 'voice-held' }]);
      // 押している間の呼びかけ語は、離した後の待ちを作らない。
      expect(sends(run([seg('次の区間', 3500)], { ...always, mode }, state).outs)).toEqual([]);
    }
    const empty = run([{ kind: 'holdStart', at: 0 }, { kind: 'holdEnd', at: 100 }]);
    expect(sends(empty.outs)).toEqual([]);
    // 離した後の区間は押している間に数えない。
    const late = run([{ kind: 'holdStart', at: 0 }, seg('テスト', 50), { kind: 'holdEnd', at: 100 }, seg('おまけ', 200)]);
    expect(sends(late.outs)).toEqual([{ text: 'テスト', origin: 'voice-held' }]);
  });

  it('held turn reply opens the window in always mode', () => {
    const { outs } = run([{ kind: 'holdStart', at: 0 }, seg('状況を教えて', 100), { kind: 'holdEnd', at: 200 }, { kind: 'replied', at: 1000 }, seg('じゃあそれで', 2000)]);
    expect(sends(outs).map((s) => s.origin)).toEqual(['voice-held', 'voice-window']);
  });

  it('toggle first is strong, rest is weak', () => {
    const toggle: Cfg = { ...always, mode: 'toggle' };
    const { outs } = run(
      [{ kind: 'toggleOn', at: 0 }, seg('状況を教えて', 100), seg('それと PR も', 200), { kind: 'toggleOff', at: 300 }, seg('独り言', 400), { kind: 'toggleOn', at: 500 }, seg('もう一度', 600)],
      toggle,
    );
    expect(outs[0]?.phase).toBe('listening');
    expect(outs[4]?.phase).toBe('off');
    expect(sends(outs)).toEqual([
      { text: '状況を教えて', origin: 'voice-toggle-first' },
      { text: 'それと PR も', origin: 'voice-toggle-rest' },
      { text: 'もう一度', origin: 'voice-toggle-first' },
    ]);
    // 切り替えは toggle の聞き方のときだけ効く。
    const elsewhere = run([{ kind: 'toggleOn', at: 0 }, seg('状況を教えて', 100)], { ...always, mode: 'off' });
    expect(sends(elsewhere.outs)).toEqual([]);
  });

  it('stop word while speaking stops and does not send', () => {
    const speaking: Cfg = { ...always, speaking: true };
    const a = run([seg('止めて。', 0)], speaking);
    expect(a.outs[0]).toMatchObject({ stopSpeaking: true });
    expect(a.outs[0]?.send).toBeUndefined();
    const b = run([{ kind: 'toggleOn', at: 0 }, seg('ストップ', 100)], { ...speaking, mode: 'toggle' });
    expect(b.outs[1]).toMatchObject({ stopSpeaking: true });
    expect(sends(b.outs)).toEqual([]);
    // 押している間でも止めるだけで、まとめに入れない。
    const c = run([{ kind: 'holdStart', at: 0 }, seg('すとっぷ', 100), { kind: 'holdEnd', at: 200 }], speaking);
    expect(c.outs[1]?.stopSpeaking).toBe(true);
    expect(sends(c.outs)).toEqual([]);
    // 読み上げ中でなければ、ふつうの区間として扱う。
    const d = run([{ kind: 'toggleOn', at: 0 }, seg('止めて', 100)], { ...always, mode: 'toggle' });
    expect(d.outs[1]?.stopSpeaking).toBeUndefined();
    expect(sends(d.outs)).toEqual([{ text: '止めて', origin: 'voice-toggle-first' }]);
    // 止める語に続きがあれば止めない。
    const e = run([seg('止めてから考えよう', 0)], speaking);
    expect(e.outs[0]?.stopSpeaking).toBeUndefined();
  });

  it('send text never carries a mark and empty text is not sent', () => {
    const { outs } = run([{ kind: 'toggleOn', at: 0 }, seg('  ', 100), seg('[voice] 状況', 200)], { ...always, mode: 'toggle' });
    // 印を剥がすのはサーバの markOrchestratorText。ここでは足さないし、空は送らない。
    expect(sends(outs)).toEqual([{ text: '[voice] 状況', origin: 'voice-toggle-first' }]);
  });
});
