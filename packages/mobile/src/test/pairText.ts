import { encodePairing } from '@agent-hangar/shared';
import { randomKeyBytes } from './fixtures.ts';

export const WORKER = 'https://hangar.example.workers.dev';

export function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 試験用のつなぐ文字列（#pair= の後ろ）と、その中の鍵の文字列。 */
export function makePairText(opts: { expiresAt?: number; pcName?: string; keyBytes?: Uint8Array } = {}): { text: string; keyText: string } {
  const keyText = b64url(opts.keyBytes ?? randomKeyBytes());
  const text = encodePairing({ url: WORKER, code: 'code-1', key: keyText, pcName: opts.pcName ?? 'Mac', expiresAt: opts.expiresAt ?? Date.now() + 4 * 60_000 });
  return { text, keyText };
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
