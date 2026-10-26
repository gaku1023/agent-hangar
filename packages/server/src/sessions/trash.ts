import fs from 'node:fs';
import path from 'node:path';
import { touchRow } from '../db/notify.ts';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { MessageError, msg, type Message } from '../i18n/message.ts';
import { forgetTranscriptFile } from '../indexer/indexFile.ts';
import { stmt } from '../indexer/statements.ts';
import { isStrictlyUnder } from '../platform/paths.ts';
import type { TrashFn } from '../platform/trash.ts';
import { isAgentKind, isSafeKeyId } from '@agent-hangar/shared';
import { AGENT_SYNC, isExportAgent } from '../sync/agentSync.ts';
import { mangleCwd } from '../provider/claude-code/transcript/discover.ts';
import { setSessionTrashed } from './states.ts';

/**
 * セッションの削除（docs/design.md の「セッションの削除」）。
 *
 * 削除は利用者が決めることなので、印は session_states.trashed_at に置く（版 25）。
 * 本文（主線の jsonl と、隣の `<uuid>/` のサブエージェントの本文）は OS のゴミ箱へ移し、rm はしない（platform/trash.ts）。
 * 移せなかったら何も変えない。移せたら印を書き、sessions の行を論理削除する。
 *
 * 印を受け取った PC は、次の回（applyMarks）で同じことをする。
 * - その PC が本文の持ち主（手元に本文がある）なら、ゴミ箱へ移す。その PC で実行中なら、止まるまで待つ。
 * - hangar が降ろした写し（~/.agent-hangar/remote の下）は hangar の持ち物なので、ゴミ箱を通さずに消す。
 * 起きていなかった PC は、起きて印を受け取った後の回で同じことをする。
 *
 * 生き返らないように、同期の取り込み（sync/apply.ts）は、印のあるセッションの sessions の行を論理削除のまま保つ（alignSessionTrash）。
 * 印は明示の復元でしか外れない。印の無い session_states の行が後勝ちで届いても、restored_at が印より新しくなければ印を保つ（版 27）。
 * 戻した後に、戻す前の印を持つ行が届いても、印は restored_at 以下なので付き直らない（sync/apply.ts の mergeTrash）。
 * 索引（indexer/write.ts）は、論理削除したセッションの本文を掘り起こさない。
 *
 * ゴミ箱へ移す本文の元のパスは、移す前に端末ローカルの trashed_transcripts に控え、移せなかったら取り消す（版 26）。
 * 移した後の DB の書き込みで転んでも、控えが残るので、利用者がゴミ箱から戻せば元に戻る。
 * 同じパスに主線の本文が戻ってきたら、印と論理削除を外して索引し直す（checkRestores）。復元は同期でほかの PC にも届く。
 *
 * opencode の会話の本文は opencode の記録の置き場にあり、hangar は消さない（ゴミ箱へ移せるファイルが無い）。
 * hangar の持ち物である、同期のための書き出し（`~/.agent-hangar/opencode/export/<会話>.json`）と、降ろした写し（`remote/<PC>/opencode/<会話>.json`）は消す。
 * 索引に写した本文（agent_events）と、その索引と検索も片付ける。日別の使用量は Claude と同じく残す。
 */

/** 削除の誤り。status は HTTP の応答の番号で、message はトーストにそのまま出せる一文である。 */
export class DeleteError extends MessageError {
  constructor(readonly status: 404 | 409 | 500, text: Message) {
    super(text);
    this.name = 'DeleteError';
  }
}

