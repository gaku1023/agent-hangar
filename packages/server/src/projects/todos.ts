import { newId, type TodoDto } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { softDeleteShared, upsertShared } from '../db/shared.ts';
import { MessageError, msg } from '../i18n/message.ts';

type Row = {
  id: string; project_id: string; text: string; done: number; position: number; session_id: string | null; updated_at: number; deleted_at: number | null;
  candidate_at: number | null; candidate_session_id: string | null; candidate_note: string | null; rejected_sessions: string;
  suggested_at: number | null; suggested_note: string | null;
};

/** 根拠の一文の上限（空白を除いた字数）。 */
export const CANDIDATE_NOTE_MAX = 200;

/**
 * Claude の提案か。完了の行は提案として扱わない。
 * 提案の行は完了にも完了の候補にもならないので、完了かつ提案という矛盾は同期の競り合いか古い端末の書き込みでしか起きない。
 */
const isSuggestion = (r: Row): boolean => r.suggested_at !== null && r.done !== 1;

// 完了かつ候補という矛盾は同期の競り合いでしか起きない。完了を正とし、候補は無いものとして読む（書き直しはしない）。
// 提案も同じく、完了を正とする。提案かつ候補は、提案を正として候補を無いものとする（受け入れる前の行は候補にできないため）。
const toDto = (r: Row): TodoDto => ({
  id: r.id, projectId: r.project_id, text: r.text, done: r.done === 1, position: r.position, sessionId: r.session_id, updatedAt: r.updated_at,
  candidate: r.candidate_at !== null && r.done !== 1 && !isSuggestion(r) ? { sessionId: r.candidate_session_id, note: r.candidate_note, at: r.candidate_at } : null,
  suggestion: isSuggestion(r) ? { note: r.suggested_note, at: r.suggested_at! } : null,
});

const NO_CANDIDATE = { candidate_at: null, candidate_session_id: null, candidate_note: null };
const NO_SUGGESTION = { suggested_at: null, suggested_note: null };

const anyRow = (db: Db, id: string) => db.prepare('select * from todos where id = ?').get(id) as Row | undefined;
const liveRow = (db: Db, id: string) => db.prepare('select * from todos where id = ? and deleted_at is null').get(id) as Row | undefined;
const reread = (db: Db, id: string) => toDto(anyRow(db, id)!);
/** そのプロジェクトの position の最大値。削除した行も含める（番号を再利用しない）。 */
const maxPosition = (db: Db, projectId: string) => (db.prepare('select max(position) m from todos where project_id = ?').get(projectId) as { m: number | null }).m ?? 0;

/** 文言を整える。前後の空白を落とし、空になれば断る。 */
function cleanText(text: string): string {
  const t = text.trim();
  if (!t) throw new MessageError(msg('todo.error.emptyText'));
  return t;
}

/** 却下されたセッションの一覧。壊れた値は空として読む。候補を出す道を投げて止めるより、出せてしまう方が害が小さい。 */
function rejectedOf(r: Row): string[] {
  try {
    const v: unknown = JSON.parse(r.rejected_sessions);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 生きている TODO を返す。projectId を省くとすべてのプロジェクトをまとめて返す。提案の行も含む（画面が別の節に分けて出す）。 */
export function listTodos(db: Db, projectId?: string): TodoDto[] {
  const rows = projectId
    ? db.prepare('select * from todos where project_id = ? and deleted_at is null order by position, id').all(projectId)
    : db.prepare('select * from todos where deleted_at is null order by project_id, position, id').all();
  return (rows as Row[]).map(toDto);
}

/**
 * 末尾に足す。position は削除した行も含めた最大値の次で、番号を再利用しない。
 * suggested を立てると Claude の提案として足す（MCP の add_todos）。note は提案の理由で、検査は呼び手が済ませる。
 */
export function addTodo(db: Db, deviceId: string, o: { projectId: string; text: string; sessionId?: string | null; suggested?: boolean; note?: string | null; now?: number }): TodoDto {
  const text = cleanText(o.text);
  const id = newId();
  const suggestion = o.suggested ? { suggested_at: o.now ?? Date.now(), suggested_note: o.note ?? null } : NO_SUGGESTION;
  upsertShared(db, 'todos', { id, project_id: o.projectId, text, done: 0, position: maxPosition(db, o.projectId) + 1, session_id: o.sessionId ?? null, ...suggestion }, deviceId);
  return reread(db, id);
}

/**
 * 文言を書き換える。前後の空白を落とし、空白だけなら断る（消すのは removeTodo）。見つからないときは null を返す。
 * 提案の行も直せる（受け入れる前に言い回しを整えられる）。同じ文言なら書かない。
 */
export function setTodoText(db: Db, deviceId: string, id: string, text: string): TodoDto | null {
  const next = cleanText(text);
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.text === next) return toDto(row);
  upsertShared(db, 'todos', { ...row, text: next }, deviceId);
  return reread(db, id);
}

/**
 * 完了の印を付け外しする。利用者の操作なので、候補の印もあわせて消す。見つからないときは null を返す。
 * 提案の行には効かない。書かずに今の行を返すので、呼び手は suggestion が残っていることで断られたと分かる。
 */
export function setTodoDone(db: Db, deviceId: string, id: string, done: boolean): TodoDto | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (isSuggestion(row)) return toDto(row);
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, done: done ? 1 : 0 }, deviceId);
  return reread(db, id);
}

