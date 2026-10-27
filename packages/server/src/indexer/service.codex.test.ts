import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { assignSessions } from '../projects/registry.ts';
import { claudeTranscriptSource } from '../provider/claude-code/transcript/source.ts';
import { codexTranscriptSource, type CodexTranscriptSource } from '../provider/codex/transcript/source.ts';
import { readEvents } from '../transcript/read.ts';
import { copyFixtureClaudeDir } from '../../test/fixtures.ts';
import { CODEX_LEGACY, CODEX_ONE_TURN, CODEX_TOOLS, fixtureBytes, makeCodexHome, putRollout, rolloutName } from '../../test/codexFixtures.ts';
import { IndexerService } from './service.ts';

// Codex の本文を、実際の索引（IndexerService）に通す。rollout はすべて合成（test/fixtures/codex）。
// legacy は実物が手元に無いので、設計の推定どおりに作った合成である。
let claudeDir: string;
let home: string;
let db: Db;
let enabled: boolean;
beforeEach(() => { claudeDir = copyFixtureClaudeDir(); home = makeCodexHome(); db = openDb(':memory:'); enabled = true; });
afterEach(() => { fs.rmSync(claudeDir, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });

const codexSource = (o: { limit?: number } = {}): CodexTranscriptSource => codexTranscriptSource({ codexHome: () => home, enabled: () => enabled, importLimit: o.limit });
const makeSvc = (database: Db, sources: CodexTranscriptSource[]) =>
  new IndexerService({ db: database, deviceId: 'd', transcripts: [claudeTranscriptSource({ claudeDir }), ...sources], isRunning: () => false });
const one = <T>(sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T;
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { c: number }).c;
const codexSessions = () => db.prepare("select * from sessions where provider = 'codex' order by provider_session_id").all() as Record<string, any>[];
const put = (f: { file: string; id: string }, when: string) => putRollout(home, rolloutName(f.id, when).rel, fixtureBytes(f.file));

describe('IndexerService に Codex の本文を通す', () => {
  it('3 つの rollout（paginated 2、legacy の合成 1）が、provider が codex の会話として入る。題名の元は最初の実際の入力、cwd は本文から', async () => {
    put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    put(CODEX_TOOLS, '2026-10-25T09-00-00');
    put(CODEX_LEGACY, '2026-10-26T09-00-00');
    await makeSvc(db, [codexSource()]).fullScan();
    const rows = codexSessions();
    expect(rows.map((r) => r.provider_session_id)).toEqual([CODEX_ONE_TURN.id, CODEX_TOOLS.id, CODEX_LEGACY.id]);
    expect(rows.find((r) => r.provider_session_id === CODEX_ONE_TURN.id)).toMatchObject({ cwd: '/work/sample', first_prompt: 'List the files please' });
    expect(rows.find((r) => r.provider_session_id === CODEX_LEGACY.id)!.first_prompt).toBe('Say hello to the legacy reader');
    // 外の会話の cwd は、最後の thread_settings_applied を優先する。
    expect(rows.find((r) => r.provider_session_id === CODEX_TOOLS.id)!.cwd).toBe('/work/sample/sub');
    expect(count("select count(*) c from transcript_files where agent = 'codex'")).toBe(3);
    // 使用量：paginated は token_usage_record、legacy は token_count から。二重に数えない。
    const usage = (id: string) => one<{ i: number; o: number }>('select sum(input_tokens) i, sum(output_tokens) o from usage_daily u join sessions s on s.id = u.session_id where s.provider_session_id = ?', id);
    expect(usage(CODEX_ONE_TURN.id)).toEqual({ i: 1200, o: 70 });
    expect(usage(CODEX_TOOLS.id)).toEqual({ i: 1100, o: 70 });
    expect(usage(CODEX_LEGACY.id)).toEqual({ i: 400, o: 30 });
    // 編集したファイルの数は、apply_patch の Edit から数える。
    expect(one<{ n: number }>('select files_changed n from session_stats st join sessions s on s.id = st.session_id where s.provider_session_id = ?', CODEX_TOOLS.id).n).toBe(1);
    // Claude の会話は変わらず入る。
    expect(count("select count(*) c from sessions where provider = 'claude-code'")).toBeGreaterThan(0);
  });

  it('読み手：索引のバイト位置から本文を読み直して、events を返す（readEvents が provider で codex を引く）', async () => {
    put(CODEX_TOOLS, '2026-10-25T09-00-00');
    await makeSvc(db, [codexSource()]).fullScan();
    const id = codexSessions()[0]!.id as string;
    const page = readEvents(db, id, {});
    const kinds = page.events.map((e) => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('tool_call');
    expect(page.events.find((e) => e.kind === 'tool_call' && e.name === 'mcp__hangar__set_turn_intent')).toBeTruthy();
    expect(page.total).toBe(page.events.length);
    expect(page.events.map((e) => e.seq)).toEqual(page.events.map((_e, i) => i));
  });

  it('codexEnabled が切のとき、何も取り込まない。入にすると入り、切に戻しても索引は残る', async () => {
    put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    enabled = false;
    const svc = makeSvc(db, [codexSource()]);
    await svc.fullScan();
    expect(codexSessions()).toHaveLength(0);
    expect(count("select count(*) c from transcript_files where agent = 'codex'")).toBe(0);
    enabled = true;
    await svc.fullScan();
    expect(codexSessions()).toHaveLength(1);
    enabled = false;
    await svc.fullScan();
    expect(codexSessions()).toHaveLength(1);
    expect(count("select count(*) c from event_index e join sessions s on s.id = e.session_id where s.provider = 'codex'")).toBeGreaterThan(5);
  });

  it('切のままの起動では、Codex の面が無いときと DB が同じ（Claude の索引は変わらない）', async () => {
    put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    enabled = false;
    const withCodex = openDb(':memory:');
    const without = openDb(':memory:');
    await makeSvc(withCodex, [codexSource()]).fullScan();
    await makeSvc(without, []).fullScan();
    // 会話の ID（uuid v7）は毎回違うので、provider_session_id に読み替えて比べる。
    const dump = (d: Db) => [
      d.prepare('select provider, provider_session_id, cwd, first_prompt, started_at, last_activity_at from sessions order by provider_session_id').all(),
      d.prepare('select s.provider_session_id p, e.seq, e.kind, e.byte_offset, e.byte_length, e.file_path_ref from event_index e join sessions s on s.id = e.session_id order by p, e.parent_agent, e.seq').all(),
      d.prepare('select path, size, indexed_bytes, agent from transcript_files order by path').all(),
      d.prepare('select s.provider_session_id p, u.day, u.file_path, u.input_tokens, u.output_tokens from usage_daily u join sessions s on s.id = u.session_id order by p, u.file_path, u.day').all(),
    ];
    expect((withCodex.prepare("select count(*) c from sessions where provider = 'codex'").get() as { c: number }).c).toBe(0);
    expect(dump(withCodex)).toEqual(dump(without));
  });

  it('.jsonl が .jsonl.zst に置き換わっても、同じ会話として続く：event_index も使用量も変わらず、読み直しも同じ。reset は立たない', async () => {
    const p = put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    const svc = makeSvc(db, [codexSource()]);
    await svc.fullScan();
    const id = codexSessions()[0]!.id as string;
    const snap = () => ({
      events: db.prepare('select seq, kind, byte_offset, byte_length, file_path_ref from event_index where session_id = ? order by seq').all(id),
      usage: db.prepare('select * from usage_daily where session_id = ?').all(id),
      tf: one<{ indexed_bytes: number }>('select indexed_bytes from transcript_files where path = ?', p).indexed_bytes,
    });
    const before = snap();
    const pageBefore = readEvents(db, id, {});
    // 圧縮された（元の .jsonl は消える）。mtime も大きさも変わる。
    fs.rmSync(p);
    fs.writeFileSync(`${p}.zst`, fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(`${p}.zst`, t, t);
    await svc.fullScan();
    expect(snap()).toEqual(before);
    expect(codexSessions()).toHaveLength(1);
    expect(readEvents(db, id, {})).toEqual(pageBefore);
    // 3 本を順に読んで展開のキャッシュを押し出しても、読み直しは変わらない。
    put(CODEX_TOOLS, '2026-10-25T09-00-00');
    await svc.fullScan();
    readEvents(db, codexSessions().find((r) => r.provider_session_id === CODEX_TOOLS.id)!.id, {});
    expect(readEvents(db, id, {})).toEqual(pageBefore);
  });

  it('zst が .jsonl に戻って追記されたとき、続きだけが入る。両方があれば .jsonl が正', async () => {
    const p = put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    const svc = makeSvc(db, [codexSource()]);
    await svc.fullScan();
    const id = codexSessions()[0]!.id as string;
    const n0 = count('select count(*) c from event_index where session_id = ?', id);
    fs.rmSync(p);
    fs.writeFileSync(`${p}.zst`, fixtureBytes(`${CODEX_ONE_TURN.file}.zst`));
    await svc.fullScan();
    // 追記で開き直した：展開した版に 1 ターン足した .jsonl を置く（zst も残る）。
    const extra = '{"timestamp":"2026-10-26T05:30:00.000Z","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"One more thing"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["user.text"]}}}\n';
    fs.writeFileSync(p, Buffer.concat([fixtureBytes(CODEX_ONE_TURN.file), Buffer.from(extra)]));
    await svc.fullScan();
    expect(count('select count(*) c from event_index where session_id = ?', id)).toBe(n0 + 1);
    const page = readEvents(db, id, { latest: true, limit: 1 });
    expect(page.events[0]).toMatchObject({ kind: 'user', text: 'One more thing' });
  });

  it('rollout が archived_sessions へ移ると、パスが変わったものは先頭から作り直し、二重に数えない', async () => {
    const p = put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    const svc = makeSvc(db, [codexSource()]);
    await svc.fullScan();
    const id = codexSessions()[0]!.id as string;
    const n0 = count('select count(*) c from event_index where session_id = ?', id);
    const moved = path.join(home, 'archived_sessions', path.basename(p));
    fs.mkdirSync(path.dirname(moved), { recursive: true });
    fs.renameSync(p, moved);
    await svc.fullScan();
    expect(count('select count(*) c from event_index where session_id = ?', id)).toBe(n0);
    expect(count('select count(*) c from event_index where session_id = ? and file_path_ref = ?', id, moved)).toBe(n0);
    expect(one<{ i: number }>('select sum(input_tokens) i from usage_daily where session_id = ?', id).i).toBe(1200);
  });

  it('取り込みの上限：索引に無いものは新しい N 件だけ。次の見比べで続きが入り、入ったものは消えない', async () => {
    for (let n = 1; n <= 4; n++) putRollout(home, rolloutName(`00000000-0000-7000-8000-00000000000${n}`, `2026-10-2${n}T09-00-00`).rel, fixtureBytes(CODEX_ONE_TURN.file));
    const svc = makeSvc(db, [codexSource({ limit: 2 })]);
    await svc.fullScan();
    expect(codexSessions().map((r) => r.provider_session_id)).toEqual(['00000000-0000-7000-8000-000000000003', '00000000-0000-7000-8000-000000000004']);
    await svc.fullScan();
    expect(codexSessions()).toHaveLength(4);
    await svc.fullScan();
    expect(codexSessions()).toHaveLength(4);
  });

  it('cwd がプロジェクト直下・配下の会話は assignSessions でそのプロジェクトに入る。cwd が無いものは未所属', async () => {
    put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    put(CODEX_TOOLS, '2026-10-25T09-00-00');
    // cwd の無い rollout（session_meta が壊れたもの）。
    const noCwd = fixtureBytes(CODEX_LEGACY.file).toString('utf8').split('\n').filter(Boolean).map((l) => {
      const r = JSON.parse(l);
      if (r.payload?.cwd) delete r.payload.cwd;
      if (r.type === 'turn_context') delete r.payload.cwd;
      return JSON.stringify(r);
    }).join('\n') + '\n';
    putRollout(home, rolloutName(CODEX_LEGACY.id, '2026-10-26T09-00-00').rel, noCwd);
    await makeSvc(db, [codexSource()]).fullScan();
    upsertShared(db, 'projects', { id: 'p-sample', name: 'sample', status: 'active', is_scratch: 0 }, 'd');
    upsertShared(db, 'project_roots', { id: 'r-sample', project_id: 'p-sample', device_id: 'd', path: '/work/sample', resolved: 1 }, 'd');
    assignSessions(db, 'd');
    const projectOf = (id: string) => (one<{ project_id: string | null }>('select project_id from sessions where provider_session_id = ?', id)).project_id;
    expect(projectOf(CODEX_ONE_TURN.id)).toBe('p-sample');
    expect(projectOf(CODEX_TOOLS.id)).toBe('p-sample');
    expect(projectOf(CODEX_LEGACY.id)).toBeNull();
  });

  it('壊れた zst は束を作らず、error に出る。ほかの会話の索引は止まらない', async () => {
    put(CODEX_ONE_TURN, '2026-10-24T09-00-00');
    putRollout(home, `${rolloutName(CODEX_TOOLS.id, '2026-10-25T09-00-00').rel}.zst`, 'not zstd');
    const svc = makeSvc(db, [codexSource()]);
    const errors: string[] = [];
    svc.on({ error: (e) => errors.push(e.path) });
    await svc.fullScan();
    expect(codexSessions().map((r) => r.provider_session_id)).toEqual([CODEX_ONE_TURN.id]);
    expect(errors.some((e) => e.includes(CODEX_TOOLS.id))).toBe(true);
  });
});

describe('ほかの PC から降ろした Codex の写し（remote/<PC>/codex）', () => {
  let remote: string;
  beforeEach(() => { remote = fs.mkdtempSync(path.join(path.dirname(home), 'codex-remote-')); });
  afterEach(() => { fs.rmSync(remote, { recursive: true, force: true }); });

  const remoteSource = (): CodexTranscriptSource => codexTranscriptSource({ codexHome: () => home, enabled: () => enabled, remoteRoot: remote });
  const putRemote = (dev: string, f: { file: string; id: string }, when: string) => putRollout(path.join(remote, dev, 'codex'), rolloutName(f.id, when).rel, fixtureBytes(f.file));
  const sharedRow = () => upsertShared(db, 'sessions', { id: 's-remote', provider: 'codex', provider_session_id: CODEX_TOOLS.id, cwd: '/work/sample', home_device: 'dev-b' }, 'dev-b');

  it('会話の行が届いていれば、降ろした写しから本文を読む。この PC で再開して手元に写ると、手元の本文に切り替わり、読める本文は同じ', async () => {
    sharedRow();
    const rp = putRemote('dev-b', CODEX_TOOLS, '2026-10-25T09-00-00');
    const svc = makeSvc(db, [remoteSource()]);
    await svc.fullScan();
    expect(db.prepare("select path, device_id from transcript_files where agent = 'codex'").all()).toEqual([{ path: rp, device_id: 'dev-b' }]);
    const before = readEvents(db, 's-remote', {});
    expect(before.events.map((e) => e.kind)).toContain('tool_call');
    // 写しからは要約を書かない（本文を持つ PC が書く）。
    expect(count('select count(*) c from session_summaries where session_id = ?', 's-remote')).toBe(0);

    // 「この PC で再開」は、写しを $CODEX_HOME の同じ相対パスへ置く。
    const lp = putRollout(home, rolloutName(CODEX_TOOLS.id, '2026-10-25T09-00-00').rel, fixtureBytes(CODEX_TOOLS.file));
    await svc.fullScan();
    expect(db.prepare("select path, device_id from transcript_files where agent = 'codex'").all()).toEqual([{ path: lp, device_id: null }]);
    const after = readEvents(db, 's-remote', {});
    expect(after.events.map((e) => [e.kind, e.seq])).toEqual(before.events.map((e) => [e.kind, e.seq]));
    expect(codexSessions()).toHaveLength(1);
    svc.stop();
  });

  it('会話の行がまだ届いていない写しは飛ばし、行が届いたら入る', async () => {
    putRemote('dev-b', CODEX_TOOLS, '2026-10-25T09-00-00');
    const svc = makeSvc(db, [remoteSource()]);
    await svc.fullScan();
    expect(codexSessions()).toHaveLength(0);
    expect(count("select count(*) c from transcript_files where agent = 'codex'")).toBe(0);
    sharedRow();
    await svc.fullScan();
    expect(count('select count(*) c from event_index where session_id = ?', 's-remote')).toBeGreaterThan(0);
    svc.stop();
  });

  it('Codex が切のときは、写しも読まない', async () => {
    sharedRow();
    putRemote('dev-b', CODEX_TOOLS, '2026-10-25T09-00-00');
    enabled = false;
    const svc = makeSvc(db, [remoteSource()]);
    await svc.fullScan();
    expect(count("select count(*) c from transcript_files where agent = 'codex'")).toBe(0);
    svc.stop();
  });
});
