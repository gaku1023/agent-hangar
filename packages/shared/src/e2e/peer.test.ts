import { describe, expect, it } from 'vitest';
import { aadLaunch, importMobileKey, open, seal } from '../mobileCrypto.ts';
import { fromBase64Url, toBase64Url } from './bytes.ts';
import { deriveEpochKeys, randomEpochKey, type EpochKeys } from './keys.ts';
import {
  aadPeerAnswer,
  aadPeerLaunch,
  aadPeerResult,
  openPeerAnswer,
  openPeerLaunch,
  openPeerResult,
  peerSealEpoch,
  PeerUnknownEpochError,
  sealPeerAnswer,
  sealPeerLaunch,
  sealPeerResult,
  type PeerKeyring,
  type PeerLaunchRequest,
  type PeerLaunchResult,
  type PeerRoute,
} from './peer.ts';
import { E2eOpenError, sealJson } from './seal.ts';

/** 世代鍵の一覧から、試験用の鍵の束を作る。cur は書くときの世代。 */
async function ringOf(epochs: Record<number, string>, cur: number): Promise<PeerKeyring> {
  const keys = new Map<number, EpochKeys>();
  for (const [n, k] of Object.entries(epochs)) keys.set(Number(n), await deriveEpochKeys(Number(n), k));
  return { current: () => keys.get(cur)!, at: (n) => keys.get(n) ?? null };
}

const route: PeerRoute = { requestId: 'req-1', from: 'pc-a', to: 'pc-b' };

const request: PeerLaunchRequest = {
  v: 1,
  createdAt: 1_700_000_000_000,
  parentSessionId: 'sess-parent',
  projectId: 'proj-1',
  scratch: false,
  agent: 'claude-code',
  account: 'work',
  permissionMode: 'default',
  model: '',
  prompt: 'テストを直して',
};

const result: PeerLaunchResult = {
  v: 1,
  at: 1_700_000_100_000,
  sessionId: 'sess-child',
  title: '試験の直し',
  reason: 'idle',
  summary: '直した',
  status: 'done',
  lastReply: '終わりました',
  truncated: false,
};

/** 封じた文字列の本体の 1 バイトを反転する。 */
function flip(sealed: string, at: number): string {
  const [ep, b64] = sealed.split('.') as [string, string];
  const raw = fromBase64Url(b64)!;
  raw[at] = raw[at]! ^ 0x01;
  return `${ep}.${toBase64Url(raw)}`;
}

