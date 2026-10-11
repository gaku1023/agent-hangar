import { describe, expect, it } from 'vitest';
import { initialStore } from '../store/store.ts';
import { initialState, transition } from './transition.ts';
import type { Input } from './types.ts';

// 連携の書き込み（MCP、シェル連携、ステータスライン）のボタン。書くのは殻の承諾の窓を経た CLI で、画面は頼むだけである。
const action = (a: Extract<Input, { kind: 'action' }>['action']): Input => ({ kind: 'action', action: a });
const runtime = (e: Extract<Input, { kind: 'runtime' }>['event']): Input => ({ kind: 'runtime', event: e });

describe('setup.run', () => {
  it('殻へ頼み、返事が来るまで押した対象を覚えて、続けて押しても重ねない', () => {
    const a = transition(initialState(), initialStore(), action({ type: 'setup.run', target: 'mcp-install' }));
    expect(a.state.setupRunning).toBe('mcp-install');
    expect(a.effects).toEqual([{ kind: 'desktop.setup', target: 'mcp-install' }]);
    const b = transition(a.state, initialStore(), action({ type: 'setup.run', target: 'statusline-install' }));
    expect(b.effects).toEqual([]);
    expect(b.state.setupRunning).toBe('mcp-install');
    const c = transition(b.state, initialStore(), runtime({ type: 'setup.done', target: 'mcp-install' }));
    expect(c.state.setupRunning).toBeNull();
  });
});
