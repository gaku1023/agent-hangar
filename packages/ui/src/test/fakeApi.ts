import { vi } from 'vitest';
import type { ApiClient } from '../runtime/api.ts';

/** フェーズ 2 の API の偽物。
 * テストは必要なものだけ上書きする。
 */
export function fakeApiExtras(): Pick<ApiClient, 'launch' | 'resume' | 'fork' | 'killRun' | 'openTab' | 'closeTab' | 'openTerminalApp' | 'openEditor' | 'projectOpenEditor' | 'projectOpenTerminal' | 'createProject'> {
  const unused = (): never => { throw new Error('not used in this test'); };
  return {
    launch: vi.fn(async () => unused()),
    resume: vi.fn(async () => unused()),
    fork: vi.fn(async () => unused()),
    killRun: vi.fn(async () => unused()),
    openTab: vi.fn(async () => unused()),
    closeTab: vi.fn(async () => unused()),
    openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    openEditor: vi.fn(async () => {}),
    projectOpenEditor: vi.fn(async () => {}),
    projectOpenTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    createProject: vi.fn(async () => unused()),
  };
}
