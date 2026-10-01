import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { clearOnNewPrompt, confirmSessionState, getSessionState, NO_STATE, proposeSessionState, rejectSessionState, setSessionState, StateInputError } from './states.ts';

function seed() {
  const db = openDb(':memory:');
  // session_states.session_id は sessions(id) への外部キーなので、紐付ける先を実際に作っておく。
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 'u1', cwd: '/w', home_device: 'd' }, 'd');
  return db;
}
type Db = ReturnType<typeof seed>;
const row = (db: Db) => db.prepare('select status, note, return_on, set_by, set_at, candidate_status, candidate_note, candidate_return_on, candidate_source, candidate_at, rejected_at from session_states where session_id = ?').get('s1');
/**
 * 最後に積んだ変更の連番。書いたかどうかはこれで見る。
 * 件数では見られない。未送信の差分は同じ行ごとに 1 つへまとまる（db/shared.ts の dropUnpushed）ので、書き直しても件数は変わらない。
 */
const lastSeq = (db: Db) => (db.prepare("select max(seq) s from changes where table_name = 'session_states'").get() as { s: number | null }).s;
const paused = { status: 'paused' as const, note: '明日の朝 CPU の数字を見る', returnOn: '2026-10-02', source: 'in_session' as const };

describe('提案する', () => {
  it('提案も却下も無ければ候補を埋め、状態は書かない', () => {
    const db = seed();
    expect(getSessionState(db, 's1')).toBeNull();
    const r = proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    expect(r).toEqual({ outcome: 'proposed', state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: { status: 'paused', note: '明日の朝 CPU の数字を見る', returnOn: '2026-10-02', source: 'in_session', at: 100 } } });
    expect(row(db)).toEqual({ status: null, note: null, return_on: null, set_by: null, set_at: null, candidate_status: 'paused', candidate_note: '明日の朝 CPU の数字を見る', candidate_return_on: '2026-10-02', candidate_source: 'in_session', candidate_at: 100, rejected_at: null });
    expect(lastSeq(db)).not.toBeNull();
  });
  it('提案があるところへの提案は上書きする。Done の提案は戻る日を持たない', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const r = proposeSessionState(db, 'd', 's1', { status: 'done', note: '直して main に入れた', returnOn: '2026-10-02', source: 'post_hoc', now: 200 });
    expect(r.outcome).toBe('proposed');
    expect(r.state.candidate).toEqual({ status: 'done', note: '直して main に入れた', returnOn: null, source: 'post_hoc', at: 200 });
  });
  it('状態が付いていれば、同じでも違っても提案は書かずに already_set', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 50 });
    const before = lastSeq(db);
    expect(proposeSessionState(db, 'd', 's1', { status: 'done', note: 'n', returnOn: null, source: 'in_session' }).outcome).toBe('already_set');
    const r = proposeSessionState(db, 'd', 's1', { ...paused });
    expect(r).toEqual({ outcome: 'already_set', state: expect.objectContaining({ status: 'done', candidate: null }) });
    expect(lastSeq(db)).toBe(before);
  });
  it('却下したセッションは、新しい発言まで rejected_before', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    rejectSessionState(db, 'd', 's1', 200);
    expect(proposeSessionState(db, 'd', 's1', { ...paused, now: 300 }).outcome).toBe('rejected_before');
    expect(clearOnNewPrompt(db, 'd', 's1', 400, () => null)).toBe(true);
    expect(proposeSessionState(db, 'd', 's1', { ...paused, now: 500 }).outcome).toBe('proposed');
  });
});

