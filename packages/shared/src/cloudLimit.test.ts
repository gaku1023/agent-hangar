import { describe, expect, it } from 'vitest';
import { d1LimitOf, D1_LIMIT_MESSAGES, nextUtcMidnight, readCloudLimit } from './cloudLimit.ts';
import * as shared from './index.ts';

describe('上限の失敗を読む', () => {
  it('パッケージの入口から取れる', () => {
    expect(shared.readCloudLimit).toBe(readCloudLimit);
    expect(shared.nextUtcMidnight).toBe(nextUtcMidnight);
  });

  it('戻る時刻は次の UTC の 0 時で、ちょうど 0 時なら翌日の 0 時', () => {
    expect(nextUtcMidnight(Date.UTC(2026, 9, 8, 23, 59, 59, 999))).toBe(Date.UTC(2026, 9, 9));
    expect(nextUtcMidnight(Date.UTC(2026, 9, 9))).toBe(Date.UTC(2026, 9, 10));
    expect(nextUtcMidnight(Date.UTC(2026, 11, 31, 12))).toBe(Date.UTC(2027, 0, 1));
  });

  it('D1 の失敗のメッセージから、読みと書きの上限を見分ける', () => {
    expect(d1LimitOf(`D1_ERROR: Exceeded ${D1_LIMIT_MESSAGES['d1-read']}`)).toBe('d1-read');
    expect(d1LimitOf(`D1_ERROR: Exceeded ${D1_LIMIT_MESSAGES['d1-write']}`)).toBe('d1-write');
    expect(d1LimitOf('D1_ERROR: no such table')).toBeNull();
  });

  it('Worker の 429 と上限の本文を読む（段 1 の PR 6 から）', () => {
    expect(readCloudLimit(429, JSON.stringify({ error: 'limit', limit: 'd1-write', resetAt: 1 }))).toBe('d1-write');
    expect(readCloudLimit(429, JSON.stringify({ error: 'limit', limit: 'requests', resetAt: 1 }))).toBe('requests');
    // 429 でない、種類が知らないもの、形が違うものは上限として読まない。
    expect(readCloudLimit(500, JSON.stringify({ error: 'limit', limit: 'd1-read', resetAt: 1 }))).toBeNull();
    expect(readCloudLimit(429, JSON.stringify({ error: 'limit', limit: 'other', resetAt: 1 }))).toBeNull();
  });

  it('本文に D1 の上限のメッセージがあれば、状態番号と形を問わずに読む', () => {
    expect(readCloudLimit(500, JSON.stringify({ error: `D1_ERROR: ${D1_LIMIT_MESSAGES['d1-read']}` }))).toBe('d1-read');
    expect(readCloudLimit(503, `D1_ERROR: ${D1_LIMIT_MESSAGES['d1-write']}`)).toBe('d1-write');
  });

  it('JSON でなく 1027 を含む本文は、Workers の 1 日の要求の上限として読む', () => {
    expect(readCloudLimit(429, 'error code: 1027')).toBe('requests');
    expect(readCloudLimit(403, `<html>${'x'.repeat(300)}<p>Error 1027</p></html>`)).toBe('requests');
  });

  it('上限でないものは null（例外も投げない）', () => {
    const cases: [number, string][] = [
      [200, 'error code: 1027'],
      [500, '{"error":"internal error"}'],
      [500, '{"code":1027}'],
      [429, 'too many'],
      [502, 'ray 8a1027f'],
      [500, ''],
      [404, 'nonsense'],
    ];
    for (const [s, t] of cases) expect(readCloudLimit(s, t), `${s} ${t}`).toBeNull();
  });
});
