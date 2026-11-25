import type { PeerChatAsk } from '@agent-hangar/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 手元の画面が、会話の前に出るフォルダの信頼の札を読み、答える口（GET と POST /api/sessions/:id/trust）。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let ask: PeerChatAsk | null;
let answered: { id: string; askId: string; keys: string[]; text?: string }[];
let result: { ok: true; label: string } | { ok: false; reason: 'ask-mismatch' | 'already-answered' | 'session-unknown' };

const json = { ...H, 'content-type': 'application/json' };
const TRUST: PeerChatAsk = { askId: 'a1', kind: 'permission', tool: 'FolderTrust', input: 'D:\\workspace\\ops', options: [{ key: '2', label: 'No, exit' }, { key: '1', label: 'Yes, I trust this folder' }], multi: false, allowText: false };

beforeEach(async () => {
  t = await testDeps();
  ask = TRUST;
  answered = [];
  result = { ok: true, label: 'Yes, I trust this folder' };
  t.deps.askLocal = {
    currentAsk: () => ask,
    answer: async (id, askId, keys, text) => { answered.push({ id, askId, keys, ...(text === undefined ? {} : { text }) }); return result; },
  };
  app = createApp(t.deps);
});
afterEach(() => { t.dispose(); });

describe('GET /api/sessions/:id/trust', () => {
  it('信頼の札があれば返し、無ければ null', async () => {
    expect(await (await app.request('/api/sessions/s1/trust', { headers: H })).json()).toEqual({ ask: TRUST });
    ask = null;
    expect(await (await app.request('/api/sessions/s1/trust', { headers: H })).json()).toEqual({ ask: null });
  });
  it('許可など別の札は返さない', async () => {
    ask = { ...TRUST, tool: 'Bash' };
    expect(await (await app.request('/api/sessions/s1/trust', { headers: H })).json()).toEqual({ ask: null });
  });
});

describe('POST /api/sessions/:id/trust', () => {
  const post = (b: unknown) => app.request('/api/sessions/s1/trust', { method: 'POST', headers: json, body: JSON.stringify(b) });
  it('key で答える', async () => {
    const r = await post({ askId: 'a1', key: '1' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, label: 'Yes, I trust this folder' });
    expect(answered).toEqual([{ id: 's1', askId: 'a1', keys: ['1'] }]);
  });
  it('答えられなければ 409 で理由を返す', async () => {
    result = { ok: false, reason: 'already-answered' };
    const r = await post({ askId: 'a1', key: '1' });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ ok: false, reason: 'already-answered' });
  });
  it('形の違う本文は 400。信頼の札でなければ打たずに 409', async () => {
    expect((await post({ askId: 'a1' })).status).toBe(400);
    ask = { ...TRUST, tool: 'Bash' };
    expect((await post({ askId: 'a1', key: '1' })).status).toBe(409);
    expect(answered).toEqual([]);
  });
});
