import type { Hono } from 'hono';
import type { AppDeps } from '../deps.ts';

/** 通知の経路が使う依存。 */
export type NotifyRouteDeps = Pick<AppDeps, 'osNotices'>;

/** 長いポーリングで待つ長さの上限（秒）。殻はこれより長い時間切れで読む。 */
const MAX_WAIT_S = 25;

/**
 * デスクトップ通知の並び（sessions/stopNotices.ts の OsNoticeFeed）。デスクトップの殻だけが読む。
 * after は殻が最後に読んだ番号、boot はそのときのサーバの起動の印で、どちらも無ければ今の番号だけを返す。
 * 続きが無ければ、届くか wait 秒（既定と上限は 25 秒）が過ぎるまで応答を待たせる。
 * 他の /api と同じく鍵（Bearer）で開く。殻は ~/.agent-hangar/token を読む。
 */
export function notifyRoutes(api: Hono, deps: NotifyRouteDeps): void {
  const feed = deps.osNotices;
  if (!feed) return;
  api.get('/notify/feed', async (c) => {
    const after = Number(c.req.query('after') ?? '-1');
    const boot = c.req.query('boot') ?? null;
    const wait = Number(c.req.query('wait') ?? String(MAX_WAIT_S));
    const ms = Number.isFinite(wait) ? Math.min(Math.max(wait, 0), MAX_WAIT_S) * 1000 : MAX_WAIT_S * 1000;
    return c.json(await feed.wait(Number.isInteger(after) ? after : -1, boot, ms));
  });
}
