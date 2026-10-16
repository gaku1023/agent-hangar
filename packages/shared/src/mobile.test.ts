import { describe, expect, it } from 'vitest';
import { LAUNCH_TTL_MS, MOBILE_FEED_MAX_BYTES, MOBILE_TEXT_MAX, PEER_STALE_MS, clampText, fitFeed, type MobileFeed } from './mobile.ts';
import { COMPAT_VERSION, MOBILE_MIN_WORKER_COMPAT } from './compat.ts';

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
    expect(COMPAT_VERSION).toBe(7);
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

  it('live だけで超えても live は落とさない', () => {
    const out = fitFeed(feed({ live: live(200), done: done(5), returns: returns(5), projects: projects(5) }));
    expect(out.live.length).toBe(200);
    expect(out.done).toEqual([]);
    expect(out.returns).toEqual([]);
    expect(out.projects).toEqual([]);
  });
});
