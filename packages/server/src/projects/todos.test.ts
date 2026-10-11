import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { MessageError } from '../i18n/message.ts';
import { acceptTodo, addTodo, confirmTodo, listTodos, proposeTodoDone, rejectTodo, removeTodo, reorderTodos, restoreTodos, setTodoDone, setTodoText } from './todos.ts';

function seed() {
  const db = openDb(':memory:');
  upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
  upsertShared(db, 'projects', { id: 'p2', name: 'beta', status: 'active', is_scratch: 0 }, 'd');
  // todos.session_id は sessions(id) への外部キーなので、紐付ける先を実際に作っておく。
  upsertShared(db, 'sessions', { id: 's1', provider: 'claude-code', provider_session_id: 's1', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
  return db;
}

describe('todos', () => {
  it('追加は position を伸ばし、一覧は position 順', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: '  最初 ' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: '次', sessionId: 's1' });
    addTodo(db, 'd', { projectId: 'p2', text: '別' });
    expect(a).toMatchObject({ projectId: 'p1', text: '最初', done: false, position: 1, sessionId: null });
    expect(b).toMatchObject({ position: 2, sessionId: 's1' });
    expect(listTodos(db, 'p1').map((t) => t.text)).toEqual(['最初', '次']);
    expect(listTodos(db).map((t) => t.text)).toEqual(['最初', '次', '別']);
    expect(() => addTodo(db, 'd', { projectId: 'p1', text: '   ' })).toThrow();
  });
  it('完了の切り替えと削除。削除した番号は再利用しない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(setTodoDone(db, 'd', a.id, true)).toMatchObject({ id: a.id, done: true });
    expect(setTodoDone(db, 'd', 'nope', true)).toBeNull();
    expect(removeTodo(db, 'd', a.id)).toMatchObject({ id: a.id });
    expect(listTodos(db, 'p1')).toEqual([]);
    expect(removeTodo(db, 'd', a.id)).toBeNull();
    expect(addTodo(db, 'd', { projectId: 'p1', text: 'b' }).position).toBe(2);
    // 書き込みは 4 回だが、未送信の差分は同じ行ごとに 1 つへまとまる（design.md の「未送信の行は同じ (table_name, row_id) ごとに 1 行へまとめてよい」）。
    // 残るのは a の delete と b の upsert の 2 行である。
    const ops = db.prepare("select row_id, op from changes where table_name = 'todos' order by seq").all() as { row_id: string; op: string }[];
    expect(ops.map((o) => o.op)).toEqual(['delete', 'upsert']);
    expect(ops.map((o) => o.row_id)).toEqual([a.id, expect.any(String)]);
  });
});

