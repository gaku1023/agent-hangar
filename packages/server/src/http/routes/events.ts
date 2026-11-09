import type { Hono } from 'hono';
import type { EventAction, EventSource, HeldEventDto } from '@agent-hangar/shared';
import { getSession } from '../../db/queries.ts';
import type { HeldChoice } from '../../event/dispatcher.ts';
import type { BindingPatchInput } from '../../event/service.ts';
import { approveClaim, hasClaim, listDraftClaims, rejectClaim } from '../../event/store.ts';
import { sessionTitleOf } from '../../mobile/feed.ts';
import { parseAllowAuthors, parsePassBody, parsePrompt, parseSource, REPO_RE } from '../../event/validate.ts';
import { errorText, MessageError, msg, render, translatorOf } from '../../i18n/message.ts';
import { parseNewTarget } from '../../schedule/target.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { readJson, tooLargeResult } from './common.ts';

export type EventRouteDeps = Pick<AppDeps, 'db' | 'deviceId' | 'live' | 'runs' | 'events'> & LanguageDeps;
const BODY_LIMIT = 64 * 1024;
const HELD_MODES: readonly HeldChoice['mode'][] = ['latest', 'all', 'skip'];

/**
 * 外のできごとで動く結び付けの経路（#563）。
 * 作る、承認する、消す、外の webhook の URL を見る、閉じている間に溜まったできごとを流す、repo の webhook の状態を見る。
 * webhook を付けられなかったとき（権限が無い、gh や Worker が使えない）は、HTTP 200 で `{ hook: { status, message? } }` を返し、何も作らない。
 * 秘密（webhook の秘密の値、受け箱の鍵）はどの応答にも載せない。外の webhook の URL は `GET /events/bindings/:id/hook-url` だけが返す。
 * run に配る MCP の秘密は /api を開けないので、この経路は画面だけが使う。
 */
