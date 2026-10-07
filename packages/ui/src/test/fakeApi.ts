import { vi } from 'vitest';
import type { ApiClient } from '../runtime/api.ts';
import { accountsFixture } from './accounts.ts';

type Extras = Pick<
  ApiClient,
  | 'launch' | 'resume' | 'fork' | 'attach' | 'adopt' | 'killRun' | 'openTab' | 'closeTab' | 'openTerminalApp' | 'jumpToPrompt' | 'leaveTranscript' | 'openEditor' | 'projectOpenEditor' | 'projectOpenTerminal' | 'createProject' | 'workspaceDirs'
  | 'usageAggregate' | 'statusline' | 'shellHook' | 'readiness' | 'compat' | 'addTodo' | 'setTodoDone' | 'removeTodo' | 'confirmTodo' | 'rejectTodo' | 'setSessionState' | 'confirmSessionState' | 'rejectSessionState' | 'memo' | 'saveMemo' | 'setSessionMemo'
  | 'addArtifact' | 'openArtifact' | 'openArtifactEditor' | 'promote' | 'regenerateSummary' | 'summarizerModels' | 'testSummarizer'
  | 'syncUsage' | 'syncNow' | 'syncPause' | 'syncFocus' | 'resumeHere' | 'joinToken' | 'configPreview' | 'configPull'
  | 'retention' | 'retentionPreview' | 'writeRetention'
  | 'live' | 'promptCommands' | 'promptFiles' | 'uploadDrop' | 'existingDrops'
  | 'accounts' | 'setCurrentAccount' | 'switchAccount' | 'addAccount' | 'updateAccount' | 'removeAccount' | 'loginAccount' | 'cancelAccountLogin' | 'refreshAccount'
>;

/** フェーズ 2 からフェーズ 4 で増えた API の偽物。
 * テストは必要なものだけ上書きする。
 * 返り値を使うテストが無い関数は、呼ばれたら投げる。
 */
export function fakeApiExtras(): Extras {
  const unused = (): never => { throw new Error('not used in this test'); };
  return {
    launch: vi.fn(async () => unused()),
    resume: vi.fn(async () => unused()),
    fork: vi.fn(async () => unused()),
    attach: vi.fn(async () => unused()),
    adopt: vi.fn(async () => unused()),
    killRun: vi.fn(async () => unused()),
    openTab: vi.fn(async () => unused()),
    closeTab: vi.fn(async () => unused()),
    openTerminalApp: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    jumpToPrompt: vi.fn(async () => ({ found: true as const })),
    leaveTranscript: vi.fn(async () => ({ left: true })),
    openEditor: vi.fn(async () => {}),
    projectOpenEditor: vi.fn(async () => {}),
    projectOpenTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    createProject: vi.fn(async () => unused()),
    // 未登録の一覧は、新しいセッションのダイアログを開くたびに取りに行くので、どのテストでも空を返す。
    workspaceDirs: vi.fn(async () => []),
    promptCommands: vi.fn(async () => []),
    promptFiles: vi.fn(async () => []),
    uploadDrop: vi.fn(async (_file: Blob, name: string) => ({ path: `/h/.agent-hangar/drops/1-0-${name}`, name, size: 0 })),
    existingDrops: vi.fn(async (paths: string[]) => paths),
    usageAggregate: vi.fn(async () => ({ days: [], projects: [] })),
    statusline: vi.fn(async () => ({ command: null, scriptPath: null, installed: false })),
    shellHook: vi.fn(async () => ({ state: 'off' as const, zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: 'hangar shell install' })),
    // 準備の確かめは、空のホームでも取りに行くので、どのテストでも答えを返す。
    readiness: vi.fn(async () => ({
      tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, code: { path: null, ok: false, problem: 'unset' as const, version: null }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
      workspace: { path: '/w', exists: true, projectCount: 1 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
      commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install' },
      compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
    })),
    compat: vi.fn(async () => ({ verifiedVersion: '2.1.292', localVersion: '2.1.292', drifts: [] })),
    addTodo: vi.fn(async (projectId: string, text: string) => ({ id: 't1', projectId, text, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
    setTodoDone: vi.fn(async (id: string, done: boolean) => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
    removeTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
    confirmTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: true, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
    rejectTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null })),
    setSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null } })),
    confirmSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null } })),
    rejectSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null } })),
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
    // フェーズ 4 の同期。状態を返すものは、使うテストが自分で上書きする。
    // 使用量は届いていない状態（null）が既定である。
    syncUsage: vi.fn(async () => null),
    syncNow: vi.fn(async () => unused()),
    syncPause: vi.fn(async () => unused()),
    syncFocus: vi.fn(async () => {}),
    resumeHere: vi.fn(async () => unused()),
    // 参加トークンは押したときだけ取りに行く値なので、既定は未発行の null にする。
    joinToken: vi.fn(async () => ({ token: null })),
    configPreview: vi.fn(async () => ({ entries: [], confirmed: false })),
    configPull: vi.fn(async () => ({ applied: 0, conflicts: 0 })),
    retention: vi.fn(async () => ({ days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: null })),
    retentionPreview: vi.fn(async () => unused()),
    writeRetention: vi.fn(async () => unused()),
    live: vi.fn(async (sessionId: string) => ({ sessionId, turnStartSeq: null, intent: null, agents: [] })),
    // アカウントは既定で 2 件の固定データを返す。切り替えの結果は使うテストが自分で上書きする。
    accounts: vi.fn(async () => accountsFixture),
    setCurrentAccount: vi.fn(async () => accountsFixture),
    switchAccount: vi.fn(async (sessionId: string) => ({ run: { id: 'r-switch', sessionId, deviceId: 'd', kind: 'resume' as const, tmuxName: 'hangar-r-switch', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId, tabs: [{ id: 'r-switch', runId: 'r-switch', sessionId, kind: 'agent' as const, title: 'Claude', tmuxName: 'hangar-r-switch', createdAt: 1, closedAt: null }] })),
    addAccount: vi.fn(async () => accountsFixture),
    updateAccount: vi.fn(async () => accountsFixture),
    removeAccount: vi.fn(async () => accountsFixture),
    loginAccount: vi.fn(async () => undefined),
    cancelAccountLogin: vi.fn(async () => accountsFixture),
    refreshAccount: vi.fn(async () => accountsFixture),
  };
}
