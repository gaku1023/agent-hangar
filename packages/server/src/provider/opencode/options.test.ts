import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect } from 'vitest';
import { readFakeOpencodeLog, writeFakeOpencode, type FakeOpencodeOptions } from '../../../test/fake-opencode.ts';
import { posixDescribe, posixIt } from '../../../test/platform.ts';
import { OPTIONS_SERVE_KEY, OpencodeOptionsService, type OpencodeOptionsDeps } from './options.ts';
import { ServeManager } from './serve/manager.ts';
import { ServeRegistry } from './serve/registry.ts';

// 偽の opencode の serve を本当に起こして一覧を取る。止め方が POSIX のものなので、Windows では飛ばす。
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
        { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode' },
        { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B', group: 'LM Studio (local)' },
        { id: 'lmstudio/gemma-4-26b', label: 'Gemma 4 26B', group: 'LM Studio (local)' },
      ],
      defaultModel: 'lmstudio/qwen/qwen3-coder-30b',
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
    expect(o.models).toEqual([{ id: 'ollama/b', label: 'B', group: 'ollama' }]);
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