describe('完了の候補', () => {
  const row = (db: ReturnType<typeof seed>, id: string) => db.prepare('select done, candidate_at, candidate_session_id, candidate_note, rejected_sessions from todos where id = ?').get(id);

  it('候補を出しても完了にはせず、出したセッションと根拠を持つ', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(a.candidate).toBeNull();
    const r = proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '直して確かめた', now: 500 });
    expect(r).toEqual({ outcome: 'proposed', todo: expect.objectContaining({ id: a.id, done: false, candidate: { sessionId: 's1', note: '直して確かめた', at: 500 } }) });
    expect(row(db, a.id)).toEqual({ done: 0, candidate_at: 500, candidate_session_id: 's1', candidate_note: '直して確かめた', rejected_sessions: '[]' });
    expect(proposeTodoDone(db, 'd', 'nope', { sessionId: 's1', note: 'x' })).toBeNull();
  });

  it('すでに候補なら根拠を上書きせず、完了なら何もしない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '最初の根拠', now: 500 });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '書き換え', now: 900 })?.outcome).toBe('already_candidate');
    expect(row(db, a.id)).toMatchObject({ candidate_at: 500, candidate_note: '最初の根拠' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    setTodoDone(db, 'd', b.id, true);
    expect(proposeTodoDone(db, 'd', b.id, { sessionId: 's1', note: 'x' })?.outcome).toBe('already_done');
    expect(row(db, b.id)).toMatchObject({ done: 1, candidate_at: null });
  });

  it('確定は完了にして候補を消す。完了済みは何もせず、候補でない未完は断る', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('not_candidate');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    expect(confirmTodo(db, 'd', a.id)).toEqual({ result: 'confirmed', todo: expect.objectContaining({ done: true, candidate: null }) });
    expect(row(db, a.id)).toMatchObject({ done: 1, candidate_at: null, candidate_session_id: null, candidate_note: null });
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('already_done');
    expect(confirmTodo(db, 'd', 'nope')).toBeNull();
  });

  it('却下は未完に戻し、出したセッションを一度だけ積み、同じセッションからは出し直せない', () => {
    const db = seed();
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 's2', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(rejectTodo(db, 'd', a.id)?.result).toBe('not_candidate');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    expect(rejectTodo(db, 'd', a.id)).toEqual({ result: 'rejected', todo: expect.objectContaining({ done: false, candidate: null }) });
    expect(row(db, a.id)).toMatchObject({ done: 0, candidate_at: null, rejected_sessions: '["s1"]' });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'もう一度' })?.outcome).toBe('rejected_before');
    // 別のセッションなら出せる。そのセッションを却下すると積み足される。
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's2', note: '別' })?.outcome).toBe('proposed');
    rejectTodo(db, 'd', a.id);
    expect(row(db, a.id)).toMatchObject({ rejected_sessions: '["s1","s2"]' });
    expect(rejectTodo(db, 'd', 'nope')).toBeNull();
  });

  it('セッションの分からない候補は、却下しても積まないので出し直せる', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: null, note: null });
    expect(listTodos(db, 'p1')[0]!.candidate).toMatchObject({ sessionId: null, note: null });
    rejectTodo(db, 'd', a.id);
    expect(row(db, a.id)).toMatchObject({ rejected_sessions: '[]' });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: null, note: null })?.outcome).toBe('proposed');
  });

  it('利用者がチェックを付け外しすると候補は消え、開き直しても却下の記録は残す', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    rejectTodo(db, 'd', a.id);
    upsertShared(db, 'sessions', { id: 's2', provider: 'claude-code', provider_session_id: 's2', cwd: '/tmp/alpha', home_device: 'd' }, 'd');
    proposeTodoDone(db, 'd', a.id, { sessionId: 's2', note: 'n' });
    expect(setTodoDone(db, 'd', a.id, true)).toMatchObject({ done: true, candidate: null });
    expect(setTodoDone(db, 'd', a.id, false)).toMatchObject({ done: false, candidate: null });
    expect(row(db, a.id)).toMatchObject({ candidate_at: null, rejected_sessions: '["s1"]' });
  });

  it('完了かつ候補という矛盾した行は、完了として読み、候補は無いものとする', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    // 同期でしか起きない形を直接作る。
    db.prepare('update todos set done = 1, candidate_at = 5, candidate_session_id = ? where id = ?').run('s1', a.id);
    expect(listTodos(db, 'p1')[0]).toMatchObject({ done: true, candidate: null });
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' })?.outcome).toBe('already_done');
    expect(confirmTodo(db, 'd', a.id)?.result).toBe('already_done');
  });

  it('rejected_sessions が壊れていても投げずに空として読む', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    db.prepare("update todos set rejected_sessions = 'not json' where id = ?").run(a.id);
    expect(proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' })?.outcome).toBe('proposed');
  });
});

describe('Claude の提案', () => {
  const row = (db: ReturnType<typeof seed>, id: string) => db.prepare('select done, position, suggested_at, suggested_note, candidate_at from todos where id = ?').get(id);

  it('提案として足すと、理由と時刻を持ち、番号は確定の TODO と同じく伸ばす', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(a.suggestion).toBeNull();
    const s = addTodo(db, 'd', { projectId: 'p1', text: ' 提案 ', sessionId: 's1', suggested: true, note: '試験が足りない', now: 700 });
    expect(s).toMatchObject({ text: '提案', done: false, position: 2, sessionId: 's1', candidate: null, suggestion: { note: '試験が足りない', at: 700 } });
    // 理由は省ける。
    expect(addTodo(db, 'd', { projectId: 'p1', text: 'b', suggested: true }).suggestion).toEqual({ note: null, at: expect.any(Number) });
  });

  it('受け入れると提案の列を消し、削除した行も含めた最大値の次へ置く。提案でなければ not_suggestion', () => {
    const db = seed();
    const s = addTodo(db, 'd', { projectId: 'p1', text: '提案', suggested: true, note: 'n' });
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const gone = addTodo(db, 'd', { projectId: 'p1', text: '消す' });
    removeTodo(db, 'd', gone.id);
    const r = acceptTodo(db, 'd', s.id);
    expect(r).toEqual({ result: 'accepted', todo: expect.objectContaining({ id: s.id, position: 4, suggestion: null }) });
    expect(row(db, s.id)).toMatchObject({ suggested_at: null, suggested_note: null, position: 4 });
    expect(listTodos(db, 'p1').map((t) => t.text)).toEqual(['a', '提案']);
    expect(acceptTodo(db, 'd', a.id)?.result).toBe('not_suggestion');
    expect(acceptTodo(db, 'd', s.id)?.result).toBe('not_suggestion');
    expect(acceptTodo(db, 'd', 'nope')).toBeNull();
    expect(acceptTodo(db, 'd', gone.id)).toBeNull();
  });

  it('提案の行は、完了の候補にも、完了にも、確定にもならず、何も書かない', () => {
    const db = seed();
    const s = addTodo(db, 'd', { projectId: 'p1', text: '提案', suggested: true });
    const before = db.prepare('select count(*) c from changes').get();
    expect(proposeTodoDone(db, 'd', s.id, { sessionId: 's1', note: 'n' })).toEqual({ outcome: 'not_accepted', todo: expect.objectContaining({ id: s.id, candidate: null }) });
    // チェックは書かずに今の行を返す。呼び手は suggestion が残っていることで断られたと分かる。
    expect(setTodoDone(db, 'd', s.id, true)).toMatchObject({ id: s.id, done: false, suggestion: { note: null } });
    expect(confirmTodo(db, 'd', s.id)?.result).toBe('not_accepted');
    expect(db.prepare('select count(*) c from changes').get()).toEqual(before);
    expect(row(db, s.id)).toMatchObject({ done: 0, candidate_at: null });
  });

  it('見送りは論理削除で、提案のまま消える', () => {
    const db = seed();
    const s = addTodo(db, 'd', { projectId: 'p1', text: '提案', suggested: true });
    expect(removeTodo(db, 'd', s.id)).toMatchObject({ id: s.id });
    expect(listTodos(db, 'p1')).toEqual([]);
  });

  it('完了かつ提案という矛盾した行は、完了として読み、提案は無いものとする', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    db.prepare('update todos set done = 1, suggested_at = 5 where id = ?').run(a.id);
    expect(listTodos(db, 'p1')[0]).toMatchObject({ done: true, suggestion: null });
  });
});

