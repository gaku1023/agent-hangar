import { serve } from '@hono/node-server';
import type http from 'node:http';
import path from 'node:path';
import { applySettingsPatch } from '../config/settingsUpdate.ts';
import { listDevices } from '../db/queries.ts';
import { createApp } from '../http/app.ts';
import { promoteSession } from '../projects/promote.ts';
import { nodePtySpawn } from '../pty/nodePty.ts';
import { PtyRelay } from '../pty/relay.ts';
import { sessionRunsAnywhere } from '../runs/announce.ts';
import { resumeHere } from '../sync/resumeHere.ts';
import { guardUpgrades } from '../ws/guard.ts';
import type { DeliveryParts } from './delivery.ts';
import type { HomeParts } from './home.ts';
import type { IndexingParts } from './indexing.ts';
import { VERSION, type StartOptions } from './options.ts';
import { panesOf, tmuxOf, type RunsParts } from './runs.ts';
import type { SummaryParts } from './summary.ts';
import type { SyncParts } from './sync.ts';

/** createApp が返すアプリの fetch。listen した後に差し込むために型だけ取る。 */
type Fetch = ReturnType<typeof createApp>['fetch'];

export type ListeningParts = {
  server: http.Server;
  host: string;
  /** 実際に待ち受けているポート。port: 0 のときは、ここで初めて決まる。 */
  port: number;
  /** 組み上がったアプリを差し込む。差し込むまでは、どの要求にも 503 を返す。 */
  serve(handler: Fetch): void;
  /** 残った keep-alive の接続を切ってから listen を閉じる。WebSocket を畳んだ後に呼ぶ。 */
  stop(): Promise<void>;
};

/**
 * 待ち受けを始める。
 * 実際のポート番号は listen するまで決まらない（port: 0 のとき）。
 * MCP の URL と run の起動はその番号を使うので、先に listen してから app を組み立てて差し込む。
 */
export async function bootListen(opts: Pick<StartOptions, 'port' | 'host'>, home: Pick<HomeParts, 'settings'>): Promise<ListeningParts> {
  const host = opts.host ?? '127.0.0.1';
  let handler: Fetch | null = null;
  const serving: Fetch = (req, env, ctx) => (handler ? handler(req, env, ctx) : new Response('starting', { status: 503 }));
  const server = await new Promise<http.Server>((resolve, reject) => {
    const s = serve({ fetch: serving, port: opts.port ?? 4177, hostname: host }, () => resolve(s as http.Server)) as http.Server;
    s.once('error', reject);
  });
  const addr = server.address();
  const port = addr && typeof addr === 'object' ? addr.port : opts.port ?? 4177;
  // 待ち受けは起動の手続きより先に始まる。/health はこの時点から返るので、ここで一度知らせる。
  console.log(`agent-hangar listening on http://${host}:${port}${home.settings.current.tmuxPath ? '' : '（tmux が見つからないため起動は使えません）'}`);
  return {
    server, host, port,
    serve: (h) => { handler = h; },
    stop: async () => {
      // この順でないと server.close が開いたままの接続を待ち続ける。
      server.closeAllConnections?.();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export type HttpParts = {
  /** 端末の中継を閉じる。 */
  stopRelay(): void;
};

/**
 * HTTP と MCP のアプリを組んで待ち受けに差し込み、WebSocket の経路を結ぶ。
 * ここで作る部品は端末の中継（PtyRelay）だけで、残りは前の関数が作った部品を createApp の依存へ並べる。
 * serverDir は、サーバの入口のファイルがある場所である。UI の置き場所の既定をそこから決める。
 */
export function bootHttp(p: {
  home: HomeParts; delivery: DeliveryParts; sync: SyncParts; indexing: IndexingParts; listening: ListeningParts; runs: RunsParts; summary: SummaryParts;
  opts: Pick<StartOptions, 'uiDist'>; serverDir: string;
}): HttpParts {
  const { home, delivery, sync, indexing, listening, runs, summary } = p;
  const { db, settings, device } = home;
  const { server, port } = listening;
  // 終了した run の Claude のタブには繋がせない。attachTarget がその判断を持つ。
  const relay = new PtyRelay({ token: home.token, port, tmux: tmuxOf(settings.current), resolveTab: (id) => runs.runs.attachTarget(id)?.tmuxName ?? null, spawn: nodePtySpawn });
  // 配布版（Tauri のバンドル）では UI の置き場所を環境変数 HANGAR_UI_DIST で受ける。
  // 入口（main.ts）が読んで消してから opts.uiDist で渡す。無ければリポジトリ内の packages/ui/dist を使う。
  const uiDist = p.opts.uiDist ?? path.resolve(p.serverDir, '../../ui/dist');
  const app = createApp({
    cloudUsage: sync.cloudUsage,
    accounts: runs.accounts,
    db, deviceId: device.id, deviceName: device.name, token: home.token, home: home.home, port, version: VERSION,
    // 最初の索引づけと紐づけが済むまで偽。.app はこれを見て起動画面に残る。
    ready: () => home.life.started,
    settings: () => settings.current,
    updateSettings: (patch) => applySettingsPatch({
      home: home.home, box: settings,
      unconfirmConfigPull: sync.unconfirmConfigPull,
      applyTmux: (s) => { const t = tmuxOf(s); runs.runs.setPanes(panesOf(t)); relay.setTmux(t); },
      onTmuxPath: runs.writeShellScript,
      onClaudePath: () => {
        runs.runs.setClaudeBin(runs.claudeBin());
        summary.rebuildClaude();
        void runs.localClaude.refreshSubcommands();
        void runs.localClaude.refreshVersion();
      },
      onSummaryCap: summary.rebuildClaude,
      publishConfigSync: sync.publishConfigSync,
    }, patch),
    live: () => delivery.registry.current(), indexer: indexing.indexer, hub: delivery.hub, runs: runs.runs, external: runs.external, usage: runs.usage, memos: indexing.memos,
    summary: summary.api,
    promote: (o) => promoteSession({
      db, deviceId: device.id, home: home.home, workspaceRoot: settings.current.workspaceRoot,
      runAlive: (id) => sessionRunsAnywhere({ db, live: () => delivery.registry.current() }, id),
    }, o),
    sync: {
      status: () => sync.engine.status(),
      syncNow: sync.syncNow,
      setPaused: (paused) => sync.engine.setPaused(paused),
      onFocus: () => sync.engine.onFocus(),
      pullBeforeLaunch: (timeoutMs) => sync.engine.pullBeforeLaunch(timeoutMs),
    },
    // 降ろすのを諦めた項目。onError は 1 度しか鳴らないので、状態にも載せて後から見られるようにする。
    syncSkipped: sync.feed.skipped,
    syncSweep: sync.feed.sweep,
    syncOncePass: sync.feed.oncePass,
    resumeHere: (sessionId, overwrite) => resumeHere({ db, home: home.home, claudeDir: home.claudeDir, resume: (id) => runs.runs.resume(id), pruneTranscripts: () => sync.pruneBackups('transcripts') }, sessionId, overwrite),
    configSync: sync.configSync,
    joinToken: sync.joinToken,
    devices: () => listDevices(db, device.id),
    shellHook: runs.shellHook,
    retention: sync.retention,
    readiness: runs.readiness,
    compat: runs.compat,
    uiDist,
  });
  listening.serve(app.fetch);

  delivery.sockets.attach(server, { path: '/ws', token: home.token, port });
  relay.attach(server, '/ws/pty');
  // 経路を握る側は path が違えば黙って返すので、最後に未知の経路を切る番人を置く。
  guardUpgrades(server);
  return { stopRelay: () => relay.close() };
}
