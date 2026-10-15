import fs from 'node:fs';
import path from 'node:path';
import { waitKindOf, type LiveStatus } from '@agent-hangar/shared';
import { Pacer } from '../../platform/pacer.ts';
import { isAlive } from '../../platform/proc.ts';
import type { LiveSession } from './types.ts';
import { RegistryMissGate, registryDrifts, registryKey, registryRef, registryStartedAt } from './compat/registry.ts';
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
 * 書きかけで読めなかった登録を、前に読めた中身のまま続ける長さ。
 * これを超えて読めないままなら、壊れた登録として読まない（いままでと同じ扱い）。
 * 0.6.0 までは読み直しの回数（500 ミリ秒ごとの 4 回）で数えていた。
 * 読み直しは見張りの知らせで続けて起きることも、待機中に間が空くこともあるので、時間で数える。
 */
export const UNREADABLE_CARRY_MS = 2000;

/**
 * 登録のファイル名ごとの、最後に読めた中身と、それから続けて読めなかった回数。
 * Claude Code は、一時のファイルからの改名に失敗すると、登録をその場で書き直す（切り詰めてから書く）。
 * Windows では、ほかのプロセスがファイルを開いているだけで改名が失敗しうる。
 * その間に読むと中身が空か途中までになり、読めないまま捨てると、そのセッションが一瞬だけ終わったように見える。
 * 終わったと見ると、待っている問いを消してしまう（sessions/liveChange.ts）ので、1 回の読めなさでは消さない。
 * 読み直しのたびに同じものを渡す（RegistryWatcher が持つ）。
 */
export type RegistryCarry = Map<string, { raw: unknown; since: number | null }>;

const UNREADABLE = Symbol('unreadable');

/** 登録 1 件を読む。読めなければ、覚えがあり上限の内なら前の中身を返す。ファイルが無くなったものは続けない。 */
function readEntry(file: string, name: string, carry: RegistryCarry | undefined, now: number): unknown {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    carry?.set(name, { raw, since: null });
    return raw;
  } catch (e) {
    const prev = carry?.get(name);
    if (!prev || (e as NodeJS.ErrnoException).code === 'ENOENT' || (prev.since !== null && now - prev.since >= UNREADABLE_CARRY_MS)) {
      carry?.delete(name);
      return UNREADABLE;
    }
    prev.since ??= now;
    return prev.raw;
  }
}

/**
 * ~/.claude/sessions/<pid>.json を読む。ファイルの出現と消失が起動と終了に対応する。
 * isGone が真を返す pid の項目は、消えたプロセスの残りとして読まない。hangar は ~/.claude のファイルを消さないので、読まないことで扱う。
 * onDrift を渡すと、形が契約と違う登録を、登録の見分け（compat/registry.ts の registryKey）と書かれた時刻（registryStartedAt）と組で知らせる。読み方はいまのまま変えない。
 * オブジェクトでない登録（配列や null）は読まない。1 件の形が崩れても、ほかのセッションの状態は出し続ける。
 * carry を渡すと、書きかけで読めなかった登録を、前に読めた中身のまま続ける（RegistryCarry）。now はその長さを数える時刻である。
 */
