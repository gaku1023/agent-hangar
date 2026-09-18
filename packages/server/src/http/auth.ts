import type { MiddlewareHandler } from 'hono';

/** 開発用の Vite のポート。ここから叩く UI は本体とは別のポートに載る。 */
const VITE_PORT = 5173;

/**
 * 許可する Origin。
 * ポートを決め打ちにすると、4177 以外で立てたときに UI からの書き込みが全部 403 になる。
 * 実際に待ち受けているポートから組み立て、開発用の Vite と Tauri だけを足す。
 * 任意のポートは通さない。
 */
export function allowedOrigins(port: number): string[] {
  const hosts = (p: number) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`];
  return [...(port === VITE_PORT ? [] : hosts(port)), ...hosts(VITE_PORT), 'tauri://localhost'];
}

/** Origin が無い要求は curl や同一オリジンの fetch なので許可し、あれば一覧にあるものだけ通す。 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || allowedOrigins(port).includes(origin);
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
export function authMiddleware(token: string, port: number): MiddlewareHandler {
  return async (c, next) => {
    if (!originAllowed(c.req.header('origin'), port)) return c.json({ error: 'origin not allowed' }, 403);
    const got = tokenFromRequest(c.req.raw.headers, c.req.header('cookie'));
    // クッキーは UI の HTML を配るときに発行するので、トークンが変わった後の
    // 開きっぱなしのタブはここに落ちる。UI はこの文をそのままトーストに出す。
    if (got !== token) return c.json({ error: '認証が切れました。ページを再読み込みしてください' }, 401);
    await next();
  };
}
