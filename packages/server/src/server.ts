import { serve } from '@hono/node-server';
import { execFile } from 'node:child_process';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listArtifacts } from './artifacts/queries.ts';
import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { resolveToolPaths, which } from './config/tools.ts';
import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { openDb, type Db } from './db/open.ts';
import { getProject, getSession, listProjects } from './db/queries.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './external/open.ts';
import { createApp, type ExternalApi } from './http/app.ts';
import { writeBaselineIfNeeded } from './indexer/baseline.ts';
import { IndexerService } from './indexer/service.ts';
import { ensureWrapperScript } from './launch/wrapper.ts';
import { MemoStore } from './projects/memo.ts';
import { promoteSession } from './projects/promote.ts';
import { assignSession, assignSessions, checkProjectRoots, syncProjectsFromWorkspace } from './projects/registry.ts';
import { ensureScratchProject } from './projects/scratch.ts';
import { RegistryWatcher } from './provider/claude-code/registry.ts';
import { ensureSpawnHelper } from './pty/helper.ts';
import { nodePtySpawn } from './pty/nodePty.ts';
import { PtyRelay } from './pty/relay.ts';
import { RunManager } from './runs/manager.ts';
import { aliveRunForSession } from './runs/queries.ts';
import { ClaudeHeadlessSummarizer } from './summary/claude.ts';
import { SummaryJob } from './summary/job.ts';
import { LmStudioSummarizer } from './summary/lmstudio.ts';
import type { Summarizer } from './summary/types.ts';
import { Tmux } from './tmux/tmux.ts';
import { UsageTracker } from './usage/statusline.ts';
import { EventHub } from './ws/hub.ts';

export const VERSION = '0.3.0';

const ROOT_CHECK_MS = 30_000;

/**
 * WebSocket の upgrade を受け付ける経路。
 * ここに無い経路は番人が切る。attach する側とこの集合が食い違うと、
 * 101 を返した直後の接続を番人が切ってしまうので、定数を正本にして両方から参照する。
 */
export const WS_PATHS = new Set(['/ws', '/ws/pty']);
/** tmux の一覧を見て run の終了を拾う間隔。 */
const RUN_POLL_MS = 2000;

/**
 * run が終わったときの要約の受け付け方。
 * RunManager.kill は tmux kill-session の直後に同期で runEnded を出すが、
 * レジストリは ~/.claude/sessions を 500 ミリ秒周期で読んだキャッシュなので、
 * その瞬間は必ず「生きている」と出て受理を断ってしまう。
 * run の終了はこちらが知っているので、生存判定だけを飛ばす。
 * 土台かどうかと 5 ターンの判定は残す。
 */
export const RUN_ENDED_SUMMARY_OPTS = { ignoreLive: true } as const;

/**
 * close が要約のジョブを待つ上限。
 * 要約は DB に書き込むので、待たずに閉じると閉じた DB に触れることになる。
 * 一方で待ちに上限が無いと、応答しない要約器に終了が引きずられる。
 * LM Studio の 1 件はおおむね数秒で終わるので 5 秒あればたいてい待ち切れ、
 * それでも終わらないときは諦めて閉じる（SummaryJob は書き込みの失敗を summary.failed に流す）。
 */
export const CLOSE_SUMMARY_WAIT_MS = 5_000;

/**
 * この端末のルートの存在を確かめ、消えたものを知らせ、戻ったものの取りこぼしを拾う。
 * ルートが消えている間に現れたセッションは、解決済みのルートに当たらないので未分類のまま残る。
 * 戻ったときに紐づけ直さないと、次の起動まで未分類のままになり、プロジェクトにも出てこない。
 * 戻ったルートが無いときは何もしない。起動時の 1 回目はたいていこちらを通るので、全件を舐めない。
 * 消えたものの検出と project.unresolved の配信は前のままである。
 */
export function checkRoots(o: { db: Db; deviceId: string; live: () => LiveSessionDto[]; broadcast: (ev: ServerEvent) => void }): { unresolved: string[]; recovered: string[] } {
  const r = checkProjectRoots(o.db, o.deviceId);
  for (const id of r.unresolved) o.broadcast({ type: 'project.unresolved', projectId: id });
  if (r.recovered.length === 0) return r;
  const unassigned = (o.db.prepare('select id from sessions where project_id is null and deleted_at is null').all() as { id: string }[]).map((x) => x.id);
  assignSessions(o.db, o.deviceId);
  const live = o.live();
  // 戻ったプロジェクトと、紐づけ直しで中身が変わったプロジェクトを配る。
  const touched = new Set(r.recovered);
  for (const id of unassigned) {
    const s = getSession(o.db, live, id);
    if (!s?.projectId) continue;
    touched.add(s.projectId);
    o.broadcast({ type: 'session.upsert', session: s });
  }
  for (const id of touched) {
    const p = getProject(o.db, o.deviceId, live, id);
    if (p) o.broadcast({ type: 'project.upsert', project: p });
  }
  return r;
}