export function readRegistry(claudeDir: string, isGone: (pid: number) => boolean = () => false, onDrift?: (d: Drift, key: string, startedAt: number | null) => void, carry?: RegistryCarry, now: number = Date.now()): LiveSession[] {
  const dir = path.join(claudeDir, 'sessions');
  if (!fs.existsSync(dir)) { carry?.clear(); return []; }
  const out: LiveSession[] = [];
  const sockets = new Map<LiveSession, string>();
  const names = fs.readdirSync(dir);
  // 消えた登録の覚えは捨てる。同じ名前で書き直されたものを、前の中身で続けないためである。
  if (carry) { const present = new Set(names); for (const f of [...carry.keys()]) if (!present.has(f)) carry.delete(f); }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    const raw = readEntry(path.join(dir, f), f, carry, now);
    // 書きかけの登録は JSON として読めない。これはずれではないので、黙って次の周期に回す。
    // 前に読めた中身があれば readEntry がそれを返すので、ここで飛ばすのは覚えの無いものと、読めないままが続いたものだけである。
    if (raw === UNREADABLE) continue;
    if (onDrift) { const key = registryKey(f, raw); const at = registryStartedAt(raw); for (const d of registryDrifts(raw)) onDrift(d, key, at); }
    if (!isRec(raw)) continue;
    const rec = raw;
    if (typeof rec.sessionId !== 'string') continue;
    if (typeof rec.pid === 'number' && isGone(rec.pid)) continue;
    // shell は、本体が休みで裏の Bash だけが動いていること。作業中のまま、裏だけの印を付ける（LiveAsideDto）。
    // 知らない値は作業中と読む。止めてよいかを誤るより、待たせるほうが害が小さい。
    const status = STATUSES.has(rec.status as LiveStatus) ? (rec.status as LiveStatus) : 'busy';
    const l: LiveSession = { sessionId: rec.sessionId, status, name: typeof rec.name === 'string' ? rec.name : null, nameSource: typeof rec.nameSource === 'string' ? rec.nameSource : null, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', pid: typeof rec.pid === 'number' ? rec.pid : 0 };
    if (rec.status === 'shell') l.aside = { shell: true, agents: 0 };
    // 何を待っているか（許可、問い、そのほか）。入力待ちの間だけ写す。Claude は抜けた後も値を残すことがある。
    const waitingFor = status === 'waiting' ? waitKindOf(rec.waitingFor) : null;
    if (waitingFor) l.waitingFor = waitingFor;
    if (typeof rec.statusUpdatedAt === 'number' && Number.isFinite(rec.statusUpdatedAt)) l.statusAt = rec.statusUpdatedAt;
    // jobId が無いと `claude attach` に渡すものが無いので、bg と書いてあってもバックグラウンドとは扱わない。
    if (rec.kind === 'bg' && typeof rec.jobId === 'string' && rec.jobId !== '') l.background = { jobId: rec.jobId };
    if (typeof rec.procStart === 'string' && rec.procStart !== '') l.procStart = rec.procStart;
    if (typeof rec.entrypoint === 'string' && rec.entrypoint !== '') l.entrypoint = rec.entrypoint;
    if (l.name) l.address = l.name;
    if (l.name && typeof rec.messagingSocketPath === 'string' && rec.messagingSocketPath !== '') sockets.set(l, rec.messagingSocketPath);
    out.push(l);
  }
  // 同じ名前が 2 つ以上あると、名前だけでは SendMessage の相手が決まらない。ListAgents と同じ [ref] を添える。
  const count = new Map<string, number>();
  for (const l of out) if (l.name) count.set(l.name, (count.get(l.name) ?? 0) + 1);
  for (const [l, sock] of sockets) if ((count.get(l.name!) ?? 0) > 1) l.address = `${l.name} [${registryRef(sock)}]`;
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** ディレクトリの見張り。変わったら event、見張りが壊れたら error を呼ぶ。見張れなければ null を返す。 */
export type WatchDir = (dir: string, event: () => void, error: () => void) => { close(): void } | null;

/**
 * fs.watch で登録のディレクトリを見張る（macOS は FSEvents、Windows は ReadDirectoryChangesW、Linux は inotify）。
 * ディレクトリが無いと見張れないので null を返す。persistent を切り、見張りだけのためにプロセスを生かさない。
 */
export const watchDir: WatchDir = (dir, event, error) => {
  let w: fs.FSWatcher;
  try {
    w = fs.watch(dir, { persistent: false }, () => event());
  } catch {
    return null;
  }
  w.on('error', () => error());
  return { close: () => { try { w.close(); } catch { /* 閉じ損ねても読み直しは続く */ } } };
};

/**
 * 見張りの知らせから読み直すまで待つ長さ。
 * Claude Code は登録を一時のファイルに書いてから改名するので、知らせは続けて 2 つ以上来る。それを 1 回の読み直しにまとめる。
 * 入力待ちになってからデスクトップ通知が出るまでの遅れは、見張りが効いている間はこの長さで済む。
 */
export const WATCH_SETTLE_MS = 50;

/** 待機中の周期（RegistryWatcher の pace）。idleMs は、見張れていて作業中が 1 つも無い間の読み直しの間隔である。 */
export type RegistryPace = { idleMs: number; watch?: WatchDir };

export class RegistryWatcher {
  private pacer: Pacer | null = null;
  private watcher: { close(): void } | null = null;
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
   * pace を渡すと、登録のディレクトリを見張り、見張れていて作業中が 1 つも無い間は pace.idleMs ごとにしか読まない（2026-10-14、0.6.1）。
   * 変化は見張りの知らせで拾う。作業中があれば、裏だけの印のために intervalMs ごとに読む。見張れない間も intervalMs ごとに読む。
   * pace を省けば、いままでどおり intervalMs ごとに読む。
   */
  constructor(private readonly claudeDir: string, private readonly intervalMs = 500, private readonly isGone: (pid: number) => boolean = goneOn(process.platform), private readonly enrich: (live: LiveSession[]) => LiveSession[] = (l) => l, private readonly compat: CompatSink = NO_COMPAT, private readonly pace?: RegistryPace) {}

  start(): void {
    if (this.pacer) return;
    // 最初の読み直しが見張りを付ける。
    this.poll(false);
    this.pacer = new Pacer({
      run: () => this.poll(true),
      fastMs: this.intervalMs,
      slowMs: this.pace?.idleMs ?? this.intervalMs,
      fast: () => !this.watcher || this.last.some((l) => l.status === 'busy'),
      onError: () => { /* poll は投げない。念のため、投げても周期を止めない */ },
    });
    this.pacer.start();
  }
  stop(): void {
    this.pacer?.stop();
    this.pacer = null;
    this.detach();
  }
  current(): LiveSession[] { return this.last; }
  onChange(cb: (live: LiveSession[]) => void): () => void { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  /** 最後に数えた登録を忘れる。ずれの記録が空になったとき、次の読み直しで残っている登録のずれを 1 回だけ数え直す。 */
  renoteDrifts(): void { this.lastRegKey = ''; }
  /**
   * 次の読み直しを ms 後へ繰り上げる（省けばいまの周期の後）。
   * 登録のファイルの外で、足し付けの結果が変わったとき（hook から許可の中身が届いたとき）に呼ぶ。
   */
  kick(ms?: number): void { this.pacer?.kick(ms); }

  /** 見張りを付ける。見張れなければ付けないまま、速い周期で読み、次の読み直しで付け直す。 */
  private attach(): void {
    if (this.watcher || !this.pace?.watch) return;
    this.watcher = this.pace.watch(
      path.join(this.claudeDir, 'sessions'),
      () => this.pacer?.kick(WATCH_SETTLE_MS),
      () => { this.detach(); this.pacer?.kick(); },
    );
  }
  private detach(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  /**
   * 登録ディレクトリを読み直し、変わっていたら知らせる。
   * 読み取りが失敗しても投げない。タイマーの中なので、投げるとプロセスごと落ちる。
   * 次の周期でやり直せばよい。
   * ずれは、足し付け（enrich）の前の登録の読み取りと、ずれの一覧が変わったときだけ数える。
   * 周期ごとに同じ登録を読み直すたびに数えると、回数が意味を失う。
   * 足し付けの後の形では見ない。読み飛ばした登録は live に載らず、印だけが変わるときは登録は変わっていないからである。
   * status の欠けは、登録が書かれてから猶予（5 秒）を過ぎても欠けているときに初めてずれの一覧に入る（compat/registry.ts の RegistryMissGate）。
   * Claude Code が登録を書き始めてから status を足すまでの間に読んだものを、読み取りが何回重なっても数えないためである。
   */
  private poll(notify: boolean): void {
    this.attach();
    let live: LiveSession[];
    let drifts: Drift[];
    let regKey: string;
    try {
      const now = Date.now();
      const found: { key: string; drift: Drift; startedAt: number | null }[] = [];
      const raw = readRegistry(this.claudeDir, this.isGone, (drift, key, startedAt) => found.push({ key, drift, startedAt }), this.carry, now);
      drifts = this.missGate.pass(found, now);
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
