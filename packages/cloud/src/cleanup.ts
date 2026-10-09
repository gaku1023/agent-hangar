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

/**
 * 旧実装の設定の同期が残した、項目ごとの本体（R2 の config/<端末>/<相対パス>）と索引（files の kind が config の行）を消す。
 *
 * 段 4 の PR 14 以降の束は、config/<端末>/.hangar/config-bundle.hgr の 1 オブジェクトと共有表 config_snapshots の行である。
 * 束の本体と索引は残し、それ以外の config の行と本体だけを消す。
 *
 * この関門（LEGACY_CONFIG_CLEANUP_ENABLED）は、旧実装を削除する PR 18 が true にする。
 * 旧実装を積んだ端末は、この索引と本体を読んで取り込むので、旧実装が端末から消える前に消してはいけない。
 * 関門が閉じている間は、何も消さず、印も置かない。
 *
 * 1 回の呼び出しは、100 件を 1 まとまりとして最大 maxRounds まとまりまでを消す。
 * D1 の書き込みは消した行の数だけで、無料枠の 1 日 10 万行に対して、旧実装の項目の総数（端末ごとに多くて数千）が 1 度かかるだけである。
 * R2 の削除は無料である。
 * 取り切れなければ次の cold start に続きを任せ、取り切ったときに印を置く。
 * R2 を先に消してから索引を消す。倒れたときは、本体の無い索引が残り、孤児の掃除（sweep.ts）が拾う。
 */
export const LEGACY_CONFIG_CLEANUP_ENABLED = false;
export const META_LEGACY_CONFIG_CLEANUP = 'legacy_config_cleanup';
export const LEGACY_CONFIG_BATCH = 100;
const LEGACY_CONFIG_MAX_ROUNDS = 5;
/** 新実装の束の相対パス。packages/server/src/sync/config/paths.ts の BUNDLE_PATH と同じである。 */
const BUNDLE_REL = '.hangar/config-bundle.hgr';

/** 取り切って印を置いたら true、関門が閉じているか、印があるか、続きが残るか、落ちたら false を返す。例外は投げない。 */
export async function cleanupLegacyConfig(
  env: Env,
  now: number,
  enabled: boolean = LEGACY_CONFIG_CLEANUP_ENABLED,
  maxRounds: number = LEGACY_CONFIG_MAX_ROUNDS,
): Promise<boolean> {
  if (!enabled) return false;
  const db = env.DB;
  try {
    const done = await db.prepare('select 1 as x from meta where key = ?').bind(META_LEGACY_CONFIG_CLEANUP).first<{ x: number }>();
    if (done) return false;
    for (let round = 0; round < maxRounds; round++) {
      const rows = await db
        .prepare("select key from files where kind = 'config' and path <> ? order by seq limit ?")
        .bind(BUNDLE_REL, LEGACY_CONFIG_BATCH)
        .all<{ key: string }>();
      const keys = rows.results.map((r) => r.key);
      if (keys.length === 0) {
        await db.batch([db.prepare('insert into meta (key, value) values (?, ?) on conflict(key) do nothing').bind(META_LEGACY_CONFIG_CLEANUP, String(now))]);
        return true;
      }
      await env.BUCKET.delete(keys);
      await db.batch([db.prepare(`delete from files where key in (${keys.map(() => '?').join(',')})`).bind(...keys)]);
    }
    return false;
  } catch (e) {
    console.error('legacy config cleanup failed', e instanceof Error ? e.name : typeof e);
    return false;
  }
}
