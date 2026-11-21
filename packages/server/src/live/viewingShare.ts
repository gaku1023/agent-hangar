import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import type { DeviceInfo } from '../config/paths.ts';
import { localViewing, onLocalViewingChange, setRemoteViewing } from './viewing.ts';

/**
 * いま開いて見ている会話を 2 台で共有する（2026-11-21）。
 *
 * この PC の画面で前に出して見ている会話（live/viewing.ts の localViewing）を、devices のこの PC の行の viewing（会話の id の JSON の配列）と viewing_at に書く。
 * 組が変わったら急ぎで書き（db/shared.ts の isUrgentWrite、ほかの PC を呼び鈴で鳴らす）、もう 1 台には 2 秒ほどで届く。
 * 見ている間は VIEWING_SHARE_REFRESH_MS ごとに viewing_at を刻み直す（急がない）。
 * ほかの PC の行は、viewing_at が REMOTE_VIEWING_TTL_MS より古ければ見ていないとみなす。窓を閉じずに眠った PC が、いつまでも知らせを止めないためである。
 * どちらかの PC で見ている会話には、どちらの PC からも未読を積まず、OS にもスマホにも知らせない（live/viewing.ts の isViewing）。
 * devices の列を足しただけなので、列を知らない古い版の PC は取り込みで捨てる（sync/apply.ts）。
 */

export const VIEWING_SHARE_REFRESH_MS = 120_000;
export const REMOTE_VIEWING_TTL_MS = 300_000;
/** 見直しの周期。画面の送り直しの途切れ（75 秒）と刻み直しを拾う。 */
export const VIEWING_SHARE_TICK_MS = 30_000;

/** ほかの PC で、いまその会話を開いて見ているか。 */
export function remoteViewing(db: Db, deviceId: string, sessionId: string, now: number): boolean {
  const rows = db.prepare('select viewing from devices where id != ? and deleted_at is null and viewing_at >= ?').all(deviceId, now - REMOTE_VIEWING_TTL_MS) as { viewing: string | null }[];
  for (const r of rows) {
    if (!r.viewing) continue;
    try {
      const ids = JSON.parse(r.viewing) as unknown;
      if (Array.isArray(ids) && ids.includes(sessionId)) return true;
    } catch {
      /* 読めない値は見ていないとみなす */
    }
  }
  return false;
}

export type ViewingShareDeps = {
  db: Db;
  device: DeviceInfo;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
};

export class ViewingShare {
  constructor(private readonly deps: ViewingShareDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** ほかの PC の判定をつなぎ、この PC の変化と周期で書き直し始める。戻り値を呼ぶと外す。 */
  start(): () => void {
    setRemoteViewing((id, now) => remoteViewing(this.deps.db, this.deps.device.id, id, now));
    const run = () => { try { this.check(); } catch (e) { console.error('[viewing] could not share', e instanceof Error ? e.message : e); } };
    const off = onLocalViewingChange(run);
    const t = (this.deps.setInterval ?? ((fn, ms) => { const h = setInterval(fn, ms); h.unref?.(); return h; }))(run, VIEWING_SHARE_TICK_MS);
    return () => { off(); clearInterval(t as ReturnType<typeof setInterval>); };
  }

  /** この PC の行を今の組に合わせる。組が同じなら、見ている間の刻み直しの時だけ書く。 */
  check(): void {
    const now = this.now();
    const ids = localViewing(now);
    const next = JSON.stringify(ids);
    const row = this.deps.db.prepare('select * from devices where id = ?').get(this.deps.device.id) as Record<string, unknown> | undefined;
    const prev = typeof row?.viewing === 'string' ? row.viewing : '[]';
    const at = typeof row?.viewing_at === 'number' ? row.viewing_at : 0;
    if (prev === next && (ids.length === 0 || now - at < VIEWING_SHARE_REFRESH_MS)) return;
    const d = this.deps.device;
    upsertShared(this.deps.db, 'devices', { ...(row ?? {}), id: d.id, name: d.name, platform: d.platform, viewing: next, viewing_at: now, deleted_at: null }, d.id, 'id', now);
  }
}
