import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addUnread } from '../../live/unread.ts';
import { SESSION_ALPHA } from '../../../test/fixtures.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 開いたら既読にする経路（POST /api/sessions/:id/seen）の試験。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
const alphaId = () => (t.db.prepare('select id from sessions where provider_session_id = ?').get(SESSION_ALPHA) as { id: string }).id;
const seen = (id: string) => app.request(`/api/sessions/${id}/seen`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: '{}' });
const unreadOf = async (id: string) => (await (await app.request(`/api/sessions/${id}`, { headers: H })).json()).unread;

beforeEach(async () => { t = await testDeps(); app = createApp(t.deps); });
afterEach(() => { t.dispose(); });

describe('POST /api/sessions/:id/seen', () => {
  it('未読を null に戻し、204 を返す', async () => {
    addUnread(t.db, alphaId(), '一つ目', 10);
    addUnread(t.db, alphaId(), '二つ目', 20);
    expect(await unreadOf(alphaId())).toEqual({ count: 2, latest: '二つ目', at: 20 });
    expect((await seen(alphaId())).status).toBe(204);
    expect(await unreadOf(alphaId())).toBeNull();
  });
  it('行が無いセッションや知らない id でも 204 で、何も書かない', async () => {
    expect((await seen(alphaId())).status).toBe(204);
    expect((await seen('nope')).status).toBe(204);
    expect(t.db.prepare('select count(*) c from session_unread').get()).toEqual({ c: 0 });
  });
});
