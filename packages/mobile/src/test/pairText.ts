import { encodePairing } from '@agent-hangar/shared';

export const WORKER = 'https://hangar.example.workers.dev';

/** 試験用のつなぐ文字列（#pair= の後ろ）。中身は url、券、PC の名前、期限だけで、鍵は入らない（互換の版 9）。 */
export function makePairText(opts: { expiresAt?: number; pcName?: string } = {}): { text: string } {
  const text = encodePairing({ url: WORKER, code: 'code-1', pcName: opts.pcName ?? 'Mac', expiresAt: opts.expiresAt ?? Date.now() + 4 * 60_000 });
  return { text };
}

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
