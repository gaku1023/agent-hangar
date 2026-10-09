import { isRec, splitDriftValue, versionOfRecord, type Drift } from './types.ts';

/** ~/.claude/sessions/<pid>.json の status として知っている値。shell は本体が休みで裏の Bash だけが動いていること。 */
export const KNOWN_REGISTRY_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting', 'shell']);

/**
 * 1 件の登録が、hangar の読む形かを見る。
 * 知らない status は、読む側（readRegistry）が作業中として扱う。休んでいるセッションを止める機能があるので、誤って止めるより待たせるほうが害が小さい。
 */
export function registryDrifts(rec: unknown): Drift[] {
  if (!isRec(rec)) return [{ contract: 'registry', value: 'entry=(not-object)', version: null }];
  const version = versionOfRecord(rec);
  const out: Drift[] = [];
  const d = (value: string) => out.push({ contract: 'registry', value, version });
  if (typeof rec.sessionId !== 'string' || rec.sessionId === '') d('sessionId=(missing)');
  if (typeof rec.pid !== 'number') d('pid=(missing)');
  if (typeof rec.status !== 'string') d('status=(missing)');
  else if (!KNOWN_REGISTRY_STATUSES.has(rec.status)) d(`status=${rec.status}`);
  return out;
}

/**
 * 記録に残ったレジストリの値が、今の集合でもずれかを返す。
 * status は、今の集合に入っていればずれでない。欠けと、オブジェクトでない登録と、知らない形の値はずれのままにする。
 */
export function isRegistryDrift(value: string): boolean {
  const kv = splitDriftValue(value);
  return kv === null || kv[0] !== 'status' || !KNOWN_REGISTRY_STATUSES.has(kv[1]);
}

/**
 * 一瞬だけ欠けうる欄のずれ。
 * Claude Code は登録を pid と sessionId を持つ形で書き始め、status は少し後に足す（2.1.295 で確かめた）。
 * その間に読むと status が欠けて見えるが、形のずれではない。pid と sessionId は書き始めから持つので入れない。
 */
export const TRANSIENT_REGISTRY_DRIFTS: ReadonlySet<string> = new Set(['status=(missing)']);
/** 一瞬だけ欠けうる欄を記録するまでに、同じ登録で続けて欠けていた読み取りの数。登録は 500 ミリ秒ごとに読み直すので、おおよそ 0.5 秒以上欠けていたことになる。 */
export const REGISTRY_MISS_THRESHOLD = 2;

/** 登録の見分け。同じ pid のファイルでも、会話が変わると sessionId が変わるので、ファイルの名前と sessionId と pid の組にする。 */
export function registryKey(file: string, rec: unknown): string {
  const r = isRec(rec) ? rec : {};
  return JSON.stringify([file, typeof r.sessionId === 'string' ? r.sessionId : null, typeof r.pid === 'number' ? r.pid : null]);
}

/**
 * 一瞬だけ欠けうる欄のずれを、同じ登録で続けて REGISTRY_MISS_THRESHOLD 回の読み取りで欠けていたときだけ通す門。
 * ほかのずれはそのまま通す。
 * 間に 1 回でも欠けていない読み取り（欄が見えた、登録が無かった、会話が変わった）があれば数え直す。
 * しきい値に達した後も欠けたままなら、読み取りのたびに通す。回数は見張り（RegistryWatcher）が登録の変わったときだけ数える。
 */
export class RegistryMissGate {
  private misses = new Map<string, number>();

  /** 1 回の読み直しで出たずれを、登録の見分け（registryKey）と組で受け取り、記録してよいずれを返す。読み直し 1 回につき 1 度だけ呼ぶ。 */
  pass(found: ReadonlyArray<{ key: string; drift: Drift }>): Drift[] {
    const next = new Map<string, number>();
    const out: Drift[] = [];
    for (const { key, drift } of found) {
      if (!TRANSIENT_REGISTRY_DRIFTS.has(drift.value)) { out.push(drift); continue; }
      const k = `${key}\0${drift.value}`;
      const n = (this.misses.get(k) ?? 0) + 1;
      next.set(k, n);
      if (n >= REGISTRY_MISS_THRESHOLD) out.push(drift);
    }
    this.misses = next;
    return out;
  }
}
