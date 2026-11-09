import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../db/open.ts';
import { openDb } from '../db/open.ts';
import type { Captured, CaptureOptions } from '../platform/capture.ts';
import { CloudError } from '../sync/client.ts';
import { EventHooks } from './githubHooks.ts';
import { bindingsForInbox, createBinding, deleteBinding, getBindingRow, listHookOrphans, type BindingInput } from './store.ts';

// findTool が見つける、中身の無い gh を置く。呼ぶのは差し替えた capture で、これは実行しない。
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-gh-hooks-'));
fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'gh.exe' : 'gh'), '', { mode: 0o755 });
const env: NodeJS.ProcessEnv = { ...process.env, PATH: dir, Path: dir };
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-no-gh-'));
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(emptyDir, { recursive: true, force: true }); });

const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const BASE = 'https://worker.example.test/';

type Call = { args: string[]; stdin: string | undefined };
type FakeApi = { create: () => Promise<{ inboxId: string }>; remove: (id: string) => Promise<void> };
type Rig = {
  hooks: EventHooks; db: Db; calls: Call[];
  created: string[]; deleted: string[]; changed: { n: number };
  /** gh の答えを決める。既定は作成が id 4242、削除が成功。 */
  gh: { create: () => Captured; remove: () => Captured };
  api: FakeApi | 'none';
  /** 今の時刻。進めると、取り直しの間隔が過ぎる。 */
  t: number;
  /** 立てると、gh の呼びが開くまで待つ。 */
  gate: Promise<void> | null;
};

const ok = (stdout = ''): Captured => ({ code: 0, stdout, stderr: '' });
const failed = (status: number): Captured => ({ code: 1, stdout: '', stderr: `gh: Something (HTTP ${status})` });
const cloudFails = (): FakeApi => ({ create: async () => { throw new CloudError(500, 'x'); }, remove: async () => { throw new CloudError(500, 'x'); } });

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

function rig(over: { env?: NodeJS.ProcessEnv; base?: string | null } = {}): Rig {
  const calls: Call[] = [];
  const created: string[] = [];
  const deleted: string[] = [];
  const changed = { n: 0 };
  let seq = 0;
  const r: Rig = {
    db, calls, created, deleted, changed,
    gh: { create: () => ok('{"id":4242,"active":true}'), remove: () => ok() },
    api: { create: async () => { const id = `inbox-${++seq}`; created.push(id); return { inboxId: id }; }, remove: async (id) => { deleted.push(id); } },
    t: T0, gate: null,
    hooks: undefined as unknown as EventHooks,
  };
  r.hooks = new EventHooks({
    db,
    api: () => {
      const a = r.api;
      return a === 'none' ? null : { createInbox: () => a.create(), deleteInbox: (id) => a.remove(id) };
    },
    baseUrl: () => (over.base === undefined ? BASE : over.base),
    onInboxChanged: () => { changed.n++; },
    env: over.env ?? env,
    now: () => r.t,
    capture: async (_file: string, args: string[], o: CaptureOptions) => {
      calls.push({ args, stdin: o.stdin });
      if (r.gate) await r.gate;
      return args.includes('POST') ? r.gh.create() : r.gh.remove();
    },
  });
  return r;
}

type Share = Pick<BindingInput, 'inboxId' | 'inboxPublicKey' | 'inboxPrivateKey' | 'webhookId' | 'hookSecret'>;

/** ensureRepoHook が返した引き取り用の材料で、結び付けを 1 件作る。 */
function bind(r: Rig, repo: string, share: Share, over: Partial<BindingInput> = {}): string {
  return createBinding(r.db, { ...share, source: { kind: 'github', repo, when: ['ci_done'] }, action: { kind: 'send_pr_owner' }, prompt: 'p', ...over }, T0).id;
}

async function registered(r: Rig, repo = 'octo/demo'): Promise<{ hookId: number; share: Share }> {
  const res = await r.hooks.ensureRepoHook(repo);
  if (res.status !== 'registered') throw new Error(`not registered: ${res.status}`);
  return res;
}

