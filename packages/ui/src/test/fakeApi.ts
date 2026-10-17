import { vi } from 'vitest';
import type { ApiClient } from '../runtime/api.ts';
import { accountsFixture } from './accounts.ts';

type Extras = Pick<
  ApiClient,
  | 'launch' | 'resume' | 'fork' | 'attach' | 'adopt' | 'killRun' | 'openTab' | 'closeTab' | 'openTerminalApp' | 'jumpToPrompt' | 'leaveTranscript' | 'openEditor' | 'projectOpenEditor' | 'editors' | 'testEditor' | 'projectOpenTerminal' | 'createProject' | 'workspaceDirs' | 'folderCandidates' | 'workspaceChildren' | 'inspectFolder' | 'registerFolders'
  | 'usageAggregate' | 'statusline' | 'shellHook' | 'readiness' | 'recheckMux' | 'compat' | 'addTodo' | 'setTodoDone' | 'removeTodo' | 'confirmTodo' | 'rejectTodo' | 'editTodo' | 'acceptTodo' | 'reorderTodos' | 'restoreTodos' | 'setSessionState' | 'confirmSessionState' | 'rejectSessionState' | 'moveSession' | 'deleteSession' | 'memo' | 'saveMemo' | 'instructions' | 'openInstruction' | 'setupGuide' | 'openSetupGuide'
  | 'addArtifact' | 'openArtifact' | 'openArtifactEditor' | 'promote' | 'regenerateSummary' | 'summarizerModels' | 'testSummarizer'
  | 'syncUsage' | 'syncNow' | 'syncPause' | 'syncFocus' | 'resumeHere' | 'resumeHerePlan' | 'takeoverStart' | 'takeoverExtend' | 'takeoverCancel' | 'joinCodeCurrent' | 'joinCodeIssue' | 'joinCodeApprove' | 'joinCodeReject' | 'joinCodeClose' | 'recoveryKeyReissue' | 'recoveryKeyConfirm' | 'cloudDevices' | 'mobilePairing' | 'mobilePaired'
  | 'configSyncState' | 'configOutgoing' | 'configInbox' | 'configConflicts' | 'configUnsent' | 'configBackups' | 'configSendUnsent' | 'configPutOrder' | 'configDeleteOrder'
  | 'retention' | 'retentionPreview' | 'writeRetention'
  | 'renameProject' | 'live' | 'sessionFiles' | 'gitSessions' | 'sessionChanges' | 'sessionDiff' | 'sessionEdits' | 'projectGit' | 'promptCommands' | 'promptFiles' | 'uploadDrop' | 'existingDrops'
  | 'accounts' | 'setCurrentAccount' | 'switchAccount' | 'addAccount' | 'previewAccountDir' | 'updateAccount' | 'removeAccount' | 'loginAccount' | 'cancelAccountLogin' | 'refreshAccount'
  | 'dismissInterrupted' | 'dismissOverlap'
>;

/** フェーズ 2 からフェーズ 4 で増えた API の偽物。
 * テストは必要なものだけ上書きする。
 * 返り値を使うテストが無い関数は、呼ばれたら投げる。
 */
