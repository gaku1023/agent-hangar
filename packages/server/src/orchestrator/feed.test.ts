import { translatorOf } from '../i18n/message.ts';
import type { LiveSessionDto } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_IDLE_MS, COMPACT_TOKENS, feedText, NOTICE_GRACE_MS, OrchestratorFeed, type FeedLine } from './feed.ts';

/**
 * 統括への出来事の送り込みと、許可待ちの通知の猶予（docs/design.md「統括」の出来事の届け方）。
 * 時計は vitest の偽の時計にし、実行中の一覧と統括の入力欄は手で動かす。
 */

const tr = translatorOf(() => 'ja');

type World = {
  live: Map<string, LiveSessionDto>;
  enabled: boolean;
  inputEmpty: boolean;
  delivered: string[];
  involved: Set<string>;
  tokens: number | null;
  graceEnded: string[];
  fed: number;
};

let w: World;
let feed: OrchestratorFeed;

const row = (id: string, over: Partial<LiveSessionDto> = {}): LiveSessionDto => ({ sessionId: `u-${id}`, status: 'busy', name: null, nameSource: null, cwd: '/w', pid: 1, ...over });
const TITLES: Record<string, string> = { orch: '統括', s1: 'ログイン修正', s2: '請求の集計', s3: '文書' };

function set(id: string, over: Partial<LiveSessionDto>): void {
  w.live.set(id, row(id, over));
  feed.onLiveChange();
}
function gone(id: string): void {
  w.live.delete(id);
  feed.onLiveChange();
}
const waitPerm = (id: string, tool = 'Bash', input = 'rm -rf build && npm run deploy --token=SECRET') =>
  set(id, { status: 'waiting', waitingFor: 'permission', permission: { tool, input } as LiveSessionDto['permission'] });
/** 偽の時計を進め、待っている約束を流す。 */
async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  w = { live: new Map(), enabled: true, inputEmpty: true, delivered: [], involved: new Set(), tokens: 10_000, graceEnded: [], fed: 0 };
  feed = new OrchestratorFeed({
    orchestrator: () => ({ enabled: w.enabled, sessionId: 'orch' }),
    live: () => [...w.live.values()],
    resolve: (l) => {
      const id = l.sessionId.replace(/^u-/, '');
      return { id, title: TITLES[id] ?? id };
    },
    involved: (_self, id) => w.involved.has(id),
    reported: (_self, id) => { w.involved.delete(id); },
    inputEmpty: async () => w.inputEmpty,
    deliver: async (_self, text) => {
      if (!w.inputEmpty) return false;
      w.delivered.push(text);
      // 渡すと統括のターンが始まる。
      w.live.set('orch', row('orch', { status: 'busy' }));
      return true;
    },
    format: (lines: FeedLine[]) => feedText(tr, lines),
    onFed: () => { w.fed++; },
    contextTokens: () => w.tokens,
    onGraceEnd: (id) => { w.graceEnded.push(id); },
  });
  // 統括は idle、ほかの会話は作業中。最初の観測は覚えるだけ。
  w.live.set('orch', row('orch', { status: 'idle' }));
  w.live.set('s1', row('s1'));
  w.live.set('s2', row('s2'));
  feed.onLiveChange();
});

afterEach(() => {
  feed.stop();
  vi.useRealTimers();
});

/** 統括が渡された文を読み終えて idle に戻った。 */
const orchIdle = () => set('orch', { status: 'idle' });

