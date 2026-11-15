import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceStateDto } from '@agent-hangar/shared';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 机の音声の口（GET /api/voice、POST /api/voice/hold|toggle|speak|stop|prepare）の試験。

const STATE: VoiceStateDto = { available: true, models: { state: 'ready', progress: 1 }, mode: 'off', phase: 'off', caption: null, speakingId: null, meeting: false, callable: true };
const fake = (ok = true) => ({
  state: vi.fn(() => STATE),
  hold: vi.fn(() => ok), toggle: vi.fn(() => ok), speak: vi.fn(() => ok), stopSpeaking: vi.fn(() => ok), prepare: vi.fn(() => ok),
});
let t: TestWorld;
const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) => app.request(path, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => { t = await testDeps(); });
afterEach(() => { t.dispose(); });

describe('補助が無い環境', () => {
  it('GET /api/voice は available が偽で、動かす口は 409', async () => {
    const app = createApp(t.deps);
    const r = await app.request('/api/voice', { headers: H });
    expect(r.status).toBe(200);
    expect((await r.json()).available).toBe(false);
    for (const [p, b] of [['hold', { on: true }], ['toggle', { on: true }], ['speak', { id: 'a', text: 'b' }], ['stop', {}], ['prepare', {}]] as const) {
      expect((await post(app, `/api/voice/${p}`, b)).status, p).toBe(409);
    }
  });
});

describe('補助がある環境', () => {
  it('GET /api/voice はサービスの状態を返す', async () => {
    const app = createApp({ ...t.deps, voice: fake() });
    expect(await (await app.request('/api/voice', { headers: H })).json()).toEqual(STATE);
  });
  it('hold と toggle は on を真偽で受け、サービスへ渡す。真偽でなければ 400', async () => {
    const v = fake();
    const app = createApp({ ...t.deps, voice: v });
    expect((await post(app, '/api/voice/hold', { on: true })).status).toBe(200);
    expect(v.hold).toHaveBeenCalledWith(true);
    expect((await post(app, '/api/voice/toggle', { on: false })).status).toBe(200);
    expect(v.toggle).toHaveBeenCalledWith(false);
    expect((await post(app, '/api/voice/hold', { on: 'yes' })).status).toBe(400);
    expect((await post(app, '/api/voice/toggle', {})).status).toBe(400);
  });
  it('speak は id と text を文字で受け、渡す。文字でなければ 400', async () => {
    const v = fake();
    const app = createApp({ ...t.deps, voice: v });
    expect((await post(app, '/api/voice/speak', { id: 'r1', text: '終わりました' })).status).toBe(200);
    expect(v.speak).toHaveBeenCalledWith('r1', '終わりました');
    expect((await post(app, '/api/voice/speak', { id: 'r1' })).status).toBe(400);
    expect((await post(app, '/api/voice/speak', { id: 1, text: 'x' })).status).toBe(400);
  });
  it('stop と prepare はサービスへ渡す', async () => {
    const v = fake();
    const app = createApp({ ...t.deps, voice: v });
    expect((await post(app, '/api/voice/stop', {})).status).toBe(200);
    expect((await post(app, '/api/voice/prepare', {})).status).toBe(200);
    expect(v.stopSpeaking).toHaveBeenCalled();
    expect(v.prepare).toHaveBeenCalled();
  });
  it('補助が使えない（サービスが false を返す）と 409', async () => {
    const app = createApp({ ...t.deps, voice: fake(false) });
    expect((await post(app, '/api/voice/hold', { on: true })).status).toBe(409);
  });
});
