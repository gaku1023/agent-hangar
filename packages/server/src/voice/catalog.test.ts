import { describe, expect, it, vi } from 'vitest';
import { buildCatalog, engineUrl, fetchEngineSource, openEngine } from './catalog.ts';

// 声の一覧（エンジンの /speakers と、補助が返すこの Mac の声）の試験。

const SPEAKERS = [
  { name: 'ずんだもん', speaker_uuid: 'u1', styles: [{ name: 'ノーマル', id: 3 }, { name: 'あまあま', id: 1, type: 'talk' }, { name: 'うた', id: 6000, type: 'singing' }] },
  { name: '四国めたん', speaker_uuid: 'u2', styles: [{ name: 'ノーマル', id: 2, type: 'talk' }] },
];
const json = (body: unknown, ok = true): Response => ({ ok, json: async () => body }) as unknown as Response;
const never = (): Promise<Response> => new Promise(() => { /* 応えない */ });

describe('engineUrl', () => {
  it('既定の口を返し、環境変数が 127.0.0.1 なら使う', () => {
    expect(engineUrl('voicevox', {})).toBe('http://127.0.0.1:50021');
    expect(engineUrl('aivis', {})).toBe('http://127.0.0.1:10101');
    expect(engineUrl('voicevox', { HANGAR_VOICEVOX_URL: 'http://127.0.0.1:5000' })).toBe('http://127.0.0.1:5000');
    expect(engineUrl('aivis', { HANGAR_AIVIS_URL: 'http://127.0.0.1:9/' })).toBe('http://127.0.0.1:9');
  });
  it('127.0.0.1 以外、http 以外、壊れた URL は既定に戻す', () => {
    for (const u of ['http://example.com:50021', 'http://localhost:50021', 'http://127.0.0.1.evil.com:1', 'https://127.0.0.1:50021', 'http://user@192.168.1.5:1', 'not a url', '']) {
      expect(engineUrl('voicevox', { HANGAR_VOICEVOX_URL: u }), u).toBe('http://127.0.0.1:50021');
    }
  });
});

describe('fetchEngineSource', () => {
  it('/speakers の応答を話者とスタイルにし、talk 以外のスタイルは除く', async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json(SPEAKERS));
    const s = await fetchEngineSource('voicevox', { env: {}, fetch: f });
    expect(f.mock.calls[0]![0]).toBe('http://127.0.0.1:50021/speakers');
    expect(s).toEqual({
      id: 'voicevox', running: true,
      speakers: [
        { name: 'ずんだもん', styles: [{ name: 'ノーマル', voice: 'voicevox:3' }, { name: 'あまあま', voice: 'voicevox:1' }] },
        { name: '四国めたん', styles: [{ name: 'ノーマル', voice: 'voicevox:2' }] },
      ],
    });
  });
  it('AivisSpeech は aivis:<id> で、大きな style id も通す', async () => {
    const s = await fetchEngineSource('aivis', { env: {}, fetch: async () => json([{ name: 'A', styles: [{ name: 'n', id: 888753760 }] }]) });
    expect(s.speakers[0]!.styles[0]!.voice).toBe('aivis:888753760');
  });
  it('talk のスタイルが無い話者は出さない。id が非負の整数でないスタイルも捨てる', async () => {
    const s = await fetchEngineSource('voicevox', { env: {}, fetch: async () => json([
      { name: 'A', styles: [{ name: 'x', id: 1, type: 'singing' }] },
      { name: 'B', styles: [{ name: 'x', id: -1 }, { name: 'y', id: 1.5 }, { name: 'z', id: '3' }, { name: 'ok', id: 4 }] },
    ]) });
    expect(s.speakers).toEqual([{ name: 'B', styles: [{ name: 'ok', voice: 'voicevox:4' }] }]);
  });
  it('繋がらない・応えない・壊れた応答は running:false で speakers は空', async () => {
    const bad: Array<typeof fetch> = [
      async () => { throw new Error('ECONNREFUSED'); },
      never,
      async () => ({ ok: true, json: async () => { throw new SyntaxError('x'); } }) as unknown as Response,
      async () => json({ not: 'array' }),
      async () => json([], false),
    ];
    for (const f of bad) {
      expect(await fetchEngineSource('aivis', { env: {}, fetch: f, timeoutMs: 20 })).toEqual({ id: 'aivis', running: false, speakers: [] });
    }
  });
  it('環境変数が外の URL なら、既定の口へ繋ぐ', async () => {
    const f = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => json([]));
    await fetchEngineSource('voicevox', { env: { HANGAR_VOICEVOX_URL: 'http://evil.example:1' }, fetch: f });
    expect(f.mock.calls[0]![0]).toBe('http://127.0.0.1:50021/speakers');
  });
});