/** 要約のジョブが空になるまで待つ。上限までに空になれば真、諦めたら偽を返す。 */
export function waitForSummaryIdle(job: { idle(): Promise<void> }, ms: number = CLOSE_SUMMARY_WAIT_MS): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    job.idle().then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); timer.unref?.(); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

/** createApp が返すアプリの fetch。listen した後に差し込むために型だけ取る。 */
type Fetch = ReturnType<typeof createApp>['fetch'];

export type StartOptions = {
  /** 0 を渡すと空いているポートを使い、実際の番号を返り値の port に入れる。 */
  port?: number;
  host?: string;
  home?: string;
  /** 設定ファイルより優先する Claude Code のディレクトリ。テストがフィクスチャの複製を指すために使う。 */
  claudeDir?: string;
  uiDist?: string;
};

/**
 * DB、索引、実行中セッションの監視、run の管理、HTTP と WebSocket をまとめて起動する。
 * ~/.claude は読むだけで、書き込みは home 配下に限る。
 */
export async function startServer(opts: StartOptions = {}): Promise<{ close(): Promise<void>; port: number }> {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  const device = readOrCreateDevice(home);
  // tmux と code のパスが設定に無ければここで探して書き戻す。GUI 起動の貧弱な PATH でも見つけられる。
  let settings: Settings = resolveToolPaths(loadSettings(home));
  saveSettings(home, settings);
  ensureWrapperScript(home);
  const fixed = ensureSpawnHelper();
  if (fixed.length) console.log('[pty] spawn-helper に実行権限を付けました:', fixed.join(', '));

  const claudeDir = opts.claudeDir ?? (settings.claudeDir || defaultClaudeDir());
  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  const registry = new RegistryWatcher(claudeDir);
  const indexer = new IndexerService({ db, deviceId: device.id, claudeDir, isRunning: (id) => registry.current().some((l) => l.sessionId === id) });

  // 起動の途中かどうか。最初の全走査では未分類のセッションを数えきれないほど流すので、知らせるのは起動後だけにする。
  let started = false;
  // 未分類だと知らせたセッション。本文が伸びるたびに同じ知らせを出さないために持つ。
  const toldUnassigned = new Set<string>();
  /**
   * どのルートの配下でもない cwd のセッションは「未分類」に残る（設計どおり）。
   * ただし黙って残ると利用者は気付けないので、セッションごとに 1 度だけ知らせる。
   * ここで勝手にプロジェクトを作ることはしない。紐づけは利用者が決める。
   */
  const tellUnassigned = (sessionId: string, cwd: string): void => {
    if (!started || toldUnassigned.has(sessionId)) return;
    toldUnassigned.add(sessionId);
    hub.broadcast({ type: 'toast', level: 'info', message: `どのプロジェクトにも属さないセッションが現れました（${cwd}）。未分類のまま置いてあります` });
  };

  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    sessionChanged: (e) => {
      // 起動後に現れたセッションは project_id が空のままなので、ここで紐づけてから配る。
      const row = db.prepare('select project_id from sessions where id = ?').get(e.sessionId) as { project_id: string | null } | undefined;
      const assigned = row && row.project_id === null ? assignSession(db, device.id, e.sessionId) : null;
      const s = getSession(db, registry.current(), e.sessionId);
      if (!s) return;
      hub.broadcast({ type: 'session.upsert', session: s });
      if (assigned) {
        const p = getProject(db, device.id, registry.current(), assigned);
        if (p) hub.broadcast({ type: 'project.upsert', project: p });
      } else if (row && row.project_id === null) {
        tellUnassigned(e.sessionId, s.cwd);
      }
      if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended });
      // 索引化が拾ったアーティファクトを配る。
      for (const a of listArtifacts(db, { ids: e.artifactIds })) hub.broadcast({ type: 'artifact.upsert', artifact: a });
    },
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  // 実行中だったセッションの id。出入りを見て土台の要約の状態を書き替えるために持つ。
  let liveIds = new Set<string>();
  const sessionIdOf = (providerSessionId: string): string | null =>
    (db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ?").get(providerSessionId) as { id: string } | undefined)?.id ?? null;
  registry.onChange((live) => {
    hub.broadcast({ type: 'live.update', live });
    // Claude の最後の書き込みは登録ファイルの削除より前に起きるので、索引の側では終了に気付けない。
    // 出入りしたセッションだけ、ここで土台の要約を書き直す。
    const now = new Set(live.map((l) => l.sessionId));
    const moved = [...new Set([...now, ...liveIds])].filter((id) => now.has(id) !== liveIds.has(id));
    liveIds = now;
    for (const providerSessionId of moved) {
      const sessionId = sessionIdOf(providerSessionId);
      if (!sessionId) continue;
      writeBaselineIfNeeded(db, sessionId, device.id, now.has(providerSessionId));
      const s = getSession(db, live, sessionId);
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    }
    for (const p of listProjects(db, device.id, live)) hub.broadcast({ type: 'project.upsert', project: p });
    // hangar が起こした run に Claude の pid を書き込むのはここだけである。
    runs.linkRegistry(live);
  });

  const host = opts.host ?? '127.0.0.1';
  // 実際のポート番号は listen するまで決まらない（port: 0 のとき）。
  // MCP の URL と run の起動はその番号を使うので、先に listen してから app を組み立てて差し込む。
  let handler: Fetch | null = null;
  const serving: Fetch = (req, env, ctx) => (handler ? handler(req, env, ctx) : new Response('starting', { status: 503 }));
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = serve({ fetch: serving, port: opts.port ?? 4177, hostname: host }, () => resolve(s as http.Server)) as http.Server;
    s.once('error', reject);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : opts.port ?? 4177;

  const tmuxOf = (s: Settings): Tmux | null => (s.tmuxPath ? new Tmux({ tmuxPath: s.tmuxPath }) : null);
  const runs = new RunManager({
    db, deviceId: device.id, home, tmux: tmuxOf(settings), port, token,
    claudeBin: process.env.HANGAR_CLAUDE_BIN ?? 'claude',
    // 起動に失敗した run の後始末で、本文の jsonl があるかを実体で確かめるために要る。
    claudeDir,
    // hangar の外で動いている Claude を再開すると二重起動になるので、レジストリを見て弾く。
    isLive: (providerSessionId) => registry.current().some((l) => l.sessionId === providerSessionId),
  });
  const usage = new UsageTracker(db);
  const memos = new MemoStore({ db, deviceId: device.id, home });
  const claudeBin = process.env.HANGAR_CLAUDE_BIN ?? which('claude');
  // Claude への切り替えの件数はプロセスの寿命で数えるので、要約器はここで 1 度だけ作り、
  // 設定の変更は列の組み立てで反映する。毎回作り直すと 1 時間の窓が空になる。
  const claudeSummarizer = () => new ClaudeHeadlessSummarizer({ claudeBin, hourlyCap: settings.summaryHourlyCap, usage: () => usage.current() });
  let claude = claudeSummarizer();
  const summarizers = (): Summarizer[] => {
    const list: Summarizer[] = [new LmStudioSummarizer({ baseUrl: settings.lmStudioUrl, model: settings.lmStudioModel })];
    if (settings.summaryFallback) list.push(claude);
    return list;
  };
  const summary = new SummaryJob({ db, deviceId: device.id, summarizers, live: () => registry.current(), hub });

  // 終了した run の Claude のタブには繋がせない。attachTarget がその判断を持つ。
  const relay = new PtyRelay({ token, port, tmux: tmuxOf(settings), resolveTab: (id) => runs.attachTarget(id)?.tmuxName ?? null, spawn: nodePtySpawn });

  runs.on({
    runStarted: (r) => {
      hub.broadcast({ type: 'run.started', run: r.run, tabs: r.tabs });
      const s = getSession(db, registry.current(), r.sessionId);
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    },
    runUpdated: (run) => hub.broadcast({ type: 'run.upsert', run }),
    // run が終わったときは事後要約の契機になる。受け付けの可否は SummaryJob が決める。
    runEnded: (run) => { hub.broadcast({ type: 'run.ended', run }); summary.enqueue(run.sessionId, RUN_ENDED_SUMMARY_OPTS); },
    tabChanged: (tab) => hub.broadcast({ type: 'tab.upsert', tab }),
  });

  // 設定は書き替わるので、外部連携は呼ばれた時点の settings を読む。
  const external: ExternalApi = {
    openTerminal: ({ tmuxName }) => {
      if (!settings.tmuxPath) throw new Error('tmux が見つかりません。Settings で tmuxPath を設定してください');
      return openInTerminalApp({ home, tmuxPath: settings.tmuxPath, tmuxName, app: settings.terminalApp });
    },
    openDirTerminal: ({ dir }) => openDirInTerminalApp({ home, dir, app: settings.terminalApp }),
    openEditor: ({ target }) => openInEditor({ codePath: settings.codePath, target }),
    openUrl: (url) => new Promise<void>((resolve, reject) => execFile('open', [url], (err) => (err ? reject(err) : resolve()))),
  };

  const uiDist = opts.uiDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
  const app = createApp({
    db, deviceId: device.id, deviceName: device.name, token, home, port, version: VERSION,
    settings: () => settings,
    updateSettings: (patch) => {
      settings = { ...settings, ...patch };
      saveSettings(home, settings);
      // tmuxPath が変われば、これから起こす run も新しい attach も新しいパスを使う。
      const t = tmuxOf(settings);
      runs.setTmux(t);
      relay.setTmux(t);
      // 上限だけは要約器が内側に持つので、変わったときに作り直す。
      if (patch.summaryHourlyCap !== undefined) claude = claudeSummarizer();
      return settings;
    },
    live: () => registry.current(), indexer, hub, runs, external, usage, memos,
    summary: {
      enqueue: (id, opts) => summary.enqueue(id, opts),
      pending: () => summary.pending(),
      test: () => summary.test(),
      // 一覧は設定のモデルに依らないので、その場限りの問い合わせ用に作る。
      listModels: () => new LmStudioSummarizer({ baseUrl: settings.lmStudioUrl, model: null }).listModels(),
    },
    promote: (o) => promoteSession({
      db, deviceId: device.id, home, workspaceRoot: settings.workspaceRoot,
      // hangar の run だけでなく、hangar の外で動いている Claude も「実行中」と見なす。
      runAlive: (id) => {
        if (aliveRunForSession(db, id) !== null) return true;
        const s = db.prepare('select provider_session_id p from sessions where id = ?').get(id) as { p: string } | undefined;
        return !!s && registry.current().some((l) => l.sessionId === s.p);
      },
    }, o),
    uiDist,
  });
  handler = app.fetch;

  hub.attach(server, { path: '/ws', token, port });
  relay.attach(server, '/ws/pty');
  // 経路を握る側は path が違えば黙って返すので、最後に未知の経路を切る番人を置く。
  // upgrade を受けた時点でこの接続は HTTP 側の管理から外れるため、誰も引き取らないと相手が待ち続ける。
  server.on('upgrade', (req, socket) => {
    if (!WS_PATHS.has(new URL(req.url ?? '/', 'http://x').pathname)) socket.destroy();
  });

  registry.start();
  liveIds = new Set(registry.current().map((l) => l.sessionId));
  await indexer.start();
  syncProjectsFromWorkspace(db, device.id, settings.workspaceRoot);
  assignSessions(db, device.id);
  ensureScratchProject(db, device.id, home);
  // メモは DB とファイルの両方にある。起動時に食い違いを直し、以後はファイルの外部編集を監視で取り込む。
  for (const m of memos.reconcileAll()) hub.broadcast({ type: 'memo.update', memo: m });
  const stopMemoWatch = memos.watch((m) => {
    hub.broadcast({ type: 'memo.update', memo: m });
    const p = listProjects(db, device.id, registry.current()).find((x) => x.id === m.projectId);
    if (p) hub.broadcast({ type: 'project.upsert', project: p });
  });
  const checkRootsNow = () => checkRoots({ db, deviceId: device.id, live: () => registry.current(), broadcast: (ev) => hub.broadcast(ev) });
  checkRootsNow();
  const rootTimer = setInterval(checkRootsNow, ROOT_CHECK_MS);
  rootTimer.unref();
  // 前回の終了時に生きていた run のうち、tmux セッションが残っていないものを lost で閉じる。
  const lost = runs.recoverAtStartup();
  if (lost.length) console.log(`[runs] tmux セッションの無い run を ${lost.length} 件 lost で閉じました`);
  runs.startPolling(RUN_POLL_MS);
  // ここまでで既存のセッションの紐づけは済んでいる。以後に現れた未分類だけを知らせる。
  started = true;

  console.log(`agent-hangar listening on http://${host}:${port}${settings.tmuxPath ? '' : '（tmux が見つからないため起動は使えません）'}`);
  return {
    port,
    close: async () => {
      clearInterval(rootTimer);
      stopMemoWatch();
      runs.stop();
      indexer.stop();
      registry.stop();
      relay.close();
      // WebSocket を先に畳み、残った keep-alive の接続を切ってから listen を閉じる。
      // この順でないと server.close が開いたままの接続を待ち続ける。
      await hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      // 走っている要約は DB に書き込む。閉じた DB に触れさせないよう、ここで待ち切ってから閉じる。
      // 新しい受け付けは HTTP も run の終了も止まった後なので、待ち行列はもう増えない。
      if (!(await waitForSummaryIdle(summary, CLOSE_SUMMARY_WAIT_MS))) {
        console.warn(`[summary] 要約の終了を ${CLOSE_SUMMARY_WAIT_MS} ミリ秒待ちましたが終わらないので、待たずに閉じます`);
      }
      db.close();
    },
  };
}
