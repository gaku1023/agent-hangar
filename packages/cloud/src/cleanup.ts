import type { Env } from './env.ts';

/**
 * 段 1 で消したものが D1 に残した行を、1 回だけ消す。
 *
 * 消すのは、meta の鍵が d1_rows: で始まる行である。Worker が D1 への書き込みを数えていた日ごとの台帳で、段 1 で数えるのをやめた。
 * files の kind が config の行（Claude Code の設定の同期の索引）と R2 の config/ の本体には触らない。
 * 設定の同期は段 1 では残し、段 4 で作り直すからである（全体計画の D6）。
 *
 * Workers には配備の後に 1 度だけ走る処理が無い。
 * そこで、isolate ごとに 1 度走るスキーマの用意（schema.ts の ensureSchema）から呼び、
 * 済んだ印を meta に置いて、2 度目からは印を読むだけで帰る。
 * 消す文と印を置く文は 1 つの batch に入れる。D1 の batch は 1 つの取引なので、途中で倒れても半端に残らない。
 * 2 つの isolate が同時に走っても、どの文も何度流しても同じ結果になる。
 *
 * 落ちても要求は落とさない。
 * 後始末は同期に要らないので、失敗は記録だけ残し、次の cold start でまた試す。
 */
export const META_STAGE1_CLEANUP = 'stage1_cleanup';

/** 消したら true、印があって何もしなかったか、落ちたら false を返す。例外は投げない。 */
export async function cleanupStage1(env: Env, now: number): Promise<boolean> {
  const db = env.DB;
  try {
    const done = await db.prepare('select 1 as x from meta where key = ?').bind(META_STAGE1_CLEANUP).first<{ x: number }>();
    if (done) return false;
    await db.batch([
      db.prepare("delete from meta where substr(key, 1, 8) = 'd1_rows:'"),
      db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do nothing').bind(META_STAGE1_CLEANUP, String(now)),
    ]);
    return true;
  } catch (e) {
    console.error('cleanup failed', e instanceof Error ? e.name : typeof e);
    return false;
  }
}
