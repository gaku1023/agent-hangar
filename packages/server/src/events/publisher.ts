import type { LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { getArtifact } from '../artifacts/queries.ts';
import { onRowChange, rowChangeClock, settleRowChanges, type RowChange, type RowOrigin } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listDevices } from '../db/queries.ts';
import { memoFromDb } from '../projects/memo.ts';

/**
 * DB の行の変化を、画面へのイベントにして配る 1 層。
 *
 * 書いた側は行の変化の口（db/notify.ts）へ「どの表のどの行が変わったか」を知らせるだけで、DTO を組まず、hub にも触れない。
 * この層がその知らせを受け、表名と主キーから行を読み直して DTO を組み、hub へ渡す。
 * この端末の書き込みも、同期で降りた行も、同じ道を通る。
 *
 * - 同じ tick の中で同じ行が何度変わっても、配るのは 1 回である。組むのは tick の終わり（マイクロタスク）なので、中身は最後の状態になる。
 * - ロックの判定に要る端末の ID は、ここで 1 回だけ渡す。呼び手ごとに渡していた頃は、渡し忘れるとロックの無い行が配られた。
 * - 表からイベントへの対応は下の `TABLES` の 1 つの表にある。表を足すときは、そこへ 1 行を足す。
 *
 * 表の変化に対応しない知らせ（トースト、run の起動と終了、索引の進み、同期の状態など）は、呼び手が `broadcast` で渡す。
 * それらも同じ列に並べて tick の終わりに渡すので、行のイベントとの前後は呼んだ順のまま保たれる。
 */

/** DTO を組むのに要るもの。 */
type Ctx = { db: Db; deviceId: string; live: () => LiveSessionDto[] };

/**
 * 配るイベントの種類。行のイベントは、種類と ID の組（鍵）で 1 つに畳む。
 * `build` は行を読み直してイベントを組む。行が無い（消えた）ときは null を返し、何も配らない。
 * `idOf` は、呼び手が手で配ったイベントがこの種類なら、その ID を返す。同じ行の二重の配りを見分けるのに使う。
 */
type Kind = {
  build: (ctx: Ctx, id: string) => ServerEvent | null;
  idOf: (ev: ServerEvent) => string | null;
};

const KINDS = {
  session: {
    // ロックを出すために自端末の ID を渡す。渡さないと他端末の run が一切見えない。
    build: (ctx, id) => { const s = getSession(ctx.db, ctx.live(), id, { deviceId: ctx.deviceId }); return s ? { type: 'session.upsert', session: s } : null; },
    idOf: (ev) => (ev.type === 'session.upsert' ? ev.session.id : null),
  },
  project: {
    build: (ctx, id) => { const p = getProject(ctx.db, ctx.deviceId, ctx.live(), id); return p ? { type: 'project.upsert', project: p } : null; },
    idOf: (ev) => (ev.type === 'project.upsert' ? ev.project.id : null),
  },
  // 端末は一覧ごと配るので、ID は持たない。
  devices: {
    build: (ctx) => ({ type: 'devices.update', devices: listDevices(ctx.db, ctx.deviceId) }),
    idOf: (ev) => (ev.type === 'devices.update' ? '' : null),
  },
  memo: {
    build: (ctx, id) => { const m = memoFromDb(ctx.db, id); return m ? { type: 'memo.update', memo: m } : null; },
    idOf: (ev) => (ev.type === 'memo.update' ? ev.memo.projectId : null),
  },
  artifact: {
    build: (ctx, id) => { const a = getArtifact(ctx.db, id); return a ? { type: 'artifact.upsert', artifact: a } : null; },
    idOf: (ev) => (ev.type === 'artifact.upsert' ? ev.artifact.id : null),
  },
} satisfies Record<string, Kind>;

type KindName = keyof typeof KINDS;
/** 配る先。種類と、その ID。 */
type Target = [kind: KindName, id: string];

/**
 * 表ごとの決まり。`to` は、変わった行から配る先を返す。
 * `from` を書いた表は、その出どころの知らせだけを配る。書かなければ、どの出どころでも配る。
 */
