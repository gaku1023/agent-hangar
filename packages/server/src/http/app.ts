import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { COMPAT_VERSION, t, type Language, type SyncSkippedDto, type SyncStatusBody } from '@agent-hangar/shared';
import { createMcpApp } from '../mcp/app.ts';
import { accountsRoutes, type AccountsDeps } from './accounts.ts';
import { authMiddleware, tokenEquals, tokenFromRequest } from './auth.ts';
import type { AppDeps } from './deps.ts';
import { artifactRoutes } from './routes/artifacts.ts';
import { bootstrapRoutes } from './routes/bootstrap.ts';
import { beforeLaunchOf } from './routes/common.ts';
import { memoRoutes } from './routes/memos.ts';
import { projectRoutes } from './routes/projects.ts';
import { promptRoutes } from './routes/prompt.ts';
import { retentionRoutes } from './routes/retention.ts';
import { runRoutes } from './routes/runs.ts';
import { sessionRoutes } from './routes/sessions.ts';
import { settingsRoutes } from './routes/settings.ts';
import { syncRoutes } from './routes/sync.ts';
import { systemRoutes } from './routes/system.ts';
import { todoRoutes } from './routes/todos.ts';
import { usageRoutes } from './routes/usage.ts';

/**
 * HTTP の層の組み立て。
 * 経路の中身は資源ごとのファイル（routes/*.ts）にあり、ここは認証を当てて、それらを登録するだけである。
 * 依存の一覧（AppDeps）は deps.ts にある。
 * 下の再輸出は、これらを app.ts から引いている呼び手を切らないためである。
 */
export type { AppDeps, ExternalApi, RunsApi, SummaryApi, SummaryEnqueueOpts, SyncApi } from './deps.ts';
export { safeExternalMessage } from './routes/common.ts';
export { toSettingsDto } from './routes/settings.ts';
/**
 * 型は shared に移した。
 * 画面も同じ形を読むので、正本は 1 つにしてある。
 * ここから再輸出しておくのは、この 2 つを app.ts から引いている呼び手を切らないためである。
 */
export type { SyncSkippedDto, SyncStatusBody };

/**
 * トークンのクッキーの寿命。
 * 期限を書かないとブラウザを閉じたときに消え、そのたびに鍵付きの URL が要る。
 * ブックマークから開き直せるように 1 年残す。
 */
const ENTRY_COOKIE_MAX_AGE = 31536000;
/** UI の HTML と一緒に配るトークンのクッキー。 */
const entryCookie = (token: string) => `hangar_token=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ENTRY_COOKIE_MAX_AGE}`;
/**
 * 鍵を持たずに GET / を叩いたときに返す案内。
 * トークンは書かない。ここは認証の前なので、誰が見ているか分からない。
 * 文は辞書（http.entry.*）から引く。コマンドの名前は訳さないので、引数で渡す。
 */
