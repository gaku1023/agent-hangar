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
 * Claude Code は登録を pid と sessionId と startedAt を持つ形で書き始め、status は 100 ミリ秒ほど後に足す（2.1.295 と 2.1.296 で確かめた）。
 * その間に読むと status が欠けて見えるが、形のずれではない。pid と sessionId は書き始めから持つので入れない。
 */
export const TRANSIENT_REGISTRY_DRIFTS: ReadonlySet<string> = new Set(['status=(missing)']);
/**
 * 一瞬だけ欠けうる欄を、登録が書かれてから欠けたままでも待つ時間。
 * 足すまでの間は、全コアを埋めた負荷でも 250 ミリ秒ほどだった。読み取りの回数で数えると、見張りの側が混んで読み取りが詰まったときに誤る（2026-10-10 に起きた）。
 * 時間で区切れば、読み取りの間隔に左右されない。
 */
export const REGISTRY_STATUS_GRACE_MS = 5000;

/** 登録が書かれた時刻（Claude Code の startedAt）。無いか数でなければ null。 */
export function registryStartedAt(rec: unknown): number | null {
  return isRec(rec) && typeof rec.startedAt === 'number' && Number.isFinite(rec.startedAt) ? rec.startedAt : null;
}

/** 登録の見分け。同じ pid のファイルでも、会話が変わると sessionId が変わるので、ファイルの名前と sessionId と pid の組にする。 */
export function registryKey(file: string, rec: unknown): string {
  const r = isRec(rec) ? rec : {};
  return JSON.stringify([file, typeof r.sessionId === 'string' ? r.sessionId : null, typeof r.pid === 'number' ? r.pid : null]);
}

/**
 * 一瞬だけ欠けうる欄のずれを、登録が書かれてから REGISTRY_STATUS_GRACE_MS を過ぎても欠けているときだけ通す門。
 * ほかのずれはそのまま通す。
 * 書かれた時刻は、登録の startedAt と、この門が初めて欠けを見た時刻の早いほうにする。
 * startedAt が無いか先の時刻でも、初めて見てから猶予を過ぎれば通す。hangar を起こし直したときは、前から書かれている登録を待たない。
 * 間に 1 回でも欠けていない読み取り（欄が見えた、登録が無かった、会話が変わった）があれば、初めて見た時刻を忘れる。
 * 猶予を過ぎた後も欠けたままなら、読み取りのたびに通す。数えるのは見張り（RegistryWatcher）が一覧の変わったときだけである。
 */
export class RegistryMissGate {
  private firstSeen = new Map<string, number>();

  /** 1 回の読み直しで出たずれを、登録の見分け（registryKey）と書かれた時刻と組で受け取り、記録してよいずれを返す。読み直し 1 回につき 1 度だけ呼ぶ。 */
  pass(found: ReadonlyArray<{ key: string; drift: Drift; startedAt: number | null }>, now: number): Drift[] {
    const next = new Map<string, number>();
    const out: Drift[] = [];
    for (const { key, drift, startedAt } of found) {
      if (!TRANSIENT_REGISTRY_DRIFTS.has(drift.value)) { out.push(drift); continue; }
      const k = `${key}\0${drift.value}`;
      const seen = this.firstSeen.get(k) ?? now;
      next.set(k, seen);
      if (now - Math.min(seen, startedAt ?? seen) >= REGISTRY_STATUS_GRACE_MS) out.push(drift);
    }
    this.firstSeen = next;
    return out;
  }
}
