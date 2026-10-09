import type { ConfigSyncDto, LiveSessionDto, ServerEvent } from '@agent-hangar/shared';
import { getArtifact } from '../artifacts/queries.ts';
import { onRowChange, settleRowChanges, type RowChange, type RowOrigin } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { getProject, getSession, listDevices } from '../db/queries.ts';
import { memoFromDb } from '../projects/memo.ts';
import { listTodos } from '../projects/todos.ts';

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
 * 行のイベント（下の `RowEvent`）は `broadcast` では受けない。組むのはこの層だけである。
 * 行は書いていないが中身が変わった（実行中の一覧が動いた、手元だけの表を書いた）ときは、呼び手は `touchRow` でその行を名指しする。
 */

/** この層だけが組む、行のイベント。 */
export type RowEvent = Extract<ServerEvent, { type: 'session.upsert' | 'project.upsert' | 'devices.update' | 'memo.update' | 'artifact.upsert' | 'todos.update' | 'config.update' }>;
/** 呼び手が `broadcast` で渡せる知らせ。表の変化に対応しないものだけである。 */
export type NoticeEvent = Exclude<ServerEvent, RowEvent>;

/** DTO を組むのに要るもの。 */
type Ctx = { db: Db; deviceId: string; live: () => LiveSessionDto[]; configSync: () => ConfigSyncDto | null };

/**
 * 配るイベントの種類。行のイベントは、種類と ID の組（鍵）で 1 つに畳む。
 * 行を読み直してイベントを組む。行が無い（消えた）ときは null を返し、何も配らない。
 */
type Kind = (ctx: Ctx, id: string) => RowEvent | null;

