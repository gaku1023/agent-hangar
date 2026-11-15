import { isOrchestratorOrigin, markOrchestratorText, VOICE_WINDOW_MARK, type OrchestratorOrigin } from '@agent-hangar/shared';
import type { Hono } from 'hono';
import { noteWeakTurn } from '../../orchestrator/turnMark.ts';
import { translatorOf } from '../../i18n/message.ts';
import { sanitizeInput } from '../../mcp/screenTools.ts';
import { noteTurnStart } from '../../mcp/waitTool.ts';
import { listAutoApprovals } from '../../orchestrator/autoApprovals.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

/** 統括の柱が使う経路の依存。 */
export type OrchestratorRouteDeps = Pick<AppDeps, 'db' | 'settings' | 'runs'> & LanguageDeps;

export type SendToOrchestratorResult = { ok: true } | { ok: false; status: 400 | 409 | 500; error: string };

/**
 * 統括の会話へ 1 本の文を送る。柱の入力欄の経路と、声のサービスが同じ道を通る。
 * 頭の印は由来からここで付け直し（端末や声の補助からは受けない）、弱い声は索引が読む前から弱いターンと残す。
 */
export async function sendToOrchestrator(deps: OrchestratorRouteDeps, text: string, origin: OrchestratorOrigin): Promise<SendToOrchestratorResult> {
  const tr = translatorOf(deps.language);
  // 頭の印は端末から受けず、由来からサーバが付け直す。出来事や強い声を名乗らせないためである。
  const marked = markOrchestratorText(text, origin);
  if (marked === '') return { ok: false, status: 400, error: tr('common.field.required', { field: 'text' }) };
  const sessionId = deps.settings().orchestrator?.sessionId ?? null;
  const run = sessionId ? deps.runs.listAlive().runs.find((r) => r.sessionId === sessionId) : undefined;
  if (!sessionId || !run) return { ok: false, status: 409, error: tr('orchestratorPane.error.notRunning') };
  // 届ける前に残す。mcp の send_to_session と同じで、wait_for_session が前のターンの idle を終わりと読まないためである。
  noteTurnStart(deps.db, sessionId, { at: Date.now() });
  // 弱い声は、索引がこの文を読む前から弱いターンと読ませる（orchestrator/turnMark.ts）。
  if (marked.startsWith(VOICE_WINDOW_MARK)) noteWeakTurn(deps.db, sessionId);
  try {
    await deps.runs.sendInput(run.tmuxName, sanitizeInput(marked), true);
  } catch (e) {
    return { ok: false, status: 500, error: tr('orchestratorPane.error.sendFailed', { reason: e instanceof Error ? e.message : String(e) }) };
  }
  return { ok: true };
}

/**
 * 統括の柱の口。
 * GET /orchestrator/approvals は自動許可の記録（新しい順）、POST /orchestrator/send は柱の入力欄の文を統括の窓へ送る。
 * 送るのは統括の会話だけで、ほかの会話へは送れない（宛先は設定の orchestrator.sessionId で、本文からは受けない）。
 */
export function orchestratorRoutes(api: Hono, deps: OrchestratorRouteDeps): void {
  const tr = translatorOf(deps.language);

  api.get('/orchestrator/approvals', (c) => {
    const limit = Number(c.req.query('limit'));
    const since = Number(c.req.query('since'));
    return c.json({ approvals: listAutoApprovals(deps.db, { ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), ...(Number.isFinite(since) && since > 0 ? { since } : {}) }) });
  });

  api.post('/orchestrator/send', async (c) => {
    const b = await readJson(c, BODY_LIMITS.memo);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo, tr);
    const body = b.value as { text?: unknown; origin?: unknown } | null | undefined;
    const text = body?.text;
    if (typeof text !== 'string') return c.json({ error: tr('common.field.mustBeString', { field: 'text' }) }, 400);
    // 由来（docs/design.md「統括」の安全の境界）。省けば打鍵とみなし、知らない値は断る。
    const origin = body?.origin === undefined ? 'typed' : body.origin;
    if (!isOrchestratorOrigin(origin)) return c.json({ error: tr('settings.error.badValue', { label: 'origin' }) }, 400);
    const r = await sendToOrchestrator(deps, text, origin);
    if (!r.ok) return c.json({ error: r.error }, r.status);
    return c.json({ ok: true });
  });
}
