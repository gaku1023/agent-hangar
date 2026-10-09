import type { Db } from '../../db/open.ts';

/**
 * 基準の表 config_base。項目ごとに、最後に両方で同じだった中身の指紋を持つ（3 方向の判定の共通の祖先）。
 * 同期の本体（service.ts）と、適用する側（apply.ts。CLI の hangar config apply と殻の命令）の両方が使う。
 * サーバ全体を引かないよう、この表の出し入れだけをここに分けてある。
 */
export class ConfigBase {
  constructor(private readonly db: Db) {}
  all(): Map<string, string> {
    return new Map((this.db.prepare('select item_id, sha256 from config_base').all() as { item_id: string; sha256: string }[]).map((r) => [r.item_id, r.sha256]));
  }
  set(itemId: string, sha: string, now: number): void {
    this.db.prepare('insert into config_base (item_id, sha256, synced_at) values (?,?,?) on conflict(item_id) do update set sha256 = excluded.sha256, synced_at = excluded.synced_at').run(itemId, sha, now);
  }
  remove(itemId: string): void { this.db.prepare('delete from config_base where item_id = ?').run(itemId); }
}
