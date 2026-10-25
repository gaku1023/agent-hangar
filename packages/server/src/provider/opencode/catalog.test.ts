import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MODELS_DEV_URL, ModelsDevCatalog, trimModelsDev, type ModelsDevDeps } from './catalog.ts';

const HOUR = 3_600_000;

/** models.dev の api.json の形の偽の応答（本物は叩かない）。 */
const ANSWER = {
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', env: ['DEEPSEEK_API_KEY'],
    models: {
      'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', tool_call: true, cost: { input: 0.15, output: 0.6, cache_read: 0.01 }, limit: { context: 1_000_000, output: 64_000 } },
      'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', tool_call: true, cost: { input: 0.66, output: 1.98 }, limit: { context: 1_000_000 } },
    },
  },
  lmstudio: {
    id: 'lmstudio', name: 'LM Studio',
    models: { 'tiny-chat': { id: 'tiny-chat', tool_call: false, limit: { context: 8192 } } },
  },
  broken: 'not an object',
  noModels: { id: 'noModels' },
};

describe('trimModelsDev', () => {
  it('料金（100 万トークンあたりの入力と出力）、コンテキスト、ツール呼び出しだけを残す', () => {
    expect(trimModelsDev(ANSWER)).toEqual({
      deepseek: {
        'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6 }, context: 1_000_000, tools: true },
        'deepseek-v4-pro': { cost: { input: 0.66, output: 1.98 }, context: 1_000_000, tools: true },
      },
      lmstudio: { 'tiny-chat': { cost: null, context: 8192, tools: false } },
    });
  });
  it('形の違う答えは空にする', () => {
    expect(trimModelsDev(null)).toEqual({});
    expect(trimModelsDev([1, 2])).toEqual({});
    expect(trimModelsDev({ x: { models: { m: { cost: { input: 'a' }, limit: { context: -1 } } } } })).toEqual({ x: { m: { cost: null, context: null, tools: null } } });
  });
});

describe('ModelsDevCatalog', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-models-dev-'));
    file = path.join(dir, 'opencode', 'models-dev.json');
  });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const make = (answer: () => Response | Promise<Response>, deps: Partial<ModelsDevDeps> = {}) => {
    let now = 1_000_000;
    const urls: string[] = [];
    const fetchFn = (async (url: string | URL | Request) => { urls.push(String(url)); return answer(); }) as typeof fetch;
    const logs: string[] = [];
    const catalog = new ModelsDevCatalog({ file, fetch: fetchFn, now: () => now, log: (l) => logs.push(l), ...deps });
    return { catalog, urls, logs, advance: (ms: number) => { now += ms; }, at: () => now };
  };
  const ok = () => new Response(JSON.stringify(ANSWER), { status: 200, headers: { 'content-type': 'application/json' } });

  it('手元に無ければ取りに行き、削った形をファイルに保存する', async () => {
    const { catalog, urls } = make(ok);
    expect(catalog.current()).toBeNull();
    expect(await catalog.refresh()).toBe(true);
    expect(urls).toEqual([MODELS_DEV_URL]);
    expect(catalog.current()?.fetchedAt).toBe(1_000_000);
    expect(catalog.lookup('deepseek', 'deepseek-v4-flash')).toEqual({ cost: { input: 0.15, output: 0.6 }, context: 1_000_000, tools: true });
    expect(catalog.lookup('deepseek', 'nope')).toBeNull();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { fetchedAt: number; providers: Record<string, unknown> };
    expect(saved.fetchedAt).toBe(1_000_000);
    expect(Object.keys(saved.providers)).toEqual(['deepseek', 'lmstudio']);
  });

  it('保存したものは次の起動でも読める（取りに行かない）', async () => {
    await make(ok).catalog.refresh();
    const { catalog, urls } = make(ok);
    expect(catalog.current()?.fetchedAt).toBe(1_000_000);
    expect(await catalog.refresh()).toBe(false);
    expect(urls).toEqual([]);
  });

  it('取ってから 1 日は取り直さない。過ぎたら取り直す', async () => {
    const { catalog, urls, advance } = make(ok);
    await catalog.refresh();
    advance(23 * HOUR);
    expect(await catalog.refresh()).toBe(false);
    advance(2 * HOUR);
    expect(await catalog.refresh()).toBe(true);
    expect(urls.length).toBe(2);
    expect(catalog.current()?.fetchedAt).toBe(1_000_000 + 25 * HOUR);
  });

  it('同時に頼まれても、取りに行くのは 1 回', async () => {
    const { catalog, urls } = make(ok);
    await Promise.all([catalog.refresh(), catalog.refresh(), catalog.refresh()]);
    expect(urls.length).toBe(1);
  });

  it('失敗したら前のものを残し、1 時間は取り直さない。過ぎたらまた試す', async () => {
    let fail = false;
    const { catalog, urls, advance, logs } = make(() => (fail ? new Response('oops', { status: 503 }) : ok()));
    await catalog.refresh();
    advance(25 * HOUR);
    fail = true;
    expect(await catalog.refresh()).toBe(false);
    expect(catalog.current()?.fetchedAt).toBe(1_000_000);
    expect(logs.some((l) => l.includes('503'))).toBe(true);
    advance(30 * 60_000);
    expect(await catalog.refresh()).toBe(false);
    expect(urls.length).toBe(2);
    advance(31 * 60_000);
    fail = false;
    expect(await catalog.refresh()).toBe(true);
    expect(urls.length).toBe(3);
  });

  it('つながらない、JSON でない、中身が空の答えも失敗として扱い、投げない', async () => {
    for (const answer of [
      () => { throw new Error('getaddrinfo ENOTFOUND models.dev'); },
      () => new Response('<html>', { status: 200 }),
      () => new Response('{}', { status: 200 }),
    ]) {
      const { catalog } = make(answer);
      expect(await catalog.refresh()).toBe(false);
      expect(catalog.current()).toBeNull();
      expect(fs.existsSync(file)).toBe(false);
    }
  });

  it('壊れたファイルは無いものとして扱う', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    expect(make(ok).catalog.current()).toBeNull();
  });
});
