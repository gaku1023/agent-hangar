import { describe, expect, it } from 'vitest';
import { createExternalApi } from './api.ts';

describe('ターミナルとエディタへの受け渡し', () => {
  it('tmux のパスが無ければ、外のターミナルは開かずに設定の欄を案内する', () => {
    const api = createExternalApi({ home: '/nope', settings: () => ({ tmuxPath: null, terminalApp: 'terminal', codePath: null }) });
    expect(() => api.openTerminal({ tmuxName: 'hangar-r1' })).toThrow('tmux が見つかりません。設定の「tmux のパス」を入力してください');
  });

  it('設定は呼ばれた時点の値を読む。作ったときの値を覚えない', () => {
    let reads = 0;
    const api = createExternalApi({ home: '/nope', settings: () => { reads++; return { tmuxPath: null, terminalApp: 'terminal', codePath: null }; } });
    expect(reads).toBe(0);
    expect(() => api.openTerminal({ tmuxName: 'a' })).toThrow();
    expect(() => api.openTerminal({ tmuxName: 'a' })).toThrow();
    expect(reads).toBe(2);
  });
});
