import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import { OPTIONS_SERVE_KEY, OpencodeOptionsService, type OpencodeOptionsDeps } from './options.ts';
import { ServeManager } from './serve/manager.ts';
import { ServeRegistry } from './serve/registry.ts';

// 偽の opencode の serve を本当に起こして一覧を取る。
// 止めたことを偽の opencode の SIGTERM の記録（term）で見る試験があり、Windows は taskkill で強制で止めるので記録が残らない。Windows では飛ばす。
// serve の起こし方と止め方そのものの Windows の試験は serve/ の試験が受け持つ。
posixDescribe('OpencodeOptionsService', () => {
  let dir: string;
  let managers: ServeManager[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-oc-options-'));
    managers = [];
  });
  afterEach(async () => {
    for (const m of managers) await m.stopAll();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const make = (fake: FakeOpencodeOptions = {}, deps: Partial<OpencodeOptionsDeps> = {}) => {
    const { bin, logFile } = writeFakeOpencode(path.join(dir, 'oc'), fake);
    const serves = new ServeManager({ enabled: () => true, bin: () => bin, version: async () => '2.1.4', registry: new ServeRegistry(path.join(dir, 'serves.json')), killGraceMs: 300 });
    managers.push(serves);
    let now = 1_000;
    const service = new OpencodeOptionsService({
      serves,
      status: async () => ({ found: true, version: '2.1.4', verified: true }),
      home: '/home/me',
      now: () => now,
      retryMs: 10,
      ...deps,
    });
    return { service, serves, logFile, advance: (ms: number) => { now += ms; } };
  };
  const starts = (logFile: string) => readFakeOpencodeLog(logFile).filter((e) => e.ev === 'start').length;

  posixIt('serve が無ければ 1 本起こして一覧を取り、取り終えたら止める', async () => {
    const { service, serves, logFile } = make();
    const o = await service.get('/w/alpha');
    expect(o).toEqual({
      version: '2.1.4',
      verified: true,
      modes: [{ id: 'build', description: 'The default agent.' }, { id: 'plan', description: 'Plan mode. Disallows all edit tools.' }],
      models: [
        { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode', provider: 'opencode', tools: true, context: null, cost: null },
        { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B', group: 'LM Studio (local)', provider: 'lmstudio', tools: true, context: null, cost: null },
        { id: 'lmstudio/gemma-4-26b', label: 'Gemma 4 26B', group: 'LM Studio (local)', provider: 'lmstudio', tools: true, context: null, cost: null },
      ],
      providers: [{ id: 'opencode', name: 'OpenCode', where: 'remote' }, { id: 'lmstudio', name: 'LM Studio (local)', where: 'device' }],
      defaultModel: 'lmstudio/qwen/qwen3-coder-30b',
      pricesAt: null,
      fetchedAt: 1_000,
      stale: false,
    });
    const log = readFakeOpencodeLog(logFile);
    // 一覧は選んだ場所で聞く（opencode.json の重なりが場所で変わるため）。
    const lists = log.filter((e) => e.ev === 'list');
    expect(lists.filter((e) => e.what !== 'config').every((e) => e.directory === '/w/alpha')).toBe(true);
    expect(log.some((e) => e.ev === 'term')).toBe(true);
    expect(serves.get(OPTIONS_SERVE_KEY)).toBeNull();
  });

  posixIt('起きている serve があれば、それに聞き、起こしも止めもしない', async () => {
    const { service, serves, logFile } = make();
    await serves.ensure('h1');
    await service.get('/w/alpha');
    expect(starts(logFile)).toBe(1);
    expect(serves.get('h1')).not.toBeNull();
    expect(readFakeOpencodeLog(logFile).some((e) => e.ev === 'term')).toBe(false);
  });

  posixIt('場所ごとの最初のエージェントの一覧が空なら、聞き直す（実物の 2.1.4 の振る舞い）', async () => {
    const { service } = make({ agentsEmptyFirst: true });
    expect((await service.get('/w/alpha')).modes.map((m) => m.id)).toEqual(['build', 'plan']);
  });

  posixIt('無効のモデルは出さない。プロバイダーの名前が無ければ ID をまとまりの名前にする。既定のモデルが無ければ null', async () => {
    const { service } = make({
      models: [{ providerID: 'opencode', id: 'a', name: 'A', enabled: false }, { providerID: 'ollama', id: 'b', name: 'B' }],
      configModel: null,
    });
    const o = await service.get('/w/alpha');
    expect(o.models).toEqual([{ id: 'ollama/b', label: 'B', group: 'ollama', provider: 'ollama', tools: true, context: null, cost: null }]);
    expect(o.defaultModel).toBeNull();
  });

  posixIt('取ってから間もなければ、手元に持った一覧を返し、serve を起こさない。間が空いたら取り直す', async () => {
    const { service, logFile, advance } = make();
    await service.get('/w/alpha');
    advance(10_000);
    expect((await service.get('/w/alpha')).fetchedAt).toBe(1_000);
    expect(starts(logFile)).toBe(1);
    advance(120_000);
    expect((await service.get('/w/alpha')).fetchedAt).toBe(131_000);
    expect(starts(logFile)).toBe(2);
  });

  posixIt('取れず、手元にも無ければ投げる。起こした serve は止める', async () => {
    const { service, serves } = make({ failLists: true });
    await expect(service.get('/w/alpha')).rejects.toThrow(/500/);
    expect(serves.get(OPTIONS_SERVE_KEY)).toBeNull();
  });

  posixIt('一覧と一緒に、コマンドとスキルを読んで手元に持つ。lastCommands は取りに行かずにそれを返す（スマホの / の候補）', async () => {
    const { service, logFile, advance } = make();
    expect(service.lastCommands('/w/alpha')).toBeNull();
    await service.get('/w/alpha');
    const want = [
      { name: 'init', description: 'create/update AGENTS.md', kind: 'command' },
      { name: 'review', description: 'review changes', kind: 'command' },
      { name: 'frontend-design', description: 'Distinctive visual design.', kind: 'skill' },
    ];
    expect(service.lastCommands('/w/alpha')).toEqual(want);
    advance(120_000);
    expect(service.lastCommands('/w/alpha')).toEqual(want);
    expect(service.lastCommands(null)).toEqual(want);
    expect(service.lastCommands('/w/other')).toBeNull();
    const lists = readFakeOpencodeLog(logFile).filter((e) => e.ev === 'list' && (e.what === 'command' || e.what === 'skill'));
    expect(lists.length).toBe(2);
    expect(lists.every((e) => e.ev === 'list' && e.directory === '/w/alpha')).toBe(true);
  });

  posixIt('コマンドとスキルの道が無い版でも一覧は取れ、候補は空になる', async () => {
    const { service } = make({ noSlashLists: true });
    expect((await service.get('/w/alpha')).modes.map((m) => m.id)).toEqual(['build', 'plan']);
    expect(service.lastCommands('/w/alpha')).toEqual([]);
  });

  posixIt('last は手元の一覧を返す。無ければ null、間が空いていれば stale', async () => {
    const { service, advance } = make();
    expect(service.last('/w/alpha')).toBeNull();
    await service.get('/w/alpha');
    expect(service.last('/w/alpha')).toMatchObject({ stale: false, fetchedAt: 1_000 });
    advance(120_000);
    expect(service.last('/w/alpha')).toMatchObject({ stale: true });
    // 場所を省くとホームの一覧（無ければ、最後に取ったもの）を返す。
    expect(service.last(null)).toMatchObject({ fetchedAt: 1_000 });
  });

  posixIt('料金（最初の段）、コンテキスト、ツール呼び出しの対応を読む。プロバイダーは URL の宛先でこの PC・内側の網・それ以外に分け、API キーは持ち出さない', async () => {
    const { service } = make({
      models: [
        { providerID: 'opencode', id: 'beam-free', name: 'Beam Free', cost: [{ input: 0, output: 0 }], limit: { context: 1_048_576, output: 131_072 } },
        { providerID: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', cost: [{ input: 0.15, output: 0.6 }, { input: 0.3, output: 1.2 }], limit: { context: 1_000_000 } },
        { providerID: 'home', id: 'laguna', name: 'Laguna', tools: false, cost: [], limit: { context: 0 } },
      ],
      providers: [
        { id: 'opencode', name: 'OpenCode', baseURL: 'https://opencode.ai/inference/openai/v1' },
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'home', name: 'Home GPU', baseURL: 'http://192.168.3.40:8000/v1' },
        { id: 'box', name: 'Box', baseURL: 'http://gpu-box.local:8000/v1' },
        { id: 'lmstudio', name: 'LM Studio (local)', baseURL: 'http://127.0.0.1:1234/v1' },
      ],
    });
    const o = await service.get('/w/alpha');
    expect(o.models).toEqual([
      { id: 'opencode/beam-free', label: 'Beam Free', group: 'OpenCode', provider: 'opencode', tools: true, context: 1_048_576, cost: { input: 0, output: 0 } },
      { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', group: 'DeepSeek', provider: 'deepseek', tools: true, context: 1_000_000, cost: { input: 0.15, output: 0.6 } },
      { id: 'home/laguna', label: 'Laguna', group: 'Home GPU', provider: 'home', tools: false, context: null, cost: null },
    ]);
    expect(o.providers).toEqual([
      { id: 'opencode', name: 'OpenCode', where: 'remote' },
      { id: 'deepseek', name: 'DeepSeek', where: 'remote' },
      { id: 'home', name: 'Home GPU', where: 'lan' },
      { id: 'box', name: 'Box', where: 'lan' },
      { id: 'lmstudio', name: 'LM Studio (local)', where: 'device' },
    ]);
    expect(JSON.stringify(o)).not.toContain('sk-fake-secret');
  });

  posixIt('opencode が料金やコンテキストを返さないモデルは、models.dev の保存から埋め、その取得の時刻を添える。取り直しは頼むだけで待たない', async () => {
    let refreshed = 0;
    const catalog = {
      refresh: async () => { refreshed++; return false; },
      current: () => ({ fetchedAt: 500 }),
      lookup: (p: string, m: string) => (p === 'deepseek' && m === 'deepseek-v4-pro' ? { cost: { input: 0.66, output: 1.98 }, context: 1_000_000, tools: true } : null),
    };
    const { service } = make({
      models: [
        { providerID: 'deepseek', id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
        { providerID: 'deepseek', id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', cost: [{ input: 0.15, output: 0.6 }], limit: { context: 1_000_000 } },
      ],
    }, { catalog });
    const o = await service.get('/w/alpha');
    expect(o.models.map((m) => [m.id, m.cost, m.context])).toEqual([
      ['deepseek/deepseek-v4-pro', { input: 0.66, output: 1.98 }, 1_000_000],
      ['deepseek/deepseek-v4-flash', { input: 0.15, output: 0.6 }, 1_000_000],
    ]);
    expect(o.pricesAt).toBe(500);
    expect(refreshed).toBe(1);
  });

  posixIt('refresh を立てると、間もなくても取り直す（LM Studio の再読み込み）', async () => {
    const { service, logFile, advance } = make();
    await service.get('/w/alpha');
    advance(5_000);
    expect((await service.get('/w/alpha', { refresh: true })).fetchedAt).toBe(6_000);
    expect(starts(logFile)).toBe(2);
  });

  posixIt('場所を省くとホームで聞く', async () => {
    const { service, logFile } = make();
    await service.get(null);
    expect(readFakeOpencodeLog(logFile).filter((e) => e.ev === 'list' && e.what === 'agent').every((e) => e.ev === 'list' && e.directory === '/home/me')).toBe(true);
  });
});

posixDescribe('OpencodeOptionsService（取り直しの失敗）', () => {
  posixIt('一度取れた場所は、取り直しに失敗しても手元の一覧を stale で返す', async () => {
    let fail = false;
    let now = 0;
    const serve = { url: 'http://127.0.0.1:1', password: 'p', pid: 1 };
    const service = new OpencodeOptionsService({
      serves: { any: () => serve, ensure: async () => serve, stop: async () => undefined },
      status: async () => ({ found: true, version: '2.1.4', verified: true }),
      home: '/home/me',
      now: () => now,
      read: async () => {
        if (fail) throw new Error('down');
        return { agents: [{ id: 'build', mode: 'primary', hidden: false, description: null }], models: [], providers: [], defaultModel: null };
      },
    });
    await service.get('/w');
    fail = true;
    now = 120_000;
    expect(await service.get('/w')).toMatchObject({ stale: true, fetchedAt: 0, modes: [{ id: 'build', description: null }] });
  });
});
