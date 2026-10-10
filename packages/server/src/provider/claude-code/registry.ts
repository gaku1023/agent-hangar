import fs from 'node:fs';
import path from 'node:path';
import type { LiveStatus } from '@agent-hangar/shared';
import { isAlive } from '../../platform/proc.ts';
import type { LiveSession } from './types.ts';
import { RegistryMissGate, registryDrifts, registryKey } from './compat/registry.ts';
import { isRec, NO_COMPAT, type CompatSink, type Drift } from './compat/types.ts';

const STATUSES = new Set<LiveStatus>(['busy', 'idle', 'waiting']);

/**
 * その OS で、pid の登録を「消えたプロセスの残り」と見るかを返す。
 * macOS と Linux の claude は、止められると自分の登録を消すので、残りは見ない（いまの動きを変えない）。
 * Windows には穏やかに止める手段が無く、止められた claude は登録を消せない。動いていない pid の登録は残りと見る。
 * pid が別のプロセスに使い回されると残りを見逃すが、そのときは「動いている」と読むだけで、何も止めない。
 */
export function goneOn(platform: NodeJS.Platform): (pid: number) => boolean {
  return (pid) => platform === 'win32' && pid > 0 && !isAlive(pid);
}

/**
 * 書きかけで読めなかった登録を、前に読めた中身のまま続ける回数の上限。
 * 500 ミリ秒ごとの読み直しで 2 秒ぶんにあたる。
 * これを超えて読めないままなら、壊れた登録として読まない（いままでと同じ扱い）。
 */
export const UNREADABLE_CARRY_POLLS = 4;

/**
 * 登録のファイル名ごとの、最後に読めた中身と、それから続けて読めなかった回数。
 * Claude Code は、一時のファイルからの改名に失敗すると、登録をその場で書き直す（切り詰めてから書く）。
 * Windows では、ほかのプロセスがファイルを開いているだけで改名が失敗しうる。
 * その間に読むと中身が空か途中までになり、読めないまま捨てると、そのセッションが一瞬だけ終わったように見える。
 * 終わったと見ると、待っている問いを消してしまう（sessions/liveChange.ts）ので、1 回の読めなさでは消さない。
 * 読み直しのたびに同じものを渡す（RegistryWatcher が持つ）。
 */
export type RegistryCarry = Map<string, { raw: unknown; misses: number }>;

const UNREADABLE = Symbol('unreadable');

/** 登録 1 件を読む。読めなければ、覚えがあり上限の内なら前の中身を返す。ファイルが無くなったものは続けない。 */
function readEntry(file: string, name: string, carry: RegistryCarry | undefined): unknown {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    carry?.set(name, { raw, misses: 0 });
    return raw;
  } catch (e) {
    const prev = carry?.get(name);
    if (!prev || (e as NodeJS.ErrnoException).code === 'ENOENT' || prev.misses >= UNREADABLE_CARRY_POLLS) {
      carry?.delete(name);
      return UNREADABLE;
    }
    prev.misses += 1;
    return prev.raw;
  }
}

/**
 * ~/.claude/sessions/<pid>.json を読む。ファイルの出現と消失が起動と終了に対応する。
 * isGone が真を返す pid の項目は、消えたプロセスの残りとして読まない。hangar は ~/.claude のファイルを消さないので、読まないことで扱う。
 * onDrift を渡すと、形が契約と違う登録を、登録の見分け（compat/registry.ts の registryKey）と組で知らせる。読み方はいまのまま変えない。
 * オブジェクトでない登録（配列や null）は読まない。1 件の形が崩れても、ほかのセッションの状態は出し続ける。
 * carry を渡すと、書きかけで読めなかった登録を、前に読めた中身のまま続ける（RegistryCarry）。
 */
