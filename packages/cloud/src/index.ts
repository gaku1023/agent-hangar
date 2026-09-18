import { Hono } from 'hono';
import { authMiddleware } from './auth.ts';
import type { Env, Vars } from './env.ts';
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

// 認証が通ることを確かめるための仮の経路である。Task 4 が本物に置き換える。
app.get('/changes', (c) => c.json({ changes: [], nextSeq: 0, more: false }));

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((e, c) => c.json({ error: e.message }, 500));

export default app;
