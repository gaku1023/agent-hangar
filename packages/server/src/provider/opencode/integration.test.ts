import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import { OpencodeProvidersError, OpencodeProvidersService, PROVIDERS_SERVE_KEY, type OpencodeProvidersDeps } from './integration.ts';
import { ServeManager } from './serve/manager.ts';
import { ServeRegistry } from './serve/registry.ts';

const SECRET = 'sk-hangar-test-0123456789abcdef';

/** dir の下の全部のファイルの中身に needle が無いか。 */
function filesWith(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (fs.readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

// 偽の opencode の serve を本当に起こして聞く。止め方が POSIX のものなので、Windows では飛ばす。
posixDescribe('OpencodeProvidersService', () => {
  let dir: string;
  let hangarHome: string;
  let configFile: string;
  let managers: ServeManager[];
  let services: OpencodeProvidersService[];
  let servers: http.Server[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-providers-'));
    hangarHome = path.join(dir, 'hangar');
    fs.mkdirSync(hangarHome);
    configFile = path.join(dir, 'config', 'opencode', 'opencode.json');
    managers = [];
    services = [];
    servers = [];
  });
  afterEach(async () => {
    for (const s of services) await s.close();
    for (const m of managers) await m.stopAll();
    for (const s of servers) await new Promise<void>((r) => { s.close(() => r()); });
    fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const make = (fake: FakeOpencodeOptions = {}, deps: Partial<OpencodeProvidersDeps> = {}) => {
    const { bin, logFile } = writeFakeOpencode(path.join(dir, 'oc'), { configFile, ...fake });
    const serves = new ServeManager({ enabled: () => true, bin: () => bin, version: async () => '2.1.4', registry: new ServeRegistry(path.join(hangarHome, 'serves.json')), killGraceMs: 300 });
    managers.push(serves);
    const changed = vi.fn();
    const service = new OpencodeProvidersService({
      serves, home: '/home/me', configFile, onChange: changed, now: () => new Date(2026, 9, 25, 13, 5, 9), pollMs: 20, ...deps,
    });
    services.push(service);
    return { service, serves, logFile, changed };
  };

  /** OpenAI 互換のサーバーのふり。prefix の下の /models だけに答え、apiKey があれば Bearer を求める。 */
  const openaiServer = async (o: { prefix?: string; apiKey?: string; ids?: string[] } = {}) => {
    const seen: { path: string; auth: string | undefined }[] = [];
    const srv = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', auth: req.headers.authorization });
      if (o.apiKey && req.headers.authorization !== `Bearer ${o.apiKey}`) { res.writeHead(401); res.end('{"error":"unauthorized"}'); return; }
      if (req.url !== `${o.prefix ?? '/v1'}/models`) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: (o.ids ?? ['qwen3.8-27b-awq', 'glm-5.3-air-fp8']).map((id) => ({ id, object: 'model' })) }));
    });
    servers.push(srv);
    await new Promise<void>((r) => { srv.listen(0, '127.0.0.1', () => r()); });
    return { base: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, seen };
  };

  posixIt('一覧：つないだ先と、つないでいない追加の一覧（おすすめが先頭）を返す。料金は models.dev の保存から', async () => {
    const { service } = make({ credentials: ['groq'] }, {
      catalog: { refresh: async () => false, current: () => ({ fetchedAt: 1, providers: { deepseek: { a: { cost: { input: 0.27, output: 1.1 }, context: null, tools: true } }, abacus: { a: { cost: { input: 0, output: 0 }, context: null, tools: true }, b: { cost: { input: 1, output: 2 }, context: null, tools: true } } } }) },
    });
    const dto = await service.list();
    expect(dto.configPath).toBe(configFile);
    expect(dto.connected).toEqual([
      { id: 'opencode', name: 'OpenCode Zen', via: 'auto', envName: null, url: null, where: 'remote', price: null, canChangeKey: false, canDisconnect: false },
      { id: 'lmstudio', name: 'LM Studio', via: 'auto', envName: null, url: null, where: 'device', price: { kind: 'local', monthlyUsd: null, loginOnly: false }, canChangeKey: false, canDisconnect: false },
      { id: 'groq', name: 'Groq', via: 'key', envName: null, url: null, where: 'remote', price: null, canChangeKey: true, canDisconnect: true },
    ]);
    expect(dto.catalog.map((c) => c.id)).toEqual(['deepseek', 'zai', 'opencode-go', 'zai-coding-plan', 'github-copilot', 'abacus']);
    expect(dto.catalog.find((c) => c.id === 'deepseek')).toEqual({ id: 'deepseek', name: 'DeepSeek', recommended: true, key: true, logins: [], price: { kind: 'metered', monthlyUsd: null, loginOnly: false } });
    expect(dto.catalog.find((c) => c.id === 'opencode-go')?.price).toEqual({ kind: 'plan', monthlyUsd: 10, loginOnly: false });
    expect(dto.catalog.find((c) => c.id === 'github-copilot')).toMatchObject({ key: false, logins: [{ id: 'device', label: 'Login with GitHub Copilot' }], price: { kind: 'plan', loginOnly: true } });
    expect(dto.catalog.find((c) => c.id === 'abacus')).toMatchObject({ recommended: false, price: { kind: 'metered-free' } });
  });

  posixIt('API キーを opencode の integration に渡す。hangar のファイル、ログ、応答、serve の argv と環境には出さない', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const { service, logFile, changed } = make();
    const dto = await service.connectKey('deepseek', `  ${SECRET}\n`);
    expect(dto.connected.find((c) => c.id === 'deepseek')).toMatchObject({ via: 'key', canChangeKey: true, canDisconnect: true });
    expect(dto.catalog.some((c) => c.id === 'deepseek')).toBe(false);
    const events = readFakeOpencodeLog(logFile);
    // 前後の空白を落として渡す。
    expect(events.filter((e) => e.ev === 'connectKey')).toMatchObject([{ id: 'deepseek', key: SECRET }]);
    for (const e of events.filter((x) => x.ev === 'start')) expect(JSON.stringify(e)).not.toContain(SECRET);
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    expect(filesWith(hangarHome, SECRET)).toEqual([]);
    expect(fs.existsSync(configFile)).toBe(false);
    for (const l of logs) expect(JSON.stringify(l.mock.calls)).not.toContain(SECRET);
    expect(changed).toHaveBeenCalled();
  });

  posixIt('API キーを変更すると、新しい接続を作ってから前の接続を消す。接続を解除すると全部消す', async () => {
    const { service, logFile } = make({ credentials: ['groq'] });
    await service.connectKey('groq', SECRET);
    let ev = readFakeOpencodeLog(logFile);
    expect(ev.filter((e) => e.ev === 'deleteCredential').map((e) => (e as { id: string }).id)).toEqual(['cred_fake1']);
    const dto = await service.disconnect('groq');
    ev = readFakeOpencodeLog(logFile);
    expect(ev.filter((e) => e.ev === 'deleteCredential').map((e) => (e as { id: string }).id)).toEqual(['cred_fake1', 'cred_fake2']);
    expect(dto.connected.some((c) => c.id === 'groq')).toBe(false);
  });

  posixIt('知らないプロバイダーと空の API キーは断る。断りの文にも API キーを載せない', async () => {
    const { service } = make();
    await expect(service.connectKey('nope', SECRET)).rejects.toMatchObject({ code: 'unknown-provider' });
    await expect(service.connectKey('deepseek', '   ')).rejects.toMatchObject({ code: 'empty-key' });
    const e = await service.connectKey('nope', SECRET).then(() => new Error('resolved'), (x: unknown) => x as Error);
    expect(e).toBeInstanceOf(OpencodeProvidersError);
    expect(String(e.message)).not.toContain(SECRET);
  });

  posixIt('OpenAI 互換のサーバー：/v1/models からモデルを取り、opencode.json をバックアップしてから書く。既存のコメントと並びは保ち、API キーは integration に渡す', async () => {
    const user = '{\n    // 私の設定\n    "model": "lmstudio/qwen", // いつもの\n    "share": "disabled"\n}\n';
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, user);
    const srv = await openaiServer({ apiKey: SECRET });
    const { service, logFile, changed } = make();
    const dto = await service.addCustom({ name: 'Home GPU', url: `${srv.base}/v1/`, apiKey: SECRET });
    const text = fs.readFileSync(configFile, 'utf8');
    expect(text).toBe([
      '{',
      '    // 私の設定',
      '    "model": "lmstudio/qwen", // いつもの',
      '    "share": "disabled",',
      '    "providers": {',
      '        "home-gpu": {',
      '            "name": "Home GPU",',
      '            "package": "@opencode/ai/providers/openai-compatible",',
      '            "settings": {',
      `                "baseURL": "${srv.base}/v1"`,
      '            },',
      '            "models": {',
      '                "qwen3.8-27b-awq": {},',
      '                "glm-5.3-air-fp8": {}',
      '            }',
      '        }',
      '    }',
      '}',
      '',
    ].join('\n'));
    expect(fs.readFileSync(`${configFile}.bak-20261025-130509`, 'utf8')).toBe(user);
    expect(srv.seen.map((s) => s.path)).toEqual(['/v1/models']);
    expect(text).not.toContain(SECRET);
    expect(readFakeOpencodeLog(logFile).filter((e) => e.ev === 'connectKey')).toMatchObject([{ id: 'home-gpu', key: SECRET }]);
    expect(dto.connected.find((c) => c.id === 'home-gpu')).toEqual({ id: 'home-gpu', name: 'Home GPU', via: 'config', envName: null, url: `${srv.base}/v1`, where: 'device', price: null, canChangeKey: true, canDisconnect: true });
    expect(JSON.stringify(dto)).not.toContain(SECRET);
    expect(filesWith(hangarHome, SECRET)).toEqual([]);
    expect(changed).toHaveBeenCalled();
  });

  posixIt('OpenAI 互換のサーバー：URL に /v1 が無ければ /v1/models も試す。名前に英数字が無ければ openai-compatible を ID にし、重なれば番号を付ける', async () => {
    const srv = await openaiServer({ ids: ['m1'] });
    const { service } = make();
    await service.addCustom({ name: '自宅のサーバー', url: srv.base });
    await service.addCustom({ name: '学内', url: srv.base });
    expect(srv.seen.map((s) => s.path)).toEqual(['/models', '/v1/models', '/models', '/v1/models']);
    const json = JSON.parse(fs.readFileSync(configFile, 'utf8')) as { providers: Record<string, { name: string; settings: { baseURL: string } }> };
    expect(Object.keys(json.providers)).toEqual(['openai-compatible', 'openai-compatible-2']);
    expect(json.providers['openai-compatible']).toMatchObject({ name: '自宅のサーバー', settings: { baseURL: `${srv.base}/v1` } });
    // 初めて書いたときは、バックアップするものが無い。
    expect(fs.readdirSync(path.dirname(configFile)).filter((f) => f.includes('.bak-')).length).toBe(1);
  });

  posixIt('OpenAI 互換のサーバー：モデルを取れなければ書かない。URL の形が違えば聞きに行かない', async () => {
    const srv = await openaiServer({ apiKey: 'other' });
    const { service } = make();
    await expect(service.addCustom({ name: 'x', url: `${srv.base}/v1`, apiKey: SECRET })).rejects.toMatchObject({ code: 'models-unreachable' });
    await expect(service.addCustom({ name: 'x', url: 'ftp://host/v1' })).rejects.toMatchObject({ code: 'bad-url' });
    await expect(service.addCustom({ name: ' ', url: `${srv.base}/v1` })).rejects.toMatchObject({ code: 'bad-name' });
    const empty = await openaiServer({ ids: [] });
    await expect(service.addCustom({ name: 'x', url: `${empty.base}/v1` })).rejects.toMatchObject({ code: 'no-models' });
    expect(fs.existsSync(configFile)).toBe(false);
  });

  posixIt('OpenAI 互換のサーバーの接続を解除すると、opencode.json からも消す（バックアップしてから）', async () => {
    const srv = await openaiServer();
    const { service } = make();
    await service.addCustom({ name: 'gpu', url: `${srv.base}/v1`, apiKey: SECRET });
    const before = fs.readFileSync(configFile, 'utf8');
    const dto = await service.disconnect('gpu');
    expect(dto.connected.some((c) => c.id === 'gpu')).toBe(false);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({ providers: {} });
    expect(fs.readdirSync(path.dirname(configFile)).filter((f) => f.endsWith('.bak-20261025-130509'))).toHaveLength(1);
    expect(fs.readFileSync(`${configFile}.bak-20261025-130509`, 'utf8')).toBe(before);
  });

  posixIt('モデル ID を追加：プロバイダーの models に足す。古い書き方（provider）の行にはそこへ足し、同じ ID なら書かない', async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '{\n  "provider": {\n    "old": { "name": "Old", "options": { "baseURL": "http://10.0.0.2/v1" }, "models": { "a": {} } }\n  }\n}\n');
    const { service, changed } = make();
    await service.addModel('old', 'b');
    await service.addModel('lmstudio', ' qwen3.9-coder-48b ');
    const json = JSON.parse(fs.readFileSync(configFile, 'utf8')) as Record<string, unknown>;
    expect(json).toEqual({ provider: { old: { name: 'Old', options: { baseURL: 'http://10.0.0.2/v1' }, models: { a: {}, b: {} } } }, providers: { lmstudio: { models: { 'qwen3.9-coder-48b': {} } } } });
    const text = fs.readFileSync(configFile, 'utf8');
    await service.addModel('old', 'b');
    expect(fs.readFileSync(configFile, 'utf8')).toBe(text);
    await expect(service.addModel('old', '  ')).rejects.toMatchObject({ code: 'bad-model' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  posixIt('opencode.json が読めなければ書かない', async () => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, '{ "providers": [ }');
    const { service } = make();
    await expect(service.addModel('lmstudio', 'x')).rejects.toMatchObject({ code: 'config-unreadable' });
    expect(fs.readFileSync(configFile, 'utf8')).toBe('{ "providers": [ }');
  });

  posixIt('ログイン：フォームの既定の答えで始め、進みを聞き、終わったら知らせる。コードを入れる型は complete に渡す', async () => {
    const { service, logFile, changed } = make({ oauthPendingPolls: 1 });
    const a = await service.login('github-copilot', 'device');
    expect(a).toEqual({ attemptId: 'att_fake1', url: 'https://example.invalid/device', instructions: 'Enter code ABCD-1234', mode: 'auto' });
    expect(readFakeOpencodeLog(logFile).find((e) => e.ev === 'oauth')).toMatchObject({ id: 'github-copilot', body: { methodID: 'device', answer: { deploymentType: 'github.com' } } });
    expect(await service.loginStatus('github-copilot', a.attemptId)).toEqual({ status: 'pending', message: null });
    expect(changed).not.toHaveBeenCalled();
    expect(await service.loginStatus('github-copilot', a.attemptId)).toEqual({ status: 'complete', message: null });
    expect(changed).toHaveBeenCalled();
    const b = await service.login('opencode', 'device');
    expect(b.mode).toBe('code');
    expect(readFakeOpencodeLog(logFile).filter((e) => e.ev === 'oauth')[1]).toMatchObject({ body: { methodID: 'device', answer: { server: 'https://opencode.ai/console' } } });
    await service.loginComplete('opencode', b.attemptId, ' CODE-1 ');
    expect(readFakeOpencodeLog(logFile).find((e) => e.ev === 'oauthComplete')).toMatchObject({ id: 'opencode', code: 'CODE-1' });
    await expect(service.login('deepseek', 'device')).rejects.toMatchObject({ code: 'login-unsupported' });
  });

  posixIt('問い合わせのための serve は 1 本だけ起こし、使い終えて間が空いたら止める', async () => {
    const { service, serves, logFile } = make({}, { idleMs: 150 });
    await service.list();
    await service.list();
    expect(readFakeOpencodeLog(logFile).filter((e) => e.ev === 'start')).toHaveLength(1);
    expect(serves.get(PROVIDERS_SERVE_KEY)).not.toBeNull();
    await new Promise((r) => { setTimeout(r, 600); });
    expect(serves.get(PROVIDERS_SERVE_KEY)).toBeNull();
  });
});