describe('出来事の送り込み', () => {
  it('許可待ちになると 0.3 秒後に 1 通が統括へ渡る。文の形は見出しと 1 件 1 行で、命令の全文を含まない', async () => {
    waitPerm('s1');
    await tick(299);
    expect(w.delivered).toEqual([]);
    await tick(1);
    expect(w.delivered).toEqual(['[hangar] 出来事 1 件\n- ask.permission s1 「ログイン修正」 Bash']);
    expect(w.delivered[0]).not.toContain('rm -rf');
    expect(w.delivered[0]).not.toContain('SECRET');
    expect(w.fed).toBe(1);
  });

  it('2 件が続けば 1 通にまとまる', async () => {
    waitPerm('s1');
    await tick(100);
    set('s2', { status: 'waiting', waitingFor: 'question' });
    await tick(300);
    expect(w.delivered).toEqual(['[hangar] 出来事 2 件\n- ask.permission s1 「ログイン修正」 Bash\n- ask.question s2 「請求の集計」']);
  });

  it('統括が busy なら渡さず、idle になったら渡す', async () => {
    set('orch', { status: 'busy' });
    waitPerm('s1');
    await tick(5_000);
    expect(w.delivered).toEqual([]);
    orchIdle();
    await tick(0);
    expect(w.delivered).toHaveLength(1);
  });

  it('入力欄に打ちかけがあれば渡さず、空になったら渡す', async () => {
    w.inputEmpty = false;
    waitPerm('s1');
    await tick(5_000);
    expect(w.delivered).toEqual([]);
    w.inputEmpty = true;
    await tick(1_500);
    expect(w.delivered).toHaveLength(1);
  });

  it('渡す前に解けた待ちは文に入らない', async () => {
    set('orch', { status: 'busy' });
    waitPerm('s1');
    set('s2', { status: 'waiting', waitingFor: 'question' });
    await tick(1_000);
    // s1 は利用者が画面で答えた。
    set('s1', { status: 'busy' });
    orchIdle();
    await tick(0);
    expect(w.delivered).toEqual(['[hangar] 出来事 1 件\n- ask.question s2 「請求の集計」']);
  });

  it('全部が解けていれば何も渡さない', async () => {
    set('orch', { status: 'busy' });
    waitPerm('s1');
    await tick(1_000);
    set('s1', { status: 'busy' });
    orchIdle();
    await tick(5_000);
    expect(w.delivered).toEqual([]);
  });

  it('統括自身の待ちは出来事にならない', async () => {
    set('orch', { status: 'waiting', waitingFor: 'permission' });
    orchIdle();
    await tick(5_000);
    expect(w.delivered).toEqual([]);
  });

  it('関わっていない会話の turn.done と session.ended は出来事にならず、関わった会話のものはなる', async () => {
    set('s1', { status: 'idle' });
    gone('s2');
    await tick(5_000);
    expect(w.delivered).toEqual([]);

    w.involved.add('s1');
    w.involved.add('s3');
    set('s1', { status: 'busy' });
    set('s3', { status: 'busy' });
    set('s1', { status: 'idle' });
    gone('s3');
    await tick(1_999);
    expect(w.delivered).toEqual([]);
    await tick(1);
    expect(w.delivered).toEqual(['[hangar] 出来事 2 件\n- turn.done s1 「ログイン修正」\n- session.ended s3 「文書」']);
  });

  it('渡したあとは、統括のターンが動き出してから次を渡す', async () => {
    waitPerm('s1');
    await tick(300);
    expect(w.delivered).toHaveLength(1);
    // 統括は渡された文を読んでいる（busy）。その間の待ちは預かる。
    set('s2', { status: 'waiting', waitingFor: 'question' });
    await tick(3_000);
    expect(w.delivered).toHaveLength(1);
    orchIdle();
    await tick(0);
    expect(w.delivered).toHaveLength(2);
  });

  it('統括が無効なら何も渡さない', async () => {
    w.enabled = false;
    waitPerm('s1');
    await tick(5_000);
    expect(w.delivered).toEqual([]);
  });

  it('預かりが 20 件を超えたら古い終わりの出来事から捨て、許可と質問は捨てない', async () => {
    set('orch', { status: 'busy' });
    for (let i = 0; i < 22; i++) {
      const id = `d${i}`;
      w.involved.add(id);
      set(id, { status: 'busy' });
      set(id, { status: 'idle' });
    }
    waitPerm('s1');
    const p = feed.pending();
    expect(p).toHaveLength(20);
    expect(p.some((l) => l.kind === 'ask.permission')).toBe(true);
    expect(p.some((l) => l.sessionId === 'd0' || l.sessionId === 'd1' || l.sessionId === 'd2')).toBe(false);
  });
});

describe('許可待ちの通知の猶予', () => {
  it('統括が有効で idle なら 15 秒預かり、その間に待ちが消えたら出さない', async () => {
    waitPerm('s1');
    expect(feed.held('s1')).toBe(true);
    await tick(5_000);
    // 統括が方針で答えた。
    set('s1', { status: 'busy' });
    expect(feed.held('s1')).toBe(false);
    await tick(NOTICE_GRACE_MS);
    expect(w.graceEnded).toEqual([]);
  });

  it('消えなければ、15 秒で 1 回だけ出させる', async () => {
    waitPerm('s1');
    await tick(NOTICE_GRACE_MS - 1);
    expect(feed.held('s1')).toBe(true);
    await tick(1);
    expect(feed.held('s1')).toBe(false);
    expect(w.graceEnded).toEqual(['s1']);
    await tick(NOTICE_GRACE_MS * 2);
    expect(w.graceEnded).toEqual(['s1']);
  });

  it('統括が渡された文で busy になっても、猶予は続く', async () => {
    waitPerm('s1');
    await tick(300);
    expect(w.delivered).toHaveLength(1);
    expect(feed.held('s1')).toBe(true);
  });

  it('統括が無効、止まっている、busy のときは預からない', async () => {
    set('orch', { status: 'busy' });
    waitPerm('s1');
    expect(feed.held('s1')).toBe(false);

    set('s2', { status: 'busy' });
    gone('orch');
    waitPerm('s2');
    expect(feed.held('s2')).toBe(false);

    w.live.set('orch', row('orch', { status: 'idle' }));
    w.enabled = false;
    set('s3', { status: 'waiting', waitingFor: 'permission' });
    expect(feed.held('s3')).toBe(false);
  });

  it('質問の待ちは預からない', () => {
    set('s1', { status: 'waiting', waitingFor: 'question' });
    expect(feed.held('s1')).toBe(false);
  });
});

describe('文脈の太り', () => {
  it('閾値を超えて idle が 2 分続くと、/compact を 1 回だけ送る', async () => {
    w.tokens = COMPACT_TOKENS + 1;
    feed.onLiveChange();
    await tick(COMPACT_IDLE_MS - 1);
    expect(w.delivered).toEqual([]);
    await tick(1);
    expect(w.delivered).toEqual(['/compact']);
    // 縮んで idle に戻る前に、また見直しても送らない。
    orchIdle();
    await tick(COMPACT_IDLE_MS * 2);
    feed.onLiveChange();
    expect(w.delivered).toEqual(['/compact']);
  });

  it('閾値の内では送らず、預かりがある間も送らない', async () => {
    feed.onLiveChange();
    await tick(COMPACT_IDLE_MS * 2);
    expect(w.delivered).toEqual([]);

    w.tokens = COMPACT_TOKENS + 1;
    w.inputEmpty = false;
    waitPerm('s1');
    await tick(COMPACT_IDLE_MS * 2);
    feed.onLiveChange();
    expect(w.delivered).toEqual([]);
  });
});
