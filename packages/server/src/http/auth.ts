import type { MiddlewareHandler } from 'hono';

export const ALLOWED_ORIGINS = ['http://localhost:4177', 'http://127.0.0.1:4177', 'http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost'];

/** Origin が無い要求は curl や同一オリジンの fetch なので許可し、あれば一覧にあるものだけ通す。 */
export function originAllowed(origin: string | undefined): boolean {
  return origin === undefined || ALLOWED_ORIGINS.includes(origin);
}

/** Bearer トークンを優先し、無ければ hangar_token クッキーから取る。 */
export function tokenFromRequest(headers: Headers, cookieHeader: string | undefined): string | null {
  const auth = headers.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim();
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'hangar_token') return v.join('=');
  }
  return null;
}

/** ブラウザの他サイトからの要求を Origin で拒み、ローカルトークンで認証する。 */
export function authMiddleware(token: string): MiddlewareHandler {
  return async (c, next) => {
    if (!originAllowed(c.req.header('origin'))) return c.json({ error: 'origin not allowed' }, 403);
    const got = tokenFromRequest(c.req.raw.headers, c.req.header('cookie'));
    // クッキーは UI の HTML を配るときに発行するので、トークンが変わった後の
    // 開きっぱなしのタブはここに落ちる。UI はこの文をそのままトーストに出す。
    if (got !== token) return c.json({ error: '認証が切れました。ページを再読み込みしてください' }, 401);
    await next();
  };
}
