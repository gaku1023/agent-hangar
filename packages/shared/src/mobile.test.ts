import { describe, expect, it } from 'vitest';
import { LAUNCH_TTL_MS, MOBILE_FEED_MAX_BYTES, MOBILE_TEXT_MAX, PEER_STALE_MS, clampText, fitFeed, type MobileFeed } from './mobile.ts';
import { COMPAT_VERSION, MOBILE_MIN_WORKER_COMPAT } from './compat.ts';
import { aadFeed, deriveMobileKey, seal } from './mobileCrypto.ts';

const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).length;

function feed(over: Partial<MobileFeed> = {}): MobileFeed {
  return { v: 1, deviceId: 'pc-1', deviceName: 'PC あ', accounts: [], projects: [], live: [], returns: [], done: [], ...over };
}

describe('定数', () => {
  it('設計の値', () => {
    expect(MOBILE_TEXT_MAX).toBe(300);
    expect(MOBILE_FEED_MAX_BYTES).toBe(48 * 1024);
    expect(LAUNCH_TTL_MS).toBe(75_000);
    expect(PEER_STALE_MS).toBe(180_000);
    expect(COMPAT_VERSION).toBe(9);
    expect(MOBILE_MIN_WORKER_COMPAT).toBe(7);
  });
});

describe('clampText', () => {
  it('300 字で切り、末尾に … を付ける', () => {
    expect(clampText('あ'.repeat(400))).toBe('あ'.repeat(300) + '…');
    expect(clampText('あ'.repeat(300))).toBe('あ'.repeat(300));
    expect(clampText('abc', 2)).toBe('ab…');
  });

  it('サロゲートペアを割らない', () => {
    expect(clampText('😀'.repeat(5), 3)).toBe('😀…');
    expect(clampText('😀'.repeat(5), 4)).toBe('😀😀…');
  });

  it('null、undefined、空文字（空白だけも）は null', () => {
    expect(clampText(null)).toBeNull();
    expect(clampText(undefined)).toBeNull();
    expect(clampText('')).toBeNull();
    expect(clampText('   \n')).toBeNull();
  });

  it('前後の空白は落とす', () => {
    expect(clampText('  会話 1 \n')).toBe('会話 1');
  });
});

