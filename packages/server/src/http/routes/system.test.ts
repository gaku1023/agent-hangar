import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CompatDto } from '@agent-hangar/shared';
import { VERIFIED_CLAUDE_VERSION } from '../../provider/claude-code/compat/version.ts';
import { createApp, type AppDeps } from '../app.ts';
import { H, testDeps, type TestWorld } from '../testing.ts';

// 索引、準備の確かめ、互換、要約器の経路（routes/system.ts）の試験。依存は testDeps() で組み、createApp を通して /api の下から叩く。

let t: TestWorld;
let app: ReturnType<typeof createApp>;
let deps: AppDeps;
const get = (p: string, headers: Record<string, string> = H) => app.request(p, { headers });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

beforeEach(async () => {
  t = await testDeps();
  ({ deps } = t);
  app = createApp(deps);
});
afterEach(() => { t.dispose(); });

describe('routes', () => {
  it('索引の作り直しは 202', async () => {
    const r = await app.request('/api/index/rebuild', { method: 'POST', headers: H });
    expect(r.status).toBe(202);
  });
});

describe('Claude Code との互換', () => {
  it('GET /api/compat は互換の口の答えをそのまま返し、口が無ければ確かめた版だけを返す', async () => {
    const COMPAT: CompatDto = { verifiedVersion: '2.1.292', localVersion: '2.1.300', drifts: [{ contract: 'registry', value: 'status=thinking', version: '2.1.300', count: 2, firstSeenAt: 1, lastSeenAt: 2 }] };
    const withCompat = createApp({ ...deps, compat: async () => COMPAT });
    expect(await (await withCompat.request('/api/compat', { headers: H })).json()).toEqual(COMPAT);
    expect((await json(await get('/api/compat'))).body).toEqual({ verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: null, drifts: [] });
  });
});

describe('POST /api/readiness/mux（psmux と tmux の再確認）', () => {
  const post = (a: ReturnType<typeof createApp>) => a.request('/api/readiness/mux', { method: 'POST', headers: H });
  it('設定が空で見つかれば tmuxPath を埋め、取り直した準備の確かめを返す', async () => {
    let asked = 0;
    const a = createApp({ ...deps, findMux: () => { asked++; return '/found/psmux'; } });
    const r = await json(await post(a));
    expect(r.status).toBe(200);
    expect(asked).toBe(1);
    expect(deps.settings().tmuxPath).toBe('/found/psmux');
    expect(r.body.readiness.tools.tmux).toBeDefined();
    expect(r.body.settings.tmuxPath).toBe('/found/psmux');
  });
  it('見つからなければ設定を変えずに、準備の確かめを返す', async () => {
    const a = createApp({ ...deps, findMux: () => null });
    const r = await json(await post(a));
    expect(r.status).toBe(200);
    expect(deps.settings().tmuxPath).toBeNull();
    expect(r.body.settings.tmuxPath).toBeNull();
  });
  it('認証が無ければ断る', async () => {
    expect((await app.request('/api/readiness/mux', { method: 'POST' })).status).toBe(401);
  });
});
