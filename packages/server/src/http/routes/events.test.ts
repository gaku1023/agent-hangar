import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVENT_BINDINGS_MAX, type EventBindingDto, type EventSource, type SessionStateDto } from '@agent-hangar/shared';
import type { HeldEvent } from '../../event/dispatcher.ts';
import { EventBindingService } from '../../event/service.ts';
import { createBinding, getBindingRow, listBindings } from '../../event/store.ts';
import { watchWakeScope } from '../../event/wakeScope.ts';
import { callTool, TOOL_NAMES, type ToolDeps } from '../../mcp/tools.ts';
import { issueMcpSecret } from '../../runs/secrets.ts';
import { getSessionState } from '../../sessions/states.ts';
import { createApp } from '../app.ts';
import { fakeEventHooks, H, testDeps, type TestWorld } from '../testing.ts';

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let hooks: ReturnType<typeof fakeEventHooks>;
let changed: ReturnType<typeof vi.fn<() => void>>;
let dispatcher: { heldForUser: ReturnType<typeof vi.fn<() => HeldEvent[]>>; runHeld: ReturnType<typeof vi.fn<(choices: unknown[]) => Promise<void>>> };
let sessionId: string;

const send = (m: string, p: string, body?: unknown, headers: Record<string, string> = H) =>
  app.request(p, { method: m, headers: { ...headers, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async <T = Record<string, unknown>>(r: Response): Promise<T> => (await r.json()) as T;
const tools = () => ({ db: t.db, deviceId: t.deps.deviceId, port: 1, live: () => [], runs: t.deps.runs, language: t.deps.language, usage: () => t.deps.usage.current() }) as unknown as ToolDeps;
const github = { kind: 'github', repo: 'octo/repo', when: ['ci_done'], pr: 5 };
const input = (over: Record<string, unknown> = {}) => ({ source: github, action: { kind: 'send', sessionId }, prompt: 'check it', ...over });
/** 秘密や URL が応答に混ざっていないこと。 */
const NO_SECRET = /secret|priv|inbox-|hook-inbox|worker\.test/i;

beforeEach(async () => {
  t = await testDeps();
  hooks = fakeEventHooks(t.db);
  changed = vi.fn<() => void>();
  dispatcher = { heldForUser: vi.fn<() => HeldEvent[]>(() => []), runHeld: vi.fn(async () => {}) };
  t.deps.events = { bindings: new EventBindingService({ db: t.db, deviceId: 'd', hooks, changed, language: t.deps.language }), dispatcher };
  app = createApp(t.deps);
  sessionId = (t.db.prepare('select id from sessions where project_id is not null limit 1').get() as { id: string }).id;
});
afterEach(() => { t.dispose(); });

describe('POST /api/events/bindings', () => {
  it('registers the hook first, creates an active binding, and returns no secrets', async () => {
    const r = await send('POST', '/api/events/bindings', input());
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).not.toMatch(NO_SECRET);
    const body = JSON.parse(text) as { binding: EventBindingDto; hook: { status: string } };
    expect(body.hook).toEqual({ status: 'registered' });
    expect(body.binding).toMatchObject({ state: 'active', source: github, action: { kind: 'send', sessionId }, hookUrl: null });
    expect(hooks.ensureRepoHook).toHaveBeenCalledWith('octo/repo');
    const row = getBindingRow(t.db, body.binding.id)!;
    expect([row.inboxId, row.webhookId, row.hookSecret]).toEqual(['inbox-octo/repo', 7, 'secret']);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('creates nothing and says no_admin or failed when the hook cannot be registered', async () => {
    hooks.ensureRepoHook.mockResolvedValueOnce({ status: 'no_admin' });
    const denied = await send('POST', '/api/events/bindings', input());
    expect([denied.status, await json(denied)]).toEqual([200, { hook: { status: 'no_admin' } }]);
    expect((await json(await send('GET', '/api/events/repo-hook/octo/repo')))).toEqual({ hook: { status: 'no_admin' } });
    hooks.ensureRepoHook.mockResolvedValueOnce({ status: 'failed', message: 'gh not found' });
    expect(await json(await send('POST', '/api/events/bindings', input()))).toEqual({ hook: { status: 'failed', message: 'gh not found' } });
    expect(listBindings(t.db)).toEqual([]);
    expect(changed).not.toHaveBeenCalled();
    // 付け直せたら、札は none（結び付けが組を持つので registered）に戻る。
    expect((await send('POST', '/api/events/bindings', input())).status).toBe(200);
    expect(await json(await send('GET', '/api/events/repo-hook/octo/repo'))).toEqual({ hook: { status: 'registered' } });
  });

  it('removes the hook again when creating the binding fails after the hook was registered', async () => {
    // 付けている間に枠が埋まった。
    hooks.ensureRepoHook.mockImplementationOnce(async (repo: string) => {
      for (let i = 0; i < EVENT_BINDINGS_MAX; i++) createBinding(t.db, { inboxId: 'x', inboxPublicKey: 'x', inboxPrivateKey: 'x', source: { kind: 'hook' }, action: { kind: 'send_pr_owner' }, prompt: 'p', state: 'active' }, 1);
      return { status: 'registered', hookId: 7, share: { inboxId: `inbox-${repo}`, inboxPublicKey: 'pub', inboxPrivateKey: 'priv', webhookId: 7, hookSecret: 'secret' } };
    });
    const r = await send('POST', '/api/events/bindings', input());
    expect(r.status).toBe(400);
    expect((await json<{ error: string }>(r)).error).toBe(`イベントの設定は ${EVENT_BINDINGS_MAX} 件までです`);
    expect(hooks.removeRepoHookIfUnused).toHaveBeenCalledWith('octo/repo');
  });

  it('refuses at the cap before touching GitHub', async () => {
    for (let i = 0; i < EVENT_BINDINGS_MAX; i++) createBinding(t.db, { inboxId: 'x', inboxPublicKey: 'x', inboxPrivateKey: 'x', source: { kind: 'hook' }, action: { kind: 'send_pr_owner' }, prompt: 'p', state: 'active' }, 1);
    expect((await send('POST', '/api/events/bindings', input())).status).toBe(400);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
  });

  it('creates a hook binding with its own inbox and drops the row when the inbox cannot be made', async () => {
    const r = await send('POST', '/api/events/bindings', input({ source: { kind: 'hook' }, action: { kind: 'send', sessionId } }));
    const text = await r.text();
    expect(text).not.toMatch(NO_SECRET);
    const { binding } = JSON.parse(text) as { binding: EventBindingDto };
    expect(binding.state).toBe('active');
    expect(hooks.ensureHookInbox).toHaveBeenCalledWith(binding.id);
    expect(getBindingRow(t.db, binding.id)!.inboxId).toBe(`hook-inbox-${binding.id}`);
    hooks.ensureHookInbox.mockResolvedValueOnce({ status: 'failed', message: 'cloud not set up' });
    expect(await json(await send('POST', '/api/events/bindings', input({ source: { kind: 'hook' } })))).toEqual({ hook: { status: 'failed', message: 'cloud not set up' } });
    expect(listBindings(t.db)).toHaveLength(1);
  });

  it('rejects malformed input with 400', async () => {
    const bad = [
      input({ source: { kind: 'github', repo: 'no-slash', when: ['ci_done'] } }),
      input({ source: { kind: 'github', repo: 'octo/repo', when: [] } }),
      input({ source: { kind: 'github', repo: 'octo/repo', when: ['nope'] } }),
      input({ source: { kind: 'hook' }, action: { kind: 'send_pr_owner' } }),
      input({ action: { kind: 'wake', sessionId } }),
      input({ action: { kind: 'send', sessionId: 'missing' } }),
      input({ prompt: '  ' }),
      input({ passBody: 'yes' }),
    ];
    for (const b of bad) expect([JSON.stringify(b), (await send('POST', '/api/events/bindings', b)).status]).toEqual([JSON.stringify(b), 400]);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
  });

  it('needs the token', async () => {
    expect((await app.request('/api/events/bindings')).status).toBe(401);
  });
});

describe('PATCH and DELETE /api/events/bindings/:id', () => {
  const draftIn = { inboxId: '', inboxPublicKey: '', inboxPrivateKey: '', source: github as EventSource, action: { kind: 'send_pr_owner' }, prompt: 'p', state: 'draft' } as const;

  it('draft binding does not create an inbox until approved', async () => {
    const made = callTool(tools(), { sessionId }, 'draft_event_binding', { source: github, action: { kind: 'send_pr_owner' }, prompt: 'p' }) as { binding: { id: string; state: string } };
    expect(made.binding.state).toBe('draft');
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
    expect(getBindingRow(t.db, made.binding.id)).toMatchObject({ inboxId: '', webhookId: null, hookSecret: null, state: 'draft' });
    const r = await send('PATCH', `/api/events/bindings/${made.binding.id}`, { state: 'active' });
    const text = await r.text();
    expect(text).not.toMatch(NO_SECRET);
    expect((JSON.parse(text) as { binding: EventBindingDto }).binding.state).toBe('active');
    expect(hooks.ensureRepoHook).toHaveBeenCalledWith('octo/repo');
    expect(getBindingRow(t.db, made.binding.id)).toMatchObject({ inboxId: 'inbox-octo/repo', webhookId: 7, hookSecret: 'secret', state: 'active' });
    expect(changed).toHaveBeenCalled();
  });

  it('approving a hook draft makes its inbox then; failure keeps the draft', async () => {
    const made = callTool(tools(), { sessionId }, 'draft_event_binding', { source: { kind: 'hook' }, action: { kind: 'send', session_id: sessionId }, prompt: 'p' }) as { binding: { id: string } };
    expect(hooks.ensureHookInbox).not.toHaveBeenCalled();
    hooks.ensureHookInbox.mockResolvedValueOnce({ status: 'failed', message: 'cloud not set up' });
    expect(await json(await send('PATCH', `/api/events/bindings/${made.binding.id}`, { state: 'active' }))).toMatchObject({ hook: { status: 'failed', message: 'cloud not set up' }, binding: { id: made.binding.id, state: 'draft' } });
    expect(getBindingRow(t.db, made.binding.id)).toMatchObject({ state: 'draft', inboxId: '' });
    expect(((await json<{ binding: EventBindingDto }>(await send('PATCH', `/api/events/bindings/${made.binding.id}`, { state: 'active' }))).binding.state)).toBe('active');
    expect(getBindingRow(t.db, made.binding.id)!.inboxId).toBe(`hook-inbox-${made.binding.id}`);
  });

  it('approving a github draft with no admin access keeps it a draft', async () => {
    const b = createBinding(t.db, { ...draftIn }, 1);
    hooks.ensureRepoHook.mockResolvedValueOnce({ status: 'no_admin' });
    expect(await json(await send('PATCH', `/api/events/bindings/${b.id}`, { state: 'active' }))).toMatchObject({ hook: { status: 'no_admin' }, binding: { id: b.id, state: 'draft' } });
    expect(getBindingRow(t.db, b.id)!.state).toBe('draft');
  });

  it('edits the prompt and the body switch, and refuses other states with the decided wording', async () => {
    const b = createBinding(t.db, { ...draftIn }, 1);
    const ok = await json<{ binding: EventBindingDto }>(await send('PATCH', `/api/events/bindings/${b.id}`, { prompt: 'q', passBody: true, allowAuthors: ['alice'] }));
    expect(ok.binding).toMatchObject({ prompt: 'q', passBody: true, allowAuthors: ['alice'], state: 'draft' });
    for (const state of ['draft', 'held', 'bogus']) {
      const r = await send('PATCH', `/api/events/bindings/${b.id}`, { state });
      expect([state, r.status, (await json<{ error: string }>(r)).error]).toEqual([state, 400, 'イベントの設定の状態が正しくありません']);
    }
    const missing = await send('PATCH', '/api/events/bindings/nope', { prompt: 'q' });
    expect([missing.status, (await json<{ error: string }>(missing)).error]).toEqual([404, 'イベントの設定が見つかりません']);
  });

  it('approving a draft over the cap is refused, and drafts do not count toward the cap', async () => {
    const b = createBinding(t.db, { ...draftIn }, 1);
    for (let i = 0; i < 12; i++) createBinding(t.db, { ...draftIn }, 1);
    for (let i = 0; i < EVENT_BINDINGS_MAX; i++) createBinding(t.db, { ...draftIn, state: 'active' }, 1);
    const r = await send('PATCH', `/api/events/bindings/${b.id}`, { state: 'active' });
    expect([r.status, (await json<{ error: string }>(r)).error]).toEqual([400, `イベントの設定は ${EVENT_BINDINGS_MAX} 件までです`]);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
  });

  it('on a failed activation the response still carries the binding', async () => {
    const b = createBinding(t.db, { ...draftIn }, 1);
    hooks.ensureRepoHook.mockResolvedValueOnce({ status: 'failed', message: 'gh not found' });
    const r = await json<{ binding: EventBindingDto; hook: unknown }>(await send('PATCH', `/api/events/bindings/${b.id}`, { state: 'active' }));
    expect(r.hook).toEqual({ status: 'failed', message: 'gh not found' });
    expect(r.binding).toMatchObject({ id: b.id, state: 'draft' });
  });

  it('delete removes the binding then sweeps the hooks and the bell', async () => {
    const { binding } = await json<{ binding: EventBindingDto }>(await send('POST', '/api/events/bindings', input()));
    changed.mockClear();
    expect((await json(await send('DELETE', `/api/events/bindings/${binding.id}`)))).toEqual({ ok: true });
    expect(listBindings(t.db)).toEqual([]);
    expect(hooks.sweep).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    const again = await send('DELETE', `/api/events/bindings/${binding.id}`);
    expect([again.status, (await json<{ error: string }>(again)).error]).toEqual([404, 'イベントの設定が見つかりません']);
    expect(hooks.sweep).toHaveBeenCalledTimes(1);
  });
});

describe('external webhook url', () => {
  it('serves the url only from the hook-url route and rotates it on request', async () => {
    const { binding } = await json<{ binding: EventBindingDto }>(await send('POST', '/api/events/bindings', input({ source: { kind: 'hook' } })));
    const listed = await (await send('GET', '/api/events/bindings')).text();
    expect(listed).not.toMatch(NO_SECRET);
    const first = await json<{ url: string }>(await send('GET', `/api/events/bindings/${binding.id}/hook-url`));
    expect(first.url).toBe(`https://worker.test/hooks/hook-inbox-${binding.id}`);
    const rotated = await send('POST', `/api/events/bindings/${binding.id}/rotate-url`);
    const rotatedText = await rotated.text();
    expect(JSON.parse(rotatedText)).toEqual({ ok: true });
    expect(rotatedText).not.toMatch(NO_SECRET);
    expect(hooks.rotateHookInbox).toHaveBeenCalledWith(binding.id);
    expect(getBindingRow(t.db, binding.id)!.inboxId).toBe(`hook-inbox-rotated-${binding.id}`);
    expect((await send('GET', '/api/events/bindings/nope/hook-url')).status).toBe(404);
  });

  it('refuses to rotate a github binding', async () => {
    const { binding } = await json<{ binding: EventBindingDto }>(await send('POST', '/api/events/bindings', input()));
    expect((await send('POST', `/api/events/bindings/${binding.id}/rotate-url`)).status).toBe(400);
    expect(hooks.rotateHookInbox).not.toHaveBeenCalled();
  });

  it('hook-url route is not reachable from mcp tools', async () => {
    const { binding } = await json<{ binding: EventBindingDto }>(await send('POST', '/api/events/bindings', input({ source: { kind: 'hook' } })));
    const auth = { authorization: `Bearer ${issueMcpSecret(t.db, sessionId, 1)}` };
    for (const [m, p] of [['GET', `/api/events/bindings/${binding.id}/hook-url`], ['POST', `/api/events/bindings/${binding.id}/rotate-url`], ['GET', '/api/events/bindings'], ['PATCH', `/api/events/bindings/${binding.id}`]] as const) {
      expect([m, p, (await send(m, p, m === 'GET' ? undefined : {}, auth)).status]).toEqual([m, p, 401]);
    }
    expect(TOOL_NAMES.filter((n) => /hook|url|rotate/i.test(n))).toEqual([]);
    expect(() => callTool(tools(), { sessionId }, 'hook_url', { binding_id: binding.id })).toThrow();
  });
});

describe('held events', () => {
  it('held run route runs the chosen modes', async () => {
    dispatcher.heldForUser.mockReturnValue([{ bindingId: 'b1', facts: [] }]);
    expect(await json(await send('GET', '/api/events/held'))).toEqual({ held: [{ bindingId: 'b1', facts: [] }] });
    const choices = [{ bindingId: 'b1', mode: 'latest' }, { bindingId: 'b2', mode: 'all' }, { bindingId: 'b3', mode: 'skip' }];
    expect((await json(await send('POST', '/api/events/held/run', { choices })))).toEqual({ ok: true });
    expect(dispatcher.runHeld).toHaveBeenCalledWith(choices);
  });

  it('lists only what the card shows, never the title, body, author or url', async () => {
    const full = { source: 'github' as const, event: 'comment', repo: 'o/r', number: 4, title: 'TITLE', authorLogin: 'someone', outcome: 'success' as const, url: 'https://example.test/x', actor: 'someone', body: 'BODY', labels: ['bug'], receivedAt: 5 };
    dispatcher.heldForUser.mockReturnValue([{ bindingId: 'b1', facts: [full, { source: 'hook', event: 'hook', body: 'PAYLOAD', receivedAt: 6 }] }]);
    const text = await (await send('GET', '/api/events/held')).text();
    expect(text).not.toMatch(/TITLE|BODY|PAYLOAD|someone|example.test|bug/);
    expect(JSON.parse(text)).toEqual({ held: [{ bindingId: 'b1', facts: [{ source: 'github', event: 'comment', repo: 'o/r', number: 4, outcome: 'success', receivedAt: 5 }, { source: 'hook', event: 'hook', receivedAt: 6 }] }] });
  });

  it('answers 409 with a message when running the held events fails', async () => {
    dispatcher.runHeld.mockRejectedValueOnce(new Error('boom'));
    const r = await send('POST', '/api/events/held/run', { choices: [{ bindingId: 'b1', mode: 'all' }] });
    expect([r.status, (await json<{ error: string }>(r)).error]).toEqual([409, 'boom']);
  });

  it('rejects choices with an unknown mode', async () => {
    expect((await send('POST', '/api/events/held/run', { choices: [{ bindingId: 'b1', mode: 'nope' }] })).status).toBe(400);
    expect((await send('POST', '/api/events/held/run', {})).status).toBe(400);
    expect(dispatcher.runHeld).not.toHaveBeenCalled();
  });
});

describe('GET /api/events/repo-hook/:owner/:repo', () => {
  it('reads the state from the bindings and never calls gh', async () => {
    expect(await json(await send('GET', '/api/events/repo-hook/octo/repo'))).toEqual({ hook: { status: 'none' } });
    await send('POST', '/api/events/bindings', input());
    hooks.ensureRepoHook.mockClear();
    expect(await json(await send('GET', '/api/events/repo-hook/Octo/Repo'))).toEqual({ hook: { status: 'registered' } });
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
    expect((await send('GET', '/api/events/repo-hook/octo/re%20po')).status).toBe(400);
  });
});

describe('wake_on on the pause flow', () => {
  const wakeOn = { repo: 'octo/repo', pr: 9, when: 'ci_done' };
  const wakeBindings = () => listBindings(t.db).filter((b) => b.action.kind === 'wake');
  const propose = (over: Record<string, unknown> = {}) => callTool(tools(), { sessionId }, 'propose_session_status', { status: 'paused', note: 'CI を待つ', wake_on: wakeOn, ...over });

  it('confirming pause with wake_on creates a wake binding', async () => {
    propose();
    const cand = (getSessionState(t.db, sessionId) as SessionStateDto).candidate;
    expect(cand?.wakeOn).toEqual(wakeOn);
    expect(wakeBindings()).toEqual([]);
    const r = await send('POST', `/api/sessions/${sessionId}/state/confirm`, { wakeOn });
    expect(r.status).toBe(200);
    const body = await json<{ state: SessionStateDto; wake: { status: string } }>(r);
    expect(body.state.status).toBe('paused');
    expect(body.wake).toEqual({ status: 'created' });
    const [b] = wakeBindings();
    expect(b).toMatchObject({ state: 'active', source: { kind: 'github', repo: 'octo/repo', when: ['ci_done'], pr: 9 }, action: { kind: 'wake', sessionId } });
    expect(b!.expiresAt).not.toBeNull();
    expect(getBindingRow(t.db, b!.id)).toMatchObject({ inboxId: 'inbox-octo/repo', fromSessionId: sessionId });
    expect(changed).toHaveBeenCalled();
  });

  it('confirming without a wakeOn field creates none, even when a wake_on was suggested', async () => {
    propose();
    const r = await json<{ state: SessionStateDto; wake?: unknown }>(await send('POST', `/api/sessions/${sessionId}/state/confirm`));
    expect(r.state.status).toBe('paused');
    expect(r.wake).toBeUndefined();
    expect(wakeBindings()).toEqual([]);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
  });

  it('propose with wake_on then a conversation-confirmed Paused without it creates no binding', async () => {
    propose();
    const r = propose({ wake_on: undefined, confirmed: true }) as { outcome: string };
    expect(r.outcome).toBe('set');
    expect(wakeBindings()).toEqual([]);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
    expect(t.db.prepare('select candidate_wake_on w from session_states where session_id = ?').get(sessionId)).toEqual({ w: null });
  });

  it('a menu Paused without a wakeOn field creates none', async () => {
    await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'x' });
    expect(wakeBindings()).toEqual([]);
  });

  it('creates no wake for a session that last ran on another PC and keeps Paused', async () => {
    t.db.prepare('update sessions set home_device = ? where id = ?').run('other-pc', sessionId);
    const body = await json<{ state: SessionStateDto; wake: unknown }>(await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'x', wakeOn }));
    expect(body.state.status).toBe('paused');
    expect(body.wake).toEqual({ status: 'failed', message: 'other_pc' });
    expect(wakeBindings()).toEqual([]);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
  });

  it('a new wake replaces the earlier wake bindings of the same session, and only after it was created', async () => {
    await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'a', wakeOn });
    const [first] = wakeBindings();
    // 付けられなかったときは、前のものを残す。
    hooks.ensureRepoHook.mockResolvedValueOnce({ status: 'no_admin' });
    await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'b', wakeOn: { ...wakeOn, pr: 10 } });
    expect(wakeBindings().map((b) => b.id)).toEqual([first!.id]);
    await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'c', wakeOn: { ...wakeOn, pr: 11, when: 'review' } });
    expect(wakeBindings().map((b) => b.source)).toEqual([expect.objectContaining({ pr: 11, when: ['review'] })]);
    expect(hooks.sweep).toHaveBeenCalled();
  });

  it('removing the suggestion before confirming creates none', async () => {
    propose();
    const r = await send('POST', `/api/sessions/${sessionId}/state/confirm`, { wakeOn: null });
    expect(r.status).toBe(200);
    const body = await json<{ state: SessionStateDto; wake?: unknown }>(r);
    expect(body.state.status).toBe('paused');
    expect(body.wake).toBeUndefined();
    expect(wakeBindings()).toEqual([]);
    expect(hooks.ensureRepoHook).not.toHaveBeenCalled();
  });

  it('a user-picked wakeOn from the menu creates the binding when pausing', async () => {
    const r = await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'レビュー待ち', wakeOn: { ...wakeOn, when: 'review' } });
    expect(await json(r)).toMatchObject({ state: { status: 'paused' }, wake: { status: 'created' } });
    expect(wakeBindings()[0]!.source).toMatchObject({ when: ['review'] });
    // Done には付けない。
    const done = await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'done', wakeOn });
    expect((await json<{ wake?: unknown }>(done)).wake).toBeUndefined();
    expect(wakeBindings()).toHaveLength(1);
  });

  it('keeps Paused and reports the reason when the hook cannot be registered', async () => {
    propose();
    hooks.ensureRepoHook.mockResolvedValueOnce({ status: 'no_admin' });
    const body = await json<{ state: SessionStateDto; wake: unknown }>(await send('POST', `/api/sessions/${sessionId}/state/confirm`, { wakeOn }));
    expect(body.state.status).toBe('paused');
    expect(body.wake).toEqual({ status: 'no_admin' });
    expect(wakeBindings()).toEqual([]);
  });

  it('does not add the same wake binding twice', async () => {
    await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'a', wakeOn });
    await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'b', wakeOn });
    expect(wakeBindings()).toHaveLength(1);
  });

  describe('a wake binding belongs to the Paused it was made for', () => {
    let off: () => void;
    beforeEach(() => { off = watchWakeScope(t.db, () => {}); });
    afterEach(() => { off(); });

    it('survives a dialog-style rewrite of the same Paused, whether wakeOn is null or absent', async () => {
      await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'a', wakeOn });
      const [b] = wakeBindings();
      await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'b, edited', returnOn: '2026-11-12', wakeOn: null });
      await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'c, edited again' });
      expect(wakeBindings().map((x) => x.id)).toEqual([b!.id]);
    });

    it('is gone once the session is resumed, so a later Paused without a wake is not woken by it', async () => {
      await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'a', wakeOn });
      await send('PUT', `/api/sessions/${sessionId}/state`, { status: null });
      expect(wakeBindings()).toEqual([]);
      await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', note: 'unrelated' });
      expect(wakeBindings()).toEqual([]);
    });
  });

  it('refuses a malformed wakeOn without changing the state', async () => {
    propose();
    const r = await send('POST', `/api/sessions/${sessionId}/state/confirm`, { wakeOn: { repo: 'x', pr: 1, when: 'comment' } });
    expect(r.status).toBe(400);
    expect((getSessionState(t.db, sessionId) as SessionStateDto).status).toBeNull();
    expect((await send('PUT', `/api/sessions/${sessionId}/state`, { status: 'paused', wakeOn: 'x' })).status).toBe(400);
  });

  it('a rejected suggestion drops its wake_on', async () => {
    propose();
    await send('POST', `/api/sessions/${sessionId}/state/reject`);
    expect(t.db.prepare('select candidate_wake_on w from session_states where session_id = ?').get(sessionId)).toEqual({ w: null });
  });
});