describe('会話で選ぶ・手で選ぶ', () => {
  it('会話で選ぶ：どれでも状態を書き、set_by を conversation にし、提案を消す', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const s = setSessionState(db, 'd', 's1', { status: 'done', note: '直した', setBy: 'conversation', now: 150 });
    expect(s).toEqual({ status: 'done', note: '直した', returnOn: null, setBy: 'conversation', setAt: 150, candidate: null });
  });
  it('手で選ぶ：Done と Archived は戻る日を持たず、Paused は戻る日が要る', () => {
    const db = seed();
    expect(setSessionState(db, 'd', 's1', { status: 'done', returnOn: '2026-10-02', setBy: 'user', now: 1 })).toMatchObject({ status: 'done', returnOn: null, setBy: 'user' });
    expect(setSessionState(db, 'd', 's1', { status: 'archived', setBy: 'user', now: 2 })).toMatchObject({ status: 'archived', returnOn: null });
    expect(setSessionState(db, 'd', 's1', { status: 'paused', note: '', returnOn: '2026-10-02', setBy: 'user', now: 3 })).toEqual({ status: 'paused', note: null, returnOn: '2026-10-02', setBy: 'user', setAt: 3, candidate: null });
    expect(() => setSessionState(db, 'd', 's1', { status: 'paused', setBy: 'user' })).toThrow(new StateInputError('Paused には戻る日が要ります'));
  });
  it('印なしに戻す：状態・理由・戻る日・提案を消し、rejected_at は残す', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    rejectSessionState(db, 'd', 's1', 200);
    setSessionState(db, 'd', 's1', { status: 'paused', note: '見る', returnOn: '2026-10-02', setBy: 'user', now: 300 });
    expect(setSessionState(db, 'd', 's1', { status: null, setBy: 'user', now: 400 })).toEqual({ status: null, note: null, returnOn: null, setBy: 'user', setAt: 400, candidate: null });
    expect(row(db)).toMatchObject({ rejected_at: 200, candidate_at: null });
  });
});

describe('確定と却下', () => {
  it('確定：提案の中身を写し、日を変えればその日にする', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const r = confirmSessionState(db, 'd', 's1', { returnOn: '2026-10-05', now: 200 });
    expect(r).toEqual({ result: 'confirmed', state: { status: 'paused', note: '明日の朝 CPU の数字を見る', returnOn: '2026-10-05', setBy: 'user', setAt: 200, candidate: null } });
  });
  it('Done の提案の確定は戻る日を持たない', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { status: 'done', note: '済んだ', returnOn: null, source: 'exit', now: 100 });
    expect(confirmSessionState(db, 'd', 's1', { returnOn: '2026-10-05', now: 200 }).state).toMatchObject({ status: 'done', returnOn: null, note: '済んだ' });
  });
  it('確定のときの日は検査し、誤っていれば何も書かない', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    const before = lastSeq(db);
    expect(() => confirmSessionState(db, 'd', 's1', { returnOn: '2026-02-30' })).toThrow(StateInputError);
    expect(lastSeq(db)).toBe(before);
    expect(getSessionState(db, 's1')!.candidate).not.toBeNull();
  });
  it('却下：提案を消して rejected_at を刻む', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    expect(rejectSessionState(db, 'd', 's1', 200)).toEqual({ result: 'rejected', state: { status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null } });
    expect(row(db)).toMatchObject({ candidate_at: null, candidate_status: null, rejected_at: 200 });
  });
  it('提案が無ければ、確定も却下も not_candidate で何も書かない', () => {
    const db = seed();
    expect(confirmSessionState(db, 'd', 's1')).toEqual({ result: 'not_candidate', state: NO_STATE });
    expect(rejectSessionState(db, 'd', 's1')).toEqual({ result: 'not_candidate', state: NO_STATE });
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    const before = lastSeq(db);
    expect(confirmSessionState(db, 'd', 's1').result).toBe('not_candidate');
    expect(rejectSessionState(db, 'd', 's1').result).toBe('not_candidate');
    expect(lastSeq(db)).toBe(before);
  });
});

