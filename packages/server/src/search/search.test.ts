import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { IndexerService } from '../indexer/service.ts';
import { copyFixtureClaudeDir, SESSION_ALPHA, SESSION_OTHER } from '../../test/fixtures.ts';
import { proposeSessionState, setSessionState } from '../sessions/states.ts';
import { likeSnippet, searchSessions } from './search.ts';

let dir: string;
let db: Db;
const idOf = (p: string) => (db.prepare('select id from sessions where provider_session_id = ?').get(p) as { id: string }).id;
/** そのセッションがファイルを触ったことにする。索引の行を 1 つ足すだけで、本文は要らない。 */
const touchFile = (sessionId: string, file: string) => db.prepare("insert into event_index (session_id, seq, kind, file_path_ref, byte_offset, byte_length, file_path) values (?, 9999, 'tool', 'x', 0, 0, ?)").run(sessionId, file);
beforeEach(async () => {
  dir = copyFixtureClaudeDir(); db = openDb(':memory:');
  await new IndexerService({ db, deviceId: 'd', claudeDir: dir, isRunning: () => false }).fullScan();
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('searchSessions', () => {
  it('日本語の部分一致で当たり、抜粋を返す', () => {
    const r = searchSessions(db, { q: 'チャンネル' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: idOf(SESSION_ALPHA), matchCount: 1 });
    expect(r.hits[0]!.snippets[0]!.text).toContain('チャンネル');
    expect(r.hits[0]!.snippets[0]!.role).toBe('user');
  });
  it('ハイフン入りの語も落ちない', () => {
    expect(() => searchSessions(db, { q: 'agent-hangar' })).not.toThrow();
  });
  it('複数語は AND', () => {
    expect(searchSessions(db, { q: 'channels hello' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels' }).total).toBe(1);
  });
  it('空の検索語は空の結果', () => {
    expect(searchSessions(db, { q: '' })).toEqual({ hits: [], total: 0 });
  });
  it('2 文字の語だけでも like で当たり、抜粋に語を含む', () => {
    const r = searchSessions(db, { q: '動画' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: idOf(SESSION_ALPHA), matchCount: 1 });
    expect(r.hits[0]!.snippets).toHaveLength(1);
    expect(r.hits[0]!.snippets[0]!.text).toContain('動画');
    expect(r.hits[0]!.snippets[0]!.role).toBe('user');
    expect(r.hits[0]!.snippets[0]!.seq).toBe(0);
  });
  it('短い語と長い語の混在は両方を満たす行だけ', () => {
    // この試験はトランスクリプトの当たりを見る。名前の列にも両方の語があるので、名前の列は空にしておく。
    db.prepare('update sessions set custom_title = null, ai_title = null, first_prompt = null').run();
    // channels は 3 行に現れるが、動画 を含む行は最初の依頼だけである。
    expect(searchSessions(db, { q: 'チャンネル 動画' })).toMatchObject({ total: 1, hits: [{ sessionId: idOf(SESSION_ALPHA), matchCount: 1 }] });
    expect(searchSessions(db, { q: 'channels 動画' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels ls' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels ls' }).hits[0]!.snippets[0]!.text).toContain('ls');
  });
  // seq は主線とサブエージェントで別々に振るので、同じ seq が両方にある。
  // 抜粋にどちらの行かを添え、主線を先に、seq の順に並べる。跳び先（J1）は主線の抜粋から取る。
  it('抜粋はどの線の行かを持ち、主線を先に seq の順で並べる', () => {
    const sid = idOf(SESSION_ALPHA);
    const ins = db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)');
    ins.run(sid, 'ag1', 0, 'assistant', 'サブで ぴよぴよ zebrafish を探す');
    ins.run(sid, null, 7, 'user', '主線の後ろで ぴよぴよ zebrafish');
    ins.run(sid, null, 3, 'user', '主線の前で ぴよぴよ zebrafish');
    for (const q of ['zebrafish', 'よぴ']) {
      const r = searchSessions(db, { q });
      expect(r.hits[0]!.snippets.map((x) => [x.agentId, x.seq])).toEqual([[null, 3], [null, 7], ['ag1', 0]]);
    }
  });
  it('どこにも無い短い語は空の結果', () => {
    expect(searchSessions(db, { q: 'zz' })).toEqual({ hits: [], total: 0 });
    expect(searchSessions(db, { q: 'channels zz' })).toEqual({ hits: [], total: 0 });
  });
  it('短い語だけの経路でも絞り込みは効く', () => {
    expect(searchSessions(db, { q: 'ls', live: 'running' }).total).toBe(0);
    expect(searchSessions(db, { q: 'ls', file: 'zzz' }).total).toBe(0);
    expect(searchSessions(db, { q: 'ls', until: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(1);
    expect(searchSessions(db, { q: '%' }).total).toBe(0);
  });
  it('プロジェクト、期間、実行中、ファイルで絞る', () => {
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    const alpha = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_ALPHA)) as Record<string, unknown>;
    upsertShared(db, 'sessions', { ...alpha, project_id: 'p1' }, 'd');
    expect(searchSessions(db, { q: 'channels', projectId: 'p1' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', projectId: 'p2' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', since: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', until: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(1);
    // 状態の判定は DB に無いので、呼ぶ側が provider_session_id と hangar の id から決める。
    // 既定は終了。
    expect(searchSessions(db, { q: 'channels', live: 'running' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', live: 'ended' }).total).toBe(1);
    const liveOf = (_sid: string, psid: string) => (psid === SESSION_ALPHA ? 'waiting' as const : 'ended' as const);
    expect(searchSessions(db, { q: 'channels', live: 'waiting' }, liveOf).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', live: 'running' }, liveOf).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', live: 'ended' }, liveOf).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', live: 'running' }, (sid) => (sid === idOf(SESSION_ALPHA) ? 'running' : 'ended')).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', file: 'a.md' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', file: 'zzz' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello' }).hits[0]!.sessionId).toBe(idOf(SESSION_OTHER));
  });
  // 一覧で「触ったファイル」だけを入れたとき、キーワードが無くても絞れるようにする。
  it('キーワードが空でも、ファイルがあればそのファイルを触ったセッションを新しい順に返す', () => {
    const r = searchSessions(db, { q: '', file: 'a.md' });
    expect(r.total).toBe(1);
    expect(r.hits).toEqual([{ sessionId: idOf(SESSION_ALPHA), matchCount: expect.any(Number), snippets: [] }]);
    expect(r.hits[0]!.matchCount).toBeGreaterThan(0);
    expect(searchSessions(db, { q: '  ', file: 'a.md' }).total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'zzz' })).toEqual({ hits: [], total: 0 });
    expect(searchSessions(db, { q: '', file: '%' })).toEqual({ hits: [], total: 0 });
    expect(searchSessions(db, { q: '', file: 'a.md', live: 'running' }).total).toBe(0);
    expect(searchSessions(db, { q: '', file: 'a.md', live: 'waiting' }, () => 'waiting').total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'a.md', since: Date.parse('2026-09-02T00:00:00Z') }).total).toBe(0);
    // ファイルも無ければ、これまでどおり空の結果である。一覧は手元で組む。
    expect(searchSessions(db, { q: '', projectId: 'p1' })).toEqual({ hits: [], total: 0 });
  });
  it('キーワードが空の経路も新しい順に並べる', () => {
    const alpha = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_ALPHA)) as Record<string, unknown>;
    const other = db.prepare('select * from sessions where id = ?').get(idOf(SESSION_OTHER)) as Record<string, unknown>;
    // 同じファイルを触ったことにして、2 件を並べる。
    touchFile(idOf(SESSION_OTHER), '/w/shared/a.md');
    upsertShared(db, 'sessions', { ...alpha, last_activity_at: 1000 }, 'd');
    upsertShared(db, 'sessions', { ...other, last_activity_at: 2000 }, 'd');
    expect(searchSessions(db, { q: '', file: 'a.md' }).hits.map((h) => h.sessionId)).toEqual([idOf(SESSION_OTHER), idOf(SESSION_ALPHA)]);
  });
  // 件数は全部を数え、行は limit で切る。続きは offset で読む。
  it('offset から limit 件だけを返し、total は全件の数', () => {
    touchFile(idOf(SESSION_OTHER), '/w/shared/a.md');
    const both = searchSessions(db, { q: '', file: 'a.md' });
    expect(both.total).toBe(2);
    const first = searchSessions(db, { q: '', file: 'a.md', limit: 1 });
    expect(first).toMatchObject({ total: 2, hits: [{ sessionId: both.hits[0]!.sessionId }] });
    const rest = searchSessions(db, { q: '', file: 'a.md', limit: 1, offset: 1 });
    expect(rest).toMatchObject({ total: 2, hits: [{ sessionId: both.hits[1]!.sessionId }] });
    expect(searchSessions(db, { q: 'channels', offset: 5 })).toEqual({ hits: [], total: 1 });
    expect(searchSessions(db, { q: 'channels', offset: -3 }).hits).toHaveLength(1);
  });
});

describe('searchSessions の状態（session_states）', () => {
  // マイグレーション v13 の一括 Done は空の DB で走るので、索引の後に入ったセッションには行が無く、Active である。
  it('Paused・Done・Archived は状態の列で、Active は状態が無いもので絞る', () => {
    const alpha = idOf(SESSION_ALPHA);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(1);
    setSessionState(db, 'd', alpha, { status: 'paused', note: '明日確かめる', returnOn: '2026-10-02', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'paused' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(0);
    // キーワードの無い、触ったファイルだけの経路でも効く。
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'paused' }).total).toBe(1);
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: '', file: 'a.md', status: 'active' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).hits.map((h) => h.sessionId)).toEqual([idOf(SESSION_OTHER)]);
    // 手で Active に戻した行（status が null の行）も Active に入る。
    setSessionState(db, 'd', alpha, { status: null, setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(1);
  });
  it('確かめるは、状態の無い行に残った提案だけを数える。提案のある行は Active にも入る', () => {
    const other = idOf(SESSION_OTHER);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    proposeSessionState(db, 'd', other, { status: 'done', note: '直して push した', returnOn: null, source: 'post_hoc' });
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(1);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).total).toBe(1);
  });
  it('状態があれば提案は無いものとし、論理削除済みの行は無いものとする', () => {
    const other = idOf(SESSION_OTHER);
    setSessionState(db, 'd', other, { status: 'done', setBy: 'user' });
    // 書き込みの経路は状態を書くと提案を消すが、同期で両方が揃った行を想定して直に足す。
    db.prepare("update session_states set candidate_status = 'done', candidate_note = 'x', candidate_source = 'post_hoc', candidate_at = 1 where session_id = ?").run(other);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'done' }).total).toBe(1);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).total).toBe(0);
    // 行が論理削除されたら、状態も提案も無い Active に戻る。
    db.prepare('update session_states set deleted_at = 1 where session_id = ?').run(other);
    expect(searchSessions(db, { q: 'hello', status: 'done' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'proposed' }).total).toBe(0);
    expect(searchSessions(db, { q: 'hello', status: 'active' }).total).toBe(1);
  });
  it('「すべて」で条件を入れたとき（hideArchived）は Archived を除き、Archived のタブなら出す', () => {
    setSessionState(db, 'd', idOf(SESSION_ALPHA), { status: 'archived', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', hideArchived: true }).total).toBe(0);
    expect(searchSessions(db, { q: '', file: 'a.md', hideArchived: true }).total).toBe(0);
    expect(searchSessions(db, { q: 'channels', status: 'archived', hideArchived: true }).total).toBe(1);
  });
  it('Active は動きを見ない。動いていても止まっていても、状態が無ければ入り、状態があれば入らない', () => {
    const alpha = idOf(SESSION_ALPHA);
    const running = (sid: string) => (sid === alpha ? 'running' as const : 'ended' as const);
    expect(searchSessions(db, { q: 'channels', status: 'active' }).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'active' }, running).total).toBe(1);
    setSessionState(db, 'd', alpha, { status: 'done', setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'active' }, running).total).toBe(0);
    // 動きの条件と重ねれば、動いている Active だけに絞れる。
    setSessionState(db, 'd', alpha, { status: null, setBy: 'user' });
    expect(searchSessions(db, { q: 'channels', status: 'active', live: 'running' }, running).total).toBe(1);
    expect(searchSessions(db, { q: 'channels', status: 'active', live: 'running' }).total).toBe(0);
  });
});

