import fs from 'node:fs';
import path from 'node:path';
import { COMPAT_CONTRACTS, type CompatContract, type CompatDriftDto } from '@agent-hangar/shared';
import { isRec, type CompatSink, type Drift } from './types.ts';

/** 残す件数の上限。超えたら、最後に見た時刻の古いものから落とす。 */
export const COMPAT_MAX_ENTRIES = 100;
/** 書き出しの間隔。登録は 500 ミリ秒ごとに読み直すので、ずれを受け取るたびには書かない。 */
export const COMPAT_FLUSH_MS = 5_000;
/** 値の長さの上限。値は外のデータから来て、報告にも写されるので、ここで切る。 */
export const COMPAT_MAX_VALUE = 200;
const FILE_VERSION = 1;

/** ずれの記録の置き場。端末ごとのもので、同期しない。 */
export function compatPath(home: string): string {
  return path.join(home, 'compat.json');
}

function isEntry(v: unknown): v is CompatDriftDto {
  return isRec(v) && typeof v.contract === 'string' && COMPAT_CONTRACTS.includes(v.contract as CompatContract)
    && typeof v.value === 'string' && (v.version === null || typeof v.version === 'string')
    && typeof v.count === 'number' && typeof v.firstSeenAt === 'number' && typeof v.lastSeenAt === 'number';
}

/**
 * Claude Code の形式のずれの記録。~/.agent-hangar/compat.json に置く。
 * DB のマイグレーションを要らない形にするためにファイルにした。
 * 同じ契約と値の組は 1 件にまとめて回数を数え、版は最後に見たときのものを持つ。
 * 書き出しは start() の周期と stop() で行う。読めないファイルは空として始め、次の書き出しで置き換える。
 */
export class CompatLog implements CompatSink {
  private readonly entries = new Map<string, CompatDriftDto>();
  /** 記録したときの手元の claude の版。分からない（新しい記録か、版を持たない古い形のファイル）ときは null。 */
  private seenVersion: string | null = null;
  private dirty = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly max: number;

  constructor(private readonly o: { file: string | null; localVersion: () => string | null; now?: () => number; max?: number }) {
    this.now = o.now ?? (() => Date.now());
    this.max = o.max ?? COMPAT_MAX_ENTRIES;
    this.load();
  }

  private key(contract: string, value: string): string {
    return `${contract}\0${value}`;
  }

  private load(): void {
    if (!this.o.file) return;
    let raw: unknown;
    try { raw = JSON.parse(fs.readFileSync(this.o.file, 'utf8')); } catch { return; }
    const list = isRec(raw) && Array.isArray(raw.entries) ? raw.entries.filter(isEntry) : [];
    for (const e of list) this.entries.set(this.key(e.contract, e.value), { ...e });
    if (isRec(raw) && typeof raw.localVersion === 'string') this.seenVersion = raw.localVersion;
    this.trim();
  }

  /**
   * 手元の claude の版を知らせる。版が変わったら、ずれを全部消して数え直す。
   * 前の版で出たずれが、新しい版でも出るとは限らないためである。
   * 読めない版（null）では消さない。前の版が分からないときは「変わった」と言えないので、持つだけにする。
   * 持った版は、ずれが増えなくても書き出す。書かないと、次の起動でまた前の版が分からなくなる。
   * 消したかを返す。消したときは、呼び手が 1 度しか数えない元（置き場の項目、サブコマンド、登録）から数え直す。
   */
  setLocalVersion(v: string | null): boolean {
    if (v === null || v === this.seenVersion) return false;
    const cleared = this.seenVersion !== null;
    if (cleared) this.entries.clear();
    this.seenVersion = v;
    this.dirty = true;
    return cleared;
  }

  note(d: Drift): void {
    const at = this.now();
    const value = d.value.slice(0, COMPAT_MAX_VALUE);
    const k = this.key(d.contract, value);
    const version = d.version ?? this.o.localVersion();
    const cur = this.entries.get(k);
    if (cur) {
      this.entries.set(k, { ...cur, count: cur.count + 1, lastSeenAt: at, version: version ?? cur.version });
    } else {
      this.entries.set(k, { contract: d.contract, value, version, count: 1, firstSeenAt: at, lastSeenAt: at });
      this.trim();
    }
    this.dirty = true;
  }

  /** 上限を超えた分を、最後に見た時刻の古いものから落とす。 */
  private trim(): void {
    while (this.entries.size > this.max) {
      let oldest: string | null = null;
      let at = Number.POSITIVE_INFINITY;
      for (const [k, e] of this.entries) if (e.lastSeenAt < at) { at = e.lastSeenAt; oldest = k; }
      if (oldest === null) return;
      this.entries.delete(oldest);
    }
  }

  /** 最後に見た時刻の新しい順。同じ時刻は契約と値の順にする。 */
  list(): CompatDriftDto[] {
    return [...this.entries.values()].map((e) => ({ ...e })).sort((a, b) =>
      b.lastSeenAt - a.lastSeenAt || (a.contract < b.contract ? -1 : a.contract > b.contract ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }

  count(): number {
    return this.entries.size;
  }

  /** 変わっていれば書き出す。一時ファイルに書いてから置き換えるので、途中で切れても半端は残らない。書けなくても投げない。 */
  flush(): void {
    if (!this.dirty || !this.o.file) return;
    const tmp = `${this.o.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.o.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, localVersion: this.seenVersion, entries: this.list() }, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.o.file);
      this.dirty = false;
    } catch (e) {
      console.error('[compat] ずれの記録を書けませんでした', e instanceof Error ? e.message : e);
    }
  }

  start(intervalMs: number = COMPAT_FLUSH_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref();
  }

  stop(flush = true): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (flush) this.flush();
  }
}
