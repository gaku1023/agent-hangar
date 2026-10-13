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

/** 端末トークンなどの乱数である。base64url なので URL とヘッダに安全である。 */
export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