describe('新しい発言', () => {
  /** プロセスの起動時刻を返す偽物。引いた回数も数える。 */
  const startedAt = (t: number | null) => { const f = () => { f.calls += 1; return t; }; f.calls = 0; return f; };
  const EMPTY = { status: null, note: null, return_on: null, set_by: null, set_at: null, candidate_status: null, candidate_note: null, candidate_return_on: null, candidate_source: null, candidate_at: null, rejected_at: null };

  it('resume した後の発言（プロセスの起動が set_at より後）なら、状態を全部消して true', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'paused', note: '見る', returnOn: '2026-10-02', setBy: 'conversation', now: 100 });
    expect(clearOnNewPrompt(db, 'd', 's1', 300, startedAt(200))).toBe(true);
    expect(row(db)).toEqual(EMPTY);
    expect(getSessionState(db, 's1')).toEqual(NO_STATE);
  });
  // 実物の確かめ（2026-10-02）：会話で Paused を選んだ直後に、同じ会話で打った発言で外れていた。
  it('同じプロセスの続きの発言（プロセスの起動が set_at より前）では、状態を外さず書かない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'paused', note: '見る', returnOn: '2026-10-02', setBy: 'conversation', now: 100 });
    const before = lastSeq(db);
    expect(clearOnNewPrompt(db, 'd', 's1', 300, startedAt(50))).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 300, startedAt(100))).toBe(false);
    expect(getSessionState(db, 's1')).toMatchObject({ status: 'paused', note: '見る', setBy: 'conversation', setAt: 100 });
    expect(lastSeq(db)).toBe(before);
  });
  it('プロセスの起動時刻が取れなければ、状態を外さない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 100 });
    expect(clearOnNewPrompt(db, 'd', 's1', 300, startedAt(null))).toBe(false);
    expect(getSessionState(db, 's1')!.status).toBe('done');
  });
  it('発言の時刻が付けた時刻と同じか前なら、プロセスを問わず外さず、起動時刻も引かない', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 100 });
    const f = startedAt(500);
    expect(clearOnNewPrompt(db, 'd', 's1', 100, f)).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 99, f)).toBe(false);
    expect(getSessionState(db, 's1')!.status).toBe('done');
    expect(f.calls).toBe(0);
  });
  it('提案と却下は、プロセスを問わず、発言がそれぞれの時刻より後なら外す', () => {
    const db = seed();
    proposeSessionState(db, 'd', 's1', { ...paused, now: 100 });
    expect(clearOnNewPrompt(db, 'd', 's1', 50, startedAt(null))).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 150, startedAt(null))).toBe(true);
    expect(row(db)).toEqual(EMPTY);
    proposeSessionState(db, 'd', 's1', { ...paused, now: 200 });
    rejectSessionState(db, 'd', 's1', 300);
    expect(clearOnNewPrompt(db, 'd', 's1', 250, startedAt(null))).toBe(false);
    expect(clearOnNewPrompt(db, 'd', 's1', 350, startedAt(null))).toBe(true);
    expect(row(db)).toEqual(EMPTY);
  });
  // 導入時の一括 Done も同じ規則に従う。導入時に動いていた会話は、次に resume したときに外れる。
  it('一括 Done の行も、同じプロセスの続きでは外さず、resume した後の発言で外す', () => {
    const db = seed();
    db.prepare("insert into session_states (session_id, status, set_by, set_at, updated_at, origin_device) values ('s1', 'done', 'import', 1000, 0, 'import')").run();
    expect(clearOnNewPrompt(db, 'd', 's1', 2_000, startedAt(500))).toBe(false);
    expect(getSessionState(db, 's1')).toMatchObject({ status: 'done', setBy: 'import' });
    expect(clearOnNewPrompt(db, 'd', 's1', 3_000, startedAt(2_500))).toBe(true);
    expect(getSessionState(db, 's1')).toEqual(NO_STATE);
  });
  // 同期の競り合いで状態と提案を両方持つ行。続きの発言で提案だけが古くなる。
  it('状態と提案を両方持つ行に続きの発言が来たら、提案だけを外して状態は残す', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', note: '済', setBy: 'conversation', now: 100 });
    db.prepare("update session_states set candidate_status = 'paused', candidate_note = 'x', candidate_return_on = '2026-10-02', candidate_source = 'exit', candidate_at = 150, rejected_at = 120 where session_id = 's1'").run();
    expect(clearOnNewPrompt(db, 'd', 's1', 300, startedAt(50))).toBe(true);
    expect(row(db)).toEqual({ ...EMPTY, status: 'done', note: '済', set_by: 'conversation', set_at: 100 });
  });
  // Review Focus 2：発言は数が多い。状態の無いセッションで毎回書くと、D1 の無料枠を食う。
  it('行が無いか、状態も提案も却下も無ければ書かずに false', () => {
    const db = seed();
    expect(clearOnNewPrompt(db, 'd', 's1', 1_000, startedAt(500))).toBe(false);
    expect(lastSeq(db)).toBeNull();
    setSessionState(db, 'd', 's1', { status: null, setBy: 'user', now: 10 });
    const before = lastSeq(db);
    expect(clearOnNewPrompt(db, 'd', 's1', 2_000, startedAt(500))).toBe(false);
    expect(lastSeq(db)).toBe(before);
  });
});

