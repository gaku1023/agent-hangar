import { afterEach, describe, expect, it } from 'vitest';
import { COMPAT_HEADER, COMPAT_VERSION, nextUtcMidnight } from '@agent-hangar/shared';
import { createApp } from '../src/index.ts';
import type { Env } from '../src/env.ts';
import { d1LimitOfError, limitBody } from '../src/limits.ts';
import { resetSchemaCache } from '../src/schema.ts';

afterEach(() => { resetSchemaCache(); });

describe('D1 の上限の見分け', () => {
  it('読んだ行と書いた行の上限を、文から見分ける', () => {
    expect(d1LimitOfError(new Error('D1_ERROR: Exceeded free tier daily row read limit'))).toBe('d1-read');
    expect(d1LimitOfError(new Error('D1_ERROR: Exceeded free tier daily row write limit'))).toBe('d1-write');
  });

  it('大文字と小文字は問わず、原因（cause）の側の文も見る', () => {
    expect(d1LimitOfError(new Error('FREE TIER DAILY ROW WRITE LIMIT'))).toBe('d1-write');
    expect(d1LimitOfError(new Error('D1_ERROR', { cause: new Error('free tier daily row read limit exceeded') }))).toBe('d1-read');
  });

  it('ほかの失敗と、Error でない値は上限とみなさない', () => {
    for (const e of [new Error('D1_ERROR: no such table: files'), new Error('free tier'), 'free tier daily row write limit', null, undefined, 42]) {
      expect(d1LimitOfError(e), String(e)).toBeNull();
    }
  });

  it('原因が輪になっていても止まる', () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(d1LimitOfError(a)).toBeNull();
  });

  it('本文は上限の種類と戻る時刻を運ぶ', () => {
    const now = Date.parse('2026-10-08T06:48:00Z');
    expect(limitBody('d1-write', now)).toEqual({ error: 'limit', limit: 'd1-write', resetAt: Date.parse('2026-10-09T00:00:00Z') });
  });
});

describe('Worker の応答', () => {
  /** どの文も throw で返す D1 の立て替え。スキーマの用意（最初の batch）で倒れる。 */
  const failingEnv = (message: string): Env => ({
    DB: {
      prepare: () => { throw new Error(message); },
      batch: async () => { throw new Error(message); },
    } as unknown as D1Database,
    BUCKET: {} as R2Bucket,
  });
  const request = (env: Env) => createApp({ minDeviceCompat: 0 }).request('/changes?since=0', { headers: { [COMPAT_HEADER]: String(COMPAT_VERSION) } }, env);

  it('D1 の上限の失敗は 429 と、上限の種類と戻る時刻で返し、版の見出しも載せる', async () => {
    const before = nextUtcMidnight(Date.now());
    const r = await request(failingEnv('D1_ERROR: Exceeded free tier daily row write limit'));
    const after = nextUtcMidnight(Date.now());
    expect(r.status).toBe(429);
    expect(r.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    const body = (await r.json()) as { error: string; limit: string; resetAt: number };
    expect(body).toMatchObject({ error: 'limit', limit: 'd1-write' });
    expect([before, after]).toContain(body.resetAt);
  });

  it('読んだ行の上限も 429 にする', async () => {
    const r = await request(failingEnv('D1_ERROR: free tier daily row read limit'));
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ limit: 'd1-read' });
  });

  it('ほかの D1 の失敗は、いままでどおり 500 と一般化した 1 語で返す', async () => {
    const r = await request(failingEnv('D1_ERROR: no such table: files'));
    expect(r.status).toBe(500);
    const text = await r.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toContain('files');
  });
});

describe('Worker の応答（経路の中の失敗）', () => {
  const LIMIT_MESSAGE = 'D1_ERROR: Exceeded free tier daily row write limit';
  const device = { id: 'dev-a', name: 'a', platform: 'darwin', token_hash: 'x', joined_at: 0, last_seen_at: null, last_pulled_seq: 0 };

  /**
   * スキーマの用意と認証は通り、`failOn` に当たる文だけが上限の失敗を投げる D1 の立て替えである。
   * 通る文は空の結果を返す。
   */
  const envFailingOn = (failOn: (sql: string) => boolean): Env => {
    const stmt = (sql: string) => {
      const s = {
        sql,
        bind: () => s,
        first: async () => {
          if (failOn(sql)) throw new Error(LIMIT_MESSAGE);
          return sql.includes('from devices where token_hash') ? device : null;
        },
        all: async () => {
          if (failOn(sql)) throw new Error(LIMIT_MESSAGE);
          return { results: [] };
        },
        run: async () => {
          if (failOn(sql)) throw new Error(LIMIT_MESSAGE);
          return { meta: { rows_written: 0 } };
        },
      };
      return s;
    };
    return {
      DB: {
        prepare: (sql: string) => stmt(sql),
        batch: async (stmts: { sql: string }[]) => {
          if (stmts.some((x) => failOn(x.sql))) throw new Error(LIMIT_MESSAGE);
          return stmts.map(() => ({ results: [], meta: { rows_written: 0 } }));
        },
      } as unknown as D1Database,
      BUCKET: {} as R2Bucket,
    };
  };

  const expectLimitResponse = async (r: Response) => {
    const before = nextUtcMidnight(Date.now());
    expect(r.status).toBe(429);
    expect(r.headers.get(COMPAT_HEADER)).toBe(String(COMPAT_VERSION));
    const body = (await r.json()) as { error: string; limit: string; resetAt: number };
    const after = nextUtcMidnight(Date.now());
    expect(body).toMatchObject({ error: 'limit', limit: 'd1-write' });
    expect([before, after]).toContain(body.resetAt);
  };

  const headers = { [COMPAT_HEADER]: String(COMPAT_VERSION), authorization: 'Bearer token-a', 'content-type': 'application/json' };

  it('POST /changes の中の batch が上限の失敗を投げても 429 で返す', async () => {
    const env = envFailingOn((sql) => sql.includes('insert into changes'));
    const body = JSON.stringify({ changes: [{ tableName: 'projects', rowId: 'p1', op: 'upsert', payload: { id: 'p1' }, updatedAt: 1 }] });
    const r = await createApp({ minDeviceCompat: 0 }).request('/changes', { method: 'POST', headers, body }, env);
    await expectLimitResponse(r);
  });

  it('認証の中間処理の D1 の読みが上限の失敗を投げても 429 で返す', async () => {
    const env = envFailingOn((sql) => sql.includes('from devices where token_hash'));
    const r = await createApp({ minDeviceCompat: 0 }).request('/changes?since=0', { headers }, env);
    await expectLimitResponse(r);
  });
});
