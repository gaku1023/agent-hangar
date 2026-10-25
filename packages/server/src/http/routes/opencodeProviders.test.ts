import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpencodeProvidersDto } from '@agent-hangar/shared';
import { OpencodeProvidersError } from '../../provider/opencode/integration.ts';
import { createApp, type AppDeps } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 設定のプロバイダーの経路（routes/opencodeProviders.ts）の試験。opencode の口は偽物を渡す（口そのものは provider/opencode/integration.test.ts）。

const SECRET = 'sk-route-secret-9876543210';
const LIST: OpencodeProvidersDto = {
  connected: [{ id: 'deepseek', name: 'DeepSeek', via: 'key', envName: null, url: null, where: 'remote', price: null, canChangeKey: true, canDisconnect: true }],
  catalog: [{ id: 'zai', name: 'Z.AI（GLM）', recommended: true, key: true, logins: [], price: null }],
  configPath: '/home/me/.config/opencode/opencode.json',
};

let t: TestWorld;
let deps: AppDeps;
let api: { [K in keyof AppDeps['opencodeProviders']]: ReturnType<typeof vi.fn> };
const app = (enabled = true) => createApp({ ...deps, settings: () => ({ ...t.deps.settings(), opencodeEnabled: enabled }), opencodeProviders: api as unknown as AppDeps['opencodeProviders'] });
const send = (a: ReturnType<typeof createApp>, method: string, p: string, body?: unknown) =>
  a.request(p, { method, headers: { ...H, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

beforeEach(async () => {
  t = await testDeps();
  ({ deps } = t);
  api = {
    list: vi.fn(async () => LIST), connectKey: vi.fn(async () => LIST), disconnect: vi.fn(async () => LIST), addModel: vi.fn(async () => LIST), addCustom: vi.fn(async () => LIST),
    login: vi.fn(async () => ({ attemptId: 'a1', url: 'https://example.invalid', instructions: 'go', mode: 'auto' })),
    loginStatus: vi.fn(async () => ({ status: 'pending', message: null })), loginComplete: vi.fn(async () => undefined), loginCancel: vi.fn(async () => undefined),
  };
});
afterEach(() => { t.dispose(); });

describe('opencode のプロバイダー', () => {
  it('一覧を返す。opencode が切なら 409 で、口を呼ばない', async () => {
    expect(await (await send(app(), 'GET', '/api/opencode/providers')).json()).toEqual(LIST);
    const r = await send(app(false), 'GET', '/api/opencode/providers');
    expect(r.status).toBe(409);
    expect(api.list).toHaveBeenCalledTimes(1);
  });

  it('API キーは口に渡すだけで、応答に載せない。断りの文にも載せない', async () => {
    const r = await send(app(), 'POST', '/api/opencode/providers/deepseek/key', { key: SECRET });
    expect(api.connectKey).toHaveBeenCalledWith('deepseek', SECRET);
    expect(await r.text()).not.toContain(SECRET);
    api.connectKey.mockRejectedValueOnce(new Error(`opencode API answered 400: bad ${SECRET}`));
    const failed = await send(app(), 'POST', '/api/opencode/providers/deepseek/key', { key: SECRET });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain(SECRET);
    expect((await send(app(), 'POST', '/api/opencode/providers/deepseek/key', { key: 3 })).status).toBe(400);
  });

  it('口の断り（OpencodeProvidersError）は 400 で、その理由の文を返す', async () => {
    api.addCustom.mockRejectedValueOnce(new OpencodeProvidersError('models-unreachable', 'answered 401'));
    const r = await send(app(), 'POST', '/api/opencode/custom-providers', { name: 'gpu', url: 'http://10.0.0.2/v1', apiKey: SECRET });
    expect(r.status).toBe(400);
    expect((await r.json()).error).toBe('/v1/models からモデル一覧を取得できませんでした。URL と API キーを確認してください。');
    expect(api.addCustom).toHaveBeenCalledWith({ name: 'gpu', url: 'http://10.0.0.2/v1', apiKey: SECRET });
  });

  it('接続を解除、モデル ID を追加、OpenAI 互換のサーバー（API キーは省ける）', async () => {
    await send(app(), 'DELETE', '/api/opencode/providers/groq');
    expect(api.disconnect).toHaveBeenCalledWith('groq');
    await send(app(), 'POST', '/api/opencode/providers/lmstudio/models', { model: 'qwen3.9-coder-48b' });
    expect(api.addModel).toHaveBeenCalledWith('lmstudio', 'qwen3.9-coder-48b');
    await send(app(), 'POST', '/api/opencode/custom-providers', { name: 'gpu', url: 'http://10.0.0.2/v1' });
    expect(api.addCustom).toHaveBeenLastCalledWith({ name: 'gpu', url: 'http://10.0.0.2/v1' });
    expect((await send(app(), 'POST', '/api/opencode/custom-providers', { name: 'gpu' })).status).toBe(400);
  });

  it('ログインを始め、進みを聞き、コードで終え、取り消す', async () => {
    expect(await (await send(app(), 'POST', '/api/opencode/providers/github-copilot/login', { method: 'device' })).json()).toEqual({ attemptId: 'a1', url: 'https://example.invalid', instructions: 'go', mode: 'auto' });
    expect(api.login).toHaveBeenCalledWith('github-copilot', 'device');
    expect(await (await send(app(), 'GET', '/api/opencode/providers/github-copilot/login/a1')).json()).toEqual({ status: 'pending', message: null });
    expect((await send(app(), 'POST', '/api/opencode/providers/opencode/login/a1/complete', { code: 'C-1' })).status).toBe(204);
    expect(api.loginComplete).toHaveBeenCalledWith('opencode', 'a1', 'C-1');
    expect((await send(app(), 'DELETE', '/api/opencode/providers/opencode/login/a1')).status).toBe(204);
    expect(api.loginCancel).toHaveBeenCalledWith('opencode', 'a1');
  });
});
