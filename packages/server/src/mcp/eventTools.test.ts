import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EVENT_BINDINGS_MAX } from '@agent-hangar/shared';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { createBinding, getBindingRow, listBindings, prOwner } from '../event/store.ts';
import { IndexerService } from '../indexer/service.ts';
import { assignSessions } from '../projects/registry.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { getSessionState, setSessionState } from '../sessions/states.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA } from '../../test/fixtures.ts';
import { TOOL_CLASSES } from './toolClasses.ts';
import { callTool, TOOL_NAMES, type ToolDeps } from './tools.ts';

let dir: string;
let db: Db;
let alphaId: string;
let deps: ToolDeps;
const github = { kind: 'github', repo: 'octo/repo', when: ['ci_done', 'review'], pr: 5 } as const;
const call = (name: string, args: Record<string, unknown> = {}, ctx = { sessionId: null as string | null }) => callTool(deps, ctx, name, args) as Record<string, unknown>;
const draft = (over: Record<string, unknown> = {}, ctx?: { sessionId: string | null }) => call('draft_event_binding', { source: github, action: { kind: 'send_pr_owner' }, prompt: 'review it', ...over }, ctx);
const SECRETISH = /secret|priv|inbox|worker|https?:\/\//i;
const fill = (n: number) => { for (let i = 0; i < n; i++) createBinding(db, { inboxId: 'x', inboxPublicKey: 'x', inboxPrivateKey: 'x', source: { kind: 'hook' }, action: { kind: 'send_pr_owner' }, prompt: 'p' }, 1); };

beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', transcript: claudeTranscriptSource({ claudeDir: dir }), isRunning: () => false }).fullScan();
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'project_roots', { id: 'r1', project_id: 'p1', device_id: 'd', path: '/Users/me/workspace/alpha', resolved: 1 }, 'd');
  assignSessions(db, 'd');
  alphaId = (db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
  deps = { db, deviceId: 'd', port: 4177, live: () => [], runs: { start: () => { throw new Error('not used'); } }, usage: () => ({ fiveHour: null, sevenDay: null, updatedAt: 0 }) };
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('claim_pr', () => {
  it('files a draft that does not count as the owner until approved', () => {
    expect(call('claim_pr', { repo: 'octo/repo', pr: 5 }, { sessionId: alphaId })).toEqual({ repo: 'octo/repo', pr: 5, state: 'draft' });
    expect(prOwner(db, 'octo/repo', 5)).toBeNull();
  });

  it('never turns an approved claim back into a draft', () => {
    db.prepare("insert into session_prs (session_id, repo, pr, state, claimed_at) values (?, 'octo/repo', 5, 'active', 1)").run(alphaId);
    expect(call('claim_pr', { repo: 'octo/repo', pr: 5 }, { sessionId: alphaId }).state).toBe('active');
  });

  it('needs a session, a repo, and a positive PR number', () => {
    expect(() => call('claim_pr', { repo: 'octo/repo', pr: 5 })).toThrow();
    expect(() => call('claim_pr', { repo: 'octo/repo', pr: 5, session_id: 'missing' })).toThrow();
    for (const bad of [{ repo: 'nope', pr: 5 }, { repo: 'octo/repo', pr: 0 }, { repo: 'octo/repo', pr: 1.5 }, { repo: 'octo/repo' }, { pr: 5 }]) {
      expect(() => call('claim_pr', bad, { sessionId: alphaId }), JSON.stringify(bad)).toThrow();
    }
    expect(() => call('claim_pr', { repo: 'octo/repo', pr: 5, session_id: 'other' }, { sessionId: alphaId })).toThrow();
    expect(call('claim_pr', { repo: 'octo/repo', pr: 6, session_id: alphaId }).state).toBe('draft');
  });
});

describe('draft_event_binding', () => {
  it('files a draft with an empty inbox and touches nothing else', () => {
    const r = draft({}, { sessionId: alphaId }) as { binding: { id: string; state: string } };
    expect(r.binding).toMatchObject({ state: 'draft', source: { kind: 'github', repo: 'octo/repo', when: ['ci_done', 'review'], pr: 5 }, action: { kind: 'send_pr_owner' }, prompt: 'review it', passBody: false, allowAuthors: [] });
    expect(getBindingRow(db, r.binding.id)).toMatchObject({ state: 'draft', inboxId: '', inboxPublicKey: '', inboxPrivateKey: '', webhookId: null, hookSecret: null, fromSessionId: alphaId });
  });

  it('can draft a new session, a send to a session, and an outside webhook, without returning a url', () => {
    const made = draft({ action: { kind: 'new', project_id: 'p1', name: 'from event' }, pass_body: true, allow_authors: ['alice'] });
    expect(made).toMatchObject({ binding: { action: { kind: 'new', projectId: 'p1', name: 'from event' }, passBody: true, allowAuthors: ['alice'] } });
    expect(draft({ action: { kind: 'send', session_id: alphaId } }).binding).toMatchObject({ action: { kind: 'send', sessionId: alphaId } });
    const hook = draft({ source: { kind: 'hook' }, action: { kind: 'send', session_id: alphaId } }) as { binding: { id: string; source: unknown } };
    expect(hook.binding.source).toEqual({ kind: 'hook' });
    expect(JSON.stringify(hook)).not.toMatch(SECRETISH);
    expect(getBindingRow(db, hook.binding.id)!.inboxId).toBe('');
  });

  it('cannot draft a wake binding or a malformed one', () => {
    for (const bad of [
      { action: { kind: 'wake', session_id: alphaId } },
      { action: { kind: 'send' } },
      { action: { kind: 'send', session_id: 'missing' } },
      { source: { kind: 'hook' }, action: { kind: 'send_pr_owner' } },
      { source: { kind: 'github', repo: 'bad', when: ['ci_done'] } },
      { source: { kind: 'github', repo: 'octo/repo', when: [] } },
      { action: { kind: 'new' } },
      { action: undefined },
      { prompt: ' ' },
    ]) expect(() => draft(bad), JSON.stringify(bad)).toThrow();
    expect(listBindings(db)).toEqual([]);
  });

  it('stays within a per-session url project', () => {
    upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, 'd');
    expect(() => draft({ action: { kind: 'new', project_id: 'p2' } }, { sessionId: alphaId })).toThrow();
    expect(draft({ action: { kind: 'new' } }, { sessionId: alphaId }).binding).toMatchObject({ action: { projectId: 'p1' } });
  });

  it('stops at the binding cap', () => {
    fill(EVENT_BINDINGS_MAX);
    expect(() => draft()).toThrow(`${EVENT_BINDINGS_MAX}`);
  });
});

