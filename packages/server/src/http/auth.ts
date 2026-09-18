import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/** 開発用の Vite のポート。ここから叩く UI は本体とは別のポートに載る。 */
const VITE_PORT = 5173;

/**
 * 開発のときだけ真になる。
 * `npm run dev` の経路が HANGAR_DEV=1 を立てる。
 * `hangar start` は立てないので、日常の起動では Vite の 5173 を許さない。
 * 127.0.0.1 の別ポートは「同一サイト」なので SameSite=Strict のクッキーが載る。
 * 常時許すと、5173 に居る無関係なページがクッキーだけで書き込めてしまう。
 */
export const devMode = (): boolean => process.env.HANGAR_DEV === '1';

/**
 * 許可する Origin。
 * ポートを決め打ちにすると、4177 以外で立てたときに UI からの書き込みが全部 403 になる。
 * 実際に待ち受けているポートから組み立て、Tauri を足す。
 * 開発用の Vite は開発のときだけ足す。任意のポートは通さない。
 */
export function allowedOrigins(port: number): string[] {
  const hosts = (p: number) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`];
  const vite = devMode() && port !== VITE_PORT ? hosts(VITE_PORT) : [];
  return [...hosts(port), ...vite, 'tauri://localhost'];
}

/** Origin が無い要求は curl や同一オリジンの fetch なので許可し、あれば一覧にあるものだけ通す。 */
export function originAllowed(origin: string | undefined, port: number): boolean {
  return origin === undefined || allowedOrigins(port).includes(origin);
}

/** 状態を変えない動詞。応答は CORS で読めないので、ここでは断らない。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Sec-Fetch-Site の検査。
 * ブラウザは必ず送るので、別のページからの書き込みはここで落ちる。
 * same-origin は自分の UI、none は URL を直に叩いた操作である。
 * curl と MCP クライアントはこの見出しを送らないので、今までどおり通る。
 * 開発のときだけ same-site を通す。Vite の 5173 からの経路がここに当たる。
 */
export function fetchSiteAllowed(site: string | undefined, method: string): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (site === undefined) return true;
  if (site === 'same-origin' || site === 'none') return true;
  return site === 'same-site' && devMode();
}

/**
 * 本文の型の検査。
 * text/plain は前検査の要らない「単純な要求」で送れるので、本文を取る経路では断る。
 * application/json を名乗った時点で前検査が起き、別のサイトからは届かなくなる。
 */
export function jsonContentType(contentType: string | undefined): boolean {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/**
 * 本文を持つ要求かどうか。
 * node の受け口は本文の無い POST にも空のストリームを付けるので、ストリームの有無では測れない。
 * 見出しで測る。ブラウザは本文を送るとき必ずどちらかを付けるので、塞ぎたい経路はここに入る。
 * 本文を持たない `curl -X POST` はどちらも付けないので、今までどおり通る。
 */
export function hasRequestBody(contentLength: string | undefined, transferEncoding: string | undefined): boolean {
  if (transferEncoding !== undefined) return true;
  return contentLength !== undefined && Number(contentLength) > 0;
}

/** トークンの照合。長さの違いだけを漏らし、中身の比較には時間差を作らない。 */
export function tokenEquals(got: string | null | undefined, token: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
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
    // 入口の検査は、どれで断ったかを区別できないようそろえる。攻撃者に手掛かりを与えない。
    if (!originAllowed(c.req.header('origin'), port)) return c.json({ error: 'origin not allowed' }, 403);
    if (!fetchSiteAllowed(c.req.header('sec-fetch-site'), c.req.method)) return c.json({ error: 'origin not allowed' }, 403);
    const got = tokenFromRequest(c.req.raw.headers, c.req.header('cookie'));
    // クッキーは UI の HTML を配るときに発行するので、トークンが変わった後の
    // 開きっぱなしのタブはここに落ちる。UI はこの文をそのままトーストに出す。
    if (!tokenEquals(got, token)) return c.json({ error: '認証が切れました。ページを再読み込みしてください' }, 401);
    // 本文を持つ要求だけ型を見る。本文の無い POST は今までどおり通す。
    if (hasRequestBody(c.req.header('content-length'), c.req.header('transfer-encoding')) && !jsonContentType(c.req.header('content-type'))) {
      return c.json({ error: '要求の形式が正しくありません' }, 415);
    }
    await next();
  };
}