describe('buildCatalog', () => {
  it('kokoro・voicevox・aivis・os の順で、Kokoro は固定の 5 つ、この Mac の声は os:<識別子>', async () => {
    const f = vi.fn(async (u: string | URL | Request) => (String(u).includes(':50021') ? json(SPEAKERS) : never()));
    const c = await buildCatalog({ os: { running: true, voices: [{ id: 'com.apple.voice.Kyoko', name: 'Kyoko' }] }, env: {}, fetch: f as unknown as typeof fetch, timeoutMs: 20 });
    expect(c.sources.map((s) => [s.id, s.running])).toEqual([['kokoro', true], ['voicevox', true], ['aivis', false], ['os', true]]);
    expect(c.sources[0]!.speakers.map((s) => s.styles)).toEqual(
      ['jf_alpha', 'jf_gongitsune', 'jf_nezumi', 'jf_tebukuro', 'jm_kumo'].map((v) => [{ name: '', voice: `kokoro:${v}` }]),
    );
    expect(c.sources[0]!.speakers[0]!.name).toBe('jf_alpha');
    expect(c.sources[3]!.speakers).toEqual([{ name: 'Kyoko', styles: [{ name: '', voice: 'os:com.apple.voice.Kyoko' }] }]);
  });
  it('補助が 1 秒で答えなかった os は running:true で speakers は空（最後に受けた値があればそれ）', async () => {
    const c = await buildCatalog({ os: { running: true, voices: [] }, env: {}, fetch: (async () => { throw new Error('x'); }) as typeof fetch });
    expect(c.sources[3]).toEqual({ id: 'os', running: true, speakers: [] });
  });
  it('2 つのエンジンの待ちは並行で、遅いほうだけ running:false にして全体は待たせない', async () => {
    const t0 = Date.now();
    const c = await buildCatalog({ os: { running: true, voices: [] }, env: {}, fetch: never as unknown as typeof fetch, timeoutMs: 50 });
    expect(Date.now() - t0).toBeLessThan(500);
    expect(c.sources.filter((s) => !s.running).map((s) => s.id)).toEqual(['voicevox', 'aivis']);
  });
});

describe('openEngine', () => {
  it('macOS では open -a で起こす。シェルを通さない', async () => {
    const exec = vi.fn(async (_f: string, _a: string[]) => undefined);
    expect(await openEngine('voicevox', { platform: 'darwin', exec })).toBe('ok');
    expect(await openEngine('aivis', { platform: 'darwin', exec })).toBe('ok');
    expect(exec.mock.calls).toEqual([['open', ['-a', 'VOICEVOX']], ['open', ['-a', 'AivisSpeech']]]);
  });
  it('macOS 以外は実行せずに unsupported', async () => {
    const exec = vi.fn(async (_f: string, _a: string[]) => undefined);
    expect(await openEngine('voicevox', { platform: 'win32', exec })).toBe('unsupported');
    expect(exec).not.toHaveBeenCalled();
  });
  it('開けなければ failed と理由', async () => {
    const r = await openEngine('aivis', { platform: 'darwin', exec: async () => { throw new Error('Unable to find application'); } });
    expect(r).toEqual({ failed: 'Unable to find application' });
  });
});