export type SessionTrashDeps = {
  db: Db;
  deviceId: string;
  /** Claude Code の置き場。索引に本文の行が無いときに、cwd から本文の場所を引くのに使う。 */
  claudeDir: string;
  /** hangar が他の PC から降ろした本文の置き場（~/.agent-hangar/remote）。この下は hangar の持ち物なので、ゴミ箱を通さずに消す。 */
  remoteRoot: string;
  /** opencode の会話の同期のための書き出しの置き場（~/.agent-hangar/opencode/export）。hangar の持ち物なので、ゴミ箱を通さずに消す。省けば見ない。 */
  opencodeExportDir?: string;
  /** ゴミ箱へ移す口（platform/trash.ts の moveToTrash）。試験が差し替える。 */
  trash: TrashFn;
  /** そのセッションがどこかの PC で動いているか（runs/announce.ts の sessionRunsAnywhere）。消すときに断る。 */
  runsAnywhere: (sessionId: string) => boolean;
  /** そのセッションがこの PC で動いているか。印を受け取ったとき、動いていれば止まるまで待つ。 */
  runsHere: (sessionId: string) => boolean;
  /** この PC で復元した。索引に全件走査を頼む（本文の索引は削除のときに片付けてある）。 */
  onRestored?: (sessionId: string) => void;
  /** ほかの PC で復元された。消した写しを降ろし直してもらう（sync/puller.ts）。引数は Claude Code のセッション ID。 */
  onRestoredElsewhere?: (providerSessionId: string) => void;
  /** 記録に残す口。省けば console.error。 */
  log?: (message: string) => void;
  now?: () => number;
};

type SessionFacts = { id: string; provider: string; provider_session_id: string; cwd: string; project_id: string | null; deleted_at: number | null };
type Target = { path: string; kind: 'file' | 'dir' };
/** 印を処理する 1 件。 */
type MarkRow = { id: string; t: number };

/**
 * Claude Code のセッション ID の形。provider_session_id は同期で届くので、本文のパスを組む前にこの形かを見る。
 * 空や `..` のような値でパスを組むと、本文の置き場のフォルダごとゴミ箱へ移しかねない。合わなければ対象なしにする。
 */
const SESSION_UUID = /^[0-9a-f-]{36}$/i;

/** LIKE の型の中で、文字どおりに読ませたい文字を逃がす（sync/uploader.ts と同じ）。 */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** そのパスに何かあるか。壊れたリンクも「ある」と見る。 */
function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * ゴミ箱へ移した主線の本文が、元のパスに戻ってきたか。
 * 本文の jsonl で、大きさが 0 でないファイルのときだけ戻ったとみなす。同じ名前の空のファイルやフォルダができただけでは復元しない。
 */