describe('検査と読み方', () => {
  // Review Focus 4：UTF-16 の長さで数えると、絵文字 100 字で上限に当たる。
  it('理由は前後の空白と改行をたたみ、文字単位で 200 字まで', () => {
    const db = seed();
    expect(setSessionState(db, 'd', 's1', { status: 'done', note: '  一行目\n\n  二行目  ', setBy: 'user' }).note).toBe('一行目 二行目');
    expect(setSessionState(db, 'd', 's1', { status: 'done', note: '😀'.repeat(200), setBy: 'user' }).note).toBe('😀'.repeat(200));
    expect(() => setSessionState(db, 'd', 's1', { status: 'done', note: '😀'.repeat(201), setBy: 'user' })).toThrow(new StateInputError('理由は 200 字までです'));
  });
  it('requireNote を立てた確定は、根拠が空なら何も書かずに誤りにする。省けば今までどおり', () => {
    const db = seed();
    for (const note of [undefined, null, '', '   ']) {
      expect(() => setSessionState(db, 'd', 's1', { status: 'done', note, setBy: 'conversation', requireNote: true }), String(note)).toThrow(new StateInputError('根拠の一文が空です'));
    }
    expect(lastSeq(db)).toBeNull();
    expect(setSessionState(db, 'd', 's1', { status: 'done', note: '済', setBy: 'conversation', requireNote: true }).note).toBe('済');
    expect(setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', requireNote: false }).note).toBeNull();
  });
  it('Done の戻る日は捨てるが、形は先に検査する', () => {
    const db = seed();
    expect(() => setSessionState(db, 'd', 's1', { status: 'done', note: 'n', returnOn: 'garbage', setBy: 'user' })).toThrow(new StateInputError('戻る日は YYYY-MM-DD の形の、暦にある日付です'));
    expect(() => proposeSessionState(db, 'd', 's1', { status: 'done', note: 'n', returnOn: '2026-02-30', source: 'in_session' })).toThrow(StateInputError);
    expect(lastSeq(db)).toBeNull();
    expect(setSessionState(db, 'd', 's1', { status: 'done', note: 'n', returnOn: '2026-10-02', setBy: 'user' }).returnOn).toBeNull();
  });
  it('提案の根拠は 1 字以上が要る。戻る日は暦にある日だけ。どれも何も書かない', () => {
    const db = seed();
    expect(() => proposeSessionState(db, 'd', 's1', { ...paused, note: '   ' })).toThrow(new StateInputError('根拠の一文が空です'));
    expect(() => proposeSessionState(db, 'd', 's1', { ...paused, returnOn: null })).toThrow(new StateInputError('Paused には戻る日が要ります'));
    expect(() => proposeSessionState(db, 'd', 's1', { ...paused, returnOn: '2026-02-30' })).toThrow(new StateInputError('戻る日は YYYY-MM-DD の形の、暦にある日付です'));
    expect(lastSeq(db)).toBeNull();
  });
  it('同期で状態と提案の両方を持つ行は、状態を正として提案を出さない（書き直しはしない）', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    db.prepare("update session_states set candidate_status = 'paused', candidate_note = 'x', candidate_return_on = '2026-10-02', candidate_source = 'exit', candidate_at = 5 where session_id = 's1'").run();
    expect(getSessionState(db, 's1')).toMatchObject({ status: 'done', candidate: null });
    expect(row(db)).toMatchObject({ candidate_at: 5 });
  });
  // Ruling D：画面に出る提案と、確定・却下できる提案を同じ判定にする。
  it('状態と提案が両方ある行は、確定も却下も not_candidate（見えない提案は操作できない）', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    db.prepare("update session_states set candidate_status = 'paused', candidate_note = 'x', candidate_return_on = '2026-10-02', candidate_source = 'exit', candidate_at = 5 where session_id = 's1'").run();
    const before = lastSeq(db);
    expect(confirmSessionState(db, 'd', 's1').result).toBe('not_candidate');
    expect(rejectSessionState(db, 'd', 's1').result).toBe('not_candidate');
    expect(lastSeq(db)).toBe(before);
  });
  it('論理削除した行は無いものとして読む', () => {
    const db = seed();
    setSessionState(db, 'd', 's1', { status: 'done', setBy: 'user', now: 1 });
    db.prepare("update session_states set deleted_at = 9 where session_id = 's1'").run();
    expect(getSessionState(db, 's1')).toBeNull();
  });
});
