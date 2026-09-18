import crypto from 'node:crypto';
import type { Db } from '../db/open.ts';

/**
 * run ごとの MCP の秘密。
 *
 * claude に本体のトークンを渡すと、その claude は自分の `--mcp-config` を読んで（0600 だが、
 * そのファイルを読めるのは他ならぬ自分である）共通の `/mcp` と `/api` に回れる。
 * 閉じ込めは URL ではなく鍵で行う必要があるので、run を起こすたびに専用の秘密を作って配る。
 *
 * 置き場は DB である。tmux の上で生きている run はサーバの再起動をまたいで残り
 * （`RunManager.recoverAtStartup` は tmux セッションが残っている run を閉じない）、
 * その claude は再起動後も同じ秘密で繋ぎに来る。サーバのメモリに持つと、そこで繋がらなくなる。
 * `mcp_secrets` は共有テーブルではないので、`upsertShared` を通さず、同期にも載らない。
 */

/** そのセッション専用の秘密を作り、前の分を置き換える。返した値だけが唯一の写しである。 */
export function issueMcpSecret(db: Db, sessionId: string, now: number): string {
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('insert into mcp_secrets (session_id, secret, created_at) values (?, ?, ?) on conflict(session_id) do update set secret = excluded.secret, created_at = excluded.created_at').run(sessionId, secret, now);
  return secret;
}

/** そのセッションの生きている秘密。無ければ null。 */
export function mcpSecretFor(db: Db, sessionId: string): string | null {
  const r = db.prepare('select secret from mcp_secrets where session_id = ?').get(sessionId) as { secret: string } | undefined;
  return r?.secret ?? null;
}

/** そのセッションの秘密を無効にする。run が終わったら必ず呼ぶ。 */
export function revokeMcpSecret(db: Db, sessionId: string): void {
  db.prepare('delete from mcp_secrets where session_id = ?').run(sessionId);
}

/**
 * 生きている run のもの以外の秘密を落とす。
 * run の終わりで消し損ねても、次の起動と起動時の回復でここが拾う。
 * 消した数を返す。
 */
export function pruneMcpSecrets(db: Db, aliveSessionIds: Iterable<string>): number {
  const alive = new Set(aliveSessionIds);
  const ids = (db.prepare('select session_id from mcp_secrets').all() as { session_id: string }[]).map((r) => r.session_id);
  let n = 0;
  for (const id of ids) {
    if (alive.has(id)) continue;
    revokeMcpSecret(db, id);
    n++;
  }
  return n;
}

/** 秘密の照合。長さの違いだけを漏らし、中身の比較には時間差を作らない。 */
export function mcpSecretMatches(db: Db, sessionId: string, got: string | null | undefined): boolean {
  const want = mcpSecretFor(db, sessionId);
  if (want === null || typeof got !== 'string') return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
