import { describe, expect, it } from 'vitest';
import type { Account } from '../../config/accounts.ts';
import { AgentUsageTracker } from '../../usage/agentUsage.ts';
import type { CodexAccountService } from './account.ts';
import { CodexAccountAuth } from './accountAuth.ts';

const acct = (id: string): Account => ({ id, name: id, dir: `/x/.codex-${id}`, color: '#000000' });
const fakeSvc = (reads: Record<string, unknown>) => {
  const dirs: (string | null)[] = [];
  const svc = {
    readAccount: async (dir: string | null) => { dirs.push(dir); return reads[dir ?? 'null'] as never; },
    readRateLimits: async () => ({ fiveHour: { usedPercent: 5, resetsAt: null }, sevenDay: null, plan: 'plus' }),
  } as unknown as CodexAccountService;
  return { svc, dirs };
};

describe('CodexAccountAuth', () => {
  it('読んでいないものだけ読み、最初のアカウントは dir null で読む', async () => {
    const { svc, dirs } = fakeSvc({ null: { loggedIn: true, email: 'a@x', plan: 'plus', chatgptAccountId: 'cg-1' } });
    const usage = new AgentUsageTracker();
    const auth = new CodexAccountAuth({ service: svc, usage, now: () => 10 });
    const primary = acct('primary');
    expect(auth.get('primary')).toBeNull();
    auth.ensureChecked(primary);
    auth.ensureChecked(primary);
    await auth.refresh(primary);
    auth.ensureChecked(primary);
    expect(dirs).toEqual([null]);
    expect(auth.get('primary')).toEqual({ loggedIn: true, email: 'a@x', plan: 'plus', orgName: null, checkedAt: 10 });
    expect(usage.of('codex', 'primary')?.fiveHour?.usedPercent).toBe(5);
    expect(auth.accountOfChatgptId('cg-1')).toBe('primary');
    expect(auth.accountOfChatgptId('zz')).toBeNull();
  });
  it('読めなかったら写しを作らず、投げず、変化は知らせる', async () => {
    const svc = { readAccount: async () => { throw new Error('boom'); }, readRateLimits: async () => null } as unknown as CodexAccountService;
    let n = 0;
    const auth = new CodexAccountAuth({ service: svc });
    auth.setOnChange(() => { n++; });
    await auth.refresh(acct('b'));
    expect(auth.get('b')).toBeNull();
    expect(n).toBe(1);
  });
  it('forget で写しを捨てる', async () => {
    const { svc } = fakeSvc({ '/x/.codex-b': { loggedIn: false, email: null, plan: null, chatgptAccountId: null } });
    const auth = new CodexAccountAuth({ service: svc });
    await auth.refresh(acct('b'));
    expect(auth.get('b')?.loggedIn).toBe(false);
    auth.forget('b');
    expect(auth.get('b')).toBeNull();
  });
});
