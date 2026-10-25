import type { Context, Hono } from 'hono';
import { opencodeEnabledOf, type MessageKey } from '@agent-hangar/shared';
import { errorText, translatorOf } from '../../i18n/message.ts';
import { OpencodeProvidersError, type OpencodeProvidersErrorCode } from '../../provider/opencode/integration.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';
import { BODY_LIMITS, readJson, tooLargeResult } from './common.ts';

/** 設定のプロバイダーの経路が使う依存。 */
export type OpencodeProviderRouteDeps = Pick<AppDeps, 'settings' | 'opencodeProviders'> & LanguageDeps;

/** 口の断りの code ごとの文。 */
const REASON: Record<OpencodeProvidersErrorCode, MessageKey> = {
  'unknown-provider': 'system.opencode.providers.unknownProvider',
  'empty-key': 'system.opencode.providers.emptyKey',
  'bad-name': 'system.opencode.providers.badName',
  'bad-url': 'system.opencode.providers.badUrl',
  'bad-model': 'system.opencode.providers.badModel',
  'models-unreachable': 'system.opencode.providers.modelsUnreachable',
  'no-models': 'system.opencode.providers.noModels',
  'login-unsupported': 'system.opencode.providers.loginUnsupported',
  'config-unreadable': 'system.opencode.providers.configUnreadable',
};

/**
 * 設定の「連携 › opencode › プロバイダー」の経路（docs/design.md「opencode のプロバイダー」）。
 * どれも serve を起こすことがあるので、設定で opencode を有効にしていなければ 409 で断る。
 * API キーは本文で受けて口に渡すだけで、応答に載せない。口が投げた文に API キーが混ざっていたら伏せてから返す。
 */
export function opencodeProviderRoutes(api: Hono, deps: OpencodeProviderRouteDeps): void {
  const language = deps.language;
  const tr = translatorOf(deps.language);
  /** 本文の文字列の欄。無い、文字列でないときは null。 */
  const field = (b: unknown, k: string): string | null => {
    const v = (b as Record<string, unknown> | null)?.[k];
    return typeof v === 'string' ? v : null;
  };
  const run = async (c: Context, f: () => Promise<unknown>, secrets: (string | null)[] = []) => {
    if (!opencodeEnabledOf(deps.settings())) return c.json({ error: tr('system.opencode.disabled') }, 409);
    try {
      const r = await f();
      return r === undefined ? c.body(null, 204) : c.json(r);
    } catch (e) {
      // REASON の文はどれも引数を取らない。
      if (e instanceof OpencodeProvidersError) return c.json({ error: (tr as (k: MessageKey) => string)(REASON[e.code]) }, 400);
      const reason = secrets.filter((s): s is string => !!s).reduce((t, s) => t.split(s).join('***'), errorText(language(), e));
      return c.json({ error: tr('system.opencode.providersFailed', { reason }) }, 502);
    }
  };
  const body = async (c: Context): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> => readJson(c, BODY_LIMITS.default);

  api.get('/opencode/providers', (c) => run(c, () => deps.opencodeProviders.list()));
  // API キーで接続する（API キーの変更も同じ）。
  api.post('/opencode/providers/:id/key', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const key = field(b.value, 'key');
    if (key === null) return c.json({ error: tr('common.field.mustBeString', { field: 'key' }) }, 400);
    return run(c, () => deps.opencodeProviders.connectKey(c.req.param('id'), key), [key.trim(), key]);
  });
  api.delete('/opencode/providers/:id', (c) => run(c, () => deps.opencodeProviders.disconnect(c.req.param('id'))));
  api.post('/opencode/providers/:id/models', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const model = field(b.value, 'model');
    if (model === null) return c.json({ error: tr('common.field.mustBeString', { field: 'model' }) }, 400);
    return run(c, () => deps.opencodeProviders.addModel(c.req.param('id'), model));
  });
  // OpenAI 互換のサーバー。apiKey は任意。
  api.post('/opencode/custom-providers', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const name = field(b.value, 'name');
    const url = field(b.value, 'url');
    const apiKey = field(b.value, 'apiKey');
    if (name === null) return c.json({ error: tr('common.field.mustBeString', { field: 'name' }) }, 400);
    if (url === null) return c.json({ error: tr('common.field.mustBeString', { field: 'url' }) }, 400);
    return run(c, () => deps.opencodeProviders.addCustom({ name, url, ...(apiKey ? { apiKey } : {}) }), [apiKey?.trim() ?? null, apiKey]);
  });
  // ログイン。始めると、開く URL と案内を返す。画面は進みを聞き続け、コードを入れる型なら complete に送る。
  api.post('/opencode/providers/:id/login', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const method = field(b.value, 'method');
    if (method === null) return c.json({ error: tr('common.field.mustBeString', { field: 'method' }) }, 400);
    return run(c, () => deps.opencodeProviders.login(c.req.param('id'), method));
  });
  api.get('/opencode/providers/:id/login/:attempt', (c) => run(c, () => deps.opencodeProviders.loginStatus(c.req.param('id'), c.req.param('attempt'))));
  api.post('/opencode/providers/:id/login/:attempt/complete', async (c) => {
    const b = await body(c);
    if (b.tooLarge) return tooLargeResult(c, BODY_LIMITS.default, tr);
    const code = field(b.value, 'code') ?? '';
    return run(c, () => deps.opencodeProviders.loginComplete(c.req.param('id'), c.req.param('attempt'), code), [code.trim(), code]);
  });
  api.delete('/opencode/providers/:id/login/:attempt', (c) => run(c, () => deps.opencodeProviders.loginCancel(c.req.param('id'), c.req.param('attempt'))));
}
