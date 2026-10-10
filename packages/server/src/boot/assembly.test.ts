import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunDto, ServerEvent } from '@agent-hangar/shared';
import type { NoticeEvent } from '../events/publisher.ts';
import { ensureSession } from '../indexer/indexFile.ts';
import { mangleCwd } from '../provider/claude-code/discover.ts';
import type { RunListener } from '../runs/manager.ts';
import { toastVia } from '../sync/notices.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { bootDelivery } from './delivery.ts';
import { bootHome, type HomeParts } from './home.ts';
import { bootListen } from './http.ts';
import { bootIndexing } from './indexing.ts';
import type { RunsParts } from './runs.ts';
import { bootSummary } from './summary.ts';
import { bootSync } from './sync.ts';

/**
 * 組み立て関数のうち、配る層、索引、要約、待ち受けを、1 つずつ起こして確かめる。
 * 置き場（home.test.ts）、同期（sync.test.ts）、run（runs.test.ts）は、それぞれの試験にある。
 * 全部を結んだ確かめは、全体を起動する試験（src/server.test.ts）にある。
 */

/** 見本の登録の pid は実在しない。Windows の既定は動いていない pid の登録を読まないので、試験では全部読ませる。 */
const ALL_ALIVE = (): boolean => false;

let home: string;
let claudeDir: string;
let ws: string;
let prevClaudeBin: string | undefined;
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
  ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-')));
  prevClaudeBin = process.env.HANGAR_CLAUDE_BIN;
  process.env.HANGAR_CLAUDE_BIN = path.join(home, 'no-claude');
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  if (prevClaudeBin === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prevClaudeBin;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

const homeParts = (): HomeParts => {
  const h = bootHome({ home, claudeDir });
  cleanups.push(() => h.stop());
  return h;
};

/** 実際の Claude Code と同じ配置で、発言 1 つだけの本文ファイルを置く。 */
function writeTranscript(cwd: string, sessionId: string, text: string): void {
  const dir = path.join(claudeDir, 'projects', mangleCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd, sessionId };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
}

describe('配る層と実行中の一覧の組み立て', () => {
  it('実行中の一覧は作るだけで、読み始めるのは起動の手続きである', () => {
    const h = homeParts();
    const d = bootDelivery(h, { registryIsGone: ALL_ALIVE });
    cleanups.push(async () => { d.registry.stop(); await d.stopPublishing(); d.compatLog.stop(); });
    expect(d.registry.current()).toEqual([]);
    d.registry.start();
    // 見本の登録ファイルが alpha を実行中にしている。
    expect(d.registry.current().map((l) => l.sessionId)).toEqual([SESSION_ALPHA]);
    expect(d.claudeVersion.current).toBeNull();
  });

  it('知らせは配る層を通る。受け手がいなくても落ちず、止めるときは出し切ってから畳む', async () => {
    const h = homeParts();
    const d = bootDelivery(h);
    cleanups.push(() => { d.compatLog.stop(); });
    expect(d.hub).toBe(d.publisher);
    expect(() => d.toast('info', '知らせ')).not.toThrow();
    expect(d.sockets.clientCount()).toBe(0);
    await expect(d.stopPublishing()).resolves.toBeUndefined();
  });
});

describe('索引とプロジェクトの組み立て', () => {
  const boot = () => {
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
    const h = homeParts();
    const d = bootDelivery(h, { registryIsGone: ALL_ALIVE });
    const sent: NoticeEvent[] = [];
    const hub = { broadcast: (ev: NoticeEvent) => { sent.push(ev); } };
    const sync = bootSync(h, { hub, toast: toastVia(hub) }, { memoPath: (id) => indexing.memos.memoPath(id) });
    const indexing = bootIndexing(h, { ...d, hub }, sync);
    cleanups.push(async () => {
      indexing.stopTimers();
      sync.stopTimers();
      await sync.drain(() => 1000);
      indexing.stopMemoWatch();
      indexing.indexer.stop();
      await d.stopPublishing();
      d.compatLog.stop();
    });
    return { h, sent, indexing };
  };

  it('起動の手続きで、本文を索引し、ワークスペースの直下をプロジェクトにして紐づけ、スクラッチを用意する', async () => {
    const dir = path.join(ws, 'alpha');
    fs.mkdirSync(dir);
    writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000001', 'first');
    const { h, sent, indexing } = boot();
    expect((h.db.prepare('select count(*) c from sessions').get() as { c: number }).c).toBe(0);
    await indexing.start();
    // 見本の 3 件と、いま置いた 1 件。
    expect((h.db.prepare('select count(*) c from sessions where deleted_at is null').get() as { c: number }).c).toBe(4);
    const s = h.db.prepare("select project_id p from sessions where provider_session_id = 'bbbbbbbb-0000-4000-8000-000000000001'").get() as { p: string | null };
    expect(s.p).not.toBeNull();
    expect((h.db.prepare('select name from projects where id = ?').get(s.p) as { name: string }).name).toBe('alpha');
    expect((h.db.prepare('select count(*) c from projects where is_scratch = 1').get() as { c: number }).c).toBe(1);
    // 最初の全走査では未分類のセッションを数えきれないほど流すので、起動の途中は知らせない。
    expect(sent.filter((e) => e.type === 'toast')).toEqual([]);
    // 進みは配る。
    expect(sent.some((e) => e.type === 'index.progress')).toBe(true);
  }, 20_000);

  it('メモの置き場は、置き場の下のプロジェクトごとのファイルである', () => {
    const { indexing } = boot();
    expect(indexing.memos.memoPath('p1')).toBe(path.join(home, 'projects', 'p1', 'memo.md'));
  });
});

describe('要約と、run の出来事の受け手の組み立て', () => {
  it('run の出来事を配り、終わった run を要約の契機にして、そのセッションの本文を上げる', () => {
    const h = homeParts();
    const d = bootDelivery(h);
    cleanups.push(async () => { await d.stopPublishing(); d.compatLog.stop(); });
    const sent: ServerEvent[] = [];
    const listeners: RunListener[] = [];
    const flushed: string[] = [];
    const uuid = '11111111-1111-4111-8111-111111111111';
    const s1 = ensureSession(h.db, uuid, '/w', 'd');
    const runs = {
      runs: { on: (l: RunListener) => { listeners.push(l); return () => {}; } },
      usage: { current: () => ({}) },
      claudeBin: () => null,
    } as unknown as Pick<RunsParts, 'runs' | 'usage' | 'claudeBin'>;
    const summary = bootSummary(h, { ...d, hub: { broadcast: (ev) => { sent.push(ev); } } }, runs, { uploader: { flushSession: async (u: string) => { flushed.push(u); } } as never });
    // 受け手は 2 つ。配りと要約が先で、本文の上げが後である。
    expect(listeners.length).toBe(2);
    const run: RunDto = { id: 'r1', sessionId: s1, deviceId: 'd', kind: 'start', tmuxName: 'hangar-r1', pid: null, startedAt: 1, endedAt: 9, endReason: 'exited', heartbeatAt: 1 };
    for (const l of listeners) l.runEnded?.(run);
    expect(sent.map((e) => e.type)).toEqual(['run.ended']);
    expect(flushed).toEqual([uuid]);
    // 要約は、土台の要約が無いセッションでは受け付けない。頼んでも落ちない。
    expect(summary.api.pending()).toEqual([]);
    expect(summary.api.enqueue(s1)).toBe(false);
    expect(() => summary.rebuildClaude()).not.toThrow();
  });

  it('止めるときは、走っている要約を待つ。待ち行列が空ならすぐ返る', async () => {
    const h = homeParts();
    const d = bootDelivery(h);
    cleanups.push(async () => { await d.stopPublishing(); d.compatLog.stop(); });
    const runs = { runs: { on: () => () => {} }, usage: { current: () => ({}) }, claudeBin: () => null } as unknown as Pick<RunsParts, 'runs' | 'usage' | 'claudeBin'>;
    const summary = bootSummary(h, d, runs, { uploader: null });
    const t = Date.now();
    await summary.stop(2000);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe('待ち受けの組み立て', () => {
  const settings = () => ({ settings: { current: { tmuxPath: null } } }) as unknown as Pick<HomeParts, 'settings'>;

  it('空いているポートで待ち受け、アプリを差し込むまでは 503 を返す', async () => {
    const l = await bootListen({ port: 0 }, settings());
    cleanups.push(() => l.stop());
    expect(l.port).toBeGreaterThan(0);
    expect(l.host).toBe('127.0.0.1');
    const before = await fetch(`http://127.0.0.1:${l.port}/health`);
    expect(before.status).toBe(503);
    expect(await before.text()).toBe('starting');
    l.serve(() => new Response('ok'));
    const after = await fetch(`http://127.0.0.1:${l.port}/health`);
    expect(after.status).toBe(200);
    expect(await after.text()).toBe('ok');
  });

  it('keep-alive の接続が残っていても、止めれば listen を閉じる', async () => {
    const l = await bootListen({ port: 0 }, settings());
    l.serve(() => new Response('ok'));
    // fetch は keep-alive で接続を残す。
    await (await fetch(`http://127.0.0.1:${l.port}/`)).text();
    const result = await Promise.race([l.stop().then(() => 'closed'), new Promise<string>((r) => setTimeout(() => r('timeout'), 2000))]);
    expect(result).toBe('closed');
    await expect(fetch(`http://127.0.0.1:${l.port}/`)).rejects.toThrow();
  });

  it('ポートが塞がっていれば、起動を転ばせる', async () => {
    const first = await bootListen({ port: 0 }, settings());
    cleanups.push(() => first.stop());
    await expect(bootListen({ port: first.port }, settings())).rejects.toThrow(/EADDRINUSE/);
  });
});
