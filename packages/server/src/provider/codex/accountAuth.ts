import type { AccountAuthDto } from '@agent-hangar/shared';
import type { Account } from '../../config/accounts.ts';
import { PRIMARY_ACCOUNT_ID, type AgentUsageTracker } from '../../usage/agentUsage.ts';
import { codexAccounts, type CodexAccountRead, type CodexAccountService } from './account.ts';

/**
 * Codex のアカウントの認証の写し（計画の S5）。Claude の AccountAuth にあたる。
 * 「開くたびに、まだ読んでいないものだけ読む」（ensureChecked）。サーバの起動時には読まない。
 * 読んだとき、ログイン済みなら使用量（account/rateLimits）も読み、AgentUsageTracker にアカウントの id で入れる。
 * 読んだ chatgptAccountId から、「chatgptAccountId からアカウントの id」を引く表も持つ（hangar の外の会話の枠を結ぶ）。
 */
export class CodexAccountAuth {
  private readonly entries = new Map<string, { read: CodexAccountRead; checkedAt: number }>();
  private readonly inflight = new Map<string, Promise<void>>();
  private onChange: (() => void) | null = null;

  constructor(private readonly o: { service?: CodexAccountService; usage?: AgentUsageTracker; now?: () => number; log?: (line: string) => void } = {}) {}

  setOnChange(cb: () => void): void { this.onChange = cb; }

  private dirOf(a: Account): string | null { return a.id === PRIMARY_ACCOUNT_ID ? null : a.dir; }

  get(id: string): AccountAuthDto | null {
    const e = this.entries.get(id);
    return e ? { loggedIn: e.read.loggedIn, email: e.read.email, plan: e.read.plan, orgName: null, checkedAt: e.checkedAt } : null;
  }

  /** まだ読んでいなければ、裏で読む。終わったら onChange で知らせる。 */
  ensureChecked(a: Account): void {
    if (this.entries.has(a.id) || this.inflight.has(a.id)) return;
    void this.refresh(a);
  }

  /** 読み直す。読めなかったときは前の写しを保ち、投げない。 */
  refresh(a: Account): Promise<void> {
    const prior = this.inflight.get(a.id);
    if (prior) return prior;
    const svc = this.o.service ?? codexAccounts;
    const now = this.o.now ?? Date.now;
    const p = (async () => {
      try {
        const read = await svc.readAccount(this.dirOf(a));
        this.entries.set(a.id, { read, checkedAt: now() });
        if (read.loggedIn && this.o.usage) {
          try {
            const w = await svc.readRateLimits(this.dirOf(a));
            if (w) this.o.usage.set('codex', w, now(), a.id);
          } catch (e) { this.o.log?.(`[codex] rate limits of ${a.id}: ${e instanceof Error ? e.message : String(e)}`); }
        }
      } catch (e) {
        this.o.log?.(`[codex] account/read of ${a.id}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.inflight.delete(a.id);
        this.onChange?.();
      }
    })();
    this.inflight.set(a.id, p);
    return p;
  }

  forget(id: string): void {
    this.entries.delete(id);
  }

  /** 読んだ chatgptAccountId からアカウントの id を引く。まだ読んでいなければ null。 */
  accountOfChatgptId(chatgptAccountId: string): string | null {
    for (const [id, e] of this.entries) if (e.read.chatgptAccountId === chatgptAccountId) return id;
    return null;
  }
}