type TableRule = {
  from?: readonly RowOrigin[];
  to: (c: RowChange, ctx: Ctx) => Target[];
};

const self = (kind: KindName) => (c: RowChange): Target[] => [[kind, c.rowId]];
/** この端末の変化だけを配る（書き込みと、書き込みを伴わない知らせ）。 */
const LOCAL: readonly RowOrigin[] = ['write', 'touch'];

/**
 * 表からイベントへの対応。画面へ配る表を足すときは、ここへ 1 行を足す。
 * ここに無い表（run_tabs、todos、artifact_versions、手元だけの表）の知らせは、何も配らない。
 * todos は、HTTP と MCP の経路がまだ手で配っている。その手書きを外すときに、ここへ足す。
 */
const TABLES: Record<string, TableRule> = {
  sessions: { to: self('session') },
  session_summaries: { to: self('session') },
  session_states: { to: self('session') },
  // SessionDto が runs から読むのは、他端末の生きた run（ロック）である。それが動くのは同期で降りたときだけなので、そのときだけ配る。
  // この端末の run の変化は、run.started、run.upsert、run.ended の明示のイベントが運ぶ。
  runs: {
    from: ['apply'],
    to: (c, ctx) => {
      const r = ctx.db.prepare('select session_id s from runs where id = ?').get(c.rowId) as { s: string } | undefined;
      return r ? [['session', r.s]] : [];
    },
  },
  projects: { to: self('project') },
  // ルートの行は、そのプロジェクトの DTO（この端末のパスと、解決しているか）に載る。
  // この端末のルートが未解決になった書き込みだけは、ここでは配らない。
  // それを書くのはルートの確かめ（checkProjectRoots）で、解決済みから未解決へ移ったときである。
  // そのときは呼び手（server.ts の checkRoots）が project.unresolved を手で渡す。画面はそれで置き場の選び直しを開くので、遷移を知っている側だけが出す。
  // 同期で降りた行と名指しは遷移ではないので、未解決のままでも project.upsert にする。
  project_roots: {
    to: (c, ctx) => {
      const r = ctx.db.prepare('select project_id, device_id, resolved, deleted_at from project_roots where id = ?').get(c.rowId) as { project_id: string; device_id: string; resolved: number; deleted_at: number | null } | undefined;
      if (!r) return [];
      if (c.origin === 'write' && r.device_id === ctx.deviceId && r.resolved === 0 && r.deleted_at === null) return [];
      return [['project', r.project_id]];
    },
  },
  devices: { to: () => [['devices', '']] },
  // メモの頭は ProjectDto にも載る（memoHead）ので、プロジェクトも配り直す。
  // 同期で降りたメモとアーティファクトは、今の画面では配っていない。その振る舞いを変えないよう、この端末の変化だけにしてある。
  project_memos: { from: LOCAL, to: (c) => [['memo', c.rowId], ['project', c.rowId]] },
  artifacts: { from: LOCAL, to: self('artifact') },
};

const keyOf = (kind: KindName, id: string): string => `${kind}\u0000${id}`;

/** 手で配られたイベントが行のイベントなら、その鍵を返す。 */
function explicitKey(ev: ServerEvent): string | null {
  for (const name of Object.keys(KINDS) as KindName[]) {
    const id = KINDS[name].idOf(ev);
    if (id !== null) return keyOf(name, id);
  }
  return null;
}

/** 列に並ぶもの。呼び手が渡したイベントか、tick の終わりに組む行。dead は、後から同じ行が知らされて並び直したもの。 */
type Item =
  | { ev: ServerEvent; /** 渡された時点までに起きていた行の変化の通し番号。 */ at: number }
  | { kind: KindName; id: string; key: string; /** この行の最後の変化の通し番号。 */ at: number; dead: boolean };

export type PublisherDeps = {
  db: Db;
  /** この端末の ID。ロックの判定と、この端末のルートの見分けに使う。 */
  deviceId: string;
  live: () => LiveSessionDto[];
  hub: { broadcast(ev: ServerEvent): void };
  /** 受け手がいるか。いなければ行を読み直さない（起動時の全走査で、誰も受けない DTO を組まないため）。省けば常にいるものとする。 */
  active?: () => boolean;
};