describe('文言の書き換え', () => {
  it('前後の空白を落として書き、空白だけは断る。同じ文言なら書かない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    expect(setTodoText(db, 'd', a.id, '  直した ')).toMatchObject({ id: a.id, text: '直した' });
    expect(() => setTodoText(db, 'd', a.id, '   ')).toThrow(MessageError);
    expect(listTodos(db, 'p1')[0]!.text).toBe('直した');
    const before = db.prepare('select count(*) c from changes').get();
    setTodoText(db, 'd', a.id, '直した');
    expect(db.prepare('select count(*) c from changes').get()).toEqual(before);
    expect(setTodoText(db, 'd', 'nope', 'x')).toBeNull();
  });

  it('提案の行の文言も直せる。提案のまま残る', () => {
    const db = seed();
    const s = addTodo(db, 'd', { projectId: 'p1', text: '提案', suggested: true, note: 'n' });
    expect(setTodoText(db, 'd', s.id, '直した提案')).toMatchObject({ text: '直した提案', suggestion: { note: 'n' } });
  });
});

describe('並べ替え', () => {
  const positions = (db: ReturnType<typeof seed>) => Object.fromEntries((db.prepare('select text, position from todos order by text').all() as { text: string; position: number }[]).map((r) => [r.text, r.position]));

  it('渡した行の今の番号を昇順にして、新しい並びに配り直す。最大値は変わらない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const gone = addTodo(db, 'd', { projectId: 'p1', text: 'gone' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    const c = addTodo(db, 'd', { projectId: 'p1', text: 'c' });
    removeTodo(db, 'd', gone.id);
    const r = reorderTodos(db, 'd', 'p1', [c.id, a.id, b.id]);
    expect(r?.map((t) => t.text)).toEqual(['c', 'a', 'b']);
    // a、b、c の番号 1、3、4 を c、a、b に配る。消した行の 2 は動かさない。
    expect(positions(db)).toEqual({ a: 3, b: 4, c: 1, gone: 2 });
    expect(addTodo(db, 'd', { projectId: 'p1', text: 'd' }).position).toBe(5);
  });

  it('番号の変わった行だけ書く', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    const c = addTodo(db, 'd', { projectId: 'p1', text: 'c' });
    db.prepare('update changes set pushed_at = 1').run();
    reorderTodos(db, 'd', 'p1', [b.id, a.id, c.id]);
    const written = (db.prepare("select row_id from changes where table_name = 'todos' and pushed_at is null").all() as { row_id: string }[]).map((r) => r.row_id).sort();
    expect(written).toEqual([a.id, b.id].sort());
  });

  it('プロジェクトの外、消した行、見つからない ID、重複、提案が混ざれば、全体を断って何も書かない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    const other = addTodo(db, 'd', { projectId: 'p2', text: 'other' });
    const gone = addTodo(db, 'd', { projectId: 'p1', text: 'gone' });
    removeTodo(db, 'd', gone.id);
    const s = addTodo(db, 'd', { projectId: 'p1', text: 's', suggested: true });
    const before = positions(db);
    expect(reorderTodos(db, 'd', 'p1', [b.id, other.id, a.id])).toBeNull();
    expect(reorderTodos(db, 'd', 'p1', [b.id, gone.id, a.id])).toBeNull();
    expect(reorderTodos(db, 'd', 'p1', [b.id, 'nope', a.id])).toBeNull();
    expect(reorderTodos(db, 'd', 'p1', [b.id, a.id, b.id])).toBeNull();
    expect(reorderTodos(db, 'd', 'p1', [b.id, s.id, a.id])).toBeNull();
    expect(positions(db)).toEqual(before);
  });
});

