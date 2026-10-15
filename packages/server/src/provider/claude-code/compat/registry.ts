import { createHash } from 'node:crypto';
import { KNOWN_WAITING_FOR } from '@agent-hangar/shared';
import { isRec, splitDriftValue, versionOfRecord, type Drift } from './types.ts';

/** ~/.claude/sessions/<pid>.json の status として知っている値。shell は本体が休みで裏の Bash だけが動いていること。 */
export const KNOWN_REGISTRY_STATUSES: ReadonlySet<string> = new Set(['busy', 'idle', 'waiting', 'shell']);
/**
 * 入力待ちの登録の waitingFor として知っている値（shared の KNOWN_WAITING_FOR）。
 * 知らない値は、読む側（readRegistry）が other（ダイアログと同じ、許可待ちでない入力待ち）として扱う。
 * 古い Claude は書かないので、欠けはずれにしない。
 */
export const KNOWN_WAITING_FOR_VALUES: ReadonlySet<string> = new Set(KNOWN_WAITING_FOR);

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
  if (rec.status === 'waiting' && typeof rec.waitingFor === 'string' && !KNOWN_WAITING_FOR_VALUES.has(rec.waitingFor)) d(`waitingFor=${rec.waitingFor}`);
  return out;
}

/**
 * 記録に残ったレジストリの値が、今の集合でもずれかを返す。
 * status と waitingFor は、今の集合に入っていればずれでない。欠けと、オブジェクトでない登録と、知らない形の値はずれのままにする。
 */
export function isRegistryDrift(value: string): boolean {
  const kv = splitDriftValue(value);
  if (kv === null) return true;
  if (kv[0] === 'status') return !KNOWN_REGISTRY_STATUSES.has(kv[1]);
  if (kv[0] === 'waitingFor') return !KNOWN_WAITING_FOR_VALUES.has(kv[1]);
  return true;
}

/**
 * 一瞬だけ欠けうる欄のずれ。
 * Claude Code は登録を pid と sessionId と startedAt を持つ形で書き始め、status は REPL の画面ができてから足す。
 * 新しく始めたときは 100 ミリ秒ほど後（2.1.295 と 2.1.296 で確かめた）だが、会話を再開したときは画面ができるまで数秒かかる。
 * その間に読むと status が欠けて見えるが、形のずれではない。pid と sessionId は書き始めから持つので入れない。
 */
export const TRANSIENT_REGISTRY_DRIFTS: ReadonlySet<string> = new Set(['status=(missing)']);
/**
 * 一瞬だけ欠けうる欄を、登録が書かれてから欠けたままでも待つ時間。
 * 2.1.300 の Windows で測ると、新しく始めたときは 0.5 秒ほどで足したが、再開したときは会話の大きさによらず 4〜10 秒かかった（2026-10-16）。
 * 0.6.3 までの 5 秒では、再開のたびに欠けを数えうる。数えると、休みの自動停止を止めたと Claude の版が変わるまで出し続ける。
 * 欠けている間の登録は作業中と読むので、長く待っても止めてよいかを誤らない。
 * 読み取りの回数で数えると、見張りの側が混んで読み取りが詰まったときに誤る（2026-10-10 に起きた）。時間で区切れば、読み取りの間隔に左右されない。
 */
export const REGISTRY_STATUS_GRACE_MS = 60_000;

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
 * 通した欠けの後で、同じ登録に欄が見えたら、遅かっただけで形のずれではなかったので settled で返す。記録から落とすためである。
 * そのときほかの登録で同じ欠けを通しているなら、記録はそちらのものでもあるので返さない。
 * 欄が見えないまま登録が無くなったものは、欠けたまま終わったので返さない。
 */
export class RegistryMissGate {
  private firstSeen = new Map<string, number>();
  /** 猶予を過ぎて通した欠け。登録の見分けと組で持つ。 */
  private passed = new Map<string, { key: string; drift: Drift }>();

  /**
   * 1 回の読み直しで出たずれを、登録の見分け（registryKey）と書かれた時刻と組で受け取る。present はその読み直しで読めた登録の見分けである。
   * 記録してよいずれ（drifts）と、記録から落としてよいずれ（settled）を返す。読み直し 1 回につき 1 度だけ呼ぶ。
   */
  pass(found: ReadonlyArray<{ key: string; drift: Drift; startedAt: number | null }>, present: ReadonlySet<string>, now: number): { drifts: Drift[]; settled: Drift[] } {
    const next = new Map<string, number>();
    const nextPassed = new Map<string, { key: string; drift: Drift }>();
    const drifts: Drift[] = [];
    for (const { key, drift, startedAt } of found) {
      if (!TRANSIENT_REGISTRY_DRIFTS.has(drift.value)) { drifts.push(drift); continue; }
      const k = `${key}\0${drift.value}`;
      const seen = this.firstSeen.get(k) ?? now;
      next.set(k, seen);
      if (now - Math.min(seen, startedAt ?? seen) < REGISTRY_STATUS_GRACE_MS) continue;
      drifts.push(drift);
      nextPassed.set(k, { key, drift });
    }
    const still = new Set([...nextPassed.values()].map((p) => p.drift.value));
    const settled: Drift[] = [];
    for (const [k, p] of this.passed) {
      if (nextPassed.has(k) || !present.has(p.key) || still.has(p.drift.value)) continue;
      if (!settled.some((d) => d.value === p.drift.value)) settled.push(p.drift);
    }
    this.firstSeen = next;
    this.passed = nextPassed;
    return { drifts, settled };
  }
}

/**
 * SendMessage の宛先の [ref]（ListAgents が名前の後ろに添える 6 桁）。
 * 同じ名前のセッションが 2 つ以上あるときに、名前と組にして相手を決める（`名前 [ref]`）。
 * Claude Code は登録の messagingSocketPath から `session:<パス>` の sha256 を作り、先頭の 6 桁を使う。
 * 公開の文書には無い形で、2.1.300 の本体と ListAgents の出力で確かめた（2026-10-15）。
 */
export function registryRef(socketPath: string): string {
  return createHash('sha256').update(`session:${socketPath}`).digest('hex').slice(0, 6);
}