export class Publisher {
  private queue: Item[] = [];
  /** いまの列に並んでいる行。鍵から、その並びを引く。 */
  private rows = new Map<string, Extract<Item, { key: string }>>();
  private scheduled = false;
  private off: (() => void) | null;

  constructor(private readonly deps: PublisherDeps) {
    this.off = onRowChange((c) => { if (c.db === deps.db) this.onRow(c); });
  }

  /** 行の変化を受ける。配る先を決めて列に並べる。DTO はここでは組まない。 */
  private onRow(c: RowChange): void {
    const rule = TABLES[c.table];
    if (!rule || (rule.from && !rule.from.includes(c.origin))) return;
    for (const [kind, id] of rule.to(c, this.deps)) {
      const key = keyOf(kind, id);
      // 同じ行がもう並んでいれば、最後に知らされた位置へ並び直す。配るのは 1 回のままである。
      // 変化の順番は、起きたのが最も後のものを持つ（知らせは起きた順に届くとは限らない）。
      const cur = this.rows.get(key);
      if (cur) cur.dead = true;
      const item = { kind, id, key, at: Math.max(c.at, cur?.at ?? 0), dead: false };
      this.rows.set(key, item);
      this.queue.push(item);
    }
    this.schedule();
  }

  /**
   * 表の変化に対応しない知らせを渡す。EventHub と同じ形なので、hub を受け取る部品へそのまま渡せる。
   * 行のイベント（session.upsert など）を手で渡してもよい。その行の最後の書き込みより後に渡されたものなら、同じ tick にこの層が同じ行を重ねて配ることはしない。
   */
  broadcast(ev: ServerEvent): void {
    if (!this.off) return;
    this.queue.push({ ev, at: rowChangeClock() });
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /**
   * 溜めた分を配る。ふだんは tick の終わりに自分で呼ぶ。閉じる前と試験からは、直に呼べる。
   *
   * 呼び手が同じ行のイベントを、その行の最後の変化より後に手で配っていた tick では、この層の分は出さない。
   * HTTP と MCP の経路がまだ手で配っているあいだ、同じ行が二重に届かないようにするためである。
   * 手で配られた方は、数も中身もそのまま渡す。
   * 手で配られた後に同じ行がまた変わっていたら、手の分は古いので、この層も最新の中身を配る（2 つ届くが、最後に届くのは最新である）。
   * 前後は並びではなく、変化の通し番号で比べる。トランザクションの中の変化は知らせが遅れて届くので、並びでは前後が分からない。
   */
  flush(): void {
    this.scheduled = false;
    if (!this.off) return;
    // トランザクションの中の書き込みは、確定の後のマイクロタスクまで知らせが遅れる。
    // 先にそれを受け取っておかないと、手の配りだけが先に出て、遅れて来た知らせでもう 1 回配ってしまう。
    settleRowChanges(this.deps.db);
    const queue = this.queue;
    this.queue = [];
    this.rows = new Map();
    this.scheduled = false;
    // 鍵ごとに、最後に手で配られた時点。
    const explicit = new Map<string, number>();
    for (const it of queue) {
      if (!('ev' in it)) continue;
      const key = explicitKey(it.ev);
      if (key !== null) explicit.set(key, Math.max(it.at, explicit.get(key) ?? 0));
    }
    const active = this.deps.active ? this.deps.active() : true;
    for (const it of queue) {
      try {
        if ('ev' in it) { this.deps.hub.broadcast(it.ev); continue; }
        if (it.dead || (explicit.get(it.key) ?? -1) >= it.at || !active) continue;
        const ev = KINDS[it.kind].build(this.deps, it.id);
        if (ev) this.deps.hub.broadcast(ev);
      } catch (e) {
        // 1 つの行が読めなくても、残りは配る。
        console.error('[publisher]', 'ev' in it ? it.ev.type : it.kind, e instanceof Error ? e.message : e);
      }
    }
  }

  /** 購読を外し、溜めた分を捨てる。以後は何も配らない。DB を閉じる前に呼ぶ。 */
  stop(): void {
    this.off?.();
    this.off = null;
    this.queue = [];
    this.rows = new Map();
  }
}
