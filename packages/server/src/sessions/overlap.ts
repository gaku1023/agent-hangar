import type { LiveSessionDto, LiveStatus, OverlapFileDto, SessionOverlapDto } from '@agent-hangar/shared';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { EDIT_TOOLS } from '../indexer/write.ts';

/**
 * 同じファイルを 2 本のセッションが編集していることの警告（止めない）。
 *
 * 判定は次のとおりである。
 * - 実行中の 2 本が、間を N 分（OVERLAP_WINDOW_MS）以内に空けて同じパスを編集した（Edit、Write、MultiEdit、NotebookEdit。サブエージェントの編集も数える）。
 * - そのうえで、交互に書いた（先の側が後からまた書いた）か、後の側が書いた時点で先の側がまだ作業中だった（ターンを終えていない）。
 *   先の側がターンを終えてから後の側が直しただけなら、人が順に頼んだとみて出さない。
 * - 消えるのは、重なりを作った最後の編集から N 分経ったとき、どちらかが実行中でなくなったとき、「このファイルでは表示しない」にしたときである。
 * Bash で書き換えた分は索引にパスが無いので拾えない（画面の注記でその旨を言う）。
 *
 * 作業中だったかは、Claude の登録の状態の移り変わり（busy か waiting の間はターンの途中）から決める。サーバが起きる前の分は分からないので、作業中ではないとみる。
 */

/** 重なりとみる編集の間隔と、出しておく長さ（10 分）。 */
export const OVERLAP_WINDOW_MS = 10 * 60_000;
/** 見張りが索引を読み直す間隔。 */
export const OVERLAP_TICK_MS = 3000;

/** 編集 1 回。sessionId は hangar のセッションの id、at はミリ秒の時刻、path は NFC にそろえた絶対パスである。 */
export type OverlapEdit = { sessionId: string; path: string; at: number };
/** そのセッションが、その時刻に作業中（ターンの途中）だったか。 */
export type WorkingAt = (sessionId: string, at: number) => boolean;

/** 「このファイルでは表示しない」の鍵。2 つのセッションの id は小さい方を先に置く。 */
export const dismissKey = (a: string, b: string, path: string): string => (a < b ? `${a}\u0000${b}\u0000${path}` : `${b}\u0000${a}\u0000${path}`);

type Side = { sessionId: string; at: number };

/**
 * 2 本の同じパスへの編集から、重なりを作った編集の時刻（最新のもの）と、交互だったかを出す。重ならなければ null。
 * 編集を時刻の順に並べ、同じ側の続きを 1 つの塊にして、塊の切り替わりごとに見る。
 */
function pairOverlap(edits: Side[], working: WorkingAt, now: number): { at: number; alternating: boolean } | null {
  const sorted = [...edits].sort((x, y) => x.at - y.at);
  const blocks: { sessionId: string; first: number; last: number }[] = [];
  for (const e of sorted) {
    const b = blocks.at(-1);
    if (b && b.sessionId === e.sessionId) b.last = e.at;
    else blocks.push({ sessionId: e.sessionId, first: e.at, last: e.at });
  }
  let latest: number | null = null;
  let anyAlternating = false;
  for (let k = 1; k < blocks.length; k++) {
    const prev = blocks[k - 1]!;
    const cur = blocks[k]!;
    if (cur.first - prev.last > OVERLAP_WINDOW_MS) continue;
    // 交互：この切り替わりが、前の切り替わり（間が N 分以内）からの戻りである。
    const before = k >= 2 ? blocks[k - 2]! : null;
    const alternating = before !== null && prev.first - before.last <= OVERLAP_WINDOW_MS;
    if (!alternating && !working(prev.sessionId, cur.first)) continue;
    if (now - cur.first > OVERLAP_WINDOW_MS) continue;
    latest = latest === null ? cur.first : Math.max(latest, cur.first);
    anyAlternating ||= alternating;
  }
  return latest === null ? null : { at: latest, alternating: anyAlternating };
}

/**
 * 実行中のセッションの編集から、セッションごとの重なりを組む。重なりの無いセッションは入らない。
 * files は相手の最後の編集の新しい順、with はその順に並べた相手である。
 */
export function computeOverlaps(edits: OverlapEdit[], working: WorkingAt, dismissed: ReadonlySet<string>, now: number): Map<string, SessionOverlapDto> {
  const byPath = new Map<string, OverlapEdit[]>();
  for (const e of edits) {
    const list = byPath.get(e.path);
    if (list) list.push(e);
    else byPath.set(e.path, [e]);
  }
  const files = new Map<string, OverlapFileDto[]>();
  const push = (id: string, f: OverlapFileDto) => {
    const list = files.get(id);
    if (list) list.push(f);
    else files.set(id, [f]);
  };
  for (const [path, list] of byPath) {
    const ids = [...new Set(list.map((e) => e.sessionId))].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (dismissed.has(dismissKey(a, b, path))) continue;
        const pair = list.filter((e) => e.sessionId === a || e.sessionId === b);
        const hit = pairOverlap(pair, working, now);
        if (!hit) continue;
        const lastOf = (id: string) => Math.max(...pair.filter((e) => e.sessionId === id).map((e) => e.at));
        push(a, { path, with: b, mineAt: lastOf(a), theirsAt: lastOf(b), alternating: hit.alternating });
        push(b, { path, with: a, mineAt: lastOf(b), theirsAt: lastOf(a), alternating: hit.alternating });
      }
    }
  }
  const out = new Map<string, SessionOverlapDto>();
  for (const [id, list] of files) {
    list.sort((x, y) => y.theirsAt - x.theirsAt || x.path.localeCompare(y.path));
    out.set(id, { with: [...new Set(list.map((f) => f.with))], files: list });
  }
  return out;
}

