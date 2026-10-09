import type { Hono } from 'hono';
import { LOCK_BUSY_MESSAGE } from '../../provider/claude-code/config/claudeFileWrite.ts';
import { JsonTextEditError } from '../../config/jsonTextEdit.ts';
import { RetentionConflictError, RetentionUnwritableError } from '../../provider/claude-code/config/retention.ts';
import { errorText, translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

/** 保持期間の経路が使う依存。 */
export type RetentionRouteDeps = Pick<AppDeps, 'retention'> & LanguageDeps;

/** Claude Code の保持期間の経路。今の値、書く前の下見、書き込みを持つ。 */
export function retentionRoutes(api: Hono, deps: RetentionRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  /** 保持期間として受け付ける値。Claude Code は 1 未満を弾く。上は 100 年で切り、打ち間違いの桁あふれを通さない。 */
  const retentionDays = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 36500 ? v : null);
  const badDays = () => tr('retention.days.invalid');

  api.get('/retention', (c) => c.json(deps.retention.current()));
  api.post('/retention/preview', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const days = retentionDays((b.value as { days?: unknown } | null)?.days);
    if (days === null) return c.json({ error: badDays() }, 400);
    try {
      return c.json(deps.retention.preview(days));
    } catch (e) {
      if (e instanceof JsonTextEditError) return c.json({ error: errorText(language(), e) }, 400);
      throw e;
    }
  });
  api.put('/retention', async (c) => {
    const b = await readJson(c, BODY_LIMITS.default);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const body = (b.value ?? {}) as { days?: unknown; baseSha256?: unknown };
    const days = retentionDays(body.days);
    if (days === null) return c.json({ error: badDays() }, 400);
    if (typeof body.baseSha256 !== 'string') return c.json({ error: tr('retention.preview.fingerprintMissing') }, 400);
    try {
      return c.json(deps.retention.write(days, body.baseSha256));
    } catch (e) {
      if (e instanceof RetentionConflictError) return c.json({ error: 'retention_conflict' }, 409);
      if (e instanceof JsonTextEditError || e instanceof RetentionUnwritableError || (e instanceof Error && e.message === LOCK_BUSY_MESSAGE)) return c.json({ error: errorText(language(), e) }, 400);
      throw e;
    }
  });
}