function isTranscriptBack(p: string): boolean {
  if (!p.endsWith('.jsonl')) return false;
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 印のある（削除した）セッションなら、その時刻。印が無ければ null。 */
export function trashedAtOf(db: Db, sessionId: string): number | null {
  const r = stmt(db, 'select trashed_at from session_states where session_id = ? and deleted_at is null').get(sessionId) as { trashed_at: number | null } | undefined;
  return r?.trashed_at ?? null;
}

/**
 * 同期で sessions か session_states の行が届いた後に、sessions の行の論理削除を印に合わせる（sync/apply.ts）。
 * - 印があれば、sessions の行を論理削除のまま保つ。古い upsert（deleted_at が null）が後から届いても生き返らない。
 * - 印が外れた（prevTrashedAt があって、いまは無い）なら、論理削除を外す。ほかの PC での復元である。
 * どちらも手元の表だけを直し、押し返さない。印はどの PC にも届くので、それぞれが自分で合わせる。
 */
export function alignSessionTrash(db: Db, sessionId: string, prevTrashedAt: number | null = null): void {
  const t = trashedAtOf(db, sessionId);
  let changed = false;
  if (t !== null) changed = db.prepare('update sessions set deleted_at = ? where id = ? and deleted_at is null').run(t, sessionId).changes > 0;
  else if (prevTrashedAt !== null) changed = db.prepare('update sessions set deleted_at = null where id = ? and deleted_at is not null').run(sessionId).changes > 0;
  if (!changed) return;
  touchRow(db, 'sessions', sessionId);
  const p = db.prepare('select project_id from sessions where id = ?').get(sessionId) as { project_id: string | null } | undefined;
  if (p?.project_id) touchRow(db, 'projects', p.project_id);
}

/**
 * 削除の印が before 以前で、その後に戻されていないセッション（ゴミ箱の掃除の対象。sync/trashSweep.ts）。
 * 印は同期で届くので、ほかの PC で消したセッションも入る。
 * 同じ Claude Code のセッション ID を持つ生きたセッションの行があれば外す（本文の鍵名はその ID から求めるので、生きている方の本文まで消してしまう）。
 * ID の形が違うものも外す（Claude は UUID、opencode は鍵に使える形。sync/trashSweep.ts が鍵名を会話のエージェントで求める）。
 */
export function trashedLongAgo(db: Db, before: number): { sessionId: string; uuid: string }[] {
  const rows = db.prepare(`select st.session_id sessionId, s.provider_session_id uuid, s.provider provider from session_states st
    join sessions s on s.id = st.session_id
    where st.deleted_at is null and st.trashed_at is not null and st.trashed_at <= ?
      and (st.restored_at is null or st.restored_at < st.trashed_at)
      and not exists (select 1 from sessions o where o.provider_session_id = s.provider_session_id and o.deleted_at is null)
    order by st.trashed_at, st.session_id`).all(before) as { sessionId: string; uuid: string; provider: string }[];
  return rows
    .filter((r) => (isAgentKind(r.provider) ? AGENT_SYNC[r.provider] : AGENT_SYNC['claude-code']).isSessionId(r.uuid))
    .map((r) => ({ sessionId: r.sessionId, uuid: r.uuid }));
}

/** 1 回の処理の結果。trashed はこの回に処理し終えたセッション、waiting はこの PC で動いているので待ったセッション。 */
export type MarksResult = { trashed: string[]; waiting: string[] };

/** 周期の処理の間隔。この PC で動いていて待ったセッションと、移せなかった本文を、この間隔でやり直す。 */
const PASS_MS = 60_000;
/** 同期で印が届いたときなどに、まとめて 1 回にするための間。 */
const SCHEDULE_DELAY_MS = 500;

/**
 * セッションの削除と、届いた印の処理と、ゴミ箱からの復元を受け持つ。
 * 消すのも印を処理するのも本文のファイルを動かすので、1 本の鎖に並べて重ならないようにする。
 */
export class SessionTrash {
  private chain: Promise<unknown> = Promise.resolve();
  /** 走っている印の処理の回。1 件ごとに鎖へ並び直すので、鎖が空いても回が終わったとは限らない（idle が待つ）。 */
  private readonly passes = new Set<Promise<MarksResult>>();
  private timer: NodeJS.Timeout | null = null;
  private soon: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(private readonly deps: SessionTrashDeps) {}

  private get db(): Db { return this.deps.db; }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private log(m: string): void { (this.deps.log ?? ((s: string) => console.error('[trash]', s)))(m); }

  /** 仕事を鎖の末尾につなぐ。前の仕事が転んでも次は走る。 */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }

  private facts(sessionId: string): SessionFacts | undefined {
    return this.db.prepare('select id, provider, provider_session_id, cwd, project_id, deleted_at from sessions where id = ?').get(sessionId) as SessionFacts | undefined;
  }

  private underRemote(p: string): boolean { return isStrictlyUnder(p, this.deps.remoteRoot); }

  /**
   * この PC の手元にある本文（ゴミ箱へ移すもの）。主線の jsonl と、隣の `<uuid>/` のフォルダ。
   * 索引の行（transcript_files）から引き、行が無ければ cwd の置き場（~/.claude/projects/<cwd を畳んだ名前>/）を見る。
   * hangar が降ろした写し（remoteRoot の下）は含めない。いまあるものだけを返す。
   */
  private localTargets(s: SessionFacts): Target[] {
    if (!SESSION_UUID.test(s.provider_session_id)) return [];
    const rows = this.db.prepare('select path from transcript_files where session_id = ? and agent_id is null').all(s.id) as { path: string }[];
    const mains = new Set(rows.map((r) => r.path).filter((p) => !this.underRemote(p)));
    mains.add(path.join(this.deps.claudeDir, 'projects', mangleCwd(s.cwd), `${s.provider_session_id}.jsonl`));
    const out: Target[] = [];
    for (const m of mains) {
      if (exists(m)) out.push({ path: m, kind: 'file' });
      const dir = path.join(path.dirname(m), s.provider_session_id);
      if (isDir(dir)) out.push({ path: dir, kind: 'dir' });
    }
    return out;
  }

  /**
   * hangar が降ろした写し。索引の行と、降ろした台帳（file_sync）から引く。
   * 主線の写しと、その隣の `<uuid>/` のフォルダを返す。remoteRoot の下にあるものだけで、いまあるものに限る。
   */
  private remoteTargets(s: SessionFacts): string[] {
    const uuid = s.provider_session_id;
    if (isExportAgent(s.provider)) return this.opencodeTargets(s);
    if (!SESSION_UUID.test(uuid)) return [];
    const fromIndex = (this.db.prepare('select path from transcript_files where session_id = ?').all(s.id) as { path: string }[]).map((r) => r.path).filter((p) => this.underRemote(p));
    const fromLedger = (this.db.prepare("select path, device_id from file_sync where kind = 'transcript' and device_id <> ? and path like ?").all(this.deps.deviceId, `%/${uuid}.jsonl`) as { path: string; device_id: string }[])
      .map((r) => path.join(this.deps.remoteRoot, r.device_id, ...r.path.split('/')))
      .filter((p) => this.underRemote(p));
    const out = new Set<string>();
    for (const p of [...fromIndex, ...fromLedger]) {
      // サブエージェントの写しは、主線の隣のフォルダごと消す。
      const parts = p.split(path.sep);
      const i = parts.lastIndexOf(uuid);
      const main = i >= 0 ? path.join(parts.slice(0, i).join(path.sep) || path.sep, `${uuid}.jsonl`) : p;
      const dir = path.join(path.dirname(main), uuid);
      if (exists(main) && this.underRemote(main)) out.add(main);
      if (isDir(dir) && this.underRemote(dir)) out.add(dir);
    }
    return [...out];
  }

  /**
   * opencode の会話の、hangar の持ち物のファイル。同期のための書き出しと、降ろした写し（台帳から引く）。いまあるものだけ。
   * 置き場の外を指すものは返さない。
   */
  private opencodeTargets(s: SessionFacts): string[] {
    const id = s.provider_session_id;
    if (!isSafeKeyId(id)) return [];
    const out = new Set<string>();
    const dir = this.deps.opencodeExportDir;
    if (dir) {
      const f = path.join(dir, `${id}.json`);
      if (exists(f) && isStrictlyUnder(f, dir)) out.add(f);
    }
    const rows = this.db.prepare("select device_id from file_sync where kind = 'transcript' and device_id <> ? and key like ?").all(this.deps.deviceId, `opencode/%/${id}.json.gz`) as { device_id: string }[];
    for (const r of rows) {
      const p = path.join(this.deps.remoteRoot, r.device_id, 'opencode', `${id}.json`);
      if (exists(p) && this.underRemote(p)) out.add(p);
    }
    return [...out];
  }

  /** 写しを消す。消せなかったものの数を返す。 */
  private removeRemote(targets: string[]): number {
    let failed = 0;
    for (const p of targets) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        failed++;
        this.log(`写しを消せませんでした: ${p}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return failed;
  }

  /**
   * そのセッションの本文の索引を片付ける。索引は手元だけの表なので、同期には載らない。
   * 日別の使用量（usage_daily）は残す。実際に使った量なので、会話を消しても集計からは消さない（usage/aggregate.ts）。
   */
  private forgetIndex(sessionId: string): void {
    for (const r of this.db.prepare('select path from transcript_files where session_id = ?').all(sessionId) as { path: string }[]) forgetTranscriptFile(this.db, r.path, { keepUsage: true });
    // 本文を DB に持つ会話（opencode）は、ファイルの行が無いので会話ごと片付ける。
    const p = this.db.prepare('select provider from sessions where id = ?').get(sessionId) as { provider: string } | undefined;
    if (isExportAgent(p?.provider)) {
      for (const sql of [
        'delete from event_index where session_id = ?', 'delete from event_fts where session_id = ?', 'delete from agent_events where session_id = ?',
        'delete from session_activity where session_id = ?', 'delete from session_limits where session_id = ?',
      ]) this.db.prepare(sql).run(sessionId);
    }
  }

  private record(sessionId: string, moved: Target[], at: number): void {
    const ins = this.db.prepare('insert into trashed_transcripts (path, session_id, kind, trashed_at) values (?,?,?,?) on conflict(path) do update set session_id = excluded.session_id, kind = excluded.kind, trashed_at = excluded.trashed_at');
    for (const t of moved) ins.run(t.path, sessionId, t.kind, at);
  }

  private markApplied(sessionId: string, trashedAt: number): void {
    this.db.prepare('insert into trash_applied (session_id, trashed_at) values (?, ?) on conflict(session_id) do update set trashed_at = excluded.trashed_at').run(sessionId, trashedAt);
  }

  /**
   * セッションを消す。実行中なら 409、無ければ 404、本文をゴミ箱へ移せなければ 500 の DeleteError を投げ、何も変えない。
   * 主線の本文を先に移す。主線を移せた後にサブエージェントのフォルダや写しを片付けられなかったときは、印は書き、残りは次の回（applyMarks）でやり直す。
   */
  deleteSession(sessionId: string): Promise<void> {
    return this.enqueue(() => this.deleteInner(sessionId));
  }

  private async deleteInner(sessionId: string): Promise<void> {
    const s = this.facts(sessionId);
    if (!s || s.deleted_at !== null) throw new DeleteError(404, msg('session.error.notFound'));
    if (this.deps.runsAnywhere(sessionId)) throw new DeleteError(409, msg('session.delete.running'));
    const targets = this.localTargets(s);
    // 主線を先に移す。主線を移せなければ、何も変えずに断る。
    targets.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'file' ? -1 : 1));
    const moved: Target[] = [];
    let incomplete = false;
    const at = this.now();
    for (const t of targets) {
      // 元のパスの控えを、ゴミ箱へ移す前に書く。移した後の DB の書き込みで転んでも、控えから戻せる（checkRestores）。
      // 移せなかったら控えを取り消す。
      this.record(sessionId, [t], at);
      try {
        await this.deps.trash(t.path);
        moved.push(t);
      } catch (e) {
        this.db.prepare('delete from trashed_transcripts where path = ?').run(t.path);
        const reason = e instanceof Error ? e.message : String(e);
        if (moved.length === 0) throw new DeleteError(500, msg('session.delete.trashFailed', { reason }));
        incomplete = true;
        this.log(`ゴミ箱へ移せませんでした（次の回でやり直します）: ${t.path}: ${reason}`);
      }
    }
    if (this.removeRemote(this.remoteTargets(s)) > 0) incomplete = true;
    this.db.transaction(() => {
      setSessionTrashed(this.db, this.deps.deviceId, sessionId, at);
      softDeleteShared(this.db, 'sessions', sessionId, this.deps.deviceId);
      this.forgetIndex(sessionId);
      const t = trashedAtOf(this.db, sessionId);
      if (!incomplete && t !== null) this.markApplied(sessionId, t);
      if (s.project_id) touchRow(this.db, 'projects', s.project_id);
    })();
  }

  /**
   * 届いた印を処理する（この PC がまだ処理していない印だけ）。あわせて、ほかの PC での復元と、この PC での復元を見る。
   * この PC で動いているセッションは待つ（次の回にやり直す）。移せなかった本文と消せなかった写しも、次の回にやり直す。
   * 1 件ごとに鎖へ並び直す。印が多くても、途中で頼まれた削除（DELETE の API）が残りの印の後ろで待たされないようにするためである。
   */
  applyMarks(): Promise<MarksResult> {
    const pass = this.marksPass();
    this.passes.add(pass);
    const done = () => { this.passes.delete(pass); };
    pass.then(done, done);
    return pass;
  }

  private async marksPass(): Promise<MarksResult> {
    const result: MarksResult = { trashed: [], waiting: [] };
    const rows = await this.enqueue(async () => {
      this.restoresInner();
      this.noteRestoredElsewhere();
      return this.pendingMarks();
    });
    for (const r of rows) {
      if (this.stopped) break;
      const outcome = await this.enqueue(() => this.markOne(r));
      if (outcome === 'trashed') result.trashed.push(r.id);
      else if (outcome === 'waiting') result.waiting.push(r.id);
    }
    return result;
  }

  /** この PC がまだ処理していない印。 */
  private pendingMarks(): MarkRow[] {
    return this.db.prepare(`select st.session_id id, st.trashed_at t from session_states st
      left join trash_applied ta on ta.session_id = st.session_id
      where st.deleted_at is null and st.trashed_at is not null and (ta.trashed_at is null or ta.trashed_at <> st.trashed_at)`).all() as MarkRow[];
  }

  /** 印を 1 件処理する。並んでいる間に、ほかの回が処理し終えていたり、印が変わっていたりしたら何もしない。 */
  private async markOne(r: MarkRow): Promise<'trashed' | 'waiting' | 'incomplete' | 'skipped'> {
    if (this.stopped) return 'skipped';
    if (trashedAtOf(this.db, r.id) !== r.t) return 'skipped';
    const applied = this.db.prepare('select trashed_at from trash_applied where session_id = ?').get(r.id) as { trashed_at: number } | undefined;
    if (applied?.trashed_at === r.t) return 'skipped';
    const s = this.facts(r.id);
    if (!s) return 'skipped';
    if (this.deps.runsHere(r.id)) return 'waiting';
    const moved: Target[] = [];
    let incomplete = false;
    for (const t of this.localTargets(s)) {
      try {
        await this.deps.trash(t.path);
        moved.push(t);
      } catch (e) {
        incomplete = true;
        this.log(`ゴミ箱へ移せませんでした（次の回でやり直します）: ${t.path}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (this.removeRemote(this.remoteTargets(s)) > 0) incomplete = true;
    // 待っている間に印が外れていたら（ほかの PC で復元された）、移したものだけを控えて、次の回の復元の確かめに任せる。
    const t = trashedAtOf(this.db, r.id);
    this.db.transaction(() => {
      this.record(r.id, moved, r.t);
      this.forgetIndex(r.id);
      if (t === null) return;
      // 本文の持ち主（移したものがある）か、行がまだ生きているなら、論理削除を自分でも書く。
      // 持ち主が印を受け取る前に上げた upsert がクラウドで勝っていても、ここで書く削除がそれより新しい。
      const cur = this.facts(r.id);
      if (cur && (moved.length > 0 || cur.deleted_at === null)) softDeleteShared(this.db, 'sessions', r.id, this.deps.deviceId);
      if (!incomplete) this.markApplied(r.id, t);
    })();
    return incomplete ? 'incomplete' : 'trashed';
  }

  /** 処理し終えた印が、ほかの PC での復元で外れていたら、処理済みの印を外し、消した写しを降ろし直してもらう。 */
  private noteRestoredElsewhere(): void {
    const rows = this.db.prepare(`select ta.session_id id, s.provider_session_id uuid from trash_applied ta
      left join session_states st on st.session_id = ta.session_id and st.deleted_at is null
      left join sessions s on s.id = ta.session_id
      where st.trashed_at is null`).all() as { id: string; uuid: string | null }[];
    for (const r of rows) {
      this.db.transaction(() => {
        this.db.prepare('delete from trash_applied where session_id = ?').run(r.id);
        this.db.prepare('delete from trashed_transcripts where session_id = ?').run(r.id);
      })();
      if (r.uuid) this.deps.onRestoredElsewhere?.(r.uuid);
    }
  }

  /**
   * ゴミ箱へ移した主線の本文が、元のパスに戻ってきたセッションを復元する。復元したセッションの ID を返す。
   * 印と論理削除を外し、どちらも同期に載せる。本文の索引は削除のときに片付けてあるので、索引し直してもらう。
   * 上げた控えも忘れ、本文を上げ直してもらう（forgetUploads）。
   */
  checkRestores(): string[] {
    return this.restoresInner();
  }

  private restoresInner(): string[] {
    const rows = this.db.prepare("select path, session_id from trashed_transcripts where kind = 'file'").all() as { path: string; session_id: string }[];
    const back = new Set(rows.filter((r) => isTranscriptBack(r.path)).map((r) => r.session_id));
    for (const id of back) this.restore(id);
    return [...back];
  }

  /**
   * この PC が上げた本文（主線とサブエージェント）の控え（file_sync の自端末の行）を忘れる。
   * 印から 30 日（TRASH_KEEP_MS）たつと、各 PC のゴミ箱の掃除が自分の上げた写しを消す（sync/trashSweep.ts）。
   * 控えが残っていると、上げる側（sync/uploader.ts）は中身が同じなので上げ直さず、ほかの PC はその本文を降ろせない。
   * 忘れれば、取り残しの走査が次の巡で上げ直す。
   * 30 日より前に戻したときは、同じ鍵へ同じ中身を上書きするだけである（Worker の PUT は索引の行を置き直す）。
   * 降ろした写しの台帳（ほかの端末の行）には触らない。
   */
  private forgetUploads(sessionId: string): void {
    const s = this.facts(sessionId);
    if (!s || !SESSION_UUID.test(s.provider_session_id)) return;
    const head = `transcripts/${this.deps.deviceId}/${s.provider_session_id}`;
    this.db.prepare("delete from file_sync where kind = 'transcript' and device_id = ? and (key = ? or key like ? escape '\\')")
      .run(this.deps.deviceId, `${head}.jsonl.gz`, `${escapeLike(head)}/subagents/%`);
  }

  private restore(sessionId: string): void {
    this.db.transaction(() => {
      this.db.prepare('delete from trashed_transcripts where session_id = ?').run(sessionId);
      this.db.prepare('delete from trash_applied where session_id = ?').run(sessionId);
      this.forgetUploads(sessionId);
      if (trashedAtOf(this.db, sessionId) !== null) setSessionTrashed(this.db, this.deps.deviceId, sessionId, null, this.now());
      const s = this.db.prepare('select * from sessions where id = ?').get(sessionId) as Record<string, unknown> | undefined;
      if (s && s.deleted_at !== null) upsertShared(this.db, 'sessions', { ...s, deleted_at: null }, this.deps.deviceId);
      if (typeof s?.project_id === 'string') touchRow(this.db, 'projects', s.project_id);
    })();
    this.deps.onRestored?.(sessionId);
  }

  /** 次の回を少し後に回す。同期で印が届いたとき、索引が消したセッションの本文を見たときに呼ぶ。続けて呼ばれても 1 回にまとめる。 */
  schedule(): void {
    if (this.stopped || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = null;
      void this.applyMarks().catch((e: unknown) => this.log(e instanceof Error ? e.message : String(e)));
    }, SCHEDULE_DELAY_MS);
    this.soon.unref?.();
  }

  /** 周期の処理を始め、すぐに 1 回回す。起きていなかった間に届いた印もここで処理する。 */
  start(intervalMs = PASS_MS): void {
    this.stopped = false;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), intervalMs);
    this.timer.unref?.();
  }

  /** 周期の処理を止める。走っている回は最後まで走るので、呼び手は idle() で待ち合わせる。 */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.soon) clearTimeout(this.soon);
    this.timer = null;
    this.soon = null;
  }

  /** いま鎖に並んでいる仕事と、走っている印の処理の回が終わるまで待つ。 */
  async idle(): Promise<void> {
    for (;;) {
      const c = this.chain;
      await c.then(() => undefined, () => undefined);
      await Promise.all([...this.passes].map((p) => p.then(() => undefined, () => undefined)));
      if (this.chain === c && this.passes.size === 0) return;
    }
  }
}