const entryNoticeHtml = (language: Language) => `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>agent-hangar</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; display: grid; place-items: center; min-height: 100vh; background: #f7f7f8; color: #1b1b1f; font-family: system-ui, sans-serif; line-height: 1.8; }
  main { max-width: 34rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 1rem; }
  p { margin: 0 0 0.75rem; color: #44454b; }
  code { background: #ececef; border-radius: 4px; padding: 0.1em 0.4em; font-family: ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<h1>${t(language, 'http.entry.title')}</h1>
<p>${t(language, 'http.entry.openFromUrl', { command: '<code>hangar start</code>' })}</p>
<p>${t(language, 'http.entry.printUrl', { command: '<code>hangar url</code>' })}</p>
<p>${t(language, 'http.entry.cookieStays')}</p>
</main>
</body>
</html>
`;
/**
 * UI に付ける守りの見出し。
 * `SameSite=Strict` の「サイト」はポートを数えないので、手元の別のポートに置かれたページでもクッキーは載る。
 * 枠に嵌めて被せて押させる手を止めるため、frame-ancestors と X-Frame-Options の両方を返す。
 * ほかの指示は、配っている dist の作りに合わせて絞っている。
 * インライン script は無いので script-src は 'self' だけでよい。
 * style は React の style 属性と xterm が実行時に書くので 'unsafe-inline' が要る。
 * font は @fontsource が data: の woff を含むので data: を許す。favicon も data: の SVG である。
 * connect は同じ元と、ターミナルの WebSocket のためのループバックだけにする。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.map': 'application/json' };

/** HTTP API を組み立てる。/api 配下は認証必須で、/health と UI 配信だけが素通しになる。 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  // 言語の読み手は、組み立てる側が 1 つ作って渡す。経路と MCP の道具へ同じものを配る。
  const { language } = deps;
  const { db, deviceId } = deps;

  // 鍵の要らない経路なので、起動の進み具合は段階と件数だけを載せる。
  // compat は互換の版番号で、殻は 4177 の既存のサーバを、自分と同じ版のときだけ採る（apps/desktop/src-tauri/src/health.rs の judge_existing）。
  app.get('/health', (c) => c.json({ ok: true, version: deps.version, compat: COMPAT_VERSION, ready: deps.ready(), index: deps.indexer.progress() }));

  const api = new Hono();
  api.use('*', authMiddleware(deps.token, deps.port, language));

  // 経路の登録。同じメソッドで同じパスに当たる経路の組は無いので、当たり方は登録の順に依らない。
  // 経路を足すときも、そうなるようにパスを決める。
  // アカウントの切り替えは、resume と同じく起動の前に同期の取り込みを待つ。
  const accountsDeps: AccountsDeps = { beforeLaunch: beforeLaunchOf(deps), language, ...deps.accounts };
  accountsRoutes(api, accountsDeps);
  bootstrapRoutes(api, deps);
  projectRoutes(api, deps);
  promptRoutes(api, deps);
  sessionRoutes(api, deps);
  settingsRoutes(api, deps);
  retentionRoutes(api, deps);
  systemRoutes(api, deps);
  syncRoutes(api, deps);
  runRoutes(api, deps);
  usageRoutes(api, deps);
  todoRoutes(api, deps);
  memoRoutes(api, deps);
  artifactRoutes(api, deps);

  app.route('/api', api);
  // MCP は自前の認証と Origin の検査を持つので、/api の認証を通さずに直接 mount する。
  app.route('/mcp', createMcpApp({ db, deviceId, port: deps.port, token: deps.token, live: deps.live, runs: deps.runs, usage: () => deps.usage.current(), accounts: deps.accounts, memos: deps.memos, language }));

  if (deps.uiDist) {
    const dist = path.resolve(deps.uiDist);
    const assets = path.join(dist, 'assets');
    const index = () => fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    app.get('/', (c) => {
      // 鍵付きの URL で開かれたか、もうクッキーを持っているときだけ UI を配る。
      // 素の GET / にクッキーを配ると、curl 1 本で誰でもトークンを取れてしまう。
      const authed = tokenEquals(c.req.query('t'), deps.token) || tokenEquals(tokenFromRequest(c.req.raw.headers, c.req.header('cookie')), deps.token);
      c.header('Cache-Control', 'no-store');
      // 鍵の有無に関わらず付ける。枠に嵌められるのは、認証が通ったあとの姿である。
      c.header('X-Frame-Options', 'DENY');
      c.header('Content-Security-Policy', CSP);
      if (!authed) return c.html(entryNoticeHtml(language()), 401);
      // ここで鍵をクッキーに換える。URL に残った鍵は UI が history.replaceState で消す。
      c.header('Set-Cookie', entryCookie(deps.token));
      return c.html(index());
    });
    app.get('/assets/*', (c) => {
      // 壊れたパーセント符号化は decodeURIComponent が投げるので、そういう要求は素直に 404 にする。
      let decoded: string;
      try { decoded = decodeURIComponent(c.req.path); } catch { return c.notFound(); }
      const file = path.resolve(dist, decoded.replace(/^\//, ''));
      // assets の外へ抜ける経路と存在しないファイルは 404 にする。
      if (!file.startsWith(assets + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return c.notFound();
      c.header('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(fs.readFileSync(file));
    });
  }
  return app;
}