export function fakeApiExtras(): Extras {
  const unused = (): never => { throw new Error('not used in this test'); };
  return {
    renameProject: vi.fn(async () => unused()),
    // git の表示。一覧と画面を開くたびに取りに行くので、どのテストでも空の答えを返す。
    gitSessions: vi.fn(async () => ({ sessions: {}, trees: {} })),
    sessionChanges: vi.fn(async () => ({ state: 'nogit' as const, root: null, tree: null, files: [], others: [], othersCapped: false })),
    sessionDiff: vi.fn(async () => unused()),
    sessionEdits: vi.fn(async () => unused()),
    projectGit: vi.fn(async () => ({ root: null, worktrees: [] })),
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
    editors: vi.fn(async () => ({ candidates: [], current: { id: 'vscode' as const, state: 'found' as const, path: '/usr/local/bin/code' } })),
    testEditor: vi.fn(async () => ({ ok: true, via: 'cli' as const, file: '/Users/me/.agent-hangar/hangar-editor-test.md', message: null })),
    projectOpenTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    createProject: vi.fn(async () => unused()),
    // 選んだフォルダの事前の問い合わせ。既定は、どのプロジェクトとも関わりの無いフォルダとして答える。
    inspectFolder: vi.fn(async (path: string) => ({ path, git: false, worktree: false, remote: null, registered: null, enclosing: null, link: null })),
    // 未登録の一覧は、新しいセッションのダイアログを開くたびに取りに行くので、どのテストでも空を返す。
    workspaceDirs: vi.fn(async () => []),
    folderCandidates: vi.fn(async () => ({ candidates: [], suggestedRoot: null })),
    workspaceChildren: vi.fn(async (parent: string) => ({ parent, enclosing: null, children: [] })),
    registerFolders: vi.fn(async () => ({ projects: [], failed: [] })),
    promptCommands: vi.fn(async () => []),
    promptFiles: vi.fn(async () => []),
    uploadDrop: vi.fn(async (_file: Blob, name: string) => ({ path: `/h/.agent-hangar/drops/1-0-${name}`, name, size: 0 })),
    existingDrops: vi.fn(async (paths: string[]) => paths),
    usageAggregate: vi.fn(async () => ({ days: [], projects: [] })),
    statusline: vi.fn(async () => ({ command: null, scriptPath: null, installed: false })),
    shellHook: vi.fn(async () => ({ state: 'off' as const, zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: 'hangar shell install' })),
    // 準備の確かめは、起動のたびに取りに行くので、どのテストでも答えを返す。
    readiness: vi.fn(async () => ({
      tools: { tmux: { path: '/opt/homebrew/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: '/Users/me/.local/bin/claude', ok: true, problem: null, version: '2.3.1' }, git: { path: '/usr/bin/git', ok: true, problem: null, version: '2.51.0' }, node: { path: '/opt/homebrew/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
      workspace: { path: '/w', exists: true, projectCount: 1 }, mcp: { registered: false, file: '/Users/me/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
      commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install', join: 'hangar join <token>' },
      compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
    })),
    // 再確認は、使う試験が答えを上書きする。
    recheckMux: vi.fn(async () => unused()),
    compat: vi.fn(async () => ({ verifiedVersion: '2.1.292', localVersion: '2.1.292', drifts: [] })),
    addTodo: vi.fn(async (projectId: string, text: string) => ({ id: 't1', projectId, text, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    setTodoDone: vi.fn(async (id: string, done: boolean) => ({ id, projectId: 'p1', text: 'x', done, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    removeTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    confirmTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: true, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    rejectTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    editTodo: vi.fn(async (id: string, text: string) => ({ id, projectId: 'p1', text, done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    acceptTodo: vi.fn(async (id: string) => ({ id, projectId: 'p1', text: 'x', done: false, position: 1, sessionId: null, updatedAt: 1, candidate: null, suggestion: null })),
    reorderTodos: vi.fn(async () => []),
    restoreTodos: vi.fn(async () => []),
    setSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null } })),
    confirmSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null } })),
    // 返り値は使わない（画面の正は session.upsert）ので、中身の無い応答を返す。
    moveSession: vi.fn(async () => ({}) as Awaited<ReturnType<ApiClient['moveSession']>>),
    deleteSession: vi.fn(async () => ({ ok: true as const })),
    rejectSessionState: vi.fn(async () => ({ state: { status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null } })),
    dismissInterrupted: vi.fn(async () => ({ interrupted: null })),
    dismissOverlap: vi.fn(async () => {}),
    memo: vi.fn(async (projectId: string) => ({ projectId, markdown: '', updatedAt: 0 })),
    saveMemo: vi.fn(async (projectId: string, markdown: string) => ({ projectId, markdown, updatedAt: 2 })),
    instructions: vi.fn(async (projectId: string) => ({ projectId, available: true, files: [] })),
    openInstruction: vi.fn(async () => {}),
    setupGuide: vi.fn(async () => ({ path: '~/.agent-hangar/setup-guide.md', version: '0.7.0', sha: '3f9a1c2e', prompt: '~/.agent-hangar/setup-guide.md（v0.7.0 sha256:3f9a1c2e）を読んで、私の環境を診断して。書き換えは私が承諾してから' })),
    openSetupGuide: vi.fn(async () => {}),
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
    resumeHerePlan: vi.fn(async () => unused()),
    takeoverStart: vi.fn(async () => unused()),
    takeoverExtend: vi.fn(async () => unused()),
    takeoverCancel: vi.fn(async () => {}),
    // 「PC を追加」の参加コード。既定は何も発行していない状態にする。
    joinCodeCurrent: vi.fn(async () => ({ kind: 'idle' as const })),
    joinCodeIssue: vi.fn(async () => ({ kind: 'open' as const, code: 'K7QM-2XFD', expiresAt: 300_000 })),
    joinCodeApprove: vi.fn(async () => ({ kind: 'idle' as const })),
    joinCodeReject: vi.fn(async () => ({ kind: 'idle' as const })),
    joinCodeClose: vi.fn(async () => ({ kind: 'idle' as const })),
    // リカバリーキーの再発行。使う試験が自分で上書きする。
    recoveryKeyReissue: vi.fn(async () => unused()),
    recoveryKeyConfirm: vi.fn(async () => {}),
    cloudDevices: vi.fn(async () => ({ state: 'off' as const, devices: [], creator: false, message: null })),
    // スマホを接続する QR。既定は同期していない端末の答えにする。
    mobilePairing: vi.fn(async () => ({ state: 'not-joined' as const })),
    mobilePaired: vi.fn(async () => ({ paired: null })),
    // 設定の同期（作り直した実装）。既定は何も無い状態で、使うテストが自分で上書きする。
    configSyncState: vi.fn(async () => ({ enabled: false, workerPending: false, approval: 'each' as const, incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null })),
    configOutgoing: vi.fn(async () => ({ enabled: false, items: [], droppedKeys: [], unsentCount: 0, lastSentAt: null })),
    configInbox: vi.fn(async () => ({ items: [], approval: 'each' as const })),
    configConflicts: vi.fn(async () => []),
    configUnsent: vi.fn(async () => ({ items: [] })),
    configBackups: vi.fn(async () => ({ generations: [] })),
    configSendUnsent: vi.fn(async () => ({ items: [] })),
    configPutOrder: vi.fn(async () => ({ createdAt: 1, items: [] })),
    configDeleteOrder: vi.fn(async () => {}),
    retention: vi.fn(async () => ({ days: 30, source: 'default' as const, userValue: null, writable: true, unwritableReason: null, usage: null })),
    retentionPreview: vi.fn(async () => unused()),
    writeRetention: vi.fn(async () => unused()),
    live: vi.fn(async (sessionId: string) => ({ sessionId, turnStartSeq: null, intent: null, agents: [] })),
    sessionFiles: vi.fn(async () => ({ files: [] })),
    // アカウントは既定で 2 件の固定データを返す。切り替えの結果は使うテストが自分で上書きする。
    accounts: vi.fn(async () => accountsFixture),
    setCurrentAccount: vi.fn(async () => accountsFixture),
    switchAccount: vi.fn(async (sessionId: string) => ({ run: { id: 'r-switch', sessionId, deviceId: 'd', kind: 'resume' as const, tmuxName: 'hangar-r-switch', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 }, sessionId, tabs: [{ id: 'r-switch', runId: 'r-switch', sessionId, kind: 'agent' as const, title: 'Claude', tmuxName: 'hangar-r-switch', createdAt: 1, closedAt: null }] })),
    addAccount: vi.fn(async () => accountsFixture),
    previewAccountDir: vi.fn(async (name: string, dir: string) => ({ name, input: dir, dir: dir || `/Users/me/.claude-${name}`, suggested: dir === '', exists: false, conflicts: [], registeredAs: null })),
    updateAccount: vi.fn(async () => accountsFixture),
    removeAccount: vi.fn(async () => accountsFixture),
    loginAccount: vi.fn(async () => undefined),
    cancelAccountLogin: vi.fn(async () => accountsFixture),
    refreshAccount: vi.fn(async () => accountsFixture),
  };
}
