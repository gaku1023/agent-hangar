import type { Hono } from 'hono';
import type { ScheduleTarget } from '@agent-hangar/shared';
import { MessageError, msg, render, translatorOf } from '../../i18n/message.ts';
import { getSession } from '../../db/queries.ts';
import { createSchedule, deleteSchedule, getSchedule, listSchedules, updateSchedule } from '../../schedule/store.ts';
import { parseSpec } from '../../schedule/timing.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { readJson, tooLargeResult } from './common.ts';

export type ScheduleRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'schedules'> & LanguageDeps;
const BODY_LIMIT = 64 * 1024;

/** 予定の経路。一覧の更新は表の知らせで配るので、ここの返り値は画面の正にしない。 */
export function scheduleRoutes(api: Hono, deps: ScheduleRouteDeps): void {
  const { db, deviceId } = deps;
  const tr = translatorOf(deps.language);
  const lang = () => deps.language();

  /** 宛先を検査し、予定が属するプロジェクトも決める。 */
  const targetOf = (v: unknown): { target: ScheduleTarget; projectId: string | null } => {
    const o = (v ?? {}) as { kind?: unknown; projectId?: unknown; sessionId?: unknown; agent?: unknown };
    if (o.kind === 'session' && typeof o.sessionId === 'string') {
      const s = getSession(db, deps.live(), o.sessionId, { deviceId });
      if (!s) throw new MessageError(msg('mcp.error.sessionNotFound', { id: o.sessionId }));
      return { target: { kind: 'session', sessionId: o.sessionId }, projectId: s.projectId };
    }
    if (o.kind === 'new' && typeof o.projectId === 'string') {
      return { target: { kind: 'new', projectId: o.projectId, ...(typeof o.agent === 'string' ? { agent: o.agent } : {}) }, projectId: o.projectId };
    }
    throw new MessageError(msg('schedules.error.target'));
  };
  const fail = (e: unknown): { error: string } | null => (e instanceof MessageError ? { error: e.text ? render(lang(), e.text) : e.message } : null);

  api.get('/schedules', (c) => c.json({ schedules: listSchedules(db, deviceId) }));

  api.post('/schedules', async (c) => {
    const b = await readJson(c, BODY_LIMIT);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMIT, tr);
    const body = (b.value ?? {}) as { prompt?: unknown; spec?: unknown; target?: unknown };
    const now = Date.now();
    try {
      return c.json(createSchedule(db, { deviceId, prompt: typeof body.prompt === 'string' ? body.prompt : '', spec: parseSpec(body.spec, now), ...targetOf(body.target), fromSessionId: null, now }));
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f, 400);
      throw e;
    }
  });

  api.patch('/schedules/:id', async (c) => {
    const id = c.req.param('id');
    if (!getSchedule(db, deviceId, id)) return c.json({ error: tr('schedules.error.notFound', { id }) }, 404);
    const b = await readJson(c, BODY_LIMIT);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMIT, tr);
    const body = (b.value ?? {}) as { prompt?: unknown; spec?: unknown; target?: unknown; enabled?: unknown };
    const now = Date.now();
    try {
      return c.json(updateSchedule(db, id, {
        ...(typeof body.prompt === 'string' ? { prompt: body.prompt } : {}),
        ...(body.spec !== undefined ? { spec: parseSpec(body.spec, now) } : {}),
        ...(body.target !== undefined ? targetOf(body.target) : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      }, now));
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f, 400);
      throw e;
    }
  });

  api.delete('/schedules/:id', (c) => {
    const id = c.req.param('id');
    if (!getSchedule(db, deviceId, id)) return c.json({ error: tr('schedules.error.notFound', { id }) }, 404);
    return c.json({ ok: deleteSchedule(db, id) });
  });

  api.post('/schedules/:id/run', (c) => {
    const id = c.req.param('id');
    const outcome = deps.schedules.runNow(id);
    if (outcome === 'missing') return c.json({ error: tr('schedules.error.notFound', { id }) }, 404);
    return c.json({ outcome });
  });
}
