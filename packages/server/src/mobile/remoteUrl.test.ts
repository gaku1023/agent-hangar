import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { FakeTimers } from '../../test/fake-timers.ts';
import { extractRemoteUrl, REMOTE_URL_EVERY_MS, REMOTE_URL_FOR_MS, saveRemoteUrl, watchRemoteUrl } from './remoteUrl.ts';

const URL_A = 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv';

/** claude 2.1.301 を --remote-control で起こした直後の見出し（題と場所は作り物）。 */
const HEADER = [
  ' ▐▛███▜▌   Claude Code v2.1.301',
  '▝▜█████▛▘  Opus 5.5 · Claude Max',
  '  ▘▘ ▝▝    ~/w/project-a · /rc active',
  `           /remote-control is active · Continue here, on your phone, or at ${URL_A}`,
  '',
];

/** 幅 width の端末の画面。入力欄の罫線は幅いっぱいに引かれる。 */
const screenOf = (width: number): string[] => [...HEADER, '─'.repeat(width), '❯ ', '─'.repeat(width)];

/** 幅 width で折り返した画面（-J なしの capture-pane の形。折り返しの続きは行頭から始まる）。 */
function wrap(lines: string[], width: number): string {
  return lines.flatMap((l) => {
    if (l.length <= width) return [l];
    const out: string[] = [];
    for (let i = 0; i < l.length; i += width) out.push(l.slice(i, i + width));
    return out;
  }).join('\n');
}

describe('extractRemoteUrl', () => {
  it('見出しの /remote-control の行から URL を取り出す（-J でつないだ画面）', () => {
    expect(extractRemoteUrl(screenOf(120).join('\n'))).toBe(URL_A);
    expect(extractRemoteUrl(screenOf(80).join('\n'))).toBe(URL_A);
  });

  it('URL の無い画面は null', () => {
    expect(extractRemoteUrl(' ▐▛███▜▌   Claude Code v2.1.301\n  ▘▘ ▝▝    ~/w/project-a · /rc\n\n❯ ')).toBeNull();
    expect(extractRemoteUrl('')).toBeNull();
  });

  it('claude.ai に似せた偽の行は null', () => {
    expect(extractRemoteUrl('Continue here, on your phone, or at https://claude.ai.evil.example/code/x')).toBeNull();
    expect(extractRemoteUrl('Continue at https://claude.ai.evil.example/code/session_01AbCd')).toBeNull();
    expect(extractRemoteUrl('Continue at http://claude.ai/code/session_01AbCd')).toBeNull();
    expect(extractRemoteUrl('Continue at https://claude.ai@evil.example/code/session_01AbCd')).toBeNull();
  });

  it('いちばん下（新しい）の URL を返す', () => {
    const b = 'https://claude.ai/code/session_02ZyXwVuTsRqPoNmLkJiHgFe';
    expect(extractRemoteUrl(`${HEADER.join('\n')}\n           /remote-control is active · Continue here, on your phone, or at ${b}`)).toBe(b);
  });

  it('折り返しで途中に改行の入った URL を、端末の幅を渡したときにつないで読む（-J の無い psmux の画面）', () => {
    // URL は行の 75 字目から始まる。幅 80 は https の途中、100 は session の途中、106 は session_ の直後、64 は id の途中で切れる。
    // 幅 30 と 20 では URL が 3 行以上にまたがり、真ん中の行は URL の頭を持たない。
    for (const width of [20, 30, 64, 80, 100, 106]) {
      const screen = wrap(screenOf(width), width);
      expect(screen.split('\n').length).toBeGreaterThan(HEADER.length);
      expect([width, extractRemoteUrl(screen, width)]).toEqual([width, URL_A]);
      // 幅を渡さなければ（-J でつないだ画面のつもり）つながず、切れた URL は採らない。
      expect([width, extractRemoteUrl(screen)]).not.toEqual([width, URL_A]);
    }
  });

  it('幅いっぱいの行が完全な URL で終わり、次の行が `Tip: …` なら、つながない', () => {
    const full = `${'x'.repeat(10)} ${URL_A}`;
    expect(extractRemoteUrl(`${full}\nTip: run /help\n${'─'.repeat(full.length)}`, full.length)).toBe(URL_A);
    expect(extractRemoteUrl(`${full}\n  Tip: run /help`, full.length)).toBe(URL_A);
    expect(extractRemoteUrl(`${full}\n───────`, full.length)).toBe(URL_A);
    // 幅に届かない行は、続きが英数字だけでもつながない。
    expect(extractRemoteUrl(`  or at ${URL_A}\nTip\n${'─'.repeat(120)}`, 120)).toBe(URL_A);
  });

  it('-J でつないだ見出しの行は端末より長いが、幅を渡さないのでその後ろの行を飲み込まない', () => {
    // 幅 80 の端末。つないだ URL の行（130 字）がいちばん長く、次の行は英数字で始まる。
    const screen = [...HEADER.slice(0, 4), 'Tip: run /help', '─'.repeat(80)].join('\n');
    expect(extractRemoteUrl(screen)).toBe(URL_A);
  });

  it('`/remote-control is active` の行の URL を、ほかの行の URL より先に採る', () => {
    const other = 'https://claude.ai/code/session_09OtherLinkInTheChat';
    expect(extractRemoteUrl([...HEADER, `⏺ 前の会話で見た ${other}`, '❯ '].join('\n'))).toBe(URL_A);
    expect(extractRemoteUrl(`⏺ 前の会話で見た ${other}\n❯ `)).toBe(other);
  });
});