describe('PC どうしの封', () => {
  it('頼み・答え・結果が往復する', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    expect(await openPeerLaunch(ring, route, await sealPeerLaunch(ring, route, request))).toEqual(request);
    const full: PeerLaunchRequest = { ...request, agent: 'opencode', account: '', permissionMode: '', effort: 'high', mode: 'build', autoApprove: true, name: '名前', projectId: null, scratch: true };
    expect(await openPeerLaunch(ring, route, await sealPeerLaunch(ring, route, full))).toEqual(full);
    const ok = { ok: true as const, sessionId: 'sess-child', title: '題' };
    expect(await openPeerAnswer(ring, route, await sealPeerAnswer(ring, route, ok))).toEqual(ok);
    const ng = { ok: false as const, reason: 'account-logged-out' as const, detail: 'work' };
    expect(await openPeerAnswer(ring, route, await sealPeerAnswer(ring, route, ng))).toEqual(ng);
    expect(await openPeerResult(ring, route, 3, await sealPeerResult(ring, route, 3, result))).toEqual(result);
    const long = { ...result, reason: 'ended' as const, summary: null, status: null, lastReply: 'あ'.repeat(9000), truncated: true };
    expect(await openPeerResult(ring, route, 4, await sealPeerResult(ring, route, 4, long))).toEqual(long);
  });

  it('封は <世代>.<base64url> の形で、頭の世代を読める', async () => {
    const ring = await ringOf({ 1: randomEpochKey(), 7: randomEpochKey() }, 7);
    const s = await sealPeerLaunch(ring, route, request);
    expect(s).toMatch(/^7\.[A-Za-z0-9_-]+$/);
    expect(peerSealEpoch(s)).toBe(7);
    expect(peerSealEpoch('x.abc')).toBeNull();
    expect(peerSealEpoch('0.abc')).toBeNull();
    expect(peerSealEpoch(42 as unknown as string)).toBeNull();
  });

  it('開く側は封が名乗る世代の鍵で開く（書く世代が先に進んでいても）', async () => {
    const k1 = randomEpochKey();
    const k2 = randomEpochKey();
    const old = await ringOf({ 1: k1 }, 1);
    const both = await ringOf({ 1: k1, 2: k2 }, 2);
    expect(await openPeerLaunch(both, route, await sealPeerLaunch(old, route, request))).toEqual(request);
  });

  it('AAD の各項目を入れ替えると開けない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const req = await sealPeerLaunch(ring, route, request);
    const swaps: PeerRoute[] = [
      { ...route, requestId: 'req-2' },
      { ...route, from: 'pc-c' },
      { ...route, to: 'pc-c' },
      { requestId: route.requestId, from: route.to, to: route.from },
    ];
    for (const r of swaps) await expect(openPeerLaunch(ring, r, req)).rejects.toBeInstanceOf(E2eOpenError);

    const ans = await sealPeerAnswer(ring, route, { ok: true, sessionId: 's', title: 't' });
    for (const r of swaps) await expect(openPeerAnswer(ring, r, ans)).rejects.toBeInstanceOf(E2eOpenError);

    const res = await sealPeerResult(ring, route, 2, result);
    for (const r of swaps) await expect(openPeerResult(ring, r, 2, res)).rejects.toBeInstanceOf(E2eOpenError);
    // 並べ替えと差し替え：別の番号として開けない。
    await expect(openPeerResult(ring, route, 1, res)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerResult(ring, route, 3, res)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('頼み・答え・結果を互いに取り違えて開けない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const req = await sealPeerLaunch(ring, route, request);
    const ans = await sealPeerAnswer(ring, route, { ok: true, sessionId: 's', title: 't' });
    const res = await sealPeerResult(ring, route, 1, result);
    await expect(openPeerAnswer(ring, route, req)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerResult(ring, route, 1, req)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerLaunch(ring, route, ans)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerResult(ring, route, 1, ans)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerLaunch(ring, route, res)).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerAnswer(ring, route, res)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('AAD は用途の接頭辞を持ち、スマホの AAD や行の AAD と重ならない', () => {
    const all = [aadPeerLaunch(1, route), aadPeerAnswer(1, route), aadPeerResult(1, route, 1)];
    expect(new Set(all).size).toBe(3);
    for (const a of all) {
      const v = JSON.parse(a) as unknown[];
      expect(String(v[0])).toMatch(/^peer-/);
    }
    expect(aadPeerLaunch(1, route)).not.toBe(aadLaunch(route.requestId, route.to));
  });

  it('別のグループの世代鍵では開けない', async () => {
    const mine = await ringOf({ 1: randomEpochKey() }, 1);
    const other = await ringOf({ 1: randomEpochKey() }, 1);
    await expect(openPeerLaunch(other, route, await sealPeerLaunch(mine, route, request))).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerAnswer(other, route, await sealPeerAnswer(mine, route, { ok: true, sessionId: 's', title: 't' }))).rejects.toBeInstanceOf(E2eOpenError);
    await expect(openPeerResult(other, route, 1, await sealPeerResult(mine, route, 1, result))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('持っていない世代（解除の後に回した世代など）の封は PeerUnknownEpochError で断る', async () => {
    const k1 = randomEpochKey();
    const after = await ringOf({ 1: k1, 2: randomEpochKey() }, 2);
    const revoked = await ringOf({ 1: k1 }, 1);
    const s = await sealPeerLaunch(after, route, request);
    const err = await openPeerLaunch(revoked, route, s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeerUnknownEpochError);
    expect(err).toBeInstanceOf(E2eOpenError);
    expect((err as PeerUnknownEpochError).epoch).toBe(2);
  });

  it('頭の世代を書き換えると開けない（世代も AAD に入る）', async () => {
    const k1 = randomEpochKey();
    const ring = await ringOf({ 1: k1, 2: k1 }, 1);
    const s = await sealPeerLaunch(ring, route, request);
    await expect(openPeerLaunch(ring, route, s.replace(/^1\./, '2.'))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('同じ世代でも、行の鍵やスマホの鍵で封じたものは開けない', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const keys = ring.current();
    const asRow = `1.${toBase64Url(await sealJson(keys.row, aadPeerLaunch(1, route), request))}`;
    await expect(openPeerLaunch(ring, route, asRow)).rejects.toBeInstanceOf(E2eOpenError);
    // スマホの封（版の頭が無い）を PC どうしの封として渡しても開けない。
    const m = await importMobileKey(globalThis.crypto.getRandomValues(new Uint8Array(32)));
    const phone = `1.${await seal(m, aadPeerLaunch(1, route), request)}`;
    await expect(openPeerLaunch(ring, route, phone)).rejects.toBeInstanceOf(E2eOpenError);
    // 逆に、PC どうしの封はスマホの開き方では開けない。
    const peer = (await sealPeerLaunch(ring, route, request)).split('.')[1]!;
    await expect(open(m, aadLaunch(route.requestId, route.to), peer)).rejects.toThrow();
  });

  it('壊れた封と形の違う文字列は E2eOpenError を投げる', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const s = await sealPeerLaunch(ring, route, request);
    for (const bad of [flip(s, 5), flip(s, 40), s.slice(0, 20), '', '1.', '1', 'abc', '1.!!!', `1.${s}`]) {
      await expect(openPeerLaunch(ring, route, bad)).rejects.toBeInstanceOf(E2eOpenError);
    }
    await expect(openPeerLaunch(ring, route, null as unknown as string)).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('開けても中身の形が違えば E2eOpenError を投げる', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const k = ring.current().peer;
    const wrap = async (aad: string, v: unknown) => `1.${toBase64Url(await sealJson(k, aad, v))}`;
    const badReqs: unknown[] = [null, [], { ...request, v: 2 }, { ...request, agent: 'gpt' }, { ...request, prompt: 1 }, { ...request, projectId: 3 }, { ...request, autoApprove: 'yes' }];
    for (const b of badReqs) await expect(openPeerLaunch(ring, route, await wrap(aadPeerLaunch(1, route), b))).rejects.toBeInstanceOf(E2eOpenError);
    const badAns: unknown[] = [{ ok: true }, { ok: false }, { ok: 'yes', sessionId: 's', title: 't' }];
    for (const b of badAns) await expect(openPeerAnswer(ring, route, await wrap(aadPeerAnswer(1, route), b))).rejects.toBeInstanceOf(E2eOpenError);
    const badRes: unknown[] = [{ ...result, reason: 'sleep' }, { ...result, truncated: 'no' }, { ...result, lastReply: null }];
    for (const b of badRes) await expect(openPeerResult(ring, route, 1, await wrap(aadPeerResult(1, route, 1), b))).rejects.toBeInstanceOf(E2eOpenError);
  });

  it('知らない断りの理由は launch-failed として読み、元の理由を detail に残す', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    const s = `1.${toBase64Url(await sealJson(ring.current().peer, aadPeerAnswer(1, route), { ok: false, reason: 'gpu-busy' }))}`;
    expect(await openPeerAnswer(ring, route, s)).toEqual({ ok: false, reason: 'launch-failed', detail: 'gpu-busy' });
  });

  it('封じる前に形を検める（壊れた中身は封じない）', async () => {
    const ring = await ringOf({ 1: randomEpochKey() }, 1);
    await expect(sealPeerLaunch(ring, route, { ...request, v: 2 } as unknown as PeerLaunchRequest)).rejects.toBeInstanceOf(TypeError);
    await expect(sealPeerResult(ring, route, 0, result)).rejects.toBeInstanceOf(TypeError);
    await expect(sealPeerLaunch(ring, { ...route, requestId: '' }, request)).rejects.toBeInstanceOf(TypeError);
  });
});
