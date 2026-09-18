import { serve } from '@hono/node-server';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { resolveToolPaths } from './config/tools.ts';
import { openDb } from './db/open.ts';
import { getProject, getSession, listProjects } from './db/queries.ts';
import { openDirInTerminalApp, openInEditor, openInTerminalApp } from './external/open.ts';
import { createApp, type ExternalApi } from './http/app.ts';
import { writeBaselineIfNeeded } from './indexer/baseline.ts';
import { IndexerService } from './indexer/service.ts';
import { ensureWrapperScript } from './launch/wrapper.ts';
import { assignSession, assignSessions, checkProjectRoots, syncProjectsFromWorkspace } from './projects/registry.ts';
import { RegistryWatcher } from './provider/claude-code/registry.ts';
import { ensureSpawnHelper } from './pty/helper.ts';
import { nodePtySpawn } from './pty/nodePty.ts';
import { PtyRelay } from './pty/relay.ts';
import { RunManager } from './runs/manager.ts';
import { Tmux } from './tmux/tmux.ts';
import { EventHub } from './ws/hub.ts';

export const VERSION = '0.2.0';

const ROOT_CHECK_MS = 30_000;

/**
 * WebSocket の upgrade を受け付ける経路。
 * ここに無い経路は番人が切る。attach する側とこの集合が食い違うと、
 * 101 を返した直後の接続を番人が切ってしまうので、定数を正本にして両方から参照する。
 */
export const WS_PATHS = new Set(['/ws', '/ws/pty']);
/** tmux の一覧を見て run の終了を拾う間隔。 */
const RUN_POLL_MS = 2000;

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
      }
      if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended });
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
    // hangar の外で動いている Claude を再開すると二重起動になるので、レジストリを見て弾く。
    isLive: (providerSessionId) => registry.current().some((l) => l.sessionId === providerSessionId),
  });
  // 終了した run の Claude のタブには繋がせない。attachTarget がその判断を持つ。
  const relay = new PtyRelay({ token, tmux: tmuxOf(settings), resolveTab: (id) => runs.attachTarget(id)?.tmuxName ?? null, spawn: nodePtySpawn });

  runs.on({
    runStarted: (r) => {
      hub.broadcast({ type: 'run.started', run: r.run, tabs: r.tabs });
      const s = getSession(db, registry.current(), r.sessionId);
      if (s) hub.broadcast({ type: 'session.upsert', session: s });
    },
    runUpdated: (run) => hub.broadcast({ type: 'run.upsert', run }),
    runEnded: (run) => hub.broadcast({ type: 'run.ended', run }),
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
      return settings;
    },
    live: () => registry.current(), indexer, hub, runs, external, uiDist,
  });
  handler = app.fetch;

  hub.attach(server, { path: '/ws', token });
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
  const notifyUnresolved = () => { for (const id of checkProjectRoots(db, device.id).unresolved) hub.broadcast({ type: 'project.unresolved', projectId: id }); };
  notifyUnresolved();
  const rootTimer = setInterval(notifyUnresolved, ROOT_CHECK_MS);
  rootTimer.unref();
  // 前回の終了時に生きていた run のうち、tmux セッションが残っていないものを lost で閉じる。
  const lost = runs.recoverAtStartup();
  if (lost.length) console.log(`[runs] tmux セッションの無い run を ${lost.length} 件 lost で閉じました`);
  runs.startPolling(RUN_POLL_MS);

  console.log(`agent-hangar listening on http://${host}:${port}${settings.tmuxPath ? '' : '（tmux が見つからないため起動は使えません）'}`);
  return {
    port,
    close: async () => {
      clearInterval(rootTimer);
      runs.stop();
      indexer.stop();
      registry.stop();
      relay.close();
      // WebSocket を先に畳み、残った keep-alive の接続を切ってから listen を閉じる。
      // この順でないと server.close が開いたままの接続を待ち続ける。
      await hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
