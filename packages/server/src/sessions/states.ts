import { isReturnOn, STATE_NOTE_MAX, type CandidateSource, type SessionCandidateDto, type SessionStateDto, type SessionStatus, type StateSetBy } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';

/**
 * セッションの状態の移り方。設計は docs/superpowers/specs/2026-10-01-session-status-design.md の「状態の移り方」。
 * 書き手は MCP（提案と、会話で選んだもの）、HTTP（画面）、索引（新しい発言で外すときだけ）である。
 * 変更のたびに session.upsert を配るのは呼び手の役目にする（TODO の候補と同じ分け方）。
 */

/** 状態の入力の誤り。message はトーストにそのまま出せる日本語の一文である。 */
export class StateInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateInputError';
  }
}

type StateRow = {
  session_id: string;
  status: SessionStatus | null; note: string | null; return_on: string | null; set_by: StateSetBy | null; set_at: number | null;
  candidate_status: 'paused' | 'done' | null; candidate_note: string | null; candidate_return_on: string | null; candidate_source: CandidateSource | null; candidate_at: number | null;
  rejected_at: number | null;
  updated_at: number; deleted_at: number | null; origin_device: string;
};
/** DTO に写すのに要る列。db/queries.ts の左結合の行も、この形に詰め直して渡す。 */
export type StateCols = Pick<StateRow, 'status' | 'note' | 'return_on' | 'set_by' | 'set_at' | 'candidate_status' | 'candidate_note' | 'candidate_return_on' | 'candidate_source' | 'candidate_at'>;

const NO_CANDIDATE = { candidate_status: null, candidate_note: null, candidate_return_on: null, candidate_source: null, candidate_at: null } as const;
const NO_STATUS = { status: null, note: null, return_on: null, set_by: null, set_at: null } as const;
const CLEARED = { ...NO_STATUS, ...NO_CANDIDATE, rejected_at: null } as const;

/** 行の無いセッションの状態（Active）。 */
export const NO_STATE: SessionStateDto = { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null };

/**
 * 読むときに見える提案。状態が付いていれば、提案は無いものとして読む（同期の競り合いで両方が揃った行は、状態を正とする。書き直しはしない）。
 * 提案の有無を見る箇所はすべてこれを通す。場所ごとに判定が違うと、画面に出る提案と確定できる提案がずれる。
 */
function visibleCandidate(r: StateCols): SessionCandidateDto | null {
  if (r.status !== null || r.candidate_at === null || r.candidate_status === null || r.candidate_source === null) return null;
  return { status: r.candidate_status, note: r.candidate_note, returnOn: r.candidate_return_on, source: r.candidate_source, at: r.candidate_at };
}

/** 行の列を DTO に写す。rejected_at は載せない（判定はサーバの中だけで行う）。 */
export function toStateDto(r: StateCols): SessionStateDto {
  return { status: r.status, note: r.note, returnOn: r.return_on, setBy: r.set_by, setAt: r.set_at, candidate: visibleCandidate(r) };
}

const liveRow = (db: Db, id: string) => db.prepare('select * from session_states where session_id = ? and deleted_at is null').get(id) as StateRow | undefined;

/** 今の行（無ければ空の行）に差分を重ねて書く。updated_at と origin_device は upsertShared が補う。 */
function write(db: Db, deviceId: string, sessionId: string, patch: Partial<StateRow>): SessionStateDto {
  const cur = db.prepare('select * from session_states where session_id = ?').get(sessionId) as StateRow | undefined;
  const base = cur ?? { session_id: sessionId, ...CLEARED };
  upsertShared(db, 'session_states', { ...base, ...patch, session_id: sessionId, deleted_at: null }, deviceId, 'session_id');
  return toStateDto(liveRow(db, sessionId)!);
}

/**
 * 理由と根拠を整える。1 行の欄で見せるので、改行を含む空白の並びは 1 つの空白にたたむ。
 * 字数は文字単位で数える（UTF-16 の長さで数えると、絵文字 100 字で上限に当たる）。
 */
