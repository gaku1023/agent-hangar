import type { Hono } from 'hono';
import { translatorOf } from '../../i18n/message.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { isVoiceId } from '@agent-hangar/shared';
import { buildCatalog, isEngineId, openEngine } from '../../voice/catalog.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

export type VoiceRouteDeps = Pick<AppDeps, 'voice' | 'voiceEngine'> & LanguageDeps;

/**
 * 机の音声の口（docs/design.md「机の音声」）。
 * GET /voice は状態、POST /voice/hold と /voice/toggle は押している間と切り替え、/voice/speak は読み上げ、/voice/stop は読み上げを止める、/voice/prepare はモデルの用意。
 * 補助が使えない環境（Windows、補助の無い build、落ちて戻らないとき）では、GET は available が偽で、動かす口は 409。
 * 聞き取った文を統括へ送るのはサービスで、この口からは送らない（由来を口から名乗らせないため）。
 */
export function voiceRoutes(api: Hono, deps: VoiceRouteDeps): void {
  const tr = translatorOf(deps.language);
  const unavailable = () => ({ error: tr('orchestratorPane.error.voiceUnavailable') });

  api.get('/voice', (c) => c.json(deps.voice?.state() ?? { available: false, models: { state: 'missing', progress: 0 }, mode: 'off', toggled: false, phase: 'off', caption: null, speakingId: null, meeting: false }));

  const body = async (c: Parameters<typeof readJson>[0]) => {
    const b = await readJson(c, BODY_LIMITS.memo);
    return b.tooLarge ? { tooLarge: true as const } : { tooLarge: false as const, value: (b.value ?? {}) as Record<string, unknown> };
  };

  for (const name of ['hold', 'toggle'] as const) {
    api.post(`/voice/${name}`, async (c) => {
      const b = await body(c);
      if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo, tr);
      if (typeof b.value.on !== 'boolean') return c.json({ error: tr('common.field.mustBeString', { field: 'on' }) }, 400);
      if (!deps.voice) return c.json(unavailable(), 409);
      return deps.voice[name](b.value.on) ? c.json({ ok: true }) : c.json(unavailable(), 409);
    });
  }

  api.post('/voice/speak', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo, tr);
    if (typeof b.value.id !== 'string') return c.json({ error: tr('common.field.mustBeString', { field: 'id' }) }, 400);
    if (typeof b.value.text !== 'string') return c.json({ error: tr('common.field.mustBeString', { field: 'text' }) }, 400);
    if (!deps.voice) return c.json(unavailable(), 409);
    return deps.voice.speak(b.value.id, b.value.text) ? c.json({ ok: true }) : c.json(unavailable(), 409);
  });

  api.get('/voice/voices', async (c) => {
    const os = await deps.voice?.osVoices();
    if (!os) return c.json(unavailable(), 409);
    const e = deps.voiceEngine;
    return c.json(await buildCatalog({ os, env: e?.env ?? process.env, ...(e?.fetch ? { fetch: e.fetch } : {}), ...(e?.timeoutMs !== undefined ? { timeoutMs: e.timeoutMs } : {}) }));
  });

  api.post('/voice/preview', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo, tr);
    const { voice, speed, text } = b.value;
    if (!isVoiceId(voice)) return c.json({ error: tr('common.field.mustBeString', { field: 'voice' }) }, 400);
    if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.5 || speed > 2) return c.json({ error: tr('common.field.needed', { field: 'speed' }) }, 400);
    if (text !== undefined && (typeof text !== 'string' || text.trim() === '' || Array.from(text).length > 200)) return c.json({ error: tr('common.field.mustBeString', { field: 'text' }) }, 400);
    if (!deps.voice) return c.json(unavailable(), 409);
    const line = typeof text === 'string' ? text : tr('orchestratorPane.preview.sample', { name: deps.voice.personaName() });
    return deps.voice.preview(voice, speed, line) ? c.json({ ok: true }) : c.json(unavailable(), 409);
  });

  api.post('/voice/engine', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.memo, tr);
    if (!isEngineId(b.value.source)) return c.json({ error: tr('common.field.mustBeString', { field: 'source' }) }, 400);
    if (!deps.voice) return c.json(unavailable(), 409);
    const e = deps.voiceEngine;
    const r = await openEngine(b.value.source, { platform: e?.platform ?? process.platform, ...(e?.exec ? { exec: e.exec } : {}) });
    if (r === 'ok') return c.json({ ok: true });
    if (r === 'unsupported') return c.json(unavailable(), 409);
    return c.json({ error: tr('orchestratorPane.error.engineOpen', { reason: r.failed }) }, 502);
  });

  api.post('/voice/stop', (c) => (deps.voice?.stopSpeaking() ? c.json({ ok: true }) : c.json(unavailable(), 409)));
  api.post('/voice/prepare', (c) => (deps.voice?.prepare() ? c.json({ ok: true }) : c.json(unavailable(), 409)));
}