// 名前と要約の照合（設計書 4.2 の 3）。名前は session_notes.name、sessions の custom_title・ai_title・first_prompt、要約は session_summaries の title・one_liner・body。
describe('searchSessions の名前と要約', () => {
  const alpha = () => idOf(SESSION_ALPHA);
  const other = () => idOf(SESSION_OTHER);
  const beta = () => idOf('aaaaaaaa-0000-4000-8000-000000000002');
  const setCols = (sid: string, cols: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(cols)) db.prepare(`update sessions set ${k} = ? where id = ?`).run(v, sid);
  };
  const summary = (sid: string, s: { title?: string; one_liner?: string; body?: string }) =>
    upsertShared(db, 'session_summaries', { session_id: sid, title: s.title ?? '', one_liner: s.one_liner ?? '', body: s.body ?? '', state: 'done', next_steps: '[]', source: 'in_session', source_model: null, based_on_turns: 2 }, 'd', 'session_id');
  const note = (sid: string, name: string) => upsertShared(db, 'session_notes', { session_id: sid, name, memo: null, deleted_at: null }, 'd', 'session_id');
  const fts = (sid: string, seq: number, text: string) => db.prepare('insert into event_fts (session_id, agent_id, seq, role, text) values (?,?,?,?,?)').run(sid, null, seq, 'user', text);
  const ids = (r: { hits: { sessionId: string }[] }) => r.hits.map((h) => h.sessionId);
  // 3 本とも名前の列を空にして、固有の語だけで当たりを数えられるようにする。
  beforeEach(() => {
    for (const sid of [alpha(), other(), beta()]) setCols(sid, { custom_title: null, ai_title: null, first_prompt: null });
  });

  it('名前だけで当たると、matched は name、件数 0、抜粋は空', () => {
    note(alpha(), 'Quokka の整理');
    const r = searchSessions(db, { q: 'quokka' });
    expect(r).toEqual({ hits: [{ sessionId: alpha(), matchCount: 0, snippets: [], matched: ['name'] }], total: 1 });
  });
  it('名前の列は 4 つとも引く（session_notes.name、custom_title、ai_title、first_prompt）', () => {
    note(alpha(), 'wombatA');
    setCols(other(), { custom_title: 'wombatB' });
    setCols(beta(), { ai_title: 'wombatC' });
    expect(new Set(ids(searchSessions(db, { q: 'wombat' })))).toEqual(new Set([alpha(), other(), beta()]));
    setCols(beta(), { ai_title: null, first_prompt: 'start wombatD now' });
    const r = searchSessions(db, { q: 'wombatd' });
    expect(r.hits).toMatchObject([{ sessionId: beta(), matched: ['name'] }]);
  });
  it('名前の行が論理削除されていれば、その名前では当たらない', () => {
    note(alpha(), 'quokka');
    db.prepare('update session_notes set deleted_at = 1 where session_id = ?').run(alpha());
    expect(searchSessions(db, { q: 'quokka' })).toEqual({ hits: [], total: 0 });
  });
  it('要約だけで当たると matched は summary。title、one_liner、body のどれでも引く', () => {
    summary(alpha(), { title: 'platypus の件' });
    summary(other(), { one_liner: 'platypus を直した' });
    summary(beta(), { body: '長い本文の中に platypus が出る' });
    const r = searchSessions(db, { q: 'platypus' });
    expect(new Set(ids(r))).toEqual(new Set([alpha(), other(), beta()]));
    for (const h of r.hits) expect(h).toMatchObject({ matchCount: 0, snippets: [], matched: ['summary'] });
    db.prepare('update session_summaries set deleted_at = 1').run();
    expect(searchSessions(db, { q: 'platypus' }).total).toBe(0);
  });
  it('トランスクリプトだけで当たると matched は transcript で、これまでと同じ件数と抜粋', () => {
    fts(alpha(), 1, 'ここに axolotl がいる');
    const r = searchSessions(db, { q: 'axolotl' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: alpha(), matchCount: 1, matched: ['transcript'] });
    expect(r.hits[0]!.snippets[0]!.text).toContain('axolotl');
  });
  it('重なりは 1 件に数え、matched は name、summary、transcript の順に並べ、件数と抜粋も残す', () => {
    note(alpha(), 'okapi');
    summary(alpha(), { one_liner: 'okapi の要約' });
    fts(alpha(), 1, 'okapi の話');
    const r = searchSessions(db, { q: 'okapi' });
    expect(r.total).toBe(1);
    expect(r.hits[0]).toMatchObject({ sessionId: alpha(), matchCount: 1, matched: ['name', 'summary', 'transcript'] });
    expect(r.hits[0]!.snippets).toHaveLength(1);
  });
  it('名前か要約に当たった行を先頭に、トランスクリプトだけの行が続く。件数の多さでは入れ替わらない', () => {
    // alpha はトランスクリプトに 3 件、other は名前だけ、beta は要約だけ。
    fts(alpha(), 1, 'ocelot 1'); fts(alpha(), 2, 'ocelot 2'); fts(alpha(), 3, 'ocelot 3');
    note(other(), 'ocelot');
    summary(beta(), { title: 'ocelot' });
    setCols(other(), { last_activity_at: 1000 });
    setCols(beta(), { last_activity_at: 2000 });
    const r = searchSessions(db, { q: 'ocelot' });
    // 名前に当たった行が、要約だけの行より先。トランスクリプトだけの行は最後。
    expect(ids(r)).toEqual([other(), beta(), alpha()]);
    expect(r.hits.map((h) => h.matchCount)).toEqual([0, 0, 3]);
    expect(r.total).toBe(3);
  });
  it('先頭の組の中は、名前に当たった行を先に、同じ組の中は新しい順', () => {
    note(alpha(), 'lynx'); note(other(), 'lynx');
    summary(beta(), { title: 'lynx' });
    setCols(alpha(), { last_activity_at: 1000 });
    setCols(other(), { last_activity_at: 2000 });
    setCols(beta(), { last_activity_at: 3000 });
    expect(ids(searchSessions(db, { q: 'lynx' }))).toEqual([other(), alpha(), beta()]);
  });
  it('名前に当たった行はトランスクリプトに当たっていても先頭の組に入る', () => {
    fts(alpha(), 1, 'tapir'); fts(alpha(), 2, 'tapir'); fts(alpha(), 3, 'tapir');
    fts(other(), 1, 'tapir');
    note(other(), 'tapir');
    expect(ids(searchSessions(db, { q: 'tapir' }))).toEqual([other(), alpha()]);
  });
  it('offset をまたいでも、同じ並びを切り取り、total は重なりを除いた件数のまま', () => {
    fts(alpha(), 1, 'gecko');
    note(other(), 'gecko');
    summary(beta(), { body: 'gecko' });
    setCols(other(), { last_activity_at: 1000 });
    const all = searchSessions(db, { q: 'gecko' });
    expect(all.total).toBe(3);
    expect(ids(all)).toEqual([other(), beta(), alpha()]);
    const pages: string[] = [];
    for (let offset = 0; offset < 3; offset++) {
      const p = searchSessions(db, { q: 'gecko', limit: 1, offset });
      expect(p.total).toBe(3);
      pages.push(...ids(p));
    }
    expect(pages).toEqual(ids(all));
    // 2 件ずつの頁が、名前の組とトランスクリプトの組の境をまたぐ。
    expect(ids(searchSessions(db, { q: 'gecko', limit: 2, offset: 1 }))).toEqual([beta(), alpha()]);
    expect(searchSessions(db, { q: 'gecko', offset: 3 })).toEqual({ hits: [], total: 3 });
  });
  it('同じ時刻の行でも並びが決まり、頁をまたいでも重ならない', () => {
    for (const sid of [alpha(), other(), beta()]) { note(sid, 'heron'); setCols(sid, { last_activity_at: 5000 }); }
    const all = ids(searchSessions(db, { q: 'heron' }));
    expect(all).toEqual([...all].sort());
    expect(ids(searchSessions(db, { q: 'heron', limit: 1, offset: 1 }))).toEqual([all[1]]);
  });
  it('語が複数なら、名前の列、要約の列のそれぞれの中で全部の語を満たす行だけが当たる', () => {
    note(alpha(), 'ibex marmot');
    note(other(), 'ibex');
    summary(beta(), { title: 'marmot' });
    expect(ids(searchSessions(db, { q: 'ibex marmot' }))).toEqual([alpha()]);
    // 名前の語と要約の語を、またいで満たすことはしない。
    summary(other(), { title: 'marmot' });
    expect(ids(searchSessions(db, { q: 'ibex marmot' }))).toEqual([alpha()]);
    // 名前と要約が別の語を持っても、トランスクリプトに片方だけでも、またいでは当たらない。
    fts(beta(), 1, 'ibex');
    expect(ids(searchSessions(db, { q: 'ibex marmot' }))).toEqual([alpha()]);
  });
  it('2 文字の語、大文字小文字、ワイルドカードの扱いはトランスクリプトと同じ', () => {
    note(alpha(), 'Zebra ヨタ');
    expect(ids(searchSessions(db, { q: 'ヨタ' }))).toEqual([alpha()]);
    expect(ids(searchSessions(db, { q: 'ZEBRA' }))).toEqual([alpha()]);
    expect(ids(searchSessions(db, { q: 'zebra ヨタ' }))).toEqual([alpha()]);
    expect(searchSessions(db, { q: '%' }).total).toBe(0);
    expect(searchSessions(db, { q: '_' }).total).toBe(0);
    expect(searchSessions(db, { q: 'zz' }).total).toBe(0);
  });
  it('絞り込み（プロジェクト、期間、状態、動き、削除）は名前だけの行にも同じにかかる', () => {
    note(alpha(), 'civet'); note(other(), 'civet');
    upsertShared(db, 'projects', { id: 'p1', name: 'alpha', status: 'active', is_scratch: 0 }, 'd');
    setCols(alpha(), { project_id: 'p1', last_activity_at: 1000 });
    setCols(other(), { last_activity_at: 9000 });
    expect(ids(searchSessions(db, { q: 'civet', projectId: 'p1' }))).toEqual([alpha()]);
    expect(ids(searchSessions(db, { q: 'civet', since: 5000 }))).toEqual([other()]);
    expect(ids(searchSessions(db, { q: 'civet', until: 5000 }))).toEqual([alpha()]);
    setSessionState(db, 'd', alpha(), { status: 'done', setBy: 'user' });
    expect(ids(searchSessions(db, { q: 'civet', status: 'done' }))).toEqual([alpha()]);
    expect(ids(searchSessions(db, { q: 'civet', status: 'active' }))).toEqual([other()]);
    expect(ids(searchSessions(db, { q: 'civet', hideArchived: true }))).toHaveLength(2);
    setSessionState(db, 'd', alpha(), { status: 'archived', setBy: 'user' });
    expect(ids(searchSessions(db, { q: 'civet', hideArchived: true }))).toEqual([other()]);
    const liveOf = (sid: string) => (sid === other() ? 'running' as const : 'ended' as const);
    expect(ids(searchSessions(db, { q: 'civet', live: 'running' }, liveOf))).toEqual([other()]);
    expect(ids(searchSessions(db, { q: 'civet', live: 'ended' }, liveOf))).toEqual([alpha()]);
    // 動きで落ちた行は total にも数えない。
    expect(searchSessions(db, { q: 'civet', live: 'running' }, liveOf).total).toBe(1);
    db.prepare('update sessions set deleted_at = 1 where id = ?').run(other());
    expect(searchSessions(db, { q: 'civet' }).total).toBe(1);
  });
  it('触ったファイルとの組は、名前に当たった行でもそのファイルを触った行だけ', () => {
    note(alpha(), 'dingo'); note(other(), 'dingo');
    touchFile(alpha(), '/w/dingo/a.md');
    const r = searchSessions(db, { q: 'dingo', file: 'a.md' });
    expect(r.hits).toMatchObject([{ sessionId: alpha(), matched: ['name'] }]);
    expect(r.total).toBe(1);
  });
  it('語が無くファイルだけの検索は名前を引かず、matched も付けない', () => {
    note(alpha(), 'dingo');
    touchFile(alpha(), '/w/a.md');
    const r = searchSessions(db, { q: '', file: 'a.md' });
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]).not.toHaveProperty('matched');
  });
});

describe('likeSnippet', () => {
  it('短い本文はそのまま返す', () => {
    expect(likeSnippet('動画チャンネルの整理', '動画')).toBe('動画チャンネルの整理');
  });
  it('長い本文は語の前後 60 文字に切り、切った側に省略記号を置く', () => {
    const text = 'あ'.repeat(100) + '動画' + 'い'.repeat(100);
    const out = likeSnippet(text, '動画');
    expect(out.startsWith('…')).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    expect([...out].length).toBe(62);
    expect(out).toContain('動画');
  });
  it('大文字小文字を区別せずに探す', () => {
    expect(likeSnippet('x'.repeat(100) + 'LS', 'ls')).toContain('LS');
  });
  it('語が無ければ先頭を返す', () => {
    expect(likeSnippet('abc', 'zz')).toBe('abc');
  });
});