describe('取り消し（restoreTodos）', () => {
  const fullRow = (db: ReturnType<typeof seed>, id: string) => db.prepare('select * from todos where id = ?').get(id) as Record<string, unknown>;

  it('消した行を、渡した中身で生き返らせる', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const snap = proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: '根拠', now: 300 })!.todo;
    removeTodo(db, 'd', a.id);
    const r = restoreTodos(db, 'd', [snap]);
    expect(r).toEqual([expect.objectContaining({ id: a.id, text: 'a', done: false, position: 1, candidate: { sessionId: 's1', note: '根拠', at: 300 }, suggestion: null })]);
    expect(fullRow(db, a.id).deleted_at).toBeNull();
    expect(listTodos(db, 'p1').map((t) => t.id)).toEqual([a.id]);
  });

  it('文言、完了、番号、候補、提案を戻し、却下の記録とプロジェクトは変えない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    proposeTodoDone(db, 'd', a.id, { sessionId: 's1', note: 'n' });
    rejectTodo(db, 'd', a.id);
    const snap = listTodos(db, 'p1')[0]!;
    setTodoText(db, 'd', a.id, '変えた');
    setTodoDone(db, 'd', a.id, true);
    restoreTodos(db, 'd', [{ ...snap, position: 9, suggestion: { note: '理由', at: 400 } }]);
    expect(fullRow(db, a.id)).toMatchObject({ text: 'a', done: 0, position: 9, candidate_at: null, suggested_at: 400, suggested_note: '理由', rejected_sessions: '["s1"]', project_id: 'p1' });
  });

  it('並べ替えを戻すと、元の並びになる', () => {
    const db = seed();
    addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    addTodo(db, 'd', { projectId: 'p1', text: 'c' });
    const snap = listTodos(db, 'p1');
    reorderTodos(db, 'd', 'p1', [snap[2]!.id, snap[0]!.id, snap[1]!.id]);
    restoreTodos(db, 'd', snap);
    expect(listTodos(db, 'p1').map((t) => t.text)).toEqual(['a', 'b', 'c']);
  });

  it('完了かつ候補は候補を捨て、完了かつ提案は提案を捨て、提案かつ候補は候補を捨てる', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const cand = { sessionId: 's1', note: 'n', at: 5 };
    const sug = { note: 'r', at: 6 };
    restoreTodos(db, 'd', [{ ...a, done: true, candidate: cand }]);
    expect(fullRow(db, a.id)).toMatchObject({ done: 1, candidate_at: null, candidate_session_id: null, candidate_note: null });
    restoreTodos(db, 'd', [{ ...a, done: true, suggestion: sug }]);
    expect(fullRow(db, a.id)).toMatchObject({ done: 1, suggested_at: null, suggested_note: null });
    restoreTodos(db, 'd', [{ ...a, done: false, candidate: cand, suggestion: sug }]);
    expect(fullRow(db, a.id)).toMatchObject({ done: 0, candidate_at: null, suggested_at: 6 });
  });

  it('見つからない行か、プロジェクトの違う行が 1 つでも混ざれば、全体を断って何も書かない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    removeTodo(db, 'd', a.id);
    expect(restoreTodos(db, 'd', [a, { ...b, id: 'nope' }])).toBeNull();
    expect(restoreTodos(db, 'd', [a, { ...b, projectId: 'p2' }])).toBeNull();
    expect(fullRow(db, a.id).deleted_at).not.toBeNull();
    expect(fullRow(db, b.id).project_id).toBe('p1');
  });

  it('空白だけの文言は断り、何も書かない', () => {
    const db = seed();
    const a = addTodo(db, 'd', { projectId: 'p1', text: 'a' });
    const b = addTodo(db, 'd', { projectId: 'p1', text: 'b' });
    expect(() => restoreTodos(db, 'd', [{ ...a, text: 'A' }, { ...b, text: '  ' }])).toThrow(MessageError);
    expect(fullRow(db, a.id).text).toBe('a');
  });
});
