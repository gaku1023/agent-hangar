import type { Hono } from 'hono';
import { touchRow } from '../../db/notify.ts';
import { aggregateUsage } from '../../usage/aggregate.ts';
import { buildAccountsDto } from '../accounts.ts';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, readBody, tooLargeResult } from './common.ts';

/** 使用量の経路が使う依存。 */
export type UsageRouteDeps = Pick<AppDeps, 'db' | 'usage' | 'accounts'>;

/** 使用量の経路。statusline の受け口と、今の使用量、日ごとの集計を持つ。 */
export function usageRoutes(api: Hono, deps: UsageRouteDeps): void {
  const { db } = deps;
  const accountsDeps = deps.accounts;

  // 使用量。statusline スクリプトが curl で送る。他の /api と同じ Bearer 認証を通す。
  api.post('/ingest/statusline', async (c) => {
    const text = await readBody(c, BODY_LIMITS.statusline);
    if (text === null) return tooLargeResult(c, BODY_LIMITS.statusline);
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return c.json({ error: '本文が JSON ではありません' }, 400); }
    const r = deps.usage.ingest(raw);
    if (!r) return c.json({ error: 'statusline の payload の形が違います' }, 400);
    // 使用率は、動かしたアカウントの値として accounts.update で配る。最初のアカウントも同じ道で届く。
    if (r.usageChanged) accountsDeps.broadcast(buildAccountsDto(accountsDeps));
    if (r.providerSessionId) {
      // 受けた値は手元だけの表（session_live_stats）に入る。セッションの行は変わらないが中身（モデル、文脈の量）が変わるので、名指しして配り直してもらう。
      const s = db.prepare("select id from sessions where provider = 'claude-code' and provider_session_id = ? and deleted_at is null").get(r.providerSessionId) as { id: string } | undefined;
      if (s) touchRow(db, 'sessions', s.id);
    }
    return c.body(null, 204);
  });
  api.get('/usage', (c) => c.json(deps.usage.current()));
  api.get('/usage/aggregate', (c) => {
    const raw = c.req.query('days');
    const days = raw === undefined ? 30 : Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > 365) return c.json({ error: 'days は 1 から 365 の整数です' }, 400);
    return c.json(aggregateUsage(db, { days }));
  });
}