export function eventRoutes(api: Hono, deps: EventRouteDeps): void {
  const { db, deviceId } = deps;
  const tr = translatorOf(deps.language);
  const lang = () => deps.language();
  const svc = () => deps.events.bindings;
  const fail = (e: unknown): { error: string } | null => (e instanceof MessageError ? { error: e.text ? render(lang(), e.text) : e.message } : null);
  const notFound = () => ({ error: tr('schedules.event.error.notFound') });

  /** 動きを検査する。起こす（wake）は Paused の確定からだけ作るので、ここでは受けない。 */
  const actionOf = (v: unknown, source: EventSource): EventAction => {
    const o = (typeof v === 'object' && v !== null ? v : {}) as { kind?: unknown; sessionId?: unknown };
    if (o.kind === 'send' && typeof o.sessionId === 'string') {
      if (!getSession(db, deps.live(), o.sessionId, { deviceId })) throw new MessageError(msg('mcp.error.sessionNotFound', { id: o.sessionId }));
      return { kind: 'send', sessionId: o.sessionId };
    }
    if (o.kind === 'send_pr_owner') {
      if (source.kind !== 'github') throw new MessageError(msg('schedules.event.error.invalid'));
      return { kind: 'send_pr_owner' };
    }
    if (o.kind === 'new') return parseNewTarget(v, (a) => deps.runs.agentEnabled?.(a) ?? false) as EventAction;
    throw new MessageError(msg('schedules.event.error.invalid'));
  };

  api.get('/events/bindings', (c) => c.json({ bindings: svc().list() }));

  api.post('/events/bindings', async (c) => {
    const b = await readJson(c, BODY_LIMIT);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMIT, tr);
    const body = (b.value ?? {}) as { source?: unknown; action?: unknown; prompt?: unknown; passBody?: unknown; allowAuthors?: unknown };
    try {
      const source = parseSource(body.source);
      const action = actionOf(body.action, source);
      return c.json(await svc().create({ source, action, prompt: parsePrompt(body.prompt), passBody: parsePassBody(body.passBody), allowAuthors: parseAllowAuthors(body.allowAuthors) }));
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f, 400);
      throw e;
    }
  });

  api.patch('/events/bindings/:id', async (c) => {
    const id = c.req.param('id');
    const b = await readJson(c, BODY_LIMIT);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMIT, tr);
    const body = (b.value ?? {}) as { prompt?: unknown; passBody?: unknown; allowAuthors?: unknown; state?: unknown };
    try {
      if (body.state !== undefined && body.state !== 'active') throw new MessageError(msg('schedules.event.error.badState'));
      const patch: BindingPatchInput = {
        ...(body.prompt !== undefined ? { prompt: parsePrompt(body.prompt) } : {}),
        ...(body.passBody !== undefined ? { passBody: parsePassBody(body.passBody) } : {}),
        ...(body.allowAuthors !== undefined ? { allowAuthors: parseAllowAuthors(body.allowAuthors) } : {}),
        ...(body.state === 'active' ? { state: 'active' as const } : {}),
      };
      return c.json(await svc().update(id, patch));
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f, e instanceof MessageError && e.text?.key === 'schedules.event.error.notFound' ? 404 : 400);
      throw e;
    }
  });

  api.delete('/events/bindings/:id', (c) => {
    if (!svc().remove(c.req.param('id'))) return c.json(notFound(), 404);
    return c.json({ ok: true });
  });

  api.post('/events/bindings/:id/rotate-url', async (c) => {
    try {
      return c.json(await svc().rotate(c.req.param('id')));
    } catch (e) {
      const f = fail(e);
      if (f) return c.json(f, e instanceof MessageError && e.text?.key === 'schedules.event.error.notFound' ? 404 : 400);
      throw e;
    }
  });

  // 外の webhook の URL には秘密が入っている。MCP の道具には繋がず、画面のこの道だけが返す。
  api.get('/events/bindings/:id/hook-url', (c) => {
    try {
      return c.json({ url: svc().hookUrl(c.req.param('id')) });
    } catch (e) {
      if (e instanceof MessageError) return c.json(notFound(), 404);
      throw e;
    }
  });

  // 札に要る項目だけを返す。外から来た題名と本文は、画面の状態にも持たせない。
  api.get('/events/held', (c) => c.json({ held: deps.events.dispatcher.heldForUser().map((h): HeldEventDto => ({ bindingId: h.bindingId, facts: h.facts.map((f) => ({ source: f.source, event: f.event, receivedAt: f.receivedAt, ...(f.repo !== undefined ? { repo: f.repo } : {}), ...(f.number !== undefined ? { number: f.number } : {}), ...(f.outcome !== undefined ? { outcome: f.outcome } : {}) })) })) }));

  api.post('/events/held/run', async (c) => {
    const b = await readJson(c, BODY_LIMIT);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMIT, tr);
    const raw = ((b.value ?? {}) as { choices?: unknown }).choices;
    const ok = Array.isArray(raw) && raw.every((x) => typeof x === 'object' && x !== null && typeof (x as HeldChoice).bindingId === 'string' && HELD_MODES.includes((x as HeldChoice).mode));
    if (!ok) return c.json({ error: tr('schedules.event.error.invalid') }, 400);
    const choices = (raw as HeldChoice[]).map((x) => ({ bindingId: x.bindingId, mode: x.mode }));
    try {
      await deps.events.dispatcher.runHeld(choices);
    } catch (e) {
      return c.json({ error: errorText(lang(), e) }, 409);
    }
    return c.json({ ok: true });
  });

  // PR を持つ印の下書き（MCP の claim_pr が出す）。承認するまで、レビューやコメントの宛先には使われない。画面だけが答える。
  const claimOf = (v: unknown): { sessionId: string; repo: string; pr: number } | null => {
    const o = (typeof v === 'object' && v !== null ? v : {}) as { sessionId?: unknown; repo?: unknown; pr?: unknown };
    return typeof o.sessionId === 'string' && typeof o.repo === 'string' && REPO_RE.test(o.repo) && typeof o.pr === 'number' && Number.isSafeInteger(o.pr) && o.pr > 0 ? { sessionId: o.sessionId, repo: o.repo, pr: o.pr } : null;
  };
  api.get('/events/pr-claims', (c) => c.json({ claims: listDraftClaims(db).map((x) => ({ ...x, sessionTitle: sessionTitleOf(db, x.sessionId) })) }));
  for (const [path, act] of [['approve', approveClaim], ['reject', rejectClaim]] as const) {
    api.post(`/events/pr-claims/${path}`, async (c) => {
      const b = await readJson(c, BODY_LIMIT);
      if (b.tooLarge) return tooLargeResult(c, BODY_LIMIT, tr);
      const claim = claimOf(b.value);
      if (!claim) return c.json({ error: tr('schedules.event.error.invalid') }, 400);
      if (!hasClaim(db, claim)) return c.json(notFound(), 404);
      act(db, claim);
      return c.json({ ok: true });
    });
  }

  api.get('/events/repo-hook/:owner/:repo', (c) => {
    const repo = `${c.req.param('owner')}/${c.req.param('repo')}`;
    if (!REPO_RE.test(repo)) return c.json({ error: tr('schedules.event.error.invalid') }, 400);
    return c.json({ hook: svc().repoHookState(repo) });
  });
}
