import type { Db } from '../db/open.ts';
import { touchRow } from '../db/notify.ts';
import type { NoticeEvent } from '../events/publisher.ts';
import { assignSessions, checkProjectRoots } from './registry.ts';

/**
 * この端末のルートの存在を確かめ、戻ったものの取りこぼしを拾う。
 * ルートが消えている間に現れたセッションは、解決済みのルートに当たらないので未分類のまま残る。
 * 戻ったときに紐づけ直さないと、次の起動まで未分類のままになり、プロジェクトにも出てこない。
 * 戻ったルートが無いときは何もしない。起動時の 1 回目はたいていこちらを通るので、全件を舐めない。
 *
 *
 * 消えたもの（解決済みから未解決へ移ったルート）は、ここが project.unresolved で知らせる。
 * 画面はそれで置き場の選び直しを開くので、遷移を知っているここだけが出す。
 * ほかは画面へ配らない。配るのは events/publisher.ts で、ここが書いた行の知らせから組む。
 * 戻ったルートは project.upsert、紐づけ直したセッションは session.upsert になる。
 * 紐づけ直しで中身が変わったプロジェクトだけは、行を書いていないので、ここで名指しする。
 */
export function checkRoots(o: { db: Db; deviceId: string; broadcast: (ev: NoticeEvent) => void }): { unresolved: string[]; recovered: string[] } {
  const r = checkProjectRoots(o.db, o.deviceId);
  for (const id of r.unresolved) o.broadcast({ type: 'project.unresolved', projectId: id });
  if (r.recovered.length === 0) return r;
  const unassigned = (o.db.prepare('select id from sessions where project_id is null and deleted_at is null').all() as { id: string }[]).map((x) => x.id);
  assignSessions(o.db, o.deviceId);
  // 戻ったプロジェクトと、紐づけ直しで中身が変わったプロジェクトを配り直してもらう。
  // 戻った方はルートの行の知らせでも並んでいるが、セッションの後に来るよう、ここでもう一度名指しする。
  const touched = new Set(r.recovered);
  const projectOf = o.db.prepare('select project_id p from sessions where id = ? and deleted_at is null');
  for (const id of unassigned) {
    const p = (projectOf.get(id) as { p: string | null } | undefined)?.p;
    if (p) touched.add(p);
  }
  for (const id of touched) touchRow(o.db, 'projects', id);
  return r;
}
