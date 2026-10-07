import { isRec, versionOfRecord, type Drift } from './types.ts';

/** これより大きい resets_at はミリ秒と見る。秒の UNIX 時刻が 10^11 に届くのは西暦 5138 年である。 */
export const RESETS_AT_MS_FLOOR = 1e11;

/** resets_at を epoch のミリ秒にする。秒なら 1000 倍し、ミリ秒と見られる値はそのまま使う。 */
export function resetsAtMs(v: number): number {
  return v > RESETS_AT_MS_FLOOR ? v : v * 1000;
}

/**
 * statusLine に渡る JSON が、hangar の読む項目を持っているかを見る。
 * rate_limits は起動直後の 1 回目と API キーで使うときには無いので、あるときだけ中を見る。
 * 欠けた項目は、読む側（usage/statusline.ts）がいまと同じく直前の値を保つ。
 */
export function statuslineDrifts(raw: unknown): Drift[] {
  if (!isRec(raw)) return [];
  const version = versionOfRecord(raw);
  const out: Drift[] = [];
  const d = (value: string) => out.push({ contract: 'statusline', value, version });
  if (typeof raw.session_id !== 'string' || raw.session_id === '') d('session_id=(missing)');
  const m = raw.model;
  if (!(typeof m === 'string' && m !== '') && !(isRec(m) && (typeof m.id === 'string' || typeof m.display_name === 'string'))) d('model=(missing)');
  if (!isRec(raw.context_window) || typeof raw.context_window.context_window_size !== 'number') d('context_window.context_window_size=(missing)');
  if (!isRec(raw.cost) || typeof raw.cost.total_cost_usd !== 'number') d('cost.total_cost_usd=(missing)');
  const rl = raw.rate_limits;
  if (rl !== undefined && rl !== null) {
    if (!isRec(rl)) d('rate_limits=(missing)');
    else for (const k of ['five_hour', 'seven_day']) {
      const w = rl[k];
      if (w === undefined || w === null) continue;
      if (!isRec(w)) { d(`rate_limits.${k}=(missing)`); continue; }
      if (typeof w.used_percentage !== 'number') d(`rate_limits.${k}.used_percentage=(missing)`);
      if (typeof w.resets_at !== 'number') d(`rate_limits.${k}.resets_at=(missing)`);
      else if (w.resets_at > RESETS_AT_MS_FLOOR) d(`rate_limits.${k}.resets_at=ms`);
    }
  }
  return out;
}
