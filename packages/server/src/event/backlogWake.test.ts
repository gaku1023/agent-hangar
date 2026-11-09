import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import { EVENT_INBOX_PULL_PAGE, generateInboxKeyPair, sealToInbox, type EventSource, type ScheduleTarget } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeCloudClient } from '../../test/fake-cloud.ts';
import { openDb, type Db } from '../db/open.ts';
import { getSessionState, setSessionState } from '../sessions/states.ts';
import { EventDispatcher } from './dispatcher.ts';
import { inboxApiOf } from './inboxClient.ts';
import { EventPuller } from './puller.ts';
import { createBinding } from './store.ts';

// puller と dispatcher を server.ts と同じ形でつなぎ、閉じていた間に溜まった山を流す。
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const suiteOf = (name: string): { check_suite: { id: number; conclusion: string } } => JSON.parse(fs.readFileSync(path.join(DIR, `${name}.json`), 'utf8')) as { check_suite: { id: number; conclusion: string } };
const T0 = new Date(2026, 10, 10, 9, 0).getTime();
const SECRET = 'hook-secret-for-tests';
const source: EventSource = { kind: 'github', repo: 'octo-org/demo-repo', when: ['ci_done'], pr: 42 };

let db: Db;
beforeEach(() => { db = openDb(':memory:'); });
afterEach(() => { db.close(); });

describe('backlog at start', () => {
  it('wakes once with the newest CI result even when it sits on a later page', async () => {
    const client = new FakeCloudClient({ deviceId: 'pc-a' });
    const kp = await generateInboxKeyPair();
    const inboxId = (await client.createInbox(kp.publicKey)).inboxId;
    createBinding(db, { inboxId, inboxPublicKey: kp.publicKey, inboxPrivateKey: kp.privateKey, hookSecret: SECRET, source, action: { kind: 'wake', sessionId: 's-1' }, prompt: 'go', state: 'active' }, T0);
    db.prepare("insert into sessions (id, provider, provider_session_id, cwd, home_device, updated_at, origin_device) values ('s-1', 'claude-code', 'u-1', '/w', 'dev', 1, 'dev')").run();
    setSessionState(db, 'dev', 's-1', { status: 'paused', note: 'wait for CI', setBy: 'user' });
    let n = 0;
    const post = async (conclusion: 'failure' | 'success'): Promise<void> => {
      const payload = suiteOf(`check_suite.completed.${conclusion}`);
      payload.check_suite.id = 1000 + n;
      const body = JSON.stringify(payload);
      const headers = { 'x-github-event': 'check_suite', 'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')}`, 'x-github-delivery': `d-${n++}`, 'content-type': 'application/json' };
      client.postParcel(inboxId, await sealToInbox(kp.publicKey, inboxId, { receivedAt: T0 - 1000, headers, body }));
    };
    // 1 ページ目に古い失敗、あとは 1 ページを越える数の別の荷物、最後に直した後の成功。
    await post('failure');
    for (let i = 0; i < EVENT_INBOX_PULL_PAGE + 5; i++) await post('failure');
    await post('success');

    const launched: { prompt: string; target: ScheduleTarget }[] = [];
    const dispatcher = new EventDispatcher({
      db, deviceId: 'dev', now: () => T0, language: () => 'en', me: async () => 'alice',
      launch: async (s) => { launched.push({ prompt: s.prompt, target: s.target }); return { sessionId: 's-1' }; },
      wait: () => new Promise(() => undefined),
    });
    const puller = new EventPuller({
      db, api: () => inboxApiOf(client), now: () => T0, me: () => 'alice',
      ghApi: () => Promise.reject(new Error('gh is not used in this test')),
      onPulled: (events) => { void dispatcher.handle(events, { more: true }); },
      onPassEnd: () => { dispatcher.flushWakes(); },
    });
    await puller.pull('start');
    await dispatcher.idle();
    expect(launched).toHaveLength(1);
    expect(launched[0]!.prompt).toContain('outcome=success');
    expect(launched[0]!.prompt).not.toContain('outcome=failure');
    expect(getSessionState(db, 's-1')?.status ?? null).toBeNull();
  });
});
