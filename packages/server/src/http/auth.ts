import type { MiddlewareHandler } from 'hono';
import { devMode, originAllowed, tokenEquals, tokenFromRequest } from '../auth/request.ts';
import { defaultLanguage, type GetLanguage } from '../i18n/language.ts';
import { translatorOf } from '../i18n/message.ts';

/** 入口に依らない検査は auth/request.ts に置く。HTTP の入口を読む側が 1 か所から取れるよう、ここからも出す。 */
export { allowedOrigins, devMode, originAllowed, tokenEquals, tokenFromRequest } from '../auth/request.ts';

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
 * 本文の型の例外。動詞と経路が完全に一致する要求にだけ、JSON のほかに 1 つの型を認める。
 * 初期プロンプト欄の添付は、ファイルのバイト列をそのまま送るので JSON にできない。
 * application/octet-stream は「単純な要求」で使える型（text/plain など）ではないので、
 * 別のサイトのページから送ると前検査が起き、CORS の許可を返さないここでは届かない。
 * JSON だけにしている理由（前検査を必ず挟ませる）は、この型でも保たれる。
 * 「単純でない型なら通す」に広げない。通す型は、ここに書いた 1 つだけである。
 */
const BODY_TYPE_EXCEPTIONS: readonly { method: string; path: string; type: string }[] = [
  { method: 'POST', path: '/api/drops', type: 'application/octet-stream' },
];

/** 本文を持つ要求の型を通すか。JSON か、例外の表に動詞・経路・型がそろって載っているものだけを通す。 */
export function bodyContentTypeAllowed(method: string, path: string, contentType: string | undefined): boolean {
  if (jsonContentType(contentType)) return true;
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  return BODY_TYPE_EXCEPTIONS.some((e) => e.method === method.toUpperCase() && e.path === path && e.type === type);
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

/** ブラウザの他サイトからの要求を Origin で拒み、ローカルトークンで認証する。 */
export function authMiddleware(token: string, port: number, language: GetLanguage = defaultLanguage): MiddlewareHandler {
  const tr = translatorOf(language);
  return async (c, next) => {
    // 入口の検査は、どれで断ったかを区別できないようそろえる。攻撃者に手掛かりを与えない。
    if (!originAllowed(c.req.header('origin'), port)) return c.json({ error: 'origin not allowed' }, 403);
    if (!fetchSiteAllowed(c.req.header('sec-fetch-site'), c.req.method)) return c.json({ error: 'origin not allowed' }, 403);
    const got = tokenFromRequest(c.req.raw.headers, c.req.header('cookie'));
    // クッキーは UI の HTML を配るときに発行するので、トークンが変わった後の
    // 開きっぱなしのタブはここに落ちる。UI はこの文をそのままトーストに出す。
    if (!tokenEquals(got, token)) return c.json({ error: tr('http.auth.expired') }, 401);
    // 本文を持つ要求だけ型を見る。本文の無い POST は今までどおり通す。
    if (hasRequestBody(c.req.header('content-length'), c.req.header('transfer-encoding')) && !bodyContentTypeAllowed(c.req.method, c.req.path, c.req.header('content-type'))) {
      return c.json({ error: tr('http.request.badContentType') }, 415);
    }
    await next();
  };
}
