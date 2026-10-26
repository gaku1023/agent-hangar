/**
 * HTTP の試験の組み立ての道具。
 * `testDeps()` が createApp に渡す依存の束（AppDeps）を、試験用の既定で全部組む。
 * 既定は一時ディレクトリの DB とワークスペース、何もしない偽物である。
 * 試験は変えたい項目だけ overrides で渡す。
 * 本番のコードからは読まない。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { LaunchParams, LaunchResultDto, ReadinessDto, ResumeHereConflictDto, RetentionDto, RunDto, ServerEvent, SummarizerTestDto, SyncDiskShortDto, SyncStatusDto, TabDto } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import { VERIFIED_CLAUDE_VERSION } from '../provider/claude-code/compat/version.ts';
import { AccountAuth } from '../provider/claude-code/config/accountAuth.ts';
import { AccountStore } from '../config/accounts.ts';
import { RetentionConflictError } from '../provider/claude-code/config/retention.ts';
import { openDb, type Db } from '../db/open.ts';
import { languageReader } from '../i18n/language.ts';
import { Publisher } from '../events/publisher.ts';
import { IndexerService } from '../indexer/service.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { MemoStore } from '../projects/memo.ts';
import { assignSessions, syncProjectsFromWorkspace } from '../projects/registry.ts';
import { PromoteError } from '../projects/promote.ts';
import { RunError } from '../runs/manager.ts';
import { sessionRunsAnywhere } from '../runs/announce.ts';
import { SessionTrash } from '../sessions/trash.ts';
import { TakeoverService } from '../sync/takeover.ts';
import { UsageTracker } from '../usage/statusline.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import type { AccountsDeps } from './accounts.ts';
import type { AppDeps, ExternalApi, RunsApi, SummaryApi, SummaryEnqueueOpts, SyncApi } from './app.ts';

export const TOKEN = 'test-token';
/** 認証つきの要求の見出し。 */
export const H = { authorization: `Bearer ${TOKEN}` };

export const run: RunDto = { id: 'r1', sessionId: 's1', deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: null, endReason: null, heartbeatAt: 1 };
export const agentTab: TabDto = { id: 'r1', runId: 'r1', sessionId: 's1', kind: 'agent', title: 'Claude', tmuxName: 'hangar-r1', createdAt: 1, closedAt: null };
export const shellTab: TabDto = { id: 't1', runId: 'r1', sessionId: 's1', kind: 'shell', title: 'シェル 1', tmuxName: 'hangar-r1-t1', createdAt: 2, closedAt: null };
export const launched: LaunchResultDto = { run, sessionId: 's1', tabs: [agentTab] };
export const endedRun: RunDto = { ...run, id: 'dead', tmuxName: 'hangar-dead', endedAt: 9, endReason: 'exited' };
export const deadAgentTab: TabDto = { ...agentTab, id: 'dead', runId: 'dead', tmuxName: 'hangar-dead' };
export const deadShellTab: TabDto = { ...shellTab, id: 'dead-t1', runId: 'dead', tmuxName: 'hangar-dead-t1' };
export const testResult: SummarizerTestDto = { ok: true, id: 'lmstudio', ms: 5, summary: { title: 'T', oneLiner: 'O', body: 'B', state: 'done', nextSteps: [], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: null, basedOnTurns: 3 } };
export const syncStatus: SyncStatusDto = { state: 'idle', url: 'https://h', lastPushAt: 100, lastPullAt: 200, pending: 0, error: null, deviceCount: 2, limitedUntil: null, paused: false };
export const READY: ReadinessDto = {
  tools: { tmux: { path: '/bin/tmux', ok: true, problem: null, version: '3.4' }, claude: { path: null, ok: false, problem: 'unset', version: null }, git: { path: '/usr/bin/git', ok: true, problem: null, version: '2.51.0' }, node: { path: '/bin/node', ok: true, problem: null, version: 'v22.9.0', auto: true } },
  workspace: { path: '/w', exists: true, projectCount: 1 }, mcp: { registered: false, file: '/h/.claude.json' }, statusline: { command: null, scriptPath: null, installed: false },
  commands: { mcp: 'hangar mcp install', statusline: 'hangar statusline install', shell: 'hangar shell install', join: 'hangar cloud join <URL>' },
  compat: { verifiedVersion: '2.1.292', localVersion: '2.1.292', driftCount: 0 },
};
export const RET: RetentionDto = { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null };

