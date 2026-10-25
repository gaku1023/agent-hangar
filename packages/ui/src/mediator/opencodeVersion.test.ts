import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { OPENCODE_VERSION_SEEN_KEY, readOpencodeVersionSeen } from './opencodeVersion.ts';
import { initialState, transition } from './transition.ts';

const act = (action: { type: 'opencode.version.continue' | 'opencode.version.settings'; version: string }) => transition(initialState(), initialStore(), { kind: 'action', action });

describe('readOpencodeVersionSeen：localStorage から知らせ終えた版を読み戻す', () => {
  it('文字列だけを取り、ほかは知らせていないことにする', () => {
    expect(readOpencodeVersionSeen('2.2.0')).toBe('2.2.0');
    for (const v of [undefined, null, 7, ['2.2.0'], { v: '2.2.0' }, '']) expect(readOpencodeVersionSeen(v), String(v)).toBeNull();
  });
});

describe('未検証の版の札の操作（C7）', () => {
  it('はじめはどの版も知らせ終えていない', () => {
    expect(initialState().opencodeVersionSeen).toBeNull();
  });
  it('「このまま続行」はその版を知らせ終えたことにし、端末に残す。画面は移らない', () => {
    const r = act({ type: 'opencode.version.continue', version: '2.2.0' });
    expect(r.state.opencodeVersionSeen).toBe('2.2.0');
    expect(r.state.screen).toEqual(initialState().screen);
    expect(r.effects).toEqual([{ kind: 'storage.save', key: OPENCODE_VERSION_SEEN_KEY, value: '2.2.0' }]);
  });
  it('「設定を開く」もその版を知らせ終えたことにし、設定の opencode の面へ移る', () => {
    const r = act({ type: 'opencode.version.settings', version: '2.2.0' });
    expect(r.state.opencodeVersionSeen).toBe('2.2.0');
    expect(r.effects).toEqual([
      { kind: 'storage.save', key: OPENCODE_VERSION_SEEN_KEY, value: '2.2.0' },
      { kind: 'navigate', route: { name: 'settings', at: 'opencode' } },
    ]);
  });
});
