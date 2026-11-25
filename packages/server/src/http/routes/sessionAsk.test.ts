import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PeerChatAsk } from '@agent-hangar/shared';
import { issueMcpSecret } from '../../runs/secrets.ts';
import type { AnswerResult } from '../../peer/chat/answer.ts';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// この PC の画面が、この PC の会話の札を読んで答える口（routes/sessionAsk.ts）。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let ask: PeerChatAsk | null;
let result: AnswerResult;
let answers: { id: string; askId: string; keys: string[]; text?: string }[];
let changed: string[];

const json = { ...H, 'content-type': 'application/json' };
const get = (id = 's1', headers: Record<string, string> = H) => app.request(`/api/sessions/${id}/ask`, { headers });
const post = (b: unknown, headers: Record<string, string> = json) => app.request('/api/sessions/s1/ask/answer', { method: 'POST', headers, body: typeof b === 'string' ? b : JSON.stringify(b) });

beforeEach(async () => {
  t = await testDeps();
  ask = { askId: 'A1', kind: 'permission', tool: 'Bash', input: 'ls', options: [{ key: 'once', label: '1 回だけ許可' }], multi: false, allowText: false };
  result = { ok: true, label: '1 回だけ許可' };
  answers = [];
  changed = [];
  t.deps.askLocal = {
    currentAsk: (id) => (id === 's1' ? ask : null),
    answer: async (id, askId, keys, text) => { answers.push({ id, askId, keys, ...(text !== undefined ? { text } : {}) }); return result; },
  };
  t.deps.askChanged = (id) => { changed.push(id); };
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('GET /api/sessions/:id/ask', () => {
  it('いま出ている札を返し、無ければ null', async () => {
    expect(await (await get()).json()).toEqual(ask);
    expect(await (await get('s2')).json()).toBeNull();
    ask = null;
    expect(await (await get()).json()).toBeNull();
  });
  it('認証が要る。MCP の秘密では呼べない', async () => {
    expect((await get('s1', {})).status).toBe(401);
    expect((await get('s1', { authorization: `Bearer ${issueMcpSecret(t.db, 's1', 1)}` })).status).toBe(401);
  });
});

describe('POST /api/sessions/:id/ask/answer', () => {
  it('askId と keys と text を host.local.answer へ渡し、答えを 200 で返す。答えたら札の変化を知らせる', async () => {
    const r = await post({ askId: 'A1', keys: ['once'], text: 'x' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, label: '1 回だけ許可' });
    expect(answers).toEqual([{ id: 's1', askId: 'A1', keys: ['once'], text: 'x' }]);
    expect(changed).toEqual(['s1']);
  });
  it('ディレクトリの信頼の札も、同じ口で読み、答えは同じ answerer（host.local.answer）へ渡る', async () => {
    ask = { askId: 'T1', kind: 'permission', tool: 'FolderTrust', input: '/w/app', options: [{ key: '1', label: 'Yes, I trust this folder' }, { key: '2', label: 'No, exit' }], multi: false, allowText: false };
    expect(await (await get()).json()).toEqual(ask);
    result = { ok: true, label: 'Yes, I trust this folder' };
    expect(await (await post({ askId: 'T1', keys: ['1'] })).json()).toEqual({ ok: true, label: 'Yes, I trust this folder' });
    expect(answers).toEqual([{ id: 's1', askId: 'T1', keys: ['1'] }]);
  });
  it('断りも 200 の本文で、peer chat と同じ理由の値のまま返す', async () => {
    for (const reason of ['ask-mismatch', 'already-answered', 'session-unknown'] as const) {
      result = { ok: false, reason };
      expect(await (await post({ askId: 'A1', keys: ['once'] })).json()).toEqual({ ok: false, reason });
    }
    result = { ok: false, reason: 'ask-mismatch', sent: true };
    expect(await (await post({ askId: 'A1', keys: ['once'] })).json()).toEqual({ ok: false, reason: 'ask-mismatch', sent: true });
  });
  it('形が違うのは 400、大きすぎる本文は 413。host には渡さない', async () => {
    for (const b of [{ keys: ['a'] }, { askId: 'A1', keys: 'a' }, { askId: 'A1', keys: [1] }, { askId: 'A1', keys: ['a'], text: 3 }, { askId: '', keys: ['a'] }, { askId: 'A1', keys: Array.from({ length: 200 }, () => 'a') }, 'not json']) {
      expect((await post(b)).status).toBe(400);
    }
    expect((await post({ askId: 'A1', keys: ['a'], text: 'x'.repeat(200 * 1024) })).status).toBe(413);
    expect(answers).toEqual([]);
  });
  it('認証が要る', async () => {
    expect((await post({ askId: 'A1', keys: ['once'] }, { 'content-type': 'application/json' })).status).toBe(401);
    expect(answers).toEqual([]);
  });
});

describe('札の口を持たない組み立て', () => {
  it('どちらの経路も出さない', async () => {
    delete t.deps.askLocal;
    const bare = createApp(t.deps);
    expect((await bare.request('/api/sessions/s1/ask', { headers: H })).status).toBe(404);
    expect((await bare.request('/api/sessions/s1/ask/answer', { method: 'POST', headers: json, body: '{}' })).status).toBe(404);
  });
});
