/**
 * リカバリーキーの文字列の形。
 *
 * 見出し `hangar リカバリーキー`、作成日、URL、暗号鍵の 4 行で、パスワードマネージャーに保存してもらう。
 * 暗号鍵は X25519 の秘密鍵 32 バイトの base32（RFC 4648、詰め物なし、52 字）を 4 字ごとに `-` で区切った 64 字である。
 * 読むときは、見出しと行の順の揺れ、前後の空白、`-` の抜け、小文字を許す。
 */

import { fromBase32, fromBase64UrlLen, toBase32, toBase64Url } from './bytes.ts';

export const RECOVERY_KEY_HEADING = 'hangar リカバリーキー';

const SECRET_LEN = 52;

/** リカバリーキーが読めない（暗号鍵か URL が無い、字種の外の文字がある、長さが違う）。 */
export class RecoveryKeyError extends Error {
  constructor(message = 'リカバリーキーが読めません') {
    super(message);
    this.name = 'RecoveryKeyError';
  }
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 表示と保存に使う 4 行の文字列を作る。 */
export function formatRecoveryKey(o: { priv: string; url: string; createdAt: number }): string {
  const secret = toBase32(fromBase64UrlLen(o.priv, 32, 'リカバリーキーの秘密鍵'));
  const grouped = secret.match(/.{1,4}/g)?.join('-') ?? secret;
  return [RECOVERY_KEY_HEADING, `作成日: ${localDate(o.createdAt)}`, `URL: ${o.url}`, `暗号鍵: ${grouped}`].join('\n');
}

const LINE_RE = /^(作成日|URL|暗号鍵)\s*[:：]\s*(.*)$/i;

function fields(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of String(text).split(/\r?\n|\r/)) {
    const m = LINE_RE.exec(raw.normalize('NFKC').trim());
    if (m?.[1] && m[2] !== undefined) out.set(m[1].toUpperCase(), m[2].trim());
  }
  return out;
}

/** 暗号鍵の欄から、区切りと空白を捨てた大文字の 52 字を取り出す。読めなければ投げる。 */
function cleanSecret(s: string): string {
  const secret = s.normalize('NFKC').replace(/[\s\-‐-―−ー]/g, '').toUpperCase();
  if (secret.length !== SECRET_LEN) throw new RecoveryKeyError();
  const bytes = fromBase32(secret);
  if (!bytes || bytes.length !== 32) throw new RecoveryKeyError();
  return secret;
}

/** 保存したリカバリーキーを読み、秘密鍵（base64url）と URL を返す。 */
export function parseRecoveryKey(text: string): { priv: string; url: string } {
  const f = fields(text);
  const secretField = f.get('暗号鍵');
  const url = f.get('URL');
  if (!secretField || !url) throw new RecoveryKeyError();
  const bytes = fromBase32(cleanSecret(secretField));
  if (!bytes) throw new RecoveryKeyError();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new RecoveryKeyError();
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new RecoveryKeyError();
  return { priv: toBase64Url(bytes), url };
}

/**
 * 暗号鍵の末尾 4 文字（保存を確かめるときの照合に使う）。
 * 4 行の文字列でも、暗号鍵だけの文字列でもよい。
 */
export function recoverySecretTail(text: string): string {
  const secret = cleanSecret(fields(text).get('暗号鍵') ?? text);
  return secret.slice(-4);
}
