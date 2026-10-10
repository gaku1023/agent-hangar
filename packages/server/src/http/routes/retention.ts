import type { Hono } from 'hono';
import { LOCK_BUSY_MESSAGE } from '../../config/claudeFileWrite.ts';
import { JsonTextEditError } from '../../config/jsonTextEdit.ts';
import { RetentionConflictError, RetentionUnwritableError } from '../../config/retention.ts';
import type { AppDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

/** 保持期間の経路が使う依存。 */
export type RetentionRouteDeps = Pick<AppDeps, 'retention'>;

/** Claude Code の保持期間の経路。今の値、書く前の下見、書き込みを持つ。 */
export function retentionRoutes(api: Hono, deps: RetentionRouteDeps): void {
  /** 保持期間として受け付ける値。Claude Code は 1 未満を弾く。上は 100 年で切り、打ち間違いの桁あふれを通さない。 */
  const retentionDays = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 36500 ? v : null);
  const BAD_DAYS = '保持期間は 1 以上 36500 以下の整数で指定してください';

  api.get('/retention', (c) => c.json(deps.retention.current()));
  api.post('/retention/preview', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const days = retentionDays((b.value as { days?: unknown } | null)?.days);
    if (days === null) return c.json({ error: BAD_DAYS }, 400);
    try {
      return c.json(deps.retention.preview(days));
    } catch (e) {
      if (e instanceof JsonTextEditError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
  api.put('/retention', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default);
    const body = (b.value ?? {}) as { days?: unknown; baseSha256?: unknown };
    const days = retentionDays(body.days);
    if (days === null) return c.json({ error: BAD_DAYS }, 400);
    if (typeof body.baseSha256 !== 'string') return c.json({ error: '下見の指紋がありません' }, 400);
    try {
      return c.json(deps.retention.write(days, body.baseSha256));
    } catch (e) {
      if (e instanceof RetentionConflictError) return c.json({ error: 'retention_conflict' }, 409);
      if (e instanceof JsonTextEditError || e instanceof RetentionUnwritableError || (e instanceof Error && e.message === LOCK_BUSY_MESSAGE)) return c.json({ error: e.message }, 400);
      throw e;
    }
  });
}