/**
 * 並べ替える。ids は、そのプロジェクトの未完（提案を除く）の新しい並びである。
 * 番号を新しく作らず、渡された行の今の position を昇順に並べたものを、新しい並びに配り直す。
 * 番号を再利用しない決まり（addTodo）と、最大値をそのまま保つためである。番号の変わった行だけ書く。
 * プロジェクトの外の ID、消した行、見つからない ID、重複、提案の行が混ざれば、何も書かずに null を返す。
 */
export function reorderTodos(db: Db, deviceId: string, projectId: string, ids: string[]): TodoDto[] | null {
  return db.transaction(() => {
    if (new Set(ids).size !== ids.length) return null;
    const rows: Row[] = [];
    for (const id of ids) {
      const r = anyRow(db, id);
      if (!r || r.project_id !== projectId || r.deleted_at !== null || isSuggestion(r)) return null;
      rows.push(r);
    }
    const slots = rows.map((r) => r.position).sort((a, b) => a - b);
    rows.forEach((r, i) => {
      if (r.position !== slots[i]) upsertShared(db, 'todos', { ...r, position: slots[i] }, deviceId);
    });
    return listTodos(db, projectId);
  })();
}

export type AcceptResult = 'accepted' | 'not_suggestion';

/**
 * Claude の提案を受け入れる。提案の列を消し、position を削除した行も含めた最大値の次にして一覧の末尾へ入れる。
 * 足したのは提案を出したときだが、利用者が受け入れた時点で一覧に入るので、その時点の末尾に置く。見つからないときは null を返す。
 */
export function acceptTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: AcceptResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (!isSuggestion(row)) return { todo: toDto(row), result: 'not_suggestion' };
  upsertShared(db, 'todos', { ...row, ...NO_SUGGESTION, position: maxPosition(db, row.project_id) + 1 }, deviceId);
  return { todo: reread(db, id), result: 'accepted' };
}

export type ProposeOutcome = 'proposed' | 'already_candidate' | 'already_done' | 'rejected_before' | 'not_accepted';

/**
 * 完了の候補にする。完了にはしない（完了にするのは利用者だけ）。見つからないときは null を返す。
 * すでに候補なら根拠を上書きしない。利用者が読んでいる最中に中身が差し替わらないようにするためである。
 * 利用者がまだ受け入れていない提案は、候補にせず not_accepted を返す。
 */
export function proposeTodoDone(db: Db, deviceId: string, id: string, o: { sessionId: string | null; note: string | null; now?: number }): { todo: TodoDto; outcome: ProposeOutcome } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (isSuggestion(row)) return { todo: toDto(row), outcome: 'not_accepted' };
  if (row.done === 1) return { todo: toDto(row), outcome: 'already_done' };
  if (row.candidate_at !== null) return { todo: toDto(row), outcome: 'already_candidate' };
  if (o.sessionId !== null && rejectedOf(row).includes(o.sessionId)) return { todo: toDto(row), outcome: 'rejected_before' };
  upsertShared(db, 'todos', { ...row, candidate_at: o.now ?? Date.now(), candidate_session_id: o.sessionId, candidate_note: o.note }, deviceId);
  return { todo: reread(db, id), outcome: 'proposed' };
}

