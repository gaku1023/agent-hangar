import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  deriveJoinSecrets,
  deriveSas,
  generateKeyPair,
  JOIN_CODE_TTL_MS,
  JOIN_NOTICE_ID,
  joinCodeHash,
  randomEpochKey,
  sealJoinRequest,
  setJoinKdfIterationsForTests,
  type JoinApproverState,
  type OsNoticeDto,
  type ServerEvent,
} from '@agent-hangar/shared';
import { FakeWorker } from '../../../cli/test/fakeWorker.ts';
import { joinPoll, joinRequest } from '../../../cli/src/membership.ts';
import { readCloudConfig } from '../config/cloud.ts';
import { testCloudConfig } from '../../test/cloudConfig.ts';
import { HttpCloudClient } from './client.ts';
import { JOIN_POLL_MS, JoinApprover, joinNotifier, type JoinTimers } from './joinApprover.ts';
import { Keyring } from './keyring.ts';
import { RosterStore, type ConfigWriter } from './roster.ts';

// 参加コードを発行した PC の承認（sync/joinApprover.ts）の試験。
// 偽の Worker（packages/cli/test/fakeWorker.ts）の上で、発行した PC（pc-a）と、Task 13 の CLI の関数で参加する新しい PC（pc-b）を通す。

const URL_ = 'https://h.workers.dev';
const TOKEN_A = 'token-pc-a-0123456789abcdef';
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** このクラウドの ID。偽の Worker の /health と、発行した PC の cloud.json（testCloudConfig）が同じ値を持つ。 */
const CLOUD = 'cloud-test-1';

// 参加コードの重い KDF（本番は 1 回 0.3 秒前後）は、試験では回数を減らす。
beforeAll(() => setJoinKdfIterationsForTests(1000));
afterAll(() => setJoinKdfIterationsForTests(null));

const temps: string[] = [];
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});
const tempHome = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-join-approver-'));
  temps.push(d);
  return d;
};

/** 手で回す時計と周期。fire で待っている周期を 1 回だけ回し、その問い合わせが終わるまで待つ。 */
function manualTimers(): JoinTimers & { pending(): number; fire(approver: JoinApprover): Promise<void> } {
  let next: { fn: () => void; ms: number } | null = null;
  return {
    set(fn, ms) {
      next = { fn, ms };
      return next;
    },
    clear(h) {
      if (next === h) next = null;
    },
    pending: () => (next ? 1 : 0),
    async fire(approver) {
      const n = next;
      if (!n) throw new Error('no poll is scheduled');
      expect(n.ms).toBe(JOIN_POLL_MS);
      next = null;
      n.fn();
      await approver.settled();
    },
  };
}

type World = {
  worker: FakeWorker;
  approver: JoinApprover;
  roster: RosterStore;
  timers: ReturnType<typeof manualTimers>;
  states: JoinApproverState[];
  events: ServerEvent[];
  notices: Omit<OsNoticeDto, 'seq'>[];
  clock: { now: number };
  epochKey: string;
  keyring: Keyring;
  /** このパスを含む要求に、Worker の代わりにこの状態で応える（null なら通す）。method を書けば、その方法の要求だけ。 */
  fail: { path: string | null; status: number; method?: string };
  newApprover(): JoinApprover;
};

