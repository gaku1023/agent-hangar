import { Hono } from 'hono';
import type { Env, Vars } from './env.ts';
import { ensureSchema } from './schema.ts';
import { VERSION } from './util.ts';

/** クラウド Worker である。端末ごとのトークンで認証し、変更ログとファイルを預かる。中身の暗号化は端末側で行う。 */
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

app.use('*', async (c, next) => {
  await ensureSchema(c.env);
  await next();
});
app.get('/health', (c) => c.json({ ok: true, version: VERSION }));
app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((e, c) => c.json({ error: e.message }, 500));

export default app;
