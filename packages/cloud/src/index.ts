import { Hono } from 'hono';
import { authMiddleware } from './auth.ts';
import { changesApp, rowsApp } from './changes.ts';
import type { Env, Vars } from './env.ts';
import { filesApp } from './files.ts';
import { joinHandler } from './join.ts';
import { ensureSchema } from './schema.ts';
import { VERSION } from './util.ts';

/** クラウド Worker である。端末ごとのトークンで認証し、変更ログとファイルを預かる。中身の暗号化は端末側で行う。 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', async (c, next) => {
  await ensureSchema(c.env);
  await next();
});
app.get('/health', (c) => c.json({ ok: true, version: VERSION }));

// 参加だけは端末トークンを持たずに叩ける。中で参加用の秘密のハッシュを検査する。
app.post('/join', joinHandler);

// ここから下は端末トークンが要る。経路を足すときは必ずこの一覧にも足す。
app.use('/changes', authMiddleware());
app.use('/changes/*', authMiddleware());
app.use('/rows', authMiddleware());
app.use('/rows/*', authMiddleware());
app.use('/files', authMiddleware());
app.use('/files/*', authMiddleware());

app.route('/changes', changesApp);
app.route('/rows', rowsApp);
app.route('/files', filesApp);

app.notFound((c) => c.json({ error: 'not found' }, 404));

/** 記録に残す文言の上限である。長い SQL や本文の断片を垂れ流さない。 */
const MAX_LOG_LEN = 200;

/**
 * 想定していない例外である。
 * 外へ返すのは一般化した 1 語だけにする。
 * D1 と R2 の文言には表と列と束縛の様子が出るので、そのまま返すと内側の作りを教えてしまう。
 * 詳しい内容は記録にだけ残す。記録に載るのは方式と経路と例外の名前と 1 行目で、
 * 参加用の秘密も端末トークンも本文も問い合わせ文字列も載せない。
 */
app.onError((e, c) => {
  const name = e instanceof Error ? e.name : typeof e;
  const line = (e instanceof Error ? e.message : '').split('\n')[0]!.trim().slice(0, MAX_LOG_LEN);
  console.error('worker error', c.req.method, new URL(c.req.url).pathname, name, line);
  return c.json({ error: 'internal error' }, 500);
});

export default app;
