import desktop from '../../../apps/desktop/package.json' with { type: 'json' };

/**
 * Worker の /health が名乗る版。アプリの版（apps/desktop の package.json）をそのまま使い、決め打ちしない。
 * リリースの set-version で上げれば、束ねる Worker の版も上がる。
 */
export const VERSION: string = desktop.version;

export async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 詰め物の無い base64url の形。長さが 4 で割って 1 余るものは、どのバイト列にもならない。 */
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** 空でなく、`max` 字までの、詰め物の無い base64url か。PC が封じた値（`sealed`、`sealed_meta`）の形を見る。 */
export function isSealedText(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= max && v.length % 4 !== 1 && B64URL_RE.test(v);
}

/**
 * 封じた値（base64url）を D1 の BLOB に入れるバイト列にする。
 * 文字のまま置くと、D1 の大きさが約 4/3 倍になる（設計書「使用量」）。
 * 形は `isSealedText` で確かめてから渡すこと。
 */
export function sealedToBlob(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * D1 から読んだ BLOB を base64url（詰め物なし）に戻す。
 * D1 は BLOB を数の配列で返し、ArrayBuffer で返す土台もある。
 * 文字のまま置かれた値（試験が直に入れた行など）は、そのまま返す。
 */
export function blobToSealed(v: unknown): string {
  if (typeof v === 'string') return v;
  let bytes: Uint8Array;
  if (v instanceof Uint8Array) bytes = v;
  else if (v instanceof ArrayBuffer) bytes = new Uint8Array(v);
  else if (Array.isArray(v)) bytes = Uint8Array.from(v as number[]);
  else return '';
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 端末トークンなどの乱数である。base64url なので URL とヘッダに安全である。 */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