describe('ensureRepoHook', () => {
  it('registers once per repo and reuses it', async () => {
    const r = rig();
    const first = await registered(r);
    expect(first.hookId).toBe(4242);
    expect(r.created).toHaveLength(1);
    // 結び付けを作る前に、もう一度頼まれても、同じ組を返し、gh も Worker も呼ばない。
    expect(await r.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'registered', ...first });
    // 作った後は、結び付けの行から同じ組を引く。大文字小文字は区別しない。
    bind(r, 'octo/demo', first.share);
    expect(await r.hooks.ensureRepoHook('OCTO/Demo')).toEqual({ status: 'registered', ...first });
    expect(r.calls.filter((c) => c.args.includes('POST'))).toHaveLength(1);
    expect(r.created).toHaveLength(1);
    // 別の repo は別の組になる。
    const other = await registered(r, 'octo/other');
    expect(other.share.inboxId).not.toBe(first.share.inboxId);
    expect(r.calls.filter((c) => c.args.includes('POST'))).toHaveLength(2);
  });

  it('serializes concurrent calls for the same repo into one registration', async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.hooks.ensureRepoHook('octo/demo'), r.hooks.ensureRepoHook('octo/demo')]);
    expect(a).toEqual(b);
    expect(r.calls.filter((c) => c.args.includes('POST'))).toHaveLength(1);
  });

  it('sends the spec to gh on stdin with the hook url and the six events', async () => {
    const r = rig();
    const res = await registered(r);
    const post = r.calls.find((c) => c.args.includes('POST'))!;
    expect(post.args).toEqual(['api', '--method', 'POST', 'repos/octo/demo/hooks', '--input', '-']);
    const body = JSON.parse(post.stdin!) as { name: string; active: boolean; events: string[]; config: { url: string; content_type: string; secret: string } };
    expect(body.name).toBe('web');
    expect(body.active).toBe(true);
    expect(body.events).toEqual(['check_suite', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment', 'issues']);
    expect(body.config.content_type).toBe('json');
    expect(body.config.url).toBe(`https://worker.example.test/hooks/${res.share.inboxId}`);
    expect(body.config.secret).toBe(res.share.hookSecret);
    // 32 バイトの乱数（16 進で 64 文字）。
    expect(body.config.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(res.share.webhookId).toBe(4242);
  });

  it('never puts the secret in argv', async () => {
    const r = rig();
    const res = await registered(r);
    for (const c of r.calls) {
      const argv = c.args.join(' ');
      expect(argv).not.toContain(res.share.hookSecret!);
      expect(argv).not.toContain(res.share.inboxId);
      expect(argv).not.toContain('worker.example.test');
    }
  });

  it('maps 404 and 403 to no_admin and deletes the inbox it made', async () => {
    for (const status of [404, 403]) {
      const r = rig();
      r.gh.create = () => failed(status);
      expect(await r.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'no_admin' });
      expect(r.created).toHaveLength(1);
      expect(r.deleted).toEqual(r.created);
      expect(listHookOrphans(r.db)).toEqual([]);
    }
  });

  it('reports a rate limited 403 as failed, not no_admin', async () => {
    const r = rig();
    r.gh.create = () => ({ code: 1, stdout: '', stderr: 'gh: You have exceeded a secondary rate limit (HTTP 403)' });
    expect(await r.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'failed', message: 'rate limited' });
    expect(r.deleted).toEqual(['inbox-1']);
  });

  it('reports other failures as failed with a message that holds neither secret nor url', async () => {
    const r = rig();
    r.gh.create = () => ({ code: 1, stdout: '', stderr: 'validation failed: url https://worker.example.test/hooks/inbox-1 secret abc (HTTP 422)' });
    const res = await r.hooks.ensureRepoHook('octo/demo');
    expect(res.status).toBe('failed');
    const text = JSON.stringify(res);
    expect(text).not.toContain('worker.example.test');
    expect(text).not.toContain('inbox-1');
    expect(text).not.toContain('abc');
    expect(r.deleted).toEqual(['inbox-1']);
  });

  it('fails when gh prints no hook id', async () => {
    const r = rig();
    r.gh.create = () => ok('{"id":"x"}');
    expect((await r.hooks.ensureRepoHook('octo/demo')).status).toBe('failed');
    expect(r.deleted).toEqual(['inbox-1']);
  });

  it('keeps an orphan to retry when the new inbox cannot be deleted after a failure', async () => {
    const r = rig();
    r.gh.create = () => failed(500);
    const make = (r.api as FakeApi).create;
    r.api = { create: make, remove: async () => { throw new CloudError(500, 'x'); } };
    expect((await r.hooks.ensureRepoHook('octo/demo')).status).toBe('failed');
    expect(listHookOrphans(r.db)).toEqual([{ inboxId: 'inbox-1', repo: 'octo/demo', webhookId: null }]);
  });

  it('rejects a malformed repo before any call', async () => {
    const r = rig();
    for (const repo of ['', 'nope', 'a/b/c', 'a/b --input x', '../etc/passwd', 'a b/c']) {
      expect((await r.hooks.ensureRepoHook(repo)).status).toBe('failed');
    }
    expect(r.calls).toEqual([]);
    expect(r.created).toEqual([]);
  });

  it('fails without calling the Worker when gh is missing, the cloud is not set up or the Worker has no inbox', async () => {
    const noGh = rig({ env: { ...process.env, PATH: emptyDir, Path: emptyDir, ProgramFiles: emptyDir } });
    expect(await noGh.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'failed', message: 'gh not found' });
    expect(noGh.created).toEqual([]);
    const noCloud = rig();
    noCloud.api = 'none';
    expect(await noCloud.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'failed', message: 'cloud not set up' });
    const noBase = rig({ base: null });
    expect(await noBase.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'failed', message: 'cloud not set up' });
    expect(noBase.created).toEqual([]);
    const old = rig();
    old.api = { create: async () => { throw new CloudError(404, 'not found'); }, remove: async () => undefined };
    expect(await old.hooks.ensureRepoHook('octo/demo')).toEqual({ status: 'failed', message: 'inbox unavailable' });
    expect(old.calls).toEqual([]);
  });

  it('tells the bell that an inbox appeared', async () => {
    const r = rig();
    await registered(r);
    expect(r.changed.n).toBe(1);
  });
});

