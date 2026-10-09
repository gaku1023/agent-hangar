import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { ProjectDto, ServerEvent, SessionDto } from '@agent-hangar/shared';
import { mangleCwd } from '../provider/claude-code/transcript/discover.ts';
import { startServer } from '../server.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';

/**
 * サーバを丸ごと起こし、WebSocket の購読者に届くイベントの数と中身を押さえる。
 * 書き込みの経路（索引、HTTP、MCP）ごとに、同じ行のイベントが重なって届かないことを見る。
 * 数は、配る層（events/publisher.ts）を入れる前の main と同じである。
 * ただし、同じ tick に同じ行を 2 回配っていた所（MCP の update_project の project.upsert）は、1 回になっている。
 */

/** 見本の登録の pid は実在しない。Windows の既定は動いていない pid の登録を読まないので、試験では全部読ませる。 */
const ALL_ALIVE = (): boolean => false;
/** 遅れて届く重なりを拾うための待ち。メモの監視の取り込み（300 ミリ秒）より長くする。 */
const SETTLE_MS = 700;

let home: string;
let claudeDir: string;
let ws: string;
let prevClaudeBin: string | undefined;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-home-'));
  claudeDir = copyFixtureClaudeDir();
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-ws-'));
  // 手元の本物の claude を起こさないよう、無いパスに向ける。
  prevClaudeBin = process.env.HANGAR_CLAUDE_BIN;
  process.env.HANGAR_CLAUDE_BIN = path.join(home, 'no-claude');
});
afterEach(() => {
  if (prevClaudeBin === undefined) delete process.env.HANGAR_CLAUDE_BIN; else process.env.HANGAR_CLAUDE_BIN = prevClaudeBin;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
  fs.rmSync(ws, { recursive: true, force: true });
});

const tokenOf = () => fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

function writeTranscript(cwd: string, sessionId: string, text: string): void {
  const dir = path.join(claudeDir, 'projects', mangleCwd(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const rec = { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', parentUuid: null, isSidechain: false, timestamp: '2026-09-01T10:00:00.000Z', cwd, sessionId };
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify(rec) + '\n');
}

/** 配信を貯めておき、条件に合うものが来るまで待つ。 */
function collector(port: number, token: string) {
  const sock = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { authorization: `Bearer ${token}` } });
  const seen: ServerEvent[] = [];
  const waiters = new Set<() => void>();
  sock.on('message', (d) => { seen.push(JSON.parse(String(d)) as ServerEvent); for (const w of [...waiters]) w(); });
  const opened = new Promise<void>((resolve, reject) => { sock.once('open', () => resolve()); sock.once('error', reject); });
  return {
    opened,
    all: () => seen as readonly ServerEvent[],
    close: () => sock.terminate(),
    waitFor<T extends ServerEvent>(pred: (e: ServerEvent) => e is T, ms = 8000): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const check = () => { const hit = seen.find(pred); if (hit) { waiters.delete(check); clearTimeout(timer); resolve(hit); } };
        const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`event not seen: ${JSON.stringify(seen.map((e) => e.type))}`)); }, ms);
        waiters.add(check);
        check();
      });
    },
  };
}

type Upsert = Extract<ServerEvent, { type: 'session.upsert' }>;
type ProjectUpsert = Extract<ServerEvent, { type: 'project.upsert' }>;
type MemoUpdate = Extract<ServerEvent, { type: 'memo.update' }>;
const sessionUpserts = (evs: readonly ServerEvent[], id: string) => evs.filter((e): e is Upsert => e.type === 'session.upsert' && e.session.id === id);
const projectUpserts = (evs: readonly ServerEvent[], id: string) => evs.filter((e): e is ProjectUpsert => e.type === 'project.upsert' && e.project.id === id);
const memoUpdates = (evs: readonly ServerEvent[], id: string) => evs.filter((e): e is MemoUpdate => e.type === 'memo.update' && e.memo.projectId === id);

