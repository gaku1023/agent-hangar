import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GitDto, LiveSessionDto } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { indexFile } from '../indexer/indexFile.ts';
import { git, hasGit, makeRepo } from '../../test/git.ts';
import { GitService } from './service.ts';
import { spawnGit, type GitExec } from './status.ts';

const DEV = 'dev-1';
let tmp: string;
let db: Db;
let sent: GitDto[];
let live: LiveSessionDto[];
let calls: string[][];
let exec: GitExec;

/** git を数える口。実物の git を起こしたうえで、渡した引数を覚える。 */
const counting = (inner: GitExec): GitExec => async (args, o) => { calls.push(args); return inner(args, o); };

const assistant = (uuid: string, cwd: string, branch: string, content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', model: 'm', content, usage: { input_tokens: 0, output_tokens: 1 } }, uuid, timestamp: '2026-10-01T00:00:00.000Z', cwd, sessionId: 'u1', gitBranch: branch });
const user = (uuid: string, cwd: string, branch: string, content: unknown) => ({ type: 'user', message: { role: 'user', content }, uuid, timestamp: '2026-10-01T00:00:01.000Z', cwd, sessionId: 'u1', gitBranch: branch });

/** セッションの本文を書いて索引化する。編集したファイルの呼び出しは event_index に入る。 */
function writeSession(o: { id?: string; cwd: string; branch?: string; edits?: { file: string; old?: string; next?: string; write?: string }[]; deviceId?: string | null; extra?: unknown[] }): string {
  const provider = o.id ?? 'u1';
  const dir = path.join(tmp, 'claude', 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${provider}.jsonl`);
  const recs: unknown[] = [user('u0', o.cwd, o.branch ?? 'main', 'はじめ')];
  (o.edits ?? []).forEach((e, i) => {
    const input = e.write !== undefined ? { file_path: e.file, content: e.write } : { file_path: e.file, old_string: e.old ?? '', new_string: e.next ?? '' };
    recs.push(assistant(`a${i}`, o.cwd, o.branch ?? 'main', [{ type: 'tool_use', id: `t${i}`, name: e.write !== undefined ? 'Write' : 'Edit', input }]));
    recs.push(user(`r${i}`, o.cwd, o.branch ?? 'main', [{ type: 'tool_result', tool_use_id: `t${i}`, content: `The file ${e.file} has been updated.` }]));
  });
  recs.push(...(o.extra ?? []));
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return indexFile(db, { path: file, sessionId: provider, agentId: null, deviceId: o.deviceId ?? null }, { deviceId: DEV }).sessionId;
}

const make = (over: Partial<ConstructorParameters<typeof GitService>[0]> = {}) => new GitService({
  db, deviceId: DEV, live: () => live, broadcast: (g) => sent.push(g), exec: () => exec, now: () => Date.now(), debounceMs: 0, ...over,
});

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-gitsvc-')));
  db = openDb(':memory:');
  upsertShared(db, 'devices', { id: DEV, name: 'mine', platform: process.platform }, DEV);
  sent = [];
  live = [];
  calls = [];
  exec = counting(spawnGit('git'));
});
afterEach(() => {
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(!hasGit)('GitService', () => {
  it('セッションの作業ツリーと、未コミットの件数とブランチを返す', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    const id = writeSession({ cwd: repo, branch: 'main' });
    const g = await make().sessions([id]);
    expect(g.sessions[id]).toEqual({ state: 'ok', root: repo, branch: 'main', worktree: null });
    expect(g.trees[repo]).toMatchObject({ root: repo, branch: 'main', dirty: 1, slow: false });
  });

  it('git でないフォルダは nogit、消えた worktree は gone', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    const a = writeSession({ id: 'u1', cwd: plain });
    const gone = path.join(tmp, 'alpha', '.claude', 'worktrees', 'fix');
    const b = writeSession({ id: 'u2', cwd: gone, branch: 'worktree-fix', extra: [{ type: 'worktree-state', worktreeSession: { worktreeName: 'fix', worktreePath: gone, worktreeBranch: 'worktree-fix' } }] });
    const g = await make().sessions([a, b]);
    expect(g.sessions[a]).toEqual({ state: 'nogit', root: null, branch: null, worktree: null });
    expect(g.sessions[b]).toEqual({ state: 'gone', root: null, branch: 'worktree-fix', worktree: 'fix' });
  });

  it('他の PC で動いているセッションは git を読まず、本文の gitBranch だけを返す', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    const id = writeSession({ cwd: repo, branch: 'feature-x' });
    upsertShared(db, 'runs', { id: 'r9', session_id: id, device_id: 'other', kind: 'resume', tmux_name: 'hangar-r9', pid: null, started_at: 1, ended_at: null, end_reason: null, heartbeat_at: Date.now(), launch_params: '{}' }, 'other');
    calls = [];
    const g = await make().sessions([id]);
    expect(g.sessions[id]).toEqual({ state: 'remote', root: null, branch: 'feature-x', worktree: null });
    expect(calls).toEqual([]);
  });

  it('worktree に入っていたセッションは、その作業ツリーを読み、名前と元の根を持つ', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    const wt = path.join(repo, '.claude', 'worktrees', 'fix');
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-fix', wt);
    const id = writeSession({ cwd: repo, extra: [user('w1', wt, 'worktree-fix', 'つづき')] });
    const g = await make().sessions([id]);
    expect(g.sessions[id]).toEqual({ state: 'ok', root: wt, branch: 'worktree-fix', worktree: 'fix' });
    expect(g.trees[wt]).toMatchObject({ worktree: 'fix', mainRoot: repo, branch: 'worktree-fix' });
  });

  it('同じ根は覚えた値を使い、同時の呼び出しは 1 つにまとめる', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    const a = writeSession({ id: 'u1', cwd: repo });
    const b = writeSession({ id: 'u2', cwd: repo });
    const svc = make();
    calls = [];
    await Promise.all([svc.sessions([a]), svc.sessions([b])]);
    await svc.sessions([a, b]);
    expect(calls.filter((c) => c[0] === 'status')).toHaveLength(1);
  });

  it('時間切れの根は 60 秒呼ばず、その後は未追跡を数えずに試す', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    const id = writeSession({ cwd: repo });
    let now = 1_000_000;
    let slow = true;
    const real = spawnGit('git');
    exec = async (args, o) => { calls.push(args); if (args[0] === 'status' && slow) return { code: 1, stdout: '', timedOut: true, capped: false }; return real(args, o); };
    const svc = make({ now: () => now });
    expect((await svc.sessions([id])).trees[repo]).toMatchObject({ slow: true, dirty: null });
    calls = [];
    now += 30_000;
    await svc.sessions([id]);
    expect(calls.filter((c) => c[0] === 'status')).toEqual([]);
    slow = false;
    now += 31_000;
    expect((await svc.sessions([id])).trees[repo]).toMatchObject({ slow: false, dirty: 0 });
    expect(calls.find((c) => c[0] === 'status')).toContain('--untracked-files=no');
  });

  it('変更したファイルに git の状態を添え、ほかに変わったファイルを分けて返す', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\n', 'b.txt': 'b\n', 'c.txt': 'c\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'n.txt'), 'new\n');
    fs.writeFileSync(path.join(repo, 'other.txt'), 'by bash\n');
    const id = writeSession({ cwd: repo, edits: [{ file: path.join(repo, 'a.txt'), old: 'one', next: 'one\ntwo' }, { file: path.join(repo, 'n.txt'), write: 'new\n' }, { file: path.join(repo, 'c.txt'), old: 'c', next: 'c' }] });
    const ch = await make().changes(id);
    expect(ch.state).toBe('ok');
    expect(ch.files).toEqual([
      { path: path.join(repo, 'a.txt'), rel: 'a.txt', status: 'M', added: 1, deleted: 0, binary: false },
      { path: path.join(repo, 'n.txt'), rel: 'n.txt', status: 'U', added: 1, deleted: 0, binary: false },
      { path: path.join(repo, 'c.txt'), rel: 'c.txt', status: 'C', added: null, deleted: null, binary: false },
    ]);
    expect(ch.others).toEqual([{ path: path.join(repo, 'other.txt'), rel: 'other.txt', status: 'U', added: 1, deleted: 0, binary: false }]);
    expect(ch.othersCapped).toBe(false);
  });

  it('git でないフォルダの変更したファイルは、git の状態を持たずに並べる', async () => {
    const plain = path.join(tmp, 'plain');
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(plain, 'x.md'), 'x');
    const id = writeSession({ cwd: plain, edits: [{ file: path.join(plain, 'x.md'), write: 'x' }] });
    const ch = await make().changes(id);
    expect(ch).toMatchObject({ state: 'nogit', root: null, others: [] });
    expect(ch.files.map((f) => f.rel)).toEqual(['x.md']);
  });

  it('差分は、そのセッションが変えたファイルだけを読む', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\n', 'b.txt': 'b\n' });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ONE\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'B\n');
    const id = writeSession({ cwd: repo, edits: [{ file: path.join(repo, 'a.txt'), old: 'one', next: 'ONE' }] });
    const svc = make();
    const d = await svc.diff(id, path.join(repo, 'a.txt'));
    expect(d !== null && typeof d === 'object' ? d.text : '').toContain('-one\n+ONE\n');
    expect(await svc.diff(id, path.join(repo, 'b.txt'))).toBeNull();
  });

  it('編集の呼び出しを、結果と一緒に古い順に返す', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\n' });
    const f = path.join(repo, 'a.txt');
    const id = writeSession({ cwd: repo, edits: [{ file: f, old: 'one', next: 'two' }, { file: path.join(repo, 'b.txt'), write: 'b' }, { file: f, old: 'two', next: 'three' }] });
    const e = make().edits(id, f);
    expect(e.file).toBe(f);
    expect(e.edits.map((x) => [x.call.name, (x.call.input as { new_string: string }).new_string, x.result?.isError])).toEqual([['Edit', 'two', false], ['Edit', 'three', false]]);
  });

  it('実行中のセッションの本文が伸びたら読み直し、値が変わったときだけ配る', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'), { 'a.txt': 'one\n' });
    const id = writeSession({ cwd: repo });
    live = [{ sessionId: 'u1', status: 'busy', name: null, nameSource: null, cwd: repo, pid: 1 }];
    const svc = make();
    await svc.sessions([id]);
    await svc.noteAppended(id);
    expect(sent).toEqual([]);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
    await svc.noteAppended(id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.trees[repo]).toMatchObject({ dirty: 1 });
    expect(sent[0]!.sessions[id]).toMatchObject({ state: 'ok', root: repo });
    // 実行中でないセッションでは読み直さない。
    live = [];
    fs.writeFileSync(path.join(repo, 'a.txt'), 'three\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await svc.noteAppended(id);
    expect(sent).toHaveLength(1);
  });

  it('プロジェクトの作業ツリーと worktree を並べる', async () => {
    const repo = makeRepo(path.join(tmp, 'alpha'));
    git(repo, 'worktree', 'add', '-q', '-b', 'worktree-fix', path.join(repo, '.claude', 'worktrees', 'fix'));
    const p = await make().project(repo);
    expect(p.root).toMatchObject({ root: repo, branch: 'main' });
    expect(p.worktrees).toEqual([{ path: path.join(repo, '.claude', 'worktrees', 'fix'), name: 'fix', branch: 'worktree-fix', tree: expect.objectContaining({ branch: 'worktree-fix', dirty: 0 }) }]);
    expect(await make().project(path.join(tmp, 'nope'))).toEqual({ root: null, worktrees: [] });
  });
});