describe('removeRepoHookIfUnused', () => {
  it('removes the hook when the last binding goes', async () => {
    const r = rig();
    const res = await registered(r);
    const a = bind(r, 'octo/demo', res.share);
    const b = bind(r, 'octo/demo', res.share, { source: { kind: 'github', repo: 'octo/demo', when: ['review'] } });
    r.calls.length = 0;
    r.changed.n = 0;
    // 1 件消えただけでは、まだ使っているので外さない。
    deleteBinding(r.db, a);
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.calls).toEqual([]);
    expect(r.deleted).toEqual([]);
    // 最後の 1 件が消えたら、webhook と受け箱を外す。
    deleteBinding(r.db, b);
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.calls.map((c) => c.args)).toEqual([['api', '--method', 'DELETE', 'repos/octo/demo/hooks/4242']]);
    expect(r.calls[0]!.stdin).toBeUndefined();
    expect(r.deleted).toEqual([res.share.inboxId]);
    expect(listHookOrphans(r.db)).toEqual([]);
    expect(r.changed.n).toBe(1);
    // 2 度目は何もしない。
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.calls).toHaveLength(1);
  });

  it('treats 404 from gh as success', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.gh.remove = () => failed(404);
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.deleted).toEqual([res.share.inboxId]);
    expect(listHookOrphans(r.db)).toEqual([]);
  });

  it('keeps the orphan when gh cannot reach GitHub, and finishes on the next sweep', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.gh.remove = () => failed(502);
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.deleted).toEqual([]);
    expect(listHookOrphans(r.db)).toHaveLength(1);
    // 取り直しの間隔（1 分）が過ぎるまでは、sweep しても gh を呼ばない。
    r.gh.remove = () => ok();
    const before = r.calls.length;
    await r.hooks.sweep();
    expect(r.calls).toHaveLength(before);
    r.t += 61_000;
    await r.hooks.sweep();
    expect(r.deleted).toEqual([res.share.inboxId]);
    expect(listHookOrphans(r.db)).toEqual([]);
  });

  it('gives up on the GitHub hook after 403 but still deletes the inbox', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.gh.remove = () => failed(403);
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.deleted).toEqual([res.share.inboxId]);
    expect(listHookOrphans(r.db)).toEqual([]);
  });

  it('backs off from 1 minute, doubling up to 1 hour, per orphan', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.gh.remove = () => failed(502);
    const deletes = () => r.calls.filter((c) => c.args.includes('DELETE')).length;
    await r.hooks.sweep();
    expect(deletes()).toBe(1);
    const waits = [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000];
    let n = 1;
    for (const w of waits) {
      r.t += w - 1;
      await r.hooks.sweep();
      expect(deletes()).toBe(n);
      r.t += 1;
      await r.hooks.sweep();
      n++;
      expect(deletes()).toBe(n);
    }
  });

  it('coalesces sweeps that are queued behind a running one', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    let open!: () => void;
    r.gate = new Promise<void>((res2) => { open = res2; });
    const first = r.hooks.sweep();
    await new Promise((res2) => setTimeout(res2, 5));
    const second = r.hooks.sweep();
    const third = r.hooks.sweep();
    expect(third).toBe(second);
    r.gate = null;
    open();
    await Promise.all([first, second, third]);
    expect(r.calls.filter((c) => c.args.includes('DELETE'))).toHaveLength(1);
  });

  it('does not delete an inbox that a binding took after it was orphaned', async () => {
    const r = rig();
    const res = await registered(r);
    const b1 = bind(r, 'octo/demo', res.share);
    // 呼び手が組を受け取ったあと、b1 が消え、後片付けが順番待ちになり、そのあとで結び付けが作られる。
    const again = await r.hooks.ensureRepoHook('octo/demo');
    expect(again.status).toBe('registered');
    deleteBinding(r.db, b1);
    expect(listHookOrphans(r.db)).toHaveLength(1);
    let open!: () => void;
    r.gate = new Promise<void>((res2) => { open = res2; });
    const blocker = r.hooks.ensureRepoHook('octo/blocker');
    await new Promise((res2) => setTimeout(res2, 5));
    const cleanup = r.hooks.removeRepoHookIfUnused('octo/demo');
    bind(r, 'octo/demo', res.share);
    r.gate = null;
    open();
    await Promise.all([blocker, cleanup]);
    expect(r.deleted).toEqual([]);
    expect(r.calls.filter((c) => c.args.includes('DELETE'))).toEqual([]);
    expect(listHookOrphans(r.db)).toEqual([]);
  });

  it('keeps the orphan on a rate limited 403 and retries later', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.gh.remove = () => ({ code: 1, stdout: '', stderr: 'gh: API rate limit exceeded (HTTP 403)' });
    await r.hooks.sweep();
    expect(r.deleted).toEqual([]);
    expect(listHookOrphans(r.db)).toHaveLength(1);
    r.gh.remove = () => ok();
    r.t += 61_000;
    await r.hooks.sweep();
    expect(r.deleted).toEqual([res.share.inboxId]);
  });

  it('keeps the orphan while the cloud is not available', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.api = 'none';
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(listHookOrphans(r.db)).toHaveLength(1);
  });

  it('removes a hook that was registered but never got a binding', async () => {
    const r = rig();
    const res = await registered(r);
    await r.hooks.removeRepoHookIfUnused('octo/demo');
    expect(r.calls.map((c) => c.args)).toContainEqual(['api', '--method', 'DELETE', 'repos/octo/demo/hooks/4242']);
    expect(r.deleted).toEqual([res.share.inboxId]);
    // 次の頼みは、作り直す。
    const again = await registered(r);
    expect(again.share.inboxId).not.toBe(res.share.inboxId);
  });

  it('does nothing for a malformed repo', async () => {
    const r = rig();
    await r.hooks.removeRepoHookIfUnused('a/b --x');
    expect(r.calls).toEqual([]);
  });

  it('never throws', async () => {
    const r = rig();
    const res = await registered(r);
    deleteBinding(r.db, bind(r, 'octo/demo', res.share));
    r.api = cloudFails();
    await expect(r.hooks.removeRepoHookIfUnused('octo/demo')).resolves.toBeUndefined();
    await expect(r.hooks.sweep()).resolves.toBeUndefined();
  });
});

