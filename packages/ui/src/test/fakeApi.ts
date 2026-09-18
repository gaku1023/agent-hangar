import { vi } from 'vitest';
import type { ApiClient } from '../runtime/api.ts';

type Extras = Pick<
  ApiClient,
  | 'launch' | 'resume' | 'fork' | 'killRun' | 'openTab' | 'closeTab' | 'openTerminalApp' | 'openEditor' | 'projectOpenEditor' | 'projectOpenTerminal' | 'createProject'
  | 'usageAggregate' | 'statusline' | 'addTodo' | 'setTodoDone' | 'removeTodo' | 'memo' | 'saveMemo' | 'setSessionMemo'
  | 'addArtifact' | 'openArtifact' | 'openArtifactEditor' | 'promote' | 'regenerateSummary' | 'summarizerModels' | 'testSummarizer'
>;

/** フェーズ 2 とフェーズ 3 で増えた API の偽物。
 * テストは必要なものだけ上書きする。
 * 返り値を使うテストが無い関数は、呼ばれたら投げる。
 */
export function fakeApiExtras(): Extras {
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
    usageAggregate: vi.fn(async () => ({ days: [], projects: [] })),
    statusline: vi.fn(async () => ({ command: null, scriptPath: null, installed: false })),
    addTodo: vi.fn(async (projectId: string, text: string) => ({ id: 't1', projectId, text, done: false, position: 1, sessionId: null, updatedAt: 1 })),
    setTodoDone: vi.fn(async (id: string, done: boolean) => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1 })),
    removeTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1 })),
    memo: vi.fn(async (projectId: string) => ({ projectId, markdown: '', updatedAt: 0 })),
    saveMemo: vi.fn(async (projectId: string, markdown: string) => ({ projectId, markdown, updatedAt: 2 })),
    setSessionMemo: vi.fn(async () => unused()),
    addArtifact: vi.fn(async () => unused()),
    openArtifact: vi.fn(async () => {}),
    openArtifactEditor: vi.fn(async () => {}),
    promote: vi.fn(async () => unused()),
    regenerateSummary: vi.fn(async () => {}),
    summarizerModels: vi.fn(async () => ({ models: ['gemma'] })),
    testSummarizer: vi.fn(async () => ({ ok: false as const, tried: [] })),
  };
}
