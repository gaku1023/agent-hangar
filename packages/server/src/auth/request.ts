import { timingSafeEqual } from 'node:crypto';

/**
 * 要求の出どころとトークンを確かめる、枠組みに依らない関数。
 * HTTP の入口（http/auth.ts）、WebSocket（ws/hub.ts、pty/relay.ts）、MCP（mcp/app.ts）が同じものを使う。
 * どの入口よりも下の層に置き、入口どうしが互いを呼ばないようにする。
 */

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