describe('fitFeed', () => {
  const big = 'x'.repeat(400);
  const done = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `d${i}`, projectName: 'project-a', title: `会話 ${i}`, oneLiner: big, doneAt: 1000 + i }));
  const returns = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `r${i}`, projectName: 'project-a', title: `会話 ${i}`, accountId: 'acct-1', returnOn: `2026-11-${String(10 + (i % 20)).padStart(2, '0')}`, returnTime: null }));
  const projects = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `project-${i}-${big}`, lastUsedAt: 100 + i }));
  const live = (n: number) => Array.from({ length: n }, (_, i) => ({ sessionId: `l${i}`, projectId: 'p0', projectName: 'project-a', title: `会話 ${i}`, accountId: 'acct-1', status: 'busy' as const, statusAt: 1, startedAt: 1, waiting: null, intent: big, rcUrl: null }));

  it('上限以内ならそのまま返す', () => {
    const f = feed({ done: done(3) });
    expect(fitFeed(f)).toEqual(f);
  });

  it('48 KiB を超えると done を古いものから落とす', () => {
    const f = feed({ done: done(200) });
    expect(bytes(f)).toBeGreaterThan(MOBILE_FEED_MAX_BYTES);
    const out = fitFeed(f);
    expect(bytes(out)).toBeLessThanOrEqual(MOBILE_FEED_MAX_BYTES);
    expect(out.done.length).toBeGreaterThan(0);
    expect(out.done.length).toBeLessThan(200);
    const kept = out.done.map((d) => d.doneAt);
    expect(Math.min(...kept)).toBeGreaterThan(1000);
    expect(kept).toContain(1199);
    expect(f.done.length).toBe(200);
  });

  it('done が尽きたら returns、その次に projects を古いものから落とし、live は落とさない', () => {
    const budget = bytes(feed({ live: live(5), projects: projects(10) })) + 3000;
    const out = fitFeed(feed({ live: live(5), done: done(2), returns: returns(500), projects: projects(10) }), budget);
    expect(out.done).toEqual([]);
    expect(out.live.length).toBe(5);
    expect(out.returns.length).toBeLessThan(500);
    expect(out.projects.length).toBe(10);
    expect(bytes(out)).toBeLessThanOrEqual(budget);

    const tight = bytes(feed({ live: live(5), projects: projects(2).slice(0) }));
    const out2 = fitFeed(feed({ live: live(5), done: done(2), returns: returns(5), projects: projects(10) }), tight);
    expect(out2.done).toEqual([]);
    expect(out2.returns).toEqual([]);
    expect(out2.projects.map((p) => p.id)).toEqual(['p8', 'p9']);
    expect(out2.live.length).toBe(5);
  });

  it('live だけで超えたら、done、returns、projects を落とした後に、待っていない live を古いものから落とす（idle が先）', () => {
    const items = live(200).map((l, i) => ({ ...l, status: (i % 2 === 0 ? 'idle' : 'busy') as 'idle' | 'busy', statusAt: 1000 + i }));
    const out = fitFeed(feed({ live: items, done: done(5), returns: returns(5), projects: projects(5) }));
    expect(bytes(out)).toBeLessThanOrEqual(MOBILE_FEED_MAX_BYTES);
    expect(out.done).toEqual([]);
    expect(out.returns).toEqual([]);
    expect(out.projects).toEqual([]);
    expect(out.live.length).toBeGreaterThan(0);
    expect(out.live.length).toBeLessThan(200);
    // 新しい busy は残り、古い idle から消える。
    expect(out.live.map((l) => l.sessionId)).toContain('l199');
    expect(out.live.map((l) => l.sessionId)).not.toContain('l0');
    const keptIdle = out.live.filter((l) => l.status === 'idle').length;
    const keptBusy = out.live.filter((l) => l.status === 'busy').length;
    expect(keptIdle).toBeLessThanOrEqual(keptBusy);
  });

  /** 文の欄を上限（300 字）まで埋めた live。JSON で膨らむ字（制御文字は 6 バイト）も混ぜる。 */
  const maxText = (c: string) => c.repeat(MOBILE_TEXT_MAX);
  const heavy = (n: number, status: 'idle' | 'busy' | 'waiting', from: number) => Array.from({ length: n }, (_, i) => ({
    sessionId: `${status}-${i}`, projectId: `p-${i}`, projectName: maxText('あ'), title: maxText('\u0001'), accountId: 'acct-1',
    status, statusAt: from + i, startedAt: from + i,
    waiting: status === 'waiting' ? { kind: 'question' as const, text: maxText('"') } : null,
    intent: maxText('い'), rcUrl: `https://claude.ai/code/session_${'a'.repeat(24)}`,
  }));
  const sealedBodyBytes = async (f: MobileFeed): Promise<number> => {
    const key = await deriveMobileKey('join-secret-for-tests-0123456789abcdef');
    return bytes({ sealed: await seal(key, aadFeed(f.deviceId), f) });
  };

  it('文を上限まで埋めた live が 60 件（待っているもの 30、動いているもの 30）でも、封じた本文は 96 KiB に収まる', async () => {
    const f = feed({ live: [...heavy(30, 'busy', 1000), ...heavy(30, 'waiting', 2000)], done: done(50), projects: projects(50) });
    expect(bytes(f)).toBeGreaterThan(2 * MOBILE_FEED_MAX_BYTES);
    const out = fitFeed(f);
    expect(bytes(out)).toBeLessThanOrEqual(MOBILE_FEED_MAX_BYTES);
    expect(await sealedBodyBytes(out)).toBeLessThanOrEqual(96 * 1024);
    // 待っているものを先に残す。
    expect(out.live.some((l) => l.status === 'waiting')).toBe(true);
    expect(out.live.filter((l) => l.status === 'busy').length).toBe(0);
  });

  it('待っている live だけが 60 件でも収まる。意図を詰め、それでも足りなければ文を詰め、最後に古い待ちから落とす', async () => {
    const f = feed({ live: heavy(60, 'waiting', 1000) });
    const out = fitFeed(f);
    expect(bytes(out)).toBeLessThanOrEqual(MOBILE_FEED_MAX_BYTES);
    expect(await sealedBodyBytes(out)).toBeLessThanOrEqual(96 * 1024);
    expect(out.live.length).toBeGreaterThan(0);
    // 意図は詰めるか消す。
    for (const l of out.live) expect((l.intent ?? '').length).toBeLessThan(MOBILE_TEXT_MAX);
    // 残すのは新しい待ち。
    expect(out.live.map((l) => l.sessionId)).toContain('waiting-59');
    expect(f.live[0]!.intent!.length).toBe(MOBILE_TEXT_MAX);
  });

  it('意図を詰めれば収まるなら、待っている live を落とさない', () => {
    const items = heavy(50, 'waiting', 1000).map((l) => ({ ...l, title: '会話', projectName: 'project-a', waiting: { kind: 'question' as const, text: '進めてよいですか' } }));
    const f = feed({ live: items });
    expect(bytes(f)).toBeGreaterThan(MOBILE_FEED_MAX_BYTES);
    const out = fitFeed(f);
    expect(bytes(out)).toBeLessThanOrEqual(MOBILE_FEED_MAX_BYTES);
    expect(out.live.length).toBe(50);
    expect(out.live[0]!.title).toBe('会話');
  });
});