/** 経路の検査だけをしたいので、RunManager は呼び出しを記録する偽物に差し替える。 */
export function fakeRuns(): RunsApi {
  return {
    start: vi.fn(async (p: LaunchParams): Promise<LaunchResultDto> => { if (!p.projectId) throw new RunError(400, 'プロジェクトを選んでください'); return launched; }),
    resume: vi.fn((id: string): LaunchResultDto => { if (id === 'busy') throw new RunError(409, '実行中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    resumeWith: vi.fn(async (id: string): Promise<LaunchResultDto> => {
      if (id === 'busy') throw new RunError(409, 'busy');
      if (id === 'stray') throw new RunError(409, 'still running', { code: 'stray_process', pid: 4242 });
      return { ...launched, run: { ...run, kind: 'resume' } };
    }),
    fork: vi.fn((): LaunchResultDto => ({ ...launched, sessionId: 's2', run: { ...run, kind: 'fork', sessionId: 's2' } })),
    forkMaterialized: vi.fn(async (): Promise<LaunchResultDto> => ({ ...launched, sessionId: 's2', run: { ...run, kind: 'fork', sessionId: 's2' } })),
    forksMaterialized: vi.fn((): boolean => false),
    attach: vi.fn((id: string): LaunchResultDto => { if (id === 'busy') throw new RunError(409, '実行中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    adopt: vi.fn(async (id: string): Promise<LaunchResultDto> => { if (id === 'busy') throw new RunError(409, '作業中です'); return { ...launched, run: { ...run, kind: 'resume' } }; }),
    kill: vi.fn((id: string): RunDto => { if (id !== 'r1') throw new RunError(404, '起動した Claude が見つかりません'); return { ...run, endedAt: 2, endReason: 'killed' }; }),
    openTab: vi.fn((): TabDto => shellTab),
    closeTab: vi.fn((): TabDto => ({ ...shellTab, closedAt: 3 })),
    listAlive: vi.fn((): { runs: RunDto[]; tabs: TabDto[] } => ({ runs: [run], tabs: [agentTab, shellTab] })),
    getRun: vi.fn((id: string): RunDto | null => (id === 'r1' ? run : id === 'dead' ? endedRun : null)),
    getTab: vi.fn((id: string): TabDto | null => (id === 't1' ? shellTab : id === 'r1' ? agentTab : id === 'dead' ? deadAgentTab : id === 'dead-t1' ? deadShellTab : null)),
    // 終了した run の Claude のタブだけは繋がせない。繋ぎ先の tmux セッションがもう無い。
    attachTarget: vi.fn((id: string): TabDto | null => {
      const t = id === 't1' ? shellTab : id === 'r1' ? agentTab : id === 'dead' ? deadAgentTab : id === 'dead-t1' ? deadShellTab : null;
      return t && t.kind === 'agent' && t.runId === 'dead' ? null : t;
    }),
    jumpToPrompt: vi.fn(async (id: string) => { if (id === 'dead') throw new RunError(409, 'この Claude はもう終了しています'); return { found: true as const }; }),
    leaveTranscript: vi.fn(async () => ({ left: true })),
    assertCanStart: vi.fn(() => {}),
    agentEnabled: vi.fn(() => true),
    cancelPrep: vi.fn(() => false),
    prepareModels: vi.fn(async () => {}),
    startFromTerminal: vi.fn((req: { cwd: string; args: string[] }) => { if (req.args.includes('--session-id')) throw new RunError(400, '--session-id を付けた起動は hangar では開けません'); return { ...launched, attached: false }; }),
    startOpencodeFromTerminal: vi.fn(async () => ({ ...launched, attached: false })),
  };
}

/** 設定のプロバイダーの口の偽物。どれも空の一覧を返す。 */
export function fakeOpencodeProviders(): AppDeps['opencodeProviders'] {
  const empty = async () => ({ connected: [], catalog: [], configPath: '/home/me/.config/opencode/opencode.json' });
  return {
    list: empty, connectKey: empty, disconnect: empty, addModel: empty, addCustom: empty,
    login: async () => ({ attemptId: 'a', url: 'https://example.invalid', instructions: '', mode: 'auto' as const }),
    loginStatus: async () => ({ status: 'pending' as const, message: null }),
    loginComplete: async () => undefined, loginCancel: async () => undefined,
  };
}

export function fakeExternal(): ExternalApi {
  return {
    openTerminal: vi.fn(async () => ({ app: 'terminal' as const, fellBack: false })),
    openDirTerminal: vi.fn(async () => ({ app: 'iterm' as const, fellBack: true })),
    openEditor: vi.fn(async () => {}),
    editors: vi.fn(async () => ({ candidates: [], current: { id: 'vscode' as const, state: 'found' as const, path: '/usr/local/bin/code' } })),
    testEditor: vi.fn(async () => ({ ok: true, via: 'cli' as const, file: '/h/hangar-editor-test.md', message: null })),
    openUrl: vi.fn(async () => {}),
  };
}

export type FakeSummary = SummaryApi & { enqueued: [string, SummaryEnqueueOpts | undefined][] };
export function fakeSummary(): FakeSummary {
  const s: FakeSummary = {
    enqueued: [],
    enqueue: (id, opts) => { s.enqueued.push([id, opts]); return true; },
    pending: () => ['pending-1'],
    test: async () => testResult,
    listModels: async () => ['gemma'],
  };
  return s;
}

export function fakeRetention() {
  return {
    current: vi.fn(() => RET),
    preview: vi.fn((days: number) => ({ days, path: '/c/settings.json', lines: [], baseSha256: 'abc', backupDir: '/h/backups/claude-config', projectedBytes: null })),
    write: vi.fn((days: number, sha: string): RetentionDto => { if (sha === 'stale') throw new RetentionConflictError(); return { ...RET, days, source: 'user', userValue: days }; }),
  };
}

/** 使用量の口。値がまだ無い状態（同期を設定していない端末と同じ）を返す。 */
export const noCloudUsage = (): AppDeps['cloudUsage'] => ({ current: () => null, refresh: async () => null });

/** 試験が途中で書き換える、同期まわりの偽物の状態。偽物の口はこれを毎回読む。 */
export type SyncFakeState = {
  /** 偽物の口が呼ばれた順。経路が本当に部品を呼んだかを見られる。 */
  calls: string[];
  skipped: { key: string; attempts: number; message: string }[];
  sweepPending: number | null;
  oncePass: boolean;
  diskShort?: SyncDiskShortDto | null;
  resumeHereResult: LaunchResultDto | ResumeHereConflictDto;
};

/** testDeps が返す、依存の束と、試験が中身を見たり書き換えたりするための取っ手。 */
export type TestWorld = {
  deps: AppDeps;
  db: Db;
  /** ワークスペースのルート。home も同じ場所である。alpha というフォルダが 1 つある。 */
  ws: string;
  /** 取り込み元の Claude のディレクトリ（フィクスチャの写し）。 */
  claudeDir: string;
  /** 画面へ配られたイベント。経路が渡した知らせと、配る層（events/publisher.ts）が書いた行から組んだ行のイベントが、配られた順に並ぶ。 */
  events: ServerEvent[];
  /** 偽物の口が呼ばれた順（sync.calls と同じ配列）。 */
  calls: string[];
  sync: SyncFakeState;
  /** 頼む側の流れの本物。同期の口（送る、取りに行く）は何もしない偽物で、頼みを運べるかだけ canCarry で切り替える。 */
  takeover: TakeoverService;
  canCarry: { value: boolean };
  runs: RunsApi;
  external: ExternalApi;
  /** 既定の要約の偽物。overrides で summary を差し替えたときは使われない。 */
  summary: FakeSummary;
  usage: UsageTracker;
  memos: MemoStore;
  /** ワークスペースから登録される唯一のプロジェクト alpha の id。 */
  alphaProjectId: () => string;
  /** 配る層を止めて DB を閉じ、作った一時ディレクトリを消す。afterEach で呼ぶ。 */
  dispose: () => void;
};

/**
 * createApp に渡す依存を、試験用の既定で全部組む。
 * フィクスチャの索引を読み込み済みの DB と、alpha を 1 つ持つワークスペースが付く。
 * overrides に渡した項目は、既定の代わりにそのまま入る。
 */
export async function testDeps(overrides: Partial<AppDeps> = {}): Promise<TestWorld> {
  const claudeDir = copyFixtureClaudeDir();
  const db = openDb(':memory:');
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-app-'));
  fs.mkdirSync(path.join(ws, 'alpha'));
  const indexer = new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir }), isRunning: () => false });
  await indexer.fullScan();
  db.prepare('update sessions set cwd = ? where provider_session_id = ?').run(path.join(ws, 'alpha'), SESSION_ALPHA);
  syncProjectsFromWorkspace(db, 'd', ws); assignSessions(db, 'd');

  const events: ServerEvent[] = [];
  // 行の変化を配る層。経路は行を書くだけで、画面へのイベントはこの層が組んで events へ渡す（tick の終わりに出る）。
  const publisher = new Publisher({ db, deviceId: 'd', live: () => [], hub: { broadcast: (e) => { events.push(e); } } });
  const sync: SyncFakeState = { calls: [], skipped: [], sweepPending: null, oncePass: false, resumeHereResult: launched };
  let settings: Settings = { workspaceRoot: ws, claudeDir, tmuxPath: null, terminalApp: 'terminal', editor: { id: 'vscode', path: null, fileCmd: '', dirCmd: '', terminal: 'none' }, summaryEngine: 'off', summaryClaudeModel: 'haiku', lmStudioUrl: 'http://127.0.0.1:1234', lmStudioModel: null, summaryApiKey: null, summaryFallback: false, summaryHourlyCap: 20, allowExternalSummarizer: false, nodePath: null, claudePath: null };
  const runs = fakeRuns();
  const external = fakeExternal();
  const usage = new UsageTracker(db);
  const memos = new MemoStore({ db, deviceId: 'd', home: ws });
  const summary = fakeSummary();
  const alphaProjectId = () => (db.prepare("select id from projects where name = 'alpha'").get() as { id: string }).id;
  // 最初のアカウントだけを持つアカウントの口。サーバはいつもアカウントの口を持つので、既定でも渡す。
  const accounts: AccountsDeps = {
    db, store: new AccountStore({ home: ws, primaryDir: claudeDir, homeDir: ws }), primaryDir: claudeDir, usage,
    auth: new AccountAuth({ claudeBin: () => null }),
    runs: { switchAccount: vi.fn() } as unknown as AccountsDeps['runs'],
    broadcast: (a) => events.push({ type: 'accounts.update', accounts: a }),
  };
  const canCarry = { value: true };
  const takeover = new TakeoverService({
    db, deviceId: 'd', canCarry: () => canCarry.value, pushNow: async () => {}, pull: async () => {},
    broadcast: (dto) => publisher.broadcast({ type: 'takeover.update', takeover: dto }),
  });
  const syncApi: SyncApi = {
    status: () => syncStatus,
    syncNow: async () => { sync.calls.push('syncNow'); },
    setPaused: (p: boolean) => { sync.calls.push(`pause:${p}`); },
    onFocus: async () => { sync.calls.push('focus'); },
    pullBeforeLaunch: async () => { sync.calls.push('beforeLaunch'); return true; },
  };
  const deps: AppDeps = {
    db, deviceId: 'd', deviceName: 'mac', token: TOKEN, home: ws, port: 4177, version: '0.0.0-test',
    settings: () => settings, language: languageReader(() => settings), updateSettings: (p) => (settings = { ...settings, ...p }),
    live: () => [], indexer, ready: () => true,
    hub: publisher,
    runs, external, usage, memos, summary,
    // 本物の削除に、偽のゴミ箱（ワークスペースの .test-trash へ移すだけ）を渡す。
    trash: new SessionTrash({
      db, deviceId: 'd', claudeDir, remoteRoot: path.join(ws, 'remote'),
      trash: async (p) => { const bin = path.join(ws, '.test-trash'); fs.mkdirSync(bin, { recursive: true }); fs.renameSync(p, path.join(bin, path.basename(p))); },
      runsAnywhere: (id) => sessionRunsAnywhere({ db, deviceId: 'd', live: () => [] }, id),
      runsHere: () => false,
      log: () => {},
    }),
    promote: (o) => { if (o.name === 'taken') throw new PromoteError(409, 'あります'); return { projectId: alphaProjectId(), moved: o.moveFiles, reason: null }; },
    // git を呼ばない。
    gitInit: () => {},
    sync: syncApi,
    cloudUsage: noCloudUsage(),
    accounts,
    syncSkipped: () => sync.skipped,
    syncSweep: () => sync.sweepPending,
    syncOncePass: () => sync.oncePass,
    syncDiskShort: () => sync.diskShort ?? null,
    takeover,
    resumeHere: (id: string, overwrite: boolean) => { sync.calls.push(`resumeHere:${id}:${overwrite}`); return sync.resumeHereResult; },
    configBundle: null,
    joinApprover: () => null,
    recoveryKey: () => null,
    devices: () => [{ id: 'd', name: 'mac', platform: 'darwin', lastSeenAt: 1, self: true, shell: null }],
    cloudDevices: async () => ({ state: 'off' as const, devices: [], creator: false, message: null }),
    shellHook: () => ({ state: 'off' as const, zshrc: '/Users/me/.zshrc', line: 'x  # agent-hangar', command: 'hangar shell install' }),
    retention: fakeRetention(),
    readiness: async () => READY,
    // 「Node のパス」の確かめ。既定ではどのファイルも同梱のサーバと同じ Node と答える（偽の道具を Node として保存できるように）。
    nodeCheck: { need: () => ({ napi: 10, min: '22.14', arch: 'x64' }), probe: async () => ({ version: '22.14.0', napi: 10, arch: 'x64' }) },
    findMux: () => null,
    compat: async () => ({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: null, drifts: [] }),
    opencodeStatus: async () => ({ found: false, version: null, verified: false }),
    codexStatus: async () => ({ found: false, version: null, verified: false, loggedIn: false }),
    opencodeOptions: async () => ({ version: '2.1.4', verified: true, modes: [{ id: 'build', description: null }, { id: 'plan', description: null }], models: [], providers: [], defaultModel: null, pricesAt: null, fetchedAt: 0, stale: false }),
    opencodeProviders: fakeOpencodeProviders(),
    uiDist: null,
    ...overrides,
  };

  return {
    deps, db, ws, claudeDir, events, calls: sync.calls, sync, takeover, canCarry, runs, external, summary, usage, memos, alphaProjectId,
    dispose: () => { takeover.stop(); publisher.stop(); db.close(); fs.rmSync(claudeDir, { recursive: true, force: true }); fs.rmSync(ws, { recursive: true, force: true }); },
  };
}
