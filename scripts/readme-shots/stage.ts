// 場面に渡す道具（ShootCtx）を作る。ページを開く、API の応答を差し替える、コマを集める、静止画を撮る。
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { type Env, REPO } from './env.ts';
import type { ApiMock, OpenOpts, Scene, ShootCtx } from './kit.ts';
import { MOCKS } from './mocks.ts';
import { startRecording } from './recorder.ts';

export const OUT = path.join(REPO, 'docs/images');
const W = 1280;
const H = 800;
const DEMO_HOME = '/Users/demo';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(what: string, fn: () => boolean, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれません: ${what}`);
    await sleep(100);
  }
}

function matches(m: ApiMock, pathname: string, method: string): boolean {
  if (typeof m.match === 'string') return m.match === pathname;
  if (m.match instanceof RegExp) return m.match.test(pathname);
  return m.match(pathname, method);
}

/** 一時ディレクトリの名前を画面に出さない。API と WebSocket の文字列の中の HOME を /Users/demo に読み替え、画面からの要求は元へ戻す。mocks に当たる要求は差し替える。 */
async function demoPaths(ctx: BrowserContext, e: Env, mocks: ApiMock[]): Promise<void> {
  const real = fs.realpathSync(e.home);
  const aliases = [...new Set([real, e.home])];
  const fwd = (s: string) => aliases.reduce((a, r) => a.split(r).join(DEMO_HOME), s);
  const back = (s: string) => s.split(encodeURIComponent(DEMO_HOME)).join(encodeURIComponent(real)).split(DEMO_HOME).join(real);
  await ctx.route((u) => u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    const body = req.postData();
    const url = new URL(req.url());
    const mock = mocks.find((m) => matches(m, url.pathname, req.method()));
    if (mock) {
      const json = typeof mock.json === 'function' ? (mock.json as (r: unknown) => unknown)({ url: req.url(), method: req.method(), body }) : mock.json;
      return route.fulfill({ status: mock.status ?? 200, contentType: 'application/json', body: JSON.stringify(json) });
    }
    const res = await route.fetch({ url: back(req.url()), ...(body !== null ? { postData: back(body) } : {}) });
    const type = res.headers()['content-type'] ?? '';
    if (!/json|text/.test(type)) return route.fulfill({ response: res });
    return route.fulfill({ response: res, body: fwd(await res.text()) });
  });
  await ctx.routeWebSocket((u) => u.pathname === '/ws', (ws) => {
    const server = ws.connectToServer();
    ws.onMessage((m) => server.send(typeof m === 'string' ? back(m) : m));
    server.onMessage((m) => ws.send(typeof m === 'string' ? fwd(m) : m));
    ws.onClose((c, r) => server.close({ code: c, reason: r }));
    server.onClose((c, r) => ws.close({ code: c, reason: r }));
  });
}

export type Ids = { projectIds: Record<string, string>; live: Record<string, string>; pastIds: Record<string, string> };

function makeCtx(browser: Browser, e: Env, ids: Ids, tools: { ffmpeg: string; img2webp: string }, globalMocks: ApiMock[]): ShootCtx {
  const gate = (name: string) => fs.writeFileSync(path.join(e.gates, name), '');
  return {
    e,
    ...ids,
    sleep,
    until,
    gate,
    transcriptHas(text) {
      return () => {
        const dir = path.join(e.claudeDir, 'projects');
        for (const d of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, d))) {
          if (fs.readFileSync(path.join(dir, d, f), 'utf8').includes(text)) return true;
        }
        return false;
      };
    },
    async sidebarItem(page, text) {
      for (const l of await page.getByText(text).all()) {
        const b = await l.boundingBox();
        if (b && b.x < 230) return l;
      }
      throw new Error(`サイドバーに無い: ${text}`);
    },
    async openPage(opts: OpenOpts = {}) {
      const bc = await browser.newContext({
        // 画面の大きさと倍率は起動の引数で決める（下の launch）。
        viewport: null,
        locale: 'ja-JP',
        timezoneId: 'Asia/Tokyo',
        colorScheme: 'light',
      });
      await demoPaths(bc, e, [...(opts.mocks ?? []), ...globalMocks, ...MOCKS]);
      if (opts.init) await bc.addInitScript(opts.init);
      const page = await bc.newPage();
      await page.goto(`${e.base}/?t=${e.token}`);
      await page.getByText('ホーム', { exact: true }).first().waitFor();
      await page.getByText('実行中').first().waitFor();
      await sleep(1200);
      if (opts.prepare) await opts.prepare(page);
      return { page, close: () => bc.close() };
    },
    record: (page) => startRecording(page, tools, path.join(e.root, 'frames'), OUT),
    async screenshot(page, name) {
      const out = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: out });
      console.log(`${path.relative(REPO, out)}  ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
      return out;
    },
  };
}

export async function shoot(e: Env, ids: Ids, tools: { ffmpeg: string; img2webp: string }, scenes: Scene[], globalMocks: ApiMock[]): Promise<void> {
  // DPR 2 は context の deviceScaleFactor（エミュレーション）でなく、起動の引数で決める。
  // エミュレーションだと xterm の WebGL がセルを 1 倍で測り、端末の文字が UI の倍になって行が欠ける。
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=2', `--window-size=${W},${H}`] });
  try {
    for (const s of scenes) {
      console.log(`撮影: ${s.name}（${s.kind}）`);
      await s.shoot(makeCtx(browser, e, ids, tools, globalMocks));
    }
  } finally {
    await browser.close();
  }
}