async function world(o: { noRoster?: boolean } = {}): Promise<World> {
  const clock = { now: 1_000_000 };
  const worker = new FakeWorker();
  worker.now = () => clock.now;
  worker.devices.set('pc-a', { tokenHash: sha(TOKEN_A), revoked: false });
  const keyPair = await generateKeyPair();
  const epochKey = randomEpochKey();
  let cfg = testCloudConfig({ url: URL_, deviceToken: TOKEN_A, keyPair, epochs: { '1': epochKey }, currentEpoch: 1 });
  const writer: ConfigWriter = { read: () => cfg, write: (p) => { cfg = { ...cfg, ...p }; } };
  const fail: World['fail'] = { path: null, status: 500 };
  const fetchA = (async (input: string | URL | Request, init?: RequestInit) =>
    fail.path !== null && new URL(String(input)).pathname.startsWith(fail.path) && (fail.method === undefined || (init?.method ?? 'GET') === fail.method)
      ? new Response('{"error":"refused"}', { status: fail.status, headers: { 'x-hangar-compat': '9' } })
      : worker.fetch(input, init)) as typeof fetch;
  const wire = new HttpCloudClient({ url: URL_, token: TOKEN_A, fetch: fetchA });
  const keyring = await Keyring.fromConfig(cfg);
  const roster = new RosterStore(wire, keyring, writer, 'pc-a');
  const recovery = await generateKeyPair();
  // noRoster は、setup がリカバリーキーの確認の前に止まり、名簿がまだ無いクラウドの真似である。
  if (!o.noRoster) await roster.update(() => ({ v: 1, entries: [{ id: 'pc-a', kind: 'pc', name: 'pc-a', os: 'darwin', pub: keyPair.pub, joinedAt: 1 }], recoveryPub: recovery.pub, phoneKey: null }));
  const states: JoinApproverState[] = [];
  const events: ServerEvent[] = [];
  const notices: Omit<OsNoticeDto, 'seq'>[] = [];
  const timers = manualTimers();
  const notify = joinNotifier({ broadcast: (ev) => events.push(ev), osNotices: { push: (n) => notices.push(n) }, language: () => 'ja' });
  const newApprover = (): JoinApprover =>
    new JoinApprover({
      wire,
      roster,
      keyring,
      cloudId: cfg.cloudId,
      language: () => 'ja',
      now: () => clock.now,
      timers,
      onState: (s) => { states.push(s); notify.onState(s); },
      onRequest: notify.onRequest,
    });
  return { worker, approver: newApprover(), roster, timers, states, events, notices, clock, epochKey, keyring, fail, newApprover };
}

const pcB = { id: 'pc-b', name: 'pc-b', platform: 'linux' };

