import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { CODEX_VERSION_SEEN_KEY } from './codexVersion.ts';
import { initialState, transition } from './transition.ts';

const act = (type: 'codex.version.continue' | 'codex.version.settings') => transition(initialState(), initialStore(), { kind: 'action', action: { type, version: '0.170.0' } });

describe('未検証の Codex の版の札の操作', () => {
  it('はじめはどの版も知らせ終えていない', () => {
    expect(initialState().codexVersionSeen).toBeNull();
  });
  it('「このまま続行」はその版を知らせ終えたことにし、端末に残す。画面は移らない', () => {
    const r = act('codex.version.continue');
    expect(r.state.codexVersionSeen).toBe('0.170.0');
    expect(r.effects).toEqual([{ kind: 'storage.save', key: CODEX_VERSION_SEEN_KEY, value: '0.170.0' }]);
  });
  it('「設定を開く」もその版を知らせ終えたことにし、設定の Codex の面へ移る', () => {
    expect(act('codex.version.settings').effects).toEqual([
      { kind: 'storage.save', key: CODEX_VERSION_SEEN_KEY, value: '0.170.0' },
      { kind: 'navigate', route: { name: 'settings', at: 'codex' } },
    ]);
  });
});
