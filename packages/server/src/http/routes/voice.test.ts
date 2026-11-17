import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceStateDto } from '@agent-hangar/shared';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 机の音声の口（GET /api/voice、POST /api/voice/hold|toggle|speak|stop|prepare）の試験。

const STATE: VoiceStateDto = { available: true, models: { state: 'ready', progress: 1 }, mode: 'off', phase: 'off', caption: null, speakingId: null, toggled: false, meeting: false, callable: true };
const fake = (ok = true) => ({
  state: vi.fn(() => STATE),
  hold: vi.fn(() => ok), toggle: vi.fn(() => ok), speak: vi.fn(() => ok), stopSpeaking: vi.fn(() => ok), prepare: vi.fn(() => ok),
  osVoices: vi.fn(async () => (ok ? { running: true, voices: [{ id: 'com.apple.voice.Kyoko', name: 'Kyoko' }] } : null)),
  preview: vi.fn(() => ok), personaName: vi.fn(() => 'ミナ'),
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
    for (const [p, b] of [['hold', { on: true }], ['toggle', { on: true }], ['speak', { id: 'a', text: 'b' }], ['stop', {}], ['prepare', {}], ['preview', { voice: 'kokoro:jf_alpha', speed: 1 }], ['engine', { source: 'voicevox' }]] as const) {
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

describe('声の一覧・試し聞き・エンジンを開く', () => {
  const engineFetch = (async (u: string | URL | Request) => (String(u).includes(':50021')
    ? ({ ok: true, json: async () => [{ name: 'ずんだもん', styles: [{ name: 'ノーマル', id: 3 }] }] })
    : Promise.reject(new Error('down')))) as unknown as typeof fetch;
  const appWith = (v: ReturnType<typeof fake> | undefined, engine: Record<string, unknown> = {}) =>
    createApp({ ...t.deps, ...(v ? { voice: v } : {}), voiceEngine: { fetch: engineFetch, env: {}, timeoutMs: 30, ...engine } } as never);

  it('GET /voices は補助が無ければ 409', async () => {
    expect((await appWith(undefined).request('/api/voice/voices', { headers: H })).status).toBe(409);
    expect((await appWith(fake(false)).request('/api/voice/voices', { headers: H })).status).toBe(409);
  });
  it('GET /voices は 4 つの出どころの一覧を返し、落ちているエンジンは running:false', async () => {
    const r = await appWith(fake()).request('/api/voice/voices', { headers: H });
    expect(r.status).toBe(200);
    const c = await r.json();
    expect(c.sources.map((s: { id: string; running: boolean }) => [s.id, s.running])).toEqual([['kokoro', true], ['voicevox', true], ['aivis', false], ['os', true]]);
    expect(c.sources[1].speakers[0].styles[0].voice).toBe('voicevox:3');
    expect(c.sources[3].speakers[0].styles[0].voice).toBe('os:com.apple.voice.Kyoko');
  });
  it('POST /preview は声と速さを検査し、text が無ければ人格の名前の決まった一文を渡す', async () => {
    const v = fake();
    const app = appWith(v);
    expect((await post(app, '/api/voice/preview', { voice: 'voicevox:3', speed: 1.2 })).status).toBe(200);
    expect(v.preview).toHaveBeenCalledWith('voicevox:3', 1.2, 'ミナ です。この声で読み上げます。');
    expect((await post(app, '/api/voice/preview', { voice: 'os:x', speed: 1, text: 'こんにちは' })).status).toBe(200);
    expect(v.preview).toHaveBeenLastCalledWith('os:x', 1, 'こんにちは');
  });
  it('POST /preview の不正な本文は 400', async () => {
    const v = fake();
    const app = appWith(v);
    for (const b of [{}, { voice: 'voicevox:x', speed: 1 }, { voice: 'kokoro:jf_alpha' }, { voice: 'kokoro:jf_alpha', speed: 3 }, { voice: 'kokoro:jf_alpha', speed: 0.1 }, { voice: 'kokoro:jf_alpha', speed: '1' }, { voice: 'kokoro:jf_alpha', speed: 1, text: 5 }, { voice: 'kokoro:jf_alpha', speed: 1, text: '' }, { voice: 'kokoro:jf_alpha', speed: 1, text: 'あ'.repeat(201) }]) {
      expect((await post(app, '/api/voice/preview', b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(v.preview).not.toHaveBeenCalled();
  });
  it('POST /preview は補助が使えなければ 409', async () => {
    expect((await post(appWith(fake(false)), '/api/voice/preview', { voice: 'kokoro:jf_alpha', speed: 1 })).status).toBe(409);
  });
  it('POST /engine は source を検査し、open -a を呼ぶ', async () => {
    const exec = vi.fn(async (_f: string, _a: string[]) => undefined);
    const app = appWith(fake(), { platform: 'darwin', exec });
    expect((await post(app, '/api/voice/engine', { source: 'voicevox' })).status).toBe(200);
    expect((await post(app, '/api/voice/engine', { source: 'aivis' })).status).toBe(200);
    expect(exec.mock.calls).toEqual([['open', ['-a', 'VOICEVOX']], ['open', ['-a', 'AivisSpeech']]]);
    for (const b of [{}, { source: 'kokoro' }, { source: 'os' }, { source: 'VOICEVOX' }, { source: 3 }, { source: 'voicevox; rm -rf /' }]) {
      expect((await post(app, '/api/voice/engine', b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(exec).toHaveBeenCalledTimes(2);
  });
  it('POST /engine は macOS 以外で 409、開けなければ 502', async () => {
    const exec = vi.fn(async (_f: string, _a: string[]) => undefined);
    expect((await post(appWith(fake(), { platform: 'win32', exec }), '/api/voice/engine', { source: 'voicevox' })).status).toBe(409);
    expect(exec).not.toHaveBeenCalled();
    const bad = appWith(fake(), { platform: 'darwin', exec: async () => { throw new Error('nope'); } });
    expect((await post(bad, '/api/voice/engine', { source: 'voicevox' })).status).toBe(502);
  });
});
