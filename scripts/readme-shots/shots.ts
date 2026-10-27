// 4 枚の撮影。Playwright（Chromium）で、撮影用のサーバの画面を開いて撮る。
// GIF は Playwright の録画（webm）を ffmpeg の palettegen で変換する。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { LIVE, SEARCH_QUERY } from './data.mjs';
import { type Env, REPO } from './env.ts';

const OUT = path.join(REPO, 'docs/images');
const W = 1280;
const H = 800;
const DEMO_HOME = '/Users/demo';

type Ctx = { projectIds: Record<string, string>; live: Record<string, string> };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, fn: () => boolean, ms = 60_000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`待ちきれません: ${what}`);
    await sleep(100);
  }
}

/** 一時ディレクトリの名前を画面に出さない。API と WebSocket の文字列の中の HOME を /Users/demo に読み替え、画面からの要求は元へ戻す。 */
async function demoPaths(ctx: BrowserContext, e: Env): Promise<void> {
  const real = fs.realpathSync(e.home);
  const aliases = [...new Set([real, e.home])];
  const fwd = (s: string) => aliases.reduce((a, r) => a.split(r).join(DEMO_HOME), s);
  const back = (s: string) => s.split(encodeURIComponent(DEMO_HOME)).join(encodeURIComponent(real)).split(DEMO_HOME).join(real);
  await ctx.route((u) => u.pathname.startsWith('/api/'), async (route) => {
    const req = route.request();
    const body = req.postData();
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

async function openPage(browser: import('playwright').Browser, e: Env, video: boolean): Promise<{ ctx: BrowserContext; page: Page }> {
  const dir = path.join(e.root, 'video');
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: video ? 1 : 2,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    colorScheme: 'light',
    ...(video ? { recordVideo: { dir, size: { width: W, height: H } } } : {}),
  });
  await demoPaths(ctx, e);
  const page = await ctx.newPage();
  await page.goto(`${e.base}/?t=${e.token}`);
  await page.getByText('ホーム', { exact: true }).first().waitFor();
  await page.getByText('実行中').first().waitFor();
  await sleep(1200);
  return { ctx, page };
}

/** サイドバー（x が 230 より左）にある、その文字を含む項目。 */
async function sidebarItem(page: Page, text: string) {
  const all = await page.getByText(text).all();
  for (const l of all) {
    const b = await l.boundingBox();
    if (b && b.x < 230) return l;
  }
  throw new Error(`サイドバーに無い: ${text}`);
}

function gif(ffmpeg: string, video: string, start: number, dur: number, out: string, fps = 10, width = 960): void {
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=64[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`;
  execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(dur), '-i', video, '-vf', vf, '-loop', '0', out]);
  console.log(`${path.relative(REPO, out)}  ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB`);
}

function transcriptHas(e: Env, text: string): () => boolean {
  return () => {
    const dir = path.join(e.claudeDir, 'projects');
    for (const d of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, d))) {
      if (fs.readFileSync(path.join(dir, d, f), 'utf8').includes(text)) return true;
    }
    return false;
  };
}

const gate = (e: Env, name: string) => fs.writeFileSync(path.join(e.gates, name), '');

async function closeVideo(ctx: BrowserContext, page: Page): Promise<string> {
  const v = page.video()!;
  await ctx.close();
  return v.path();
}

async function hero(browser: import('playwright').Browser, e: Env, ffmpeg: string): Promise<void> {
  const { ctx, page } = await openPage(browser, e, true);
  const t0 = Date.now();
  await (await sidebarItem(page, LIVE.hero.name)).click();
  await sleep(1400);
  gate(e, 'hero');
  const done = transcriptHas(e, 'テストは 3 本とも通っています');
  await until('hero の台本', done, 40_000);
  await sleep(1800);
  const dur = (Date.now() - t0) / 1000;
  const video = await closeVideo(ctx, page);
  gate(e, 'hero');
  // 録画は 1.2 秒の待ちの途中から始めて、その手前を切る。
  gif(ffmpeg, video, 0.6, dur + 0.6, path.join(OUT, 'hero.gif'));
}

async function split(browser: import('playwright').Browser, e: Env, ffmpeg: string): Promise<void> {
  const { ctx, page } = await openPage(browser, e, true);
  const t0 = Date.now();
  await (await sidebarItem(page, LIVE.split.name)).click();
  await sleep(1300);
  await (await sidebarItem(page, LIVE.split2.name)).click({ modifiers: ['Alt'] });
  await sleep(1800);
  gate(e, 'split');
  await sleep(500);
  gate(e, 'split2');
  const a = transcriptHas(e, 'ビルドも通りました');
  const b = transcriptHas(e, '書かなければ摂氏です');
  await until('split の台本', () => a() && b(), 40_000);
  await sleep(1800);
  const dur = (Date.now() - t0) / 1000;
  const video = await closeVideo(ctx, page);
  gif(ffmpeg, video, 0.6, dur + 0.6, path.join(OUT, 'split.gif'));
}

async function projects(browser: import('playwright').Browser, e: Env): Promise<void> {
  const { ctx, page } = await openPage(browser, e, false);
  await page.getByText('プロジェクト', { exact: true }).first().click();
  await sleep(800);
  await page.locator('main').getByText('photo-tagger', { exact: true }).first().click();
  await page.getByText('RAW 画像の読み込み').first().waitFor();
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, 'projects.png') });
  await ctx.close();
}

async function search(browser: import('playwright').Browser, e: Env): Promise<void> {
  const { ctx, page } = await openPage(browser, e, false);
  const box = page.getByPlaceholder('検索').first();
  await box.click();
  await box.fill(SEARCH_QUERY);
  await box.press('Enter');
  await page.getByText('名前に一致').first().waitFor();
  await sleep(1800);
  await page.screenshot({ path: path.join(OUT, 'search.png') });
  await ctx.close();
}

export async function shoot(e: Env, _c: Ctx, tools: { ffmpeg: string }, only: Set<string> | null): Promise<void> {
  const want = (n: string) => !only || only.has(n);
  const browser = await chromium.launch();
  try {
    // 生きた会話の台本が進む順（hero、split）の後に、一覧の画面を撮る。
    if (want('hero')) await hero(browser, e, tools.ffmpeg);
    if (want('split')) await split(browser, e, tools.ffmpeg);
    if (want('projects')) await projects(browser, e);
    if (want('search')) await search(browser, e);
  } finally {
    await browser.close();
  }
}