describe('PR claim approval', () => {
  const claim = (over: Record<string, unknown> = {}) => callTool(tools(), { sessionId }, 'claim_pr', { repo: 'octo/repo', pr: 5, ...over });
  const owner = () => t.db.prepare("select session_id s from session_prs where state = 'active' and repo = 'octo/repo' and pr = 5").get() as { s: string } | undefined;

  it('lists the drafts with the session title, and approving makes the session the owner', async () => {
    claim();
    const list = await json<{ claims: { sessionId: string; sessionTitle: string | null; repo: string; pr: number }[] }>(await send('GET', '/api/events/pr-claims'));
    expect(list.claims).toEqual([expect.objectContaining({ sessionId, repo: 'octo/repo', pr: 5 })]);
    expect(typeof list.claims[0]!.sessionTitle === 'string' || list.claims[0]!.sessionTitle === null).toBe(true);
    expect(owner()).toBeUndefined();
    expect(await json(await send('POST', '/api/events/pr-claims/approve', { sessionId, repo: 'octo/repo', pr: 5 }))).toEqual({ ok: true });
    expect(owner()).toEqual({ s: sessionId });
    expect((await json<{ claims: unknown[] }>(await send('GET', '/api/events/pr-claims'))).claims).toEqual([]);
  });

  it('rejecting removes the draft, and an unknown claim is 404', async () => {
    claim();
    expect(await json(await send('POST', '/api/events/pr-claims/reject', { sessionId, repo: 'octo/repo', pr: 5 }))).toEqual({ ok: true });
    expect((await json<{ claims: unknown[] }>(await send('GET', '/api/events/pr-claims'))).claims).toEqual([]);
    expect((await send('POST', '/api/events/pr-claims/approve', { sessionId, repo: 'octo/repo', pr: 5 })).status).toBe(404);
    expect((await send('POST', '/api/events/pr-claims/approve', { sessionId, repo: 'bad', pr: 5 })).status).toBe(400);
  });

  it('is not reachable with an MCP secret', async () => {
    claim();
    const auth = { authorization: `Bearer ${issueMcpSecret(t.db, sessionId, 1)}` };
    expect((await send('GET', '/api/events/pr-claims', undefined, auth)).status).toBe(401);
    expect((await send('POST', '/api/events/pr-claims/approve', { sessionId, repo: 'octo/repo', pr: 5 }, auth)).status).toBe(401);
    expect((await send('POST', '/api/events/pr-claims/reject', { sessionId, repo: 'octo/repo', pr: 5 }, auth)).status).toBe(401);
    expect(owner()).toBeUndefined();
  });
});