/** ワークスペースにプロジェクト alpha があり、そこにセッションが 1 つある状態でサーバを起こす。 */
async function boot() {
  const dir = path.join(ws, 'alpha');
  fs.mkdirSync(dir);
  writeTranscript(dir, 'bbbbbbbb-0000-4000-8000-000000000001', 'first');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ workspaceRoot: ws, claudeDir }));
  const s = await startServer({ port: 0, home, claudeDir, registryIsGone: ALL_ALIVE, uiDist: path.join(home, 'no-dist') });
  const token = tokenOf();
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const api = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, { ...init, headers });
  const c = collector(s.port, token);
  await c.opened;
  // 起動の直後は、実行中の一覧の最初の知らせが全プロジェクトを配る。それが済んでから数え始める。
  await settle();
  const boot0 = c.all().length;
  const sessions = async () => (await (await api('/api/sessions')).json()) as SessionDto[];
  const projects = async () => (await (await api('/api/projects')).json()) as ProjectDto[];
  const alpha = (await projects()).find((p) => p.name === 'alpha')!;
  const first = (await sessions()).find((x) => x.providerSessionId === 'bbbbbbbb-0000-4000-8000-000000000001')!;
  /** MCP の道具を 1 つ呼ぶ。 */
  const tool = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${s.port}/mcp`, {
      method: 'POST', headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"isError":true');
  };
  return { s, c, api, dir, sessions, projects, alpha, first, tool, since: () => c.all().slice(boot0), close: async () => { c.close(); await s.close(); } };
}

describe('届くイベントの数と中身', () => {
  it('索引が書いた行：新しいセッションは session.upsert が 1 つ、紐づいたプロジェクトは project.upsert が 1 つ', async () => {
    const t = await boot();
    try {
      const uuid = 'bbbbbbbb-0000-4000-8000-000000000002';
      writeTranscript(t.dir, uuid, 'second');
      const ev = await t.c.waitFor((e): e is Upsert => e.type === 'session.upsert' && e.session.providerSessionId === uuid);
      await settle();
      const all = t.since();
      expect(sessionUpserts(all, ev.session.id)).toHaveLength(1);
      expect(projectUpserts(all, t.alpha.id)).toHaveLength(1);
      expect(all.filter((e) => e.type === 'transcript.appended' && e.sessionId === ev.session.id)).toHaveLength(1);
      // 中身は、読み直した行と同じである。
      expect(ev.session).toEqual((await t.sessions()).find((x) => x.id === ev.session.id));
      expect(ev.session.projectId).toBe(t.alpha.id);
      expect(projectUpserts(all, t.alpha.id)[0]!.project).toEqual((await t.projects()).find((p) => p.id === t.alpha.id));
      // 並びは、セッション、プロジェクト、本文の伸び、の順である。
      const order = all.filter((e) => (e.type === 'session.upsert' && e.session.id === ev.session.id) || (e.type === 'project.upsert' && e.project.id === t.alpha.id) || (e.type === 'transcript.appended' && e.sessionId === ev.session.id)).map((e) => e.type);
      expect(order).toEqual(['session.upsert', 'project.upsert', 'transcript.appended']);
    } finally {
      await t.close();
    }
  }, 20000);

  it('HTTP の書き込み：状態、メモ、プロジェクトのステータスは、それぞれのイベントが 1 つずつ', async () => {
    const t = await boot();
    try {
      const put = await t.api(`/api/sessions/${t.first.id}/state`, { method: 'PUT', body: JSON.stringify({ status: 'paused', note: '明日見る', returnOn: '2099-01-01' }) });
      expect(put.status).toBe(200);
      const memo = await t.api(`/api/sessions/${t.first.id}`, { method: 'PATCH', body: JSON.stringify({ memo: '一言' }) });
      expect(memo.status).toBe(200);
      const patched = (await memo.json()) as SessionDto;
      await t.c.waitFor((e): e is Upsert => e.type === 'session.upsert' && e.session.id === t.first.id && e.session.memo === '一言');
      await settle();
      const ups = sessionUpserts(t.since(), t.first.id);
      expect(ups.map((e) => [e.session.state?.status ?? null, e.session.memo])).toEqual([['paused', null], ['paused', '一言']]);
      expect(ups[1]!.session).toEqual(patched);
      expect(projectUpserts(t.since(), t.alpha.id)).toHaveLength(0);

      const from = t.c.all().length;
      expect((await t.api(`/api/projects/${t.alpha.id}/memo`, { method: 'PUT', body: JSON.stringify({ markdown: '# 見出し\n本文' }) })).status).toBe(200);
      await t.c.waitFor((e): e is MemoUpdate => e.type === 'memo.update' && e.memo.projectId === t.alpha.id);
      await settle();
      const afterMemo = t.c.all().slice(from);
      expect(memoUpdates(afterMemo, t.alpha.id).map((e) => e.memo.markdown)).toEqual(['# 見出し\n本文']);
      expect(projectUpserts(afterMemo, t.alpha.id).map((e) => e.project.memoHead)).toEqual(['# 見出し']);
      expect(afterMemo.filter((e) => e.type === 'memo.update' || e.type === 'project.upsert').map((e) => e.type)).toEqual(['memo.update', 'project.upsert']);

      const from2 = t.c.all().length;
      const st = await t.api(`/api/projects/${t.alpha.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'paused' }) });
      expect(st.status).toBe(200);
      const project = (await st.json()) as ProjectDto;
      await t.c.waitFor((e): e is ProjectUpsert => e.type === 'project.upsert' && e.project.id === t.alpha.id && e.project.status === 'paused');
      await settle();
      expect(projectUpserts(t.c.all().slice(from2), t.alpha.id).map((e) => e.project)).toEqual([project]);
    } finally {
      await t.close();
    }
  }, 30000);

  it('MCP の書き込み：メモは session.upsert が 1 つ、update_project は書いた表ごとに 1 つずつ', async () => {
    const t = await boot();
    try {
      await t.tool('set_session_memo', { session_id: t.first.id, text: 'MCP から' });
      await t.c.waitFor((e): e is Upsert => e.type === 'session.upsert' && e.session.id === t.first.id);
      await settle();
      const ups = sessionUpserts(t.since(), t.first.id);
      expect(ups.map((e) => e.session.memo)).toEqual(['MCP から']);
      expect(ups[0]!.session).toEqual((await t.sessions()).find((x) => x.id === t.first.id));

      // status、TODO、メモを 1 回で変えても、project.upsert は最後の中身で 1 つである。
      // 道具が手で配っていた頃は、status の直後と最後に 1 つずつ出ていた。同じ tick の同じ行なので、配る層は 1 つに畳む。
      const from = t.c.all().length;
      await t.tool('update_project', { project_id: t.alpha.id, status: 'paused', add_todos: ['やること'], append_memo: '追記' });
      await t.c.waitFor((e): e is MemoUpdate => e.type === 'memo.update' && e.memo.projectId === t.alpha.id);
      await settle();
      const after = t.c.all().slice(from).filter((e) => e.type === 'project.upsert' || e.type === 'todos.update' || e.type === 'memo.update');
      expect(after.map((e) => e.type)).toEqual(['todos.update', 'memo.update', 'project.upsert']);
      const last = after[2] as ProjectUpsert;
      expect(last.project).toMatchObject({ status: 'paused', openTodoCount: 1, memoHead: '追記' });
    } finally {
      await t.close();
    }
  }, 30000);

  it('実行中の一覧が動いたとき：live.update の後に、そのセッションの session.upsert と、実行中の数を載せた project.upsert が 1 つずつ', async () => {
    const t = await boot();
    try {
      // 行は書かれないが中身が変わる。サーバは行を名指しするだけで、組むのは配る層である。
      const rec = JSON.parse(fs.readFileSync(path.join(claudeDir, 'sessions', '12345.json'), 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(path.join(claudeDir, 'sessions', '23456.json'), JSON.stringify({ ...rec, pid: 23456, sessionId: t.first.providerSessionId, cwd: t.dir, name: null, nameSource: null }));
      await t.c.waitFor((e): e is ProjectUpsert => e.type === 'project.upsert' && e.project.id === t.alpha.id && e.project.runningCount === 1);
      await settle();
      const evs = t.since();
      const ups = sessionUpserts(evs, t.first.id);
      expect(ups.map((e) => e.session.live)).toEqual(['busy']);
      expect(projectUpserts(evs, t.alpha.id).map((e) => e.project.runningCount)).toEqual([1]);
      const live = evs.findIndex((e) => e.type === 'live.update' && e.live.some((l) => l.sessionId === t.first.providerSessionId));
      expect(live).toBeGreaterThanOrEqual(0);
      expect(evs.indexOf(ups[0]!)).toBeGreaterThan(live);
    } finally {
      await t.close();
    }
  }, 30000);
});
