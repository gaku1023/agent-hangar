import { describe, expect, it } from 'vitest';
import { withFetchSyncDiagnostics } from './harness.ts';

describe('withFetchSyncDiagnostics（miniflare の同期 fetch の突き合わせの失敗に、原因の手掛かりを足す）', () => {
  const miniflareFailure = () => {
    const e = new Error('The expression evaluated to a falsy value:\n\n  (message?.id === id)\n');
    e.name = 'AssertionError';
    return e;
  };

  it('prepare を引く所で miniflare の突き合わせが落ちたら、場所と負荷の手掛かりを足して投げ直す', () => {
    const db = {
      get prepare(): never {
        throw miniflareFailure();
      },
    };
    const wrapped = withFetchSyncDiagnostics(db as never, 'DB');
    let caught: Error | undefined;
    try {
      void (wrapped as { prepare: unknown }).prepare;
    } catch (e) {
      caught = e as Error;
    }
    expect(caught?.message).toContain('message?.id === id');
    expect(caught?.message).toContain('DB.prepare');
    expect(caught?.message).toMatch(/loadavg=/);
    expect(caught?.message).toMatch(/node=v\d+/);
    expect(caught?.cause).toBeInstanceOf(Error);
  });

  it('ふつうの値と、ほかの失敗はそのまま通す', () => {
    const boom = new Error('別の失敗');
    const db = {
      value: 7,
      get bad(): never {
        throw boom;
      },
      fn() {
        return this === db ? 'ok' : 'unbound';
      },
    };
    const wrapped = withFetchSyncDiagnostics(db as never, 'DB') as typeof db;
    expect(wrapped.value).toBe(7);
    expect(() => wrapped.bad).toThrow(boom);
    expect(wrapped.fn()).toBe('ok');
  });
});
