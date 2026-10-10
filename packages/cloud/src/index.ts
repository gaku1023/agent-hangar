import { Hono } from 'hono';
import { COMPAT_VERSION } from '@agent-hangar/shared';
import { authMiddleware } from './auth.ts';
import { changesApp, rowsApp } from './changes.ts';
import { compatMiddleware, MIN_DEVICE_COMPAT } from './compat.ts';
import type { AppType, Env, Vars } from './env.ts';
import { filesApp } from './files.ts';
import { joinHandler } from './join.ts';
import { d1LimitOfError, limitBody } from './limits.ts';
import { ensureSchema } from './schema.ts';
import { collectUsage } from './usage.ts';
import { VERSION } from './util.ts';

/** 記録に残す文言の上限である。長い SQL や本文の断片を垂れ流さない。 */
const MAX_LOG_LEN = 200;

/**
 * クラウド Worker を組み立てる。端末ごとのトークンで認証し、変更ログとファイルを預かる。中身の暗号化は端末側で行う。
 *
 * 端末に求める互換の版の下限を引数で受けるのは、試験が下限を上げた Worker を起こすためである（test/harness.ts）。
 * 配備される Worker は、下の既定の輸出だけを使う（下限は MIN_DEVICE_COMPAT）。
 */
export function createApp(o: { minDeviceCompat: number }): AppType {
  const app = new Hono<{ Bindings: Env; Variables: Vars }>();

  // 版の関所は最初に通す。断る要求で、スキーマの用意（D1 への問い合わせ）も認証も走らせない。
  app.use('*', compatMiddleware(o.minDeviceCompat));
  app.use('*', async (c, next) => {
    await ensureSchema(c.env);
    await next();
  });
  app.get('/health', (c) => c.json({ ok: true, version: VERSION, compat: COMPAT_VERSION }));

  // 参加だけは端末トークンを持たずに叩ける。中で参加用の秘密のハッシュを検査する。
  app.post('/join', joinHandler);

  // ここから下は端末トークンが要る。経路を足すときは必ずこの一覧にも足す。
  app.use('/changes', authMiddleware());
  app.use('/changes/*', authMiddleware());
  app.use('/rows', authMiddleware());
  app.use('/rows/*', authMiddleware());
  app.use('/files', authMiddleware());
  app.use('/files/*', authMiddleware());
  app.use('/usage', authMiddleware());

  app.route('/changes', changesApp);
  app.route('/rows', rowsApp);
  app.route('/files', filesApp);

  // 使用量と費用。トークンの secret が無ければ外へ出ずに configured: false を返す。D1 には書かない。
  app.get('/usage', async (c) => {
    const token = c.env.USAGE_API_TOKEN?.trim();
    const accountId = c.env.CF_ACCOUNT_ID?.trim();
    if (!token || !accountId) return c.json({ configured: false });
    return c.json(await collectUsage({ token, accountId, fetch: (input, init) => fetch(input, init), now: Date.now() }));
  });

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  /**
   * 想定していない例外である。
   * 外へ返すのは一般化した 1 語だけにする。
   * D1 と R2 の文言には表と列と束縛の様子が出るので、そのまま返すと内側の作りを教えてしまう。
   * 詳しい内容は記録にだけ残す。記録に載るのは方式と経路と例外の名前と 1 行目で、
   * 参加用の秘密も端末トークンも本文も問い合わせ文字列も載せない。
   * D1 の 1 日の上限に当たった失敗だけは、待てば通るので 429 で返す（limits.ts）。
   */
  app.onError((e, c) => {
    const limit = d1LimitOfError(e);
    if (limit) {
      console.error('worker limit', c.req.method, new URL(c.req.url).pathname, limit);
      return c.json(limitBody(limit, Date.now()), 429);
    }
    const name = e instanceof Error ? e.name : typeof e;
    const line = (e instanceof Error ? e.message : '').split('\n')[0]!.trim().slice(0, MAX_LOG_LEN);
    console.error('worker error', c.req.method, new URL(c.req.url).pathname, name, line);
    return c.json({ error: 'internal error' }, 500);
  });

  return app;
}

/** 配備される Worker である。端末に求める下限は MIN_DEVICE_COMPAT。 */
export default createApp({ minDeviceCompat: MIN_DEVICE_COMPAT });