export type ConfirmResult = 'confirmed' | 'already_done' | 'not_candidate' | 'not_accepted';

/** 候補を確定して完了にする。すでに完了なら何もしない。提案の行は not_accepted で何もしない。見つからないときは null を返す。 */
export function confirmTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: ConfirmResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (isSuggestion(row)) return { todo: toDto(row), result: 'not_accepted' };
  if (row.done === 1) return { todo: toDto(row), result: 'already_done' };
  if (row.candidate_at === null) return { todo: toDto(row), result: 'not_candidate' };
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, done: 1 }, deviceId);
  return { todo: reread(db, id), result: 'confirmed' };
}

export type RejectResult = 'rejected' | 'not_candidate';

/**
 * 候補を却下して未完に戻す。出したセッションを rejected_sessions に一度だけ積む。
 * セッションの分からない候補は積まない（積む鍵が無いので、出し直しは止められない）。
 */
export function rejectTodo(db: Db, deviceId: string, id: string): { todo: TodoDto; result: RejectResult } | null {
  const row = liveRow(db, id);
  if (!row) return null;
  if (row.done === 1 || row.candidate_at === null || isSuggestion(row)) return { todo: toDto(row), result: 'not_candidate' };
  const rejected = rejectedOf(row);
  const sid = row.candidate_session_id;
  const next = sid !== null && !rejected.includes(sid) ? [...rejected, sid] : rejected;
  upsertShared(db, 'todos', { ...row, ...NO_CANDIDATE, rejected_sessions: JSON.stringify(next) }, deviceId);
  return { todo: reread(db, id), result: 'rejected' };
}

/** 論理削除する。利用者のファイルは消さないので、行は残したまま deleted_at を立てる。提案の見送りもこれで行う。 */
export function removeTodo(db: Db, deviceId: string, id: string): TodoDto | null {
  const row = liveRow(db, id);
  if (!row) return null;
  softDeleteShared(db, 'todos', id, deviceId);
  return toDto(row);
}

/**
 * 画面の取り消し（⌘Z）のために、渡した中身へ戻す。
 * 保存してある行（消した行も含む）を ID で引き、文言、完了、position、完了の候補の 3 列、提案の 2 列を渡された値に戻し、deleted_at を null にする。
 * rejected_sessions と project_id は変えない。却下の記録は取り消しの対象でなく、プロジェクトをまたぐ移動は作らないためである。
 * 完了かつ候補、完了かつ提案は完了を正とし、提案かつ候補は提案を正とする（toDto の読み方と同じ）。中身の変わらない行は書かない。
 * 見つからない行か、渡された projectId が保存してある行と違う行が 1 つでも混ざれば、何も書かずに null を返す。
 * 空白だけの文言は断る。どちらも 1 つのトランザクションで、途中まで書いた分を残さない。
 */
export function restoreTodos(db: Db, deviceId: string, rows: TodoDto[]): TodoDto[] | null {
  return db.transaction(() => {
    const plans: Row[] = [];
    for (const t of rows) {
      const stored = anyRow(db, t.id);
      if (!stored || stored.project_id !== t.projectId) return null;
      const suggestion = !t.done ? t.suggestion : null;
      const candidate = !t.done && !suggestion ? t.candidate : null;
      plans.push({
        ...stored, text: cleanText(t.text), done: t.done ? 1 : 0, position: t.position, deleted_at: null,
        candidate_at: candidate?.at ?? null, candidate_session_id: candidate?.sessionId ?? null, candidate_note: candidate?.note ?? null,
        suggested_at: suggestion?.at ?? null, suggested_note: suggestion?.note ?? null,
      });
    }
    for (const next of plans) {
      const cur = anyRow(db, next.id)!;
      const same = (Object.keys(next) as (keyof Row)[]).every((k) => k === 'updated_at' || cur[k] === next[k]);
      if (!same) upsertShared(db, 'todos', { ...next }, deviceId);
    }
    return rows.map((t) => reread(db, t.id));
  })();
}
