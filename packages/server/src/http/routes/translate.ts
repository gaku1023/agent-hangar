import type { Hono } from 'hono';
import type { TranslateResultDto } from '@agent-hangar/shared';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

export type TranslateRouteDeps = Pick<AppDeps, 'translate'> & LanguageDeps;

/**
 * AI の英語の返答と思考を訳す口（docs/design.md「英語の返答の翻訳」）。
 * POST /translate に { text } を送ると TranslateResultDto を返す。訳せないとき（設定が切、plamo-translate が無い、失敗）も 200 で理由を返し、画面は原文のまま見せる。
 */
export function translateRoutes(api: Hono, deps: TranslateRouteDeps): void {
  const tr = translatorOf(deps.language);
  api.post('/translate', async (c) => {
    const b = await readJson(c, BODY_LIMITS.memo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo, tr);
    const text = (b.value as { text?: unknown } | undefined)?.text;
    if (typeof text !== 'string') return c.json({ error: tr('common.field.mustBeString', { field: 'text' }) }, 400);
    const res: TranslateResultDto = deps.translate ? await deps.translate.translate(text) : { status: 'unavailable' };
    return c.json(res);
  });
}