function noteOf(v: string | null | undefined, required: boolean): string | null {
  const s = (v ?? '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
  if (!s) {
    if (required) throw new StateInputError('根拠の一文が空です');
    return null;
  }
  if (Array.from(s).length > STATE_NOTE_MAX) throw new StateInputError(`理由は ${STATE_NOTE_MAX} 字までです`);
  return s;
}

/** 戻る日。Paused だけが持ち、ほかの状態では渡されても捨てる（捨てる前に形は検査する）。 */
function returnOnOf(status: SessionStatus, v: string | null | undefined): string | null {
  const given = v !== null && v !== undefined && v !== '';
  if (given && !isReturnOn(v)) throw new StateInputError('戻る日は YYYY-MM-DD の形の、暦にある日付です');
  if (status !== 'paused') return null;
  if (!given) throw new StateInputError('Paused には戻る日が要ります');
  return v;
}

/**
 * 状態の入力の検査と整形を、書く前に 1 か所で済ませる。誤りは StateInputError にする。
 * 提案と MCP の確定は根拠を必須にする（requireNote）。画面の手動の確定は根拠なしでよい。
 */
export function validateStateInput(status: SessionStatus, o: { note?: string | null; returnOn?: string | null; requireNote: boolean }): { note: string | null; returnOn: string | null } {
  const note = noteOf(o.note, o.requireNote);
  return { note, returnOn: returnOnOf(status, o.returnOn) };
}

/** 今の状態。行が無いか論理削除されていれば null（Active）。 */
export function getSessionState(db: Db, sessionId: string): SessionStateDto | null {
  const r = liveRow(db, sessionId);
  return r ? toStateDto(r) : null;
}

/**
 * 状態を書く（会話で選ぶ・手で選ぶ・Active に戻す）。提案は消す。
 * Active に戻しても rejected_at は残す。却下は、そのセッションに新しい発言があるまで効く。
 * 検査はすべて書く前に済ませ、誤りは StateInputError にして何も書かない。
 */
export function setSessionState(db: Db, deviceId: string, sessionId: string, o: { status: SessionStatus | null; note?: string | null; returnOn?: string | null; setBy: 'user' | 'conversation'; requireNote?: boolean; now?: number }): SessionStateDto {
  const now = o.now ?? Date.now();
  if (o.status === null) return write(db, deviceId, sessionId, { status: null, note: null, return_on: null, set_by: o.setBy, set_at: now, ...NO_CANDIDATE });
  const { note, returnOn } = validateStateInput(o.status, { note: o.note, returnOn: o.returnOn, requireNote: o.requireNote ?? false });
  return write(db, deviceId, sessionId, { status: o.status, note, return_on: returnOn, set_by: o.setBy, set_at: now, ...NO_CANDIDATE });
}

export type ProposeStateOutcome = 'proposed' | 'set' | 'rejected_before' | 'already_set';

/**
 * 提案する。状態にはしない（状態にするのは利用者か、会話で利用者が選んだときだけ）。
 * 状態が付いていれば、同じでも違っても書かずに already_set を返す。読むときに状態を正とするので、書いても見えない提案になる。
 * 却下されていれば rejected_before を返す。提案があるところへの提案は上書きする（新しい発言の時点で前の提案は消えているので、残るのは同じターンの出し直しだけである）。
 */
export function proposeSessionState(db: Db, deviceId: string, sessionId: string, o: { status: 'paused' | 'done'; note: string; returnOn: string | null; source: CandidateSource; now?: number }): { state: SessionStateDto; outcome: Exclude<ProposeStateOutcome, 'set'> } {
  const { note, returnOn } = validateStateInput(o.status, { note: o.note, returnOn: o.returnOn, requireNote: true });
  const cur = liveRow(db, sessionId);
  if (cur && cur.status !== null) return { state: toStateDto(cur), outcome: 'already_set' };
  if (cur && cur.rejected_at !== null) return { state: toStateDto(cur), outcome: 'rejected_before' };
  const state = write(db, deviceId, sessionId, { candidate_status: o.status, candidate_note: note, candidate_return_on: returnOn, candidate_source: o.source, candidate_at: o.now ?? Date.now() });
  return { state, outcome: 'proposed' };
}

/**
 * 提案を確定する。提案の中身を状態に写し、set_by を user にする。
 * 日を変えたときだけ returnOn を渡す。Done の提案では戻る日を持たないので捨てる。
 */
export function confirmSessionState(db: Db, deviceId: string, sessionId: string, o: { returnOn?: string; now?: number } = {}): { state: SessionStateDto; result: 'confirmed' | 'not_candidate' } {
  const cur = liveRow(db, sessionId);
  const cand = cur ? visibleCandidate(cur) : null;
  if (!cur || !cand) return { state: cur ? toStateDto(cur) : NO_STATE, result: 'not_candidate' };
  const status = cand.status;
  const returnOn = returnOnOf(status, o.returnOn ?? cand.returnOn);
  const state = write(db, deviceId, sessionId, { status, note: cand.note, return_on: returnOn, set_by: 'user', set_at: o.now ?? Date.now(), ...NO_CANDIDATE });
  return { state, result: 'confirmed' };
}

/** 提案を却下する。提案を消して rejected_at に今の時刻を刻む。 */
export function rejectSessionState(db: Db, deviceId: string, sessionId: string, now = Date.now()): { state: SessionStateDto; result: 'rejected' | 'not_candidate' } {
  const cur = liveRow(db, sessionId);
  if (!cur || !visibleCandidate(cur)) return { state: cur ? toStateDto(cur) : NO_STATE, result: 'not_candidate' };
  return { state: write(db, deviceId, sessionId, { ...NO_CANDIDATE, rejected_at: now }), result: 'rejected' };
}

/**
 * 状態（status・note・return_on・set_by・set_at）を外すか。resume した後の発言だけで外す。
 * 発言が set_at より後で、かつ、その発言を出したプロセスが set_at より後に起動したものであるときに限る。
 * 同じプロセスの続きの発言では外さない。会話で Paused を選んだ直後の一言で外れてしまう。
 * 起動時刻が取れないときも外さない。利用者の目に見えない所で消えるより、残る方が害が小さい。
 * 起動時刻は引くのに手間がかかるので、発言が set_at より後のときだけ引く。
 */
function stateClears(cur: StateRow, promptTs: number, processStartOf: () => number | null): boolean {
  if (cur.status === null) return false;
  const setAt = cur.set_at ?? 0;
  if (promptTs <= setAt) return false;
  const started = processStartOf();
  return started !== null && started > setAt;
}

/**
 * 利用者の新しい発言（promptTs）で、古くなったものを外す。何か外したら true を返す。
 * 状態は resume した後の発言だけで外す（stateClears）。
 * 提案と却下の印は、発言がそれぞれの時刻より後なら外す。会話を続けたら前の提案は古く、却下の後に続けたらまた提案を出してよい。
 * 状態が無いときの set_at（Active に戻した時刻）は比べない。
 * 外すものが何も無ければ書かない。発言は数が多いので、毎回書くと D1 の無料枠を食う。
 */
export function clearOnNewPrompt(db: Db, deviceId: string, sessionId: string, promptTs: number, processStartOf: () => number | null): boolean {
  const cur = liveRow(db, sessionId);
  if (!cur) return false;
  const patch: Partial<StateRow> = {};
  if (stateClears(cur, promptTs, processStartOf)) Object.assign(patch, NO_STATUS);
  if (cur.candidate_at !== null && promptTs > cur.candidate_at) Object.assign(patch, NO_CANDIDATE);
  if (cur.rejected_at !== null && promptTs > cur.rejected_at) patch.rejected_at = null;
  if (Object.keys(patch).length === 0) return false;
  write(db, deviceId, sessionId, patch);
  return true;
}