describe('JoinApprover（発行した PC の承認）', () => {
  let w: World;
  let homeB: string;

  beforeEach(async () => {
    w = await world();
    homeB = tempHome();
  });

  it('発行 → リクエスト → 通知が 1 回 → 承認で名簿に足され、新しい PC の join-poll が approved', async () => {
    const { code, expiresAt } = await w.approver.issue();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(expiresAt).toBe(w.clock.now + JOIN_CODE_TTL_MS);
    expect(w.approver.state()).toEqual({ kind: 'open', code, expiresAt });
    expect(w.timers.pending()).toBe(1);

    // まだリクエストが無い間は open のまま問い合わせを続ける。
    await w.timers.fire(w.approver);
    expect(w.approver.state().kind).toBe('open');
    expect(w.timers.pending()).toBe(1);

    const req = await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'waiting' });

    await w.timers.fire(w.approver);
    const st = w.approver.state();
    expect(st).toEqual({ kind: 'requested', code, expiresAt, request: { name: 'pc-b', os: 'linux', sas: req.sas } });
    // 確認コードは新しい PC の join-request の値と一致する。
    // 問い合わせを重ねても、通知は 1 回だけ。
    await w.timers.fire(w.approver);
    await w.timers.fire(w.approver);
    expect(w.notices).toEqual([{ kind: 'join', sessionId: JOIN_NOTICE_ID, title: '参加リクエストを受信しました', body: `pc-b（Linux）からの参加リクエストです。確認コードは ${req.sas.slice(0, 3)} ${req.sas.slice(3)} です`, bare: false }]);
    expect(w.events.filter((e) => e.type === 'join.request')).toEqual([{ type: 'join.request', request: { name: 'pc-b', os: 'linux', sas: req.sas }, expiresAt }]);

    await w.approver.approve();
    expect(w.approver.state()).toEqual({ kind: 'done', name: 'pc-b' });
    expect(w.timers.pending()).toBe(0);
    expect(w.states.map((s) => s.kind)).toEqual(['open', 'requested', 'approving', 'done']);
    expect(w.events.filter((e) => e.type === 'join.update').map((e) => (e as { join: JoinApproverState }).join.kind)).toEqual(['open', 'requested', 'approving', 'done']);

    // 名簿に新しい PC が入る。
    const { roster } = await w.roster.read();
    expect(roster.entries.map((e) => [e.id, e.kind, e.name, e.os])).toEqual([['pc-a', 'pc', 'pc-a', 'darwin'], ['pc-b', 'pc', 'pc-b', 'linux']]);
    // Worker への書き込みは、名簿、keybox、承認の順。
    const writes = w.worker.calls.filter((c) => c.startsWith('PUT') || c.includes('/approve'));
    expect(writes.slice(-3)).toEqual(['PUT /roster', 'PUT /keyboxes', `POST /join-codes/${await joinCodeHash(code, CLOUD)}/approve`]);

    // 新しい PC は端末トークンと keybox を受け取り、世代鍵の全部を持つ cloud.json を書く。
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'approved' });
    const conf = readCloudConfig(homeB);
    expect(conf.state).toBe('ok');
    expect(conf.config?.epochs).toEqual({ '1': w.epochKey });
    expect(conf.config?.rosterVersion).toBe(2);
  });

  it('keybox には世代 1 から n までの全部が入る', async () => {
    const k2 = randomEpochKey();
    await w.keyring.addEpochs({ epochs: { '2': k2 } });
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    await w.approver.approve();
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'approved' });
    expect(readCloudConfig(homeB).config?.epochs).toEqual({ '1': w.epochKey, '2': k2 });
    expect(readCloudConfig(homeB).config?.currentEpoch).toBe(2);
  });

  it('拒否で新しい PC の join-poll が rejected になり、発行した PC は idle に戻る', async () => {
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    expect(w.approver.state().kind).toBe('requested');
    await w.approver.reject();
    expect(w.approver.state()).toEqual({ kind: 'idle' });
    expect(w.timers.pending()).toBe(0);
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'rejected' });
    // 名簿には足さない。
    expect((await w.roster.read()).roster.entries.map((e) => e.id)).toEqual(['pc-a']);
  });

  it('期限で expired になり、問い合わせが止まる', async () => {
    await w.approver.issue();
    await w.timers.fire(w.approver);
    const callsBefore = w.worker.calls.length;
    w.clock.now += JOIN_CODE_TTL_MS;
    await w.timers.fire(w.approver);
    expect(w.approver.state()).toEqual({ kind: 'expired' });
    expect(w.timers.pending()).toBe(0);
    // 期限を過ぎた後は Worker に問い合わせない。
    expect(w.worker.calls.length).toBe(callsBefore);
    await expect(w.approver.approve()).rejects.toThrow();
  });

  it('リクエストを受けた後に期限が来ても expired になり、承認できない', async () => {
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    w.clock.now += JOIN_CODE_TTL_MS;
    await w.timers.fire(w.approver);
    expect(w.approver.state()).toEqual({ kind: 'expired' });
    expect(w.timers.pending()).toBe(0);
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'expired' });
  });

  it('発行した PC を作り直す（JoinApprover を捨てる）と、新しい PC は 5 分で expired になる', async () => {
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    expect(w.approver.state().kind).toBe('requested');
    // アプリが落ちて起こし直された。参加コードの平文はメモリにしか無いので、新しい JoinApprover は承認できない。
    w.approver.stop();
    expect(w.timers.pending()).toBe(0);
    const fresh = w.newApprover();
    expect(fresh.state()).toEqual({ kind: 'idle' });
    await expect(fresh.approve()).rejects.toThrow();
    // 新しい PC は待ち続けず、期限の 5 分で expired を受け取る。
    w.clock.now += JOIN_CODE_TTL_MS - 1;
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'waiting' });
    w.clock.now += 1;
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'expired' });
    // 下書きは消え、もう問い合わせない。
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'none' });
  });

  it('確認コードは、新しい PC の join-request の値と一致する', async () => {
    const { code } = await w.approver.issue();
    const req = await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    const st = w.approver.state();
    expect(st.kind === 'requested' && st.request.sas).toBe(req.sas);
    expect(req.sas).toMatch(/^\d{6}$/);
  });

  it('別の公開鍵でリクエストを置き直されたら、確認コードが変わる', async () => {
    // 参加コードを盗み見た別の PC が、自分の公開鍵でリクエストを置いた。
    const { code } = await w.approver.issue();
    const hash = await joinCodeHash(code, CLOUD);
    const other = await generateKeyPair();
    const sealed = await sealJoinRequest(await deriveJoinSecrets(code, CLOUD),{ pub: other.pub, name: 'pc-b', os: 'linux' });
    const r = await w.worker.fetch(`${URL_}/join/requests`, { method: 'POST', body: JSON.stringify({ codeHash: hash, deviceId: 'pc-x', sealed }) });
    expect(r.status).toBe(202);
    await w.timers.fire(w.approver);
    const first = w.approver.state();
    expect(first.kind).toBe('requested');

    // 発行した PC に出る確認コードは、盗み見た PC の公開鍵から導いたもので、本物の新しい PC の画面の値とは一致しない。
    // 本物の新しい PC は同じコードには置けない（Worker は 1 つのコードに 1 つしか置かせない）ので、同じコードで導いた値と比べる。
    const genuine = await generateKeyPair();
    expect(first.kind === 'requested' && first.request.sas).toBe(await deriveSas(await deriveJoinSecrets(code, CLOUD),other.pub));
    expect(first.kind === 'requested' && first.request.sas).not.toBe(await deriveSas(await deriveJoinSecrets(code, CLOUD),genuine.pub));
    expect(w.notices).toHaveLength(1);
  });

  it('同じコードで封じた中身が置き換わったら、確認コードを計算し直して通知し直す', async () => {
    const { code } = await w.approver.issue();
    const hash = await joinCodeHash(code, CLOUD);
    const one = await generateKeyPair();
    await w.worker.fetch(`${URL_}/join/requests`, { method: 'POST', body: JSON.stringify({ codeHash: hash, deviceId: 'pc-b', sealed: await sealJoinRequest(await deriveJoinSecrets(code, CLOUD),{ pub: one.pub, name: 'pc-b', os: 'linux' }) }) });
    await w.timers.fire(w.approver);
    const a = w.approver.state();
    // Worker の行の中身が別の公開鍵のものに入れ替わった（Worker の写しを書き換えられた場合）。
    const two = await generateKeyPair();
    w.worker.codes.get(hash)!.sealed = await sealJoinRequest(await deriveJoinSecrets(code, CLOUD),{ pub: two.pub, name: 'pc-b', os: 'linux' });
    await w.timers.fire(w.approver);
    const b = w.approver.state();
    expect(a.kind === 'requested' && b.kind === 'requested').toBe(true);
    if (a.kind !== 'requested' || b.kind !== 'requested') return;
    expect(b.request.sas).not.toBe(a.request.sas);
    expect(w.notices).toHaveLength(2);
  });

  it('開けないリクエストは拒否で閉じ、failed にする', async () => {
    const { code } = await w.approver.issue();
    const hash = await joinCodeHash(code, CLOUD);
    const wrong = await sealJoinRequest(await deriveJoinSecrets('AAAA-AAAA', CLOUD),{ pub: (await generateKeyPair()).pub, name: 'x', os: 'linux' });
    await w.worker.fetch(`${URL_}/join/requests`, { method: 'POST', body: JSON.stringify({ codeHash: hash, deviceId: 'pc-x', sealed: wrong }) });
    await w.timers.fire(w.approver);
    expect(w.approver.state()).toEqual({ kind: 'failed', message: '参加リクエストを復号できませんでした。新しい参加コードを発行してください' });
    expect(w.timers.pending()).toBe(0);
    expect(w.worker.codes.get(hash)!.status).toBe('rejected');
    expect(w.notices).toEqual([]);
  });

  it('取り消すと idle に戻り、Worker のコードも閉じる', async () => {
    const { code } = await w.approver.issue();
    w.approver.cancel();
    expect(w.approver.state()).toEqual({ kind: 'idle' });
    expect(w.timers.pending()).toBe(0);
    await w.approver.settled();
    expect(w.worker.codes.get(await joinCodeHash(code, CLOUD))!.status).toBe('rejected');
  });

  it('発行し直すと前のコードは使えず、新しいコードの状態になる', async () => {
    const first = await w.approver.issue();
    const second = await w.approver.issue();
    expect(second.code).not.toBe(first.code);
    expect(w.approver.state()).toEqual({ kind: 'open', code: second.code, expiresAt: second.expiresAt });
    await expect(joinRequest({ home: homeB, url: URL_, code: first.code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now })).rejects.toThrow();
  });

  it('発行の上限（429）は投げ、状態を変えない', async () => {
    w.fail = Object.assign(w.fail, { path: '/join-codes', status: 429 });
    await expect(w.approver.issue()).rejects.toMatchObject({ status: 429 });
    expect(w.approver.state()).toEqual({ kind: 'idle' });
    expect(w.timers.pending()).toBe(0);
  });

  it('問い合わせが通信で失敗しても、問い合わせを続ける', async () => {
    await w.approver.issue();
    w.fail = Object.assign(w.fail, { path: '/join-codes/mine', status: 500 });
    await w.timers.fire(w.approver);
    expect(w.approver.state().kind).toBe('open');
    expect(w.timers.pending()).toBe(1);
  });

  it('承認の途中で Worker が断ったら failed になり、新しい PC は参加しない', async () => {
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    // keybox を置く要求を Worker が断った。
    w.fail = Object.assign(w.fail, { path: '/keyboxes', status: 500, method: 'PUT' });
    await w.approver.approve();
    const st = w.approver.state();
    expect(st.kind).toBe('failed');
    expect(st.kind === 'failed' && st.message).toMatch(/^承認できませんでした/);
    expect(w.timers.pending()).toBe(0);
    expect(w.worker.codes.get(await joinCodeHash(code, CLOUD))!.status).toBe('requested');
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'waiting' });
    // 足した名簿の項目は外す（Worker の名簿を読み直しても入っていない）。
    expect((await w.roster.read()).roster.entries.map((e) => e.id)).toEqual(['pc-a']);
    w.roster.invalidate();
    const fresh = await w.roster.read();
    expect(fresh.roster.entries.map((e) => e.id)).toEqual(['pc-a']);
    expect(fresh.version).toBe(3);
  });

  it('リクエストの扱いの途中で思わぬ失敗があっても、コードが生きている間は問い合わせを続ける', async () => {
    let calls = 0;
    const ap = new JoinApprover({
      wire: new HttpCloudClient({ url: URL_, token: TOKEN_A, fetch: w.worker.fetch }),
      roster: w.roster,
      keyring: w.keyring,
      cloudId: CLOUD,
      language: () => 'ja',
      now: () => w.clock.now,
      timers: w.timers,
      onRequest: () => {
        calls += 1;
        throw new Error('the notice could not be shown');
      },
    });
    const { code } = await ap.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(ap);
    expect(ap.state().kind).toBe('requested');
    expect(w.timers.pending()).toBe(1);
    // 同じリクエストでは通知し直さない。
    await w.timers.fire(ap);
    expect(calls).toBe(1);
    expect(w.timers.pending()).toBe(1);
    await ap.approve();
    expect(ap.state()).toEqual({ kind: 'done', name: 'pc-b' });
  });

  it('承認の前に期限が来ていたら（Worker の 409）expired になる', async () => {
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    w.fail = Object.assign(w.fail, { path: `/join-codes/${await joinCodeHash(code, CLOUD)}/approve`, status: 409 });
    await w.approver.approve();
    expect(w.approver.state()).toEqual({ kind: 'expired' });
    // 名簿と keybox は書いた後なので、足した項目を外す。
    w.roster.invalidate();
    expect((await w.roster.read()).roster.entries.map((e) => e.id)).toEqual(['pc-a']);
  });

  it('Worker に送るハッシュは重い KDF の値で、新しい PC が /health で知ったクラウドの ID と同じものから導く', async () => {
    const { code } = await w.approver.issue();
    const hash = await joinCodeHash(code, CLOUD);
    expect(w.worker.codes.has(hash)).toBe(true);
    // 素の SHA-256 は Worker に送らない。
    expect(w.worker.codes.has(sha(code.replace('-', '')))).toBe(false);
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    expect(w.worker.codes.get(hash)!.status).toBe('requested');
  });

  it('接続先が別のクラウドを名乗れば、同じコードでも新しい PC のハッシュが一致しない', async () => {
    const { code } = await w.approver.issue();
    w.worker.cloudId = 'cloud-test-2';
    await expect(joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now })).rejects.toMatchObject({ code: 'code-not-found' });
  });

  it('名簿がまだ無いクラウドでは、承認しても空の名簿を作らずに断り、新しい PC は参加しない', async () => {
    w = await world({ noRoster: true });
    const { code } = await w.approver.issue();
    await joinRequest({ home: homeB, url: URL_, code, device: pcB, fetch: w.worker.fetch, now: () => w.clock.now });
    await w.timers.fire(w.approver);
    expect(w.approver.state().kind).toBe('requested');
    await w.approver.approve();
    expect(w.approver.state()).toEqual({ kind: 'failed', message: 'クラウドの setup が終わっていません（リカバリーキーの確認が済んでいません）。Worker を作った PC で hangar setup cloud を最後まで実行してから、新しい参加コードを発行してください' });
    expect(w.timers.pending()).toBe(0);
    // 名簿も keybox も書かず、Worker では拒否として閉じる（新しい PC は待ち続けない）。
    expect(w.worker.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
    w.roster.invalidate();
    expect((await w.roster.read()).version).toBe(0);
    expect(w.worker.codes.get(await joinCodeHash(code, CLOUD))!.status).toBe('rejected');
    expect(await joinPoll({ home: homeB, fetch: w.worker.fetch })).toEqual({ status: 'rejected' });
  });

  it('リクエストが無いときの承認と拒否は投げる', async () => {
    await expect(w.approver.approve()).rejects.toThrow();
    await expect(w.approver.reject()).rejects.toThrow();
    await w.approver.issue();
    await expect(w.approver.approve()).rejects.toThrow();
  });
});