export function readRegistry(claudeDir: string, isGone: (pid: number) => boolean = () => false, onDrift?: (d: Drift, key: string) => void, carry?: RegistryCarry): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) { carry?.clear(); return []; }
  const out: LiveSession[] = [];
  const names = fs.readdirSync(dir);
  // 消えた登録の覚えは捨てる。同じ名前で書き直されたものを、前の中身で続けないためである。
  if (carry) { const now = new Set(names); for (const f of [...carry.keys()]) if (!now.has(f)) carry.delete(f); }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const raw = readEntry(path.join(dir, f), f, carry);
    // 書きかけの登録は JSON として読めない。これはずれではないので、黙って次の周期に回す。
    // 前に読めた中身があれば readEntry がそれを返すので、ここで飛ばすのは覚えの無いものと、読めないままが続いたものだけである。
    if (raw === UNREADABLE) continue;
    if (onDrift) { const key = registryKey(f, raw); for (const d of registryDrifts(raw)) onDrift(d, key); }
    if (!isRec(raw)) continue;
    const rec = raw;
    if (typeof rec.sessionId !== 'string') continue;
    if (typeof rec.pid === 'number' && isGone(rec.pid)) continue;
    // shell は、本体が休みで裏の Bash だけが動いていること。作業中のまま、裏だけの印を付ける（LiveAsideDto）。
    // 知らない値は作業中と読む。止めてよいかを誤るより、待たせるほうが害が小さい。
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    const l: LiveSession = { sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 };
    if (rec.status === 'shell') l.aside = { shell: true, agents: 0 };
    if (typeof rec.statusUpdatedAt === 'number' && Number.isFinite(rec.statusUpdatedAt)) l.statusAt = rec.statusUpdatedAt;
    // jobId が無いと `claude attach` に渡すものが無いので、bg と書いてあってもバックグラウンドとは扱わない。
    if (rec.kind === 'bg' && typeof rec.jobId === 'string' && rec.jobId !== '') l.background = { jobId: rec.jobId };
    if (typeof rec.procStart === 'string' && rec.procStart !== '') l.procStart = rec.procStart;
    if (typeof rec.entrypoint === 'string' && rec.entrypoint !== '') l.entrypoint = rec.entrypoint;
    out.push(l);
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

export class RegistryWatcher {
  private timer: NodeJS.Timeout | null = null;
  private last: LiveSession[] = [];
  private lastKey = '';
  /** 足し付けの前の登録の読み取りとずれの一覧の鍵。ずれを数え直すかを決める。 */
  private lastRegKey = '';
  /** 一瞬だけ欠けうる欄（status）を、同じ登録で続けて欠けていたときだけ通す門。 */
  private readonly missGate = new RegistryMissGate();
  /** 書きかけで読めなかった登録を、前に読めた中身で続けるための覚え（RegistryCarry）。 */
  private readonly carry: RegistryCarry = new Map();
  private listeners = new Set<(live: LiveSession[]) => void>();
  /**
   * enrich は、読んだ登録に裏だけの印などを足す関数（live/aside.ts）。読み直しのたびに通し、足した後の形で変化を見る。
   * 本文の索引が進んだだけでも印は変わるので、登録のファイルが変わらなくても次の周期で知らせられる。
   * compat は、形が契約と違う登録を受け取る口（provider/claude-code/compat/）。
   */
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500, private readonly isGone: (pid: number) => boolean = goneOn(process.platform), private readonly enrich: (live: LiveSession[]) => LiveSession[] = (l) => l, private readonly compat: CompatSink = NO_COMPAT) {}

  start(): void {
    this.poll(false);
    this.timer = setInterval(() => this.poll(true), this.intervalMs);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  current(): LiveSession[] { return this.last; }
  onChange(cb: (live: LiveSession[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  /** 最後に数えた登録を忘れる。ずれの記録が空になったとき、次の読み直しで残っている登録のずれを 1 回だけ数え直す。 */
  renoteDrifts(): void { this.lastRegKey = ''; }

  /**
   * 登録ディレクトリを読み直し、変わっていたら知らせる。
   * 読み取りが失敗しても投げない。setInterval の中なので、投げるとプロセスごと落ちる。
   * 次の周期でやり直せばよい。
   * ずれは、足し付け（enrich）の前の登録の読み取りと、ずれの一覧が変わったときだけ数える。
   * 500 ミリ秒ごとに同じ登録を読み直すたびに数えると、回数が意味を失う。
   * 足し付けの後の形では見ない。読み飛ばした登録は live に載らず、印だけが変わるときは登録は変わっていないからである。
   * status の欠けは、同じ登録で続けて 2 回の読み取りで欠けていたときに初めてずれの一覧に入る（compat/registry.ts の RegistryMissGate）。
   * Claude Code が登録を書き始めてから status を足すまでの間に 1 度読んだだけのものを数えないためである。
   */
  private poll(notify: boolean): void {
    let live: LiveSession[];
    let drifts: Drift[];
    let regKey: string;
    try {
      const found: { key: string; drift: Drift }[] = [];
      const raw = readRegistry(this.claudeDir, this.isGone, (drift, key) => found.push({ key, drift }), this.carry);
      drifts = this.missGate.pass(found);
      regKey = JSON.stringify(raw) + JSON.stringify(drifts);
      live = this.enrich(raw);
    } catch { return; }
    if (regKey !== this.lastRegKey) {
      this.lastRegKey = regKey;
      // 受け口が投げても、見張りのせいで登録の読み取りと通知を止めない。
      try { for (const d of drifts) this.compat.note(d); } catch { /* 見張りは振る舞いを変えない */ }
    }
    const key = JSON.stringify(live);
    if (key === this.lastKey) return;
    this.last = live; this.lastKey = key;
    if (notify) for (const cb of this.listeners) cb(live);
  }
}