describe('watchRemoteUrl', () => {
  it('既定は 2 秒ごとに 60 秒まで', () => {
    expect(REMOTE_URL_EVERY_MS).toBe(2_000);
    expect(REMOTE_URL_FOR_MS).toBe(60_000);
  });

  it('3 回目の読みで見つかれば onFound が 1 回呼ばれ、以後は読まない', async () => {
    const timers = new FakeTimers();
    let reads = 0;
    const found: string[] = [];
    watchRemoteUrl({ capture: () => ({ text: ++reads >= 3 ? HEADER.join('\n') : ' ▐▛███▜▌   Claude Code', width: null }), onFound: (u) => found.push(u), timers });
    await timers.advance(4_000);
    expect([reads, found]).toEqual([2, []]);
    await timers.advance(2_000);
    expect([reads, found]).toEqual([3, [URL_A]]);
    await timers.advance(60_000);
    expect([reads, found]).toEqual([3, [URL_A]]);
    expect(timers.pendingCount()).toBe(0);
  });

  it('60 秒で諦める', async () => {
    const timers = new FakeTimers();
    let reads = 0;
    const found: string[] = [];
    watchRemoteUrl({ capture: () => { reads++; return { text: '', width: null }; }, onFound: (u) => found.push(u), timers });
    await timers.advance(120_000);
    expect(reads).toBe(30);
    expect(found).toEqual([]);
    expect(timers.pendingCount()).toBe(0);
  });

  it('読めなかった回（画面がまだ無い）は投げずに次を待つ', async () => {
    const timers = new FakeTimers();
    let reads = 0;
    const found: string[] = [];
    watchRemoteUrl({ capture: () => { if (++reads === 1) throw new Error('no pane'); return { text: HEADER.join('\n'), width: null }; }, onFound: (u) => found.push(u), timers, everyMs: 1_000, forMs: 5_000 });
    await timers.advance(2_000);
    expect(found).toEqual([URL_A]);
  });

  it('折り返したままの画面は、その幅でつないで読む', async () => {
    const timers = new FakeTimers();
    const found: string[] = [];
    watchRemoteUrl({ capture: () => ({ text: wrap(screenOf(64), 64), width: 64 }), onFound: (u) => found.push(u), timers });
    await timers.advance(2_000);
    expect(found).toEqual([URL_A]);
  });

  it('stop を返し、止めた後は読まない', async () => {
    const timers = new FakeTimers();
    let reads = 0;
    const stop = watchRemoteUrl({ capture: () => { reads++; return { text: '', width: null }; }, onFound: () => {}, timers });
    await timers.advance(2_000);
    stop();
    stop();
    await timers.advance(10_000);
    expect(reads).toBe(1);
    expect(timers.pendingCount()).toBe(0);
  });
});

describe('saveRemoteUrl', () => {
  it('会話ごとに最新の 1 つを残す', () => {
    const db = openDb(':memory:');
    saveRemoteUrl(db, 's1', URL_A, 10);
    saveRemoteUrl(db, 's1', 'https://claude.ai/code/session_02New', 20);
    saveRemoteUrl(db, 's2', URL_A, 30);
    expect(db.prepare('select session_id, url, at from run_remote_urls order by session_id').all()).toEqual([
      { session_id: 's1', url: 'https://claude.ai/code/session_02New', at: 20 },
      { session_id: 's2', url: URL_A, at: 30 },
    ]);
  });
});