describe('propose_session_status with wake_on', () => {
  const wakeOn = { repo: 'octo/repo', pr: 9, when: 'merged' };
  const propose = (over: Record<string, unknown> = {}) => call('propose_session_status', { status: 'paused', note: 'マージ待ち', wake_on: wakeOn, ...over }, { sessionId: alphaId });

  it('stores wake_on beside the suggestion and creates no binding', () => {
    const r = propose() as { outcome: string; state: { candidate: { wakeOn: unknown } } };
    expect(r.outcome).toBe('proposed');
    expect(r.state.candidate.wakeOn).toEqual(wakeOn);
    expect(db.prepare('select candidate_wake_on w from session_states where session_id = ?').get(alphaId)).toEqual({ w: JSON.stringify(wakeOn) });
    expect(listBindings(db)).toEqual([]);
  });

  it('a suggestion without wake_on clears an earlier one', () => {
    propose();
    propose({ wake_on: undefined });
    expect(getSessionState(db, alphaId)!.candidate?.wakeOn).toBeUndefined();
  });

  it('refuses wake_on on Done, together with confirmed, or malformed', () => {
    expect(() => propose({ status: 'done' })).toThrow();
    expect(() => propose({ confirmed: true })).toThrow();
    for (const bad of [{ repo: 'x', pr: 9, when: 'merged' }, { repo: 'octo/repo', pr: 0, when: 'merged' }, { repo: 'octo/repo', pr: 9, when: 'comment' }, 'octo/repo#9']) {
      expect(() => propose({ wake_on: bad }), JSON.stringify(bad)).toThrow();
    }
    expect(getSessionState(db, alphaId)).toBeNull();
  });

  it('does not store wake_on when the status is already set', () => {
    setSessionState(db, 'd', alphaId, { status: 'paused', note: 'x', setBy: 'user' });
    expect((propose() as { outcome: string }).outcome).toBe('already_set');
    expect(db.prepare('select candidate_wake_on w from session_states where session_id = ?').get(alphaId)).toEqual({ w: null });
  });
});

describe('what the tools may return', () => {
  it('mcp responses never include a hook url or secret', () => {
    // 結び付けは受け箱と秘密を持っている（承認済みの GitHub と外の webhook）。道具の応答にはどれも出ない。
    createBinding(db, { inboxId: 'inbox-real-id', inboxPublicKey: 'public-key', inboxPrivateKey: 'private-key', webhookId: 42, hookSecret: 'hook-signing-secret', source: { ...github, when: ['ci_done'] }, action: { kind: 'send_pr_owner' }, prompt: 'p', state: 'active' }, 1);
    createBinding(db, { inboxId: 'hook-inbox-real-id', inboxPublicKey: 'public-key', inboxPrivateKey: 'private-key', source: { kind: 'hook' }, action: { kind: 'send_pr_owner' }, prompt: 'p', state: 'active' }, 1);
    const out = [
      draft({}, { sessionId: alphaId }), draft({ source: { kind: 'hook' }, action: { kind: 'send', session_id: alphaId } }),
      call('claim_pr', { repo: 'octo/repo', pr: 5 }, { sessionId: alphaId }),
      call('propose_session_status', { status: 'paused', note: 'x', wake_on: { repo: 'octo/repo', pr: 9, when: 'review' } }, { sessionId: alphaId }),
    ];
    const text = JSON.stringify(out);
    expect(text).not.toMatch(SECRETISH);
    expect(text).not.toMatch(/hookUrl|hook_url|webhookId|hookSecret|inboxId/);
  });

  it('the tool module does not reach the parts that hold secrets', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, 'eventTools.ts'), 'utf8');
    expect(src).not.toMatch(/githubHooks|hookUrlOf|event\/service|inboxClient|getBindingRow/);
  });

  it('hook-url route is not reachable from mcp tools', () => {
    expect(TOOL_NAMES.filter((n) => /hook|url|rotate|inbox|approve/i.test(n))).toEqual([]);
    expect(() => call('hook_url', { binding_id: 'x' })).toThrow();
  });

  it('classes both tools as write, since nothing runs until the user approves', () => {
    expect(TOOL_CLASSES.claim_pr.kind).toBe('write');
    expect(TOOL_CLASSES.draft_event_binding.kind).toBe('write');
  });
});