describe('外の webhook の受け箱', () => {
  const hookBinding = (r: Rig): string => createBinding(r.db, { inboxId: '', inboxPublicKey: '', inboxPrivateKey: '', source: { kind: 'hook' }, action: { kind: 'send_pr_owner' }, prompt: 'p' }, T0).id;

  it('creates the inbox once and builds the url from it', async () => {
    const r = rig();
    const id = hookBinding(r);
    expect(r.hooks.hookUrlOf(id)).toBeNull();
    expect(await r.hooks.ensureHookInbox(id)).toEqual({ status: 'ready' });
    expect(await r.hooks.ensureHookInbox(id)).toEqual({ status: 'ready' });
    expect(r.created).toHaveLength(1);
    const row = getBindingRow(r.db, id)!;
    expect(row.inboxId).toBe('inbox-1');
    expect(row.inboxPrivateKey).not.toBe('');
    expect(bindingsForInbox(r.db, 'inbox-1')).toHaveLength(1);
    expect(r.hooks.hookUrlOf(id)).toBe('https://worker.example.test/hooks/inbox-1');
    expect(r.changed.n).toBe(1);
  });

  it('rotates: a new inbox and keys, and the old inbox is deleted', async () => {
    const r = rig();
    const id = hookBinding(r);
    await r.hooks.ensureHookInbox(id);
    const before = getBindingRow(r.db, id)!;
    expect(await r.hooks.rotateHookInbox(id)).toEqual({ status: 'ready' });
    const after = getBindingRow(r.db, id)!;
    expect(after.inboxId).toBe('inbox-2');
    expect(after.inboxPublicKey).not.toBe(before.inboxPublicKey);
    expect(after.inboxPrivateKey).not.toBe(before.inboxPrivateKey);
    expect(r.deleted).toEqual(['inbox-1']);
    expect(listHookOrphans(r.db)).toEqual([]);
    expect(r.hooks.hookUrlOf(id)).toBe('https://worker.example.test/hooks/inbox-2');
  });

  it('keeps the old inbox as an orphan when deleting it fails during a rotation', async () => {
    const r = rig();
    const id = hookBinding(r);
    await r.hooks.ensureHookInbox(id);
    const make = (r.api as FakeApi).create;
    r.api = { create: make, remove: async () => { throw new CloudError(500, 'x'); } };
    expect(await r.hooks.rotateHookInbox(id)).toEqual({ status: 'ready' });
    expect(listHookOrphans(r.db)).toEqual([{ inboxId: 'inbox-1', repo: null, webhookId: null }]);
  });

  it('keeps the old inbox when the new one cannot be created', async () => {
    const r = rig();
    const id = hookBinding(r);
    await r.hooks.ensureHookInbox(id);
    r.api = cloudFails();
    expect(await r.hooks.rotateHookInbox(id)).toEqual({ status: 'failed', message: 'inbox unavailable' });
    expect(getBindingRow(r.db, id)!.inboxId).toBe('inbox-1');
  });

  it('refuses a missing binding and a github binding', async () => {
    const r = rig();
    expect((await r.hooks.ensureHookInbox('missing')).status).toBe('failed');
    expect((await r.hooks.rotateHookInbox('missing')).status).toBe('failed');
    const gh = createBinding(r.db, { inboxId: 'in-gh', inboxPublicKey: 'p', inboxPrivateKey: 'k', source: { kind: 'github', repo: 'octo/demo', when: ['ci_done'] }, action: { kind: 'send_pr_owner' }, prompt: 'p' }, T0).id;
    expect((await r.hooks.ensureHookInbox(gh)).status).toBe('failed');
    expect(r.hooks.hookUrlOf(gh)).toBeNull();
    expect(r.created).toEqual([]);
  });

  it('deletes the inbox of a removed hook binding on sweep', async () => {
    const r = rig();
    const id = hookBinding(r);
    await r.hooks.ensureHookInbox(id);
    deleteBinding(r.db, id);
    await r.hooks.sweep();
    expect(r.deleted).toEqual(['inbox-1']);
    expect(r.calls).toEqual([]);
    expect(listHookOrphans(r.db)).toEqual([]);
  });
});
