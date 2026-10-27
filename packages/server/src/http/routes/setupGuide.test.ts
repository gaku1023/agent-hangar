import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SetupGuideDto } from '@agent-hangar/shared';
import { createApp } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';
import { guideHeader } from '../../setupGuide/guide.ts';

// セットアップのすゝめの経路（routes/setupGuide.ts）の試験。同梱の md は、ソースから動かしているのでリポジトリの docs から読む。

let t: TestWorld;
afterEach(() => { t.dispose(); });

const get = (app: ReturnType<typeof createApp>) => app.request('/api/setup-guide', { headers: H });
const open = (app: ReturnType<typeof createApp>, body?: unknown) => app.request('/api/setup-guide/open', { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('GET /api/setup-guide', () => {
  it('置き場へ写し、場所、アプリの版、ハッシュ、貼る一言を返す', async () => {
    t = await testDeps();
    const app = createApp(t.deps);
    const r = await get(app);
    expect(r.status).toBe(200);
    const body = await r.json() as SetupGuideDto;
    expect(body.version).toBe('0.0.0-test');
    expect(body.sha).toMatch(/^[0-9a-f]{8}$/);
    expect(body.path.endsWith('setup-guide.md')).toBe(true);
    expect(body.prompt).toBe(`${body.path}（v0.0.0-test sha256:${body.sha}）を読んで、私の環境を診断して。書き換えは私が承認してから`);
    const copied = fs.readFileSync(path.join(t.deps.home, 'setup-guide.md'), 'utf8');
    expect(copied.split('\n')[0]).toBe(guideHeader('0.0.0-test', body.sha));
    expect(fs.existsSync(path.join(t.deps.home, 'setup-guide-habits.md'))).toBe(true);
  });

  it('一言は設定の言語で書く', async () => {
    t = await testDeps();
    t.deps.updateSettings({ language: 'en' });
    const body = await (await get(createApp(t.deps))).json() as SetupGuideDto;
    expect(body.prompt.startsWith(`Read ${body.path} (v0.0.0-test sha256:${body.sha})`)).toBe(true);
  });

  it('同梱の md が無ければ 500 で理由を返す', async () => {
    t = await testDeps({ setupGuideDir: null });
    const r = await get(createApp(t.deps));
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: 'セットアップのすゝめがアプリに同梱されていません' });
  });
});

describe('POST /api/setup-guide/open', () => {
  it('写した本編をエディタで開く', async () => {
    t = await testDeps();
    const r = await open(createApp(t.deps));
    expect(r.status).toBe(204);
    expect(t.external.openEditor).toHaveBeenCalledWith({ target: path.join(t.deps.home, 'setup-guide.md') });
    expect(fs.existsSync(path.join(t.deps.home, 'setup-guide.md'))).toBe(true);
  });

  it('「今回は <名前> で開く」の once を渡せる。知らないエディタは 400', async () => {
    t = await testDeps();
    const app = createApp(t.deps);
    expect((await open(app, { once: 'cursor' })).status).toBe(204);
    expect(t.external.openEditor).toHaveBeenCalledWith({ target: path.join(t.deps.home, 'setup-guide.md'), once: 'cursor' });
    expect((await open(app, { once: 'nope' })).status).toBe(400);
  });
});
