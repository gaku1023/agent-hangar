import { serve } from '@hono/node-server';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type Settings } from './config/paths.ts';
import { openDb } from './db/open.ts';
import { getSession, listProjects } from './db/queries.ts';
import { createApp } from './http/app.ts';
import { IndexerService } from './indexer/service.ts';
import { assignSessions, checkProjectRoots, syncProjectsFromWorkspace } from './projects/registry.ts';
import { RegistryWatcher } from './provider/claude-code/registry.ts';
import { EventHub } from './ws/hub.ts';

export const VERSION = '0.1.0';

const ROOT_CHECK_MS = 30_000;

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
 * DB、索引、実行中セッションの監視、HTTP と WebSocket をまとめて起動する。
 * ~/.claude は読むだけで、書き込みは home 配下に限る。
 */
export async function startServer(opts: StartOptions = {}): Promise<{ close(): Promise<void>; port: number }> {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  const device = readOrCreateDevice(home);
  let settings: Settings = loadSettings(home);
  const claudeDir = opts.claudeDir ?? (settings.claudeDir || defaultClaudeDir());
  const db = openDb(dbPath(home));
  const hub = new EventHub(VERSION);
  const registry = new RegistryWatcher(claudeDir);
  const indexer = new IndexerService({ db, deviceId: device.id, claudeDir, isRunning: (id) => registry.current().some((l) => l.sessionId === id) });

  indexer.on({
    progress: (p) => hub.broadcast({ type: 'index.progress', progress: p }),
    sessionChanged: (e) => {
      const s = getSession(db, registry.current(), e.sessionId);
      if (!s) return;
      hub.broadcast({ type: 'session.upsert', session: s });
      if (e.appended > 0) hub.broadcast({ type: 'transcript.appended', sessionId: e.sessionId, count: e.appended });
    },
    error: (e) => console.error('[indexer]', e.path, e.message),
  });
  registry.onChange((live) => {
    hub.broadcast({ type: 'live.update', live });
    for (const p of listProjects(db, device.id, live)) hub.broadcast({ type: 'project.upsert', project: p });
  });

  const uiDist = opts.uiDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ui/dist');
  const app = createApp({
    db, deviceId: device.id, deviceName: device.name, token, home, version: VERSION,
    settings: () => settings,
    updateSettings: (patch) => { settings = { ...settings, ...patch }; saveSettings(home, settings); return settings; },
    live: () => registry.current(), indexer, hub, uiDist,
  });

  const host = opts.host ?? '127.0.0.1';
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = serve({ fetch: app.fetch, port: opts.port ?? 4177, hostname: host }, () => resolve(s as http.Server)) as http.Server;
    s.once('error', reject);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : opts.port ?? 4177;
  hub.attach(server, { path: '/ws', token });

  registry.start();
  await indexer.start();
  syncProjectsFromWorkspace(db, device.id, settings.workspaceRoot);
  assignSessions(db, device.id);
  const notifyUnresolved = () => { for (const id of checkProjectRoots(db, device.id).unresolved) hub.broadcast({ type: 'project.unresolved', projectId: id }); };
  notifyUnresolved();
  const rootTimer = setInterval(notifyUnresolved, ROOT_CHECK_MS);
  rootTimer.unref();

  console.log(`agent-hangar listening on http://${host}:${port}`);
  return {
    port,
    close: async () => {
      clearInterval(rootTimer);
      indexer.stop();
      registry.stop();
      // WebSocket を先に畳み、残った keep-alive の接続を切ってから listen を閉じる。
      // この順でないと server.close が開いたままの接続を待ち続ける。
      await hub.close();
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
      db.close();
    },
  };
}