const KINDS = {
  // ロックを出すために自端末の ID を渡す。渡さないと他端末の run が一切見えない。
  session: (ctx, id) => { const s = getSession(ctx.db, ctx.live(), id, { deviceId: ctx.deviceId }); return s ? { type: 'session.upsert', session: s } : null; },
  project: (ctx, id) => { const p = getProject(ctx.db, ctx.deviceId, ctx.live(), id); return p ? { type: 'project.upsert', project: p } : null; },
  // 端末は一覧ごと配るので、ID は持たない。
  devices: (ctx) => ({ type: 'devices.update', devices: listDevices(ctx.db, ctx.deviceId) }),
  memo: (ctx, id) => { const m = memoFromDb(ctx.db, id); return m ? { type: 'memo.update', memo: m } : null; },
  artifact: (ctx, id) => { const a = getArtifact(ctx.db, id); return a ? { type: 'artifact.upsert', artifact: a } : null; },
  // TODO はプロジェクトの一覧ごと配るので、ID はプロジェクトのものである。
  todos: (ctx, id) => ({ type: 'todos.update', projectId: id, todos: listTodos(ctx.db, id) }),
  // 設定の同期（作り直した実装）の状態は 1 つなので、ID は持たない。同期を設定していない端末では組めないので、何も配らない。
  configSync: (ctx) => { const d = ctx.configSync(); return d ? { type: 'config.update', configSync: d } : null; },
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
 * ここに無い表（run_tabs、artifact_versions、手元だけの表）の知らせは、何も配らない。
 */
const TABLES: Record<string, TableRule> = {
  sessions: { to: self('session') },
  session_summaries: { to: self('session') },
  session_states: { to: self('session') },
  // 名前とメモは SessionDto に載る。この端末の書き込みも、同期で降りた行も配る。
  session_notes: { to: self('session') },
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
  // ルートの行は、そのプロジェクトの DTO（この端末のパスと、解決しているか、場所が無いものの内訳）に載る。
  // この端末のルートが未解決になった書き込みも、project.upsert で配る。ホームの帯の件数と、プロジェクトの一覧の札は、それで変わる。
  // 遷移の知らせ project.unresolved は、ルートの確かめ（projects/rootCheck.ts の checkRoots）が別に出す。画面はそれでダイアログを開かない（設計書 2.11.5）。
  project_roots: {
    to: (c, ctx) => {
      const r = ctx.db.prepare('select project_id from project_roots where id = ?').get(c.rowId) as { project_id: string } | undefined;
      return r ? [['project', r.project_id]] : [];
    },
  },
  devices: { to: () => [['devices', '']] },
  // 設定の同期。束の行（他の PC から降りたもの、この PC が書いたもの）と、状態を動かした名指し（config_state。基準、送らなかった項目、適用の指示書、スイッチ）。
  config_snapshots: { to: () => [['configSync', '']] },
  config_state: { to: () => [['configSync', '']] },
  // メモの頭は ProjectDto にも載る（memoHead）ので、プロジェクトも配り直す。
  // 同期で降りたメモとアーティファクトは、今の画面では配っていない。その振る舞いを変えないよう、この端末の変化だけにしてある。
  project_memos: { from: LOCAL, to: (c) => [['memo', c.rowId], ['project', c.rowId]] },
  artifacts: { from: LOCAL, to: self('artifact') },
  // 未完の数は ProjectDto にも載る（openTodoCount）ので、プロジェクトも配り直す。消した行も残っているので、プロジェクトは引ける。
  // 同期で降りた TODO は、メモと同じく、今の画面では配っていない。
  todos: {
    from: LOCAL,
    to: (c, ctx) => {
      const r = ctx.db.prepare('select project_id p from todos where id = ?').get(c.rowId) as { p: string } | undefined;
      return r ? [['todos', r.p], ['project', r.p]] : [];
    },
  },
};

const keyOf = (kind: KindName, id: string): string => `${kind}\u0000${id}`;

/** 列に並ぶもの。呼び手が渡した知らせか、tick の終わりに組む行。dead は、後から同じ行が知らされて並び直したもの。 */
type Item =
  | { ev: NoticeEvent }
  | { kind: KindName; id: string; key: string; dead: boolean };

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
  /** 設定の同期の状態の組み方。同期を組んだ後（boot/sync.ts）に渡される。それまでは何も配らない。 */
  private configSync: () => ConfigSyncDto | null = () => null;
  private queue: Item[] = [];
  /** いまの列に並んでいる行。鍵から、その並びを引く。 */
  private rows = new Map<string, Extract<Item, { key: string }>>();
  private scheduled = false;
  private off: (() => void) | null;

  constructor(private readonly deps: PublisherDeps) {
    this.off = onRowChange((c) => { if (c.db === deps.db) this.onRow(c); });
  }

  /** 設定の同期の状態の組み方を渡す。組み立ての順で、配る層のほうが先にできるので、後から渡す。 */
  setConfigSync(read: () => ConfigSyncDto | null): void { this.configSync = read; }

  /** 行の変化を受ける。配る先を決めて列に並べる。DTO はここでは組まない。 */
  private onRow(c: RowChange): void {
    const rule = TABLES[c.table];
    if (!rule || (rule.from && !rule.from.includes(c.origin))) return;
    for (const [kind, id] of rule.to(c, { ...this.deps, configSync: this.configSync })) {
      const key = keyOf(kind, id);
      // 同じ行がもう並んでいれば、最後に知らされた位置へ並び直す。配るのは 1 回のままである。
      const cur = this.rows.get(key);
      if (cur) cur.dead = true;
      const item = { kind, id, key, dead: false };
      this.rows.set(key, item);
      this.queue.push(item);
    }
    this.schedule();
  }

  /**
   * 表の変化に対応しない知らせを渡す。EventHub と同じ形なので、hub を受け取る部品へそのまま渡せる。
   * 行のイベント（session.upsert など）は受けない（型で断る）。この層が組む分と二重になるからである。
   */
  broadcast(ev: NoticeEvent): void {
    if (!this.off) return;
    this.queue.push({ ev });
    this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /**
   * 溜めた分を、並んだ順に配る。ふだんは tick の終わりに自分で呼ぶ。閉じる前と試験からは、直に呼べる。
   */
  flush(): void {
    this.scheduled = false;
    if (!this.off) return;
    // トランザクションの中の書き込みは、確定の後のマイクロタスクまで知らせが遅れる。
    // 先にそれを受け取っておき、同じ tick の変化をこの 1 回にまとめる。
    settleRowChanges(this.deps.db);
    const queue = this.queue;
    this.queue = [];
    this.rows = new Map();
    this.scheduled = false;
    const active = this.deps.active ? this.deps.active() : true;
    for (const it of queue) {
      try {
        if ('ev' in it) { this.deps.hub.broadcast(it.ev); continue; }
        if (it.dead || !active) continue;
        const ev = KINDS[it.kind]({ ...this.deps, configSync: this.configSync }, it.id);
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