/** 「このファイルでは表示しない」の印を付ける。組の向きによらない。 */
export function dismissOverlap(db: Db, sessionId: string, otherId: string, paths: string[], now: number): void {
  const [a, b] = sessionId < otherId ? [sessionId, otherId] : [otherId, sessionId];
  const ins = db.prepare('insert into overlap_dismissals (session_a, session_b, path, at) values (?, ?, ?, ?) on conflict do nothing');
  db.transaction(() => { for (const p of paths) ins.run(a, b, p.normalize('NFC'), now); })();
}

/** 状態の移り変わりを覚えておく長さ。判定は 2N 前の編集まで見るので、それより少し長く持つ。 */
const HISTORY_MS = 3 * OVERLAP_WINDOW_MS;

type Deps = { db: Db; live: () => readonly LiveSessionDto[]; now?: () => number };

/**
 * 同じファイルの編集の見張り。実行中のセッションの索引（event_index）を周期で読み、重なりの写しを session_overlaps に書く。
 * 写しが変わったセッションは名指し（touchRow）して、配る層に session.upsert を配らせる。
 * 状態の移り変わり（作業中だったか）は、登録の変化（noteLive）から覚える。
 */
export class OverlapWatch {
  /** Claude のセッション UUID ごとの、状態が変わった時刻の並び（古い順）。 */
  private readonly history = new Map<string, { status: LiveStatus; at: number }[]>();
  constructor(private readonly deps: Deps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 登録の一覧が変わった。状態の移り変わりを覚え、居なくなったものは忘れる。 */
  noteLive(live: readonly LiveSessionDto[]): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const l of live) {
      seen.add(l.sessionId);
      const list = this.history.get(l.sessionId) ?? [];
      if (list.at(-1)?.status !== l.status) list.push({ status: l.status, at: now });
      // 古い移り変わりは捨てる。最後の 1 つより前の、覚える長さより古いものだけを落とす。
      while (list.length > 1 && list[1]!.at < now - HISTORY_MS) list.shift();
      this.history.set(l.sessionId, list);
    }
    for (const id of [...this.history.keys()]) if (!seen.has(id)) this.history.delete(id);
  }

  /** 索引を読み、重なりの写しを書き直す。変わったセッションを名指しする。 */
  tick(): void {
    const { db } = this.deps;
    const now = this.now();
    const live = this.deps.live();
    const rows = live.length === 0 ? [] : db.prepare(`select id, provider_session_id p from sessions where provider = 'claude-code' and deleted_at is null and provider_session_id in (${live.map(() => '?').join(',')})`)
      .all(...live.map((l) => l.sessionId)) as { id: string; p: string }[];
    const uuidOf = new Map(rows.map((r) => [r.id, r.p]));
    let next = new Map<string, SessionOverlapDto>();
    if (rows.length >= 2) {
      const ids = rows.map((r) => r.id);
      const marks = EDIT_TOOLS.map(() => '?').join(',');
      const edits = (db.prepare(`select session_id, file_path, ts from event_index
        where session_id in (${ids.map(() => '?').join(',')}) and tool_name in (${marks}) and file_path is not null and ts is not null and ts >= ?`)
        .all(...ids, ...EDIT_TOOLS, now - 2 * OVERLAP_WINDOW_MS) as { session_id: string; file_path: string; ts: number }[])
        .map((r): OverlapEdit => ({ sessionId: r.session_id, path: r.file_path.normalize('NFC'), at: r.ts }));
      const dismissed = new Set((db.prepare('select session_a, session_b, path from overlap_dismissals').all() as { session_a: string; session_b: string; path: string }[])
        .map((r) => dismissKey(r.session_a, r.session_b, r.path)));
      next = computeOverlaps(edits, (id, at) => this.workingAt(uuidOf.get(id), at), dismissed, now);
    }
    this.write(next, now);
  }

  /** そのセッションが、その時刻にターンの途中（作業中か入力待ち）だったか。覚えていない時刻は偽にする。 */
  private workingAt(uuid: string | undefined, at: number): boolean {
    const list = uuid ? this.history.get(uuid) : undefined;
    if (!list) return false;
    let status: LiveStatus | null = null;
    for (const h of list) {
      if (h.at > at) break;
      status = h.status;
    }
    return status === 'busy' || status === 'waiting';
  }

  private write(next: Map<string, SessionOverlapDto>, now: number): void {
    const { db } = this.deps;
    const prev = new Map((db.prepare('select session_id, payload from session_overlaps').all() as { session_id: string; payload: string }[]).map((r) => [r.session_id, r.payload]));
    const changed: string[] = [];
    db.transaction(() => {
      for (const [id, dto] of next) {
        const payload = JSON.stringify(dto);
        if (prev.get(id) === payload) continue;
        db.prepare('insert into session_overlaps (session_id, payload, updated_at) values (?, ?, ?) on conflict(session_id) do update set payload = excluded.payload, updated_at = excluded.updated_at').run(id, payload, now);
        changed.push(id);
      }
      for (const id of prev.keys()) {
        if (next.has(id)) continue;
        db.prepare('delete from session_overlaps where session_id = ?').run(id);
        changed.push(id);
      }
    })();
    for (const id of changed) touchRow(db, 'sessions', id);
  }
}
