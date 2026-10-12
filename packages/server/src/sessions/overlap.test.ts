import type { LiveSessionDto } from '@agent-hangar/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { onRowChange } from '../db/notify.ts';
import { openDb, type Db } from '../db/open.ts';
import { upsertShared } from '../db/shared.ts';
import { computeOverlaps, dismissOverlap, OVERLAP_WINDOW_MS, OverlapWatch, type OverlapEdit } from './overlap.ts';

const MIN = 60_000;
const N = OVERLAP_WINDOW_MS;
const never = () => false;

describe('computeOverlaps（判定）', () => {
  const e = (sessionId: string, at: number, path = '/w/rank.ts'): OverlapEdit => ({ sessionId, path, at });

  it('先の側が作業中のうちに後の側が同じファイルを書いたら、両方に出す', () => {
    const working = (id: string, t: number) => id === 'a' && t <= 6 * MIN;
    const out = computeOverlaps([e('a', 1 * MIN), e('b', 5 * MIN)], working, new Set(), 6 * MIN);
    expect(out.get('a')).toEqual({ with: ['b'], files: [{ path: '/w/rank.ts', with: 'b', mineAt: 1 * MIN, theirsAt: 5 * MIN, alternating: false }] });
    expect(out.get('b')).toEqual({ with: ['a'], files: [{ path: '/w/rank.ts', with: 'a', mineAt: 5 * MIN, theirsAt: 1 * MIN, alternating: false }] });
  });

  it('先の側がターンを終えてから後の側が直しただけなら出さない（人が順に頼んだ）', () => {
    expect(computeOverlaps([e('a', 1 * MIN), e('b', 5 * MIN)], never, new Set(), 6 * MIN).size).toBe(0);
  });

  it('先の側がまた戻ってきて書いたら、交互として出す', () => {
    const out = computeOverlaps([e('a', 1 * MIN), e('b', 5 * MIN), e('a', 8 * MIN)], never, new Set(), 9 * MIN);
    expect(out.get('a')?.files[0]).toMatchObject({ with: 'b', mineAt: 8 * MIN, theirsAt: 5 * MIN, alternating: true });
    expect(out.get('b')?.files[0]).toMatchObject({ with: 'a', alternating: true });
  });

  it('間が N 分より空いた編集は重ならない', () => {
    const always = () => true;
    expect(computeOverlaps([e('a', 0), e('b', N + MIN)], always, new Set(), N + 2 * MIN).size).toBe(0);
  });

  it('重なった最後の編集から N 分で消える', () => {
    const always = () => true;
    const edits = [e('a', 1 * MIN), e('b', 2 * MIN)];
    expect(computeOverlaps(edits, always, new Set(), 2 * MIN + N - 1).size).toBe(2);
    expect(computeOverlaps(edits, always, new Set(), 2 * MIN + N + 1).size).toBe(0);
  });

  it('同じセッションの中の編集と、別のパスは重ならない', () => {
    const always = () => true;
    expect(computeOverlaps([e('a', 1 * MIN), e('a', 2 * MIN), e('b', 3 * MIN, '/w/other.ts')], always, new Set(), 4 * MIN).size).toBe(0);
  });

  it('「このファイルでは表示しない」にした組とパスは出さない', () => {
    const always = () => true;
    const edits = [e('a', 1 * MIN), e('b', 2 * MIN), e('a', 1 * MIN, '/w/x.ts'), e('b', 2 * MIN, '/w/x.ts')];
    const out = computeOverlaps(edits, always, new Set(['a\u0000b\u0000/w/rank.ts']), 3 * MIN);
    expect(out.get('a')?.files.map((f) => f.path)).toEqual(['/w/x.ts']);
  });

  it('相手が 2 本なら、相手ごとに行を持つ', () => {
    const always = () => true;
    const out = computeOverlaps([e('a', 1 * MIN), e('b', 2 * MIN), e('c', 3 * MIN)], always, new Set(), 4 * MIN);
    expect(out.get('a')?.with).toEqual(['c', 'b']);
    expect(out.get('a')?.files.map((f) => f.with)).toEqual(['c', 'b']);
  });
});

describe('OverlapWatch（見張り）', () => {
  let db: Db;
  let now: number;
  let live: LiveSessionDto[];
  const addSession = (id: string) => upsertShared(db, 'sessions', { id, provider: 'claude-code', provider_session_id: `u-${id}`, cwd: '/w', home_device: 'd' }, 'd');
  let seq = 0;
  const edit = (sessionId: string, at: number, filePath = '/w/rank.ts', agent: string | null = null) =>
    db.prepare("insert into event_index (session_id, seq, kind, ts, byte_offset, byte_length, file_path_ref, parent_agent, tool_name, file_path) values (?, ?, 'tool_call', ?, 0, 1, '/t.jsonl', ?, 'Edit', ?)")
      .run(sessionId, seq++, at, agent, filePath);
  const liveOf = (id: string, status: LiveSessionDto['status']): LiveSessionDto => ({ sessionId: `u-${id}`, status, name: null, nameSource: null, cwd: '/w', pid: 1 });

  beforeEach(() => {
    db = openDb(':memory:');
    now = 10 * MIN;
    addSession('a'); addSession('b');
    live = [liveOf('a', 'busy'), liveOf('b', 'busy')];
  });
  /** 見張りを作り、編集より前から 2 本とも作業中だったことを覚えさせる。 */
  const watch = () => {
    const w = new OverlapWatch({ db, live: () => live, now: () => now });
    now = 8 * MIN;
    w.noteLive(live);
    now = 10 * MIN;
    return w;
  };
  const count = () => db.prepare('select count(*) n from session_overlaps').get();

  it('作業中の 2 本が同じファイルを書いたら写しを書き、両方のセッションを名指しする', () => {
    const w = watch();
    edit('a', 9 * MIN);
    // 後の側の編集はサブエージェントのものでも数える。パスの綴りは NFC にそろえる。
    edit('b', 9.5 * MIN, '/w/rank.ts'.normalize('NFD'), 'agent-1');
    const touched: string[] = [];
    const off = onRowChange((c) => { if (c.origin === 'touch') touched.push(c.rowId); });
    w.tick();
    off();
    expect(touched.sort()).toEqual(['a', 'b']);
    const row = db.prepare("select payload from session_overlaps where session_id = 'a'").get() as { payload: string };
    expect(JSON.parse(row.payload)).toMatchObject({ with: ['b'], files: [{ path: '/w/rank.ts', with: 'b' }] });
    // 変わらなければ名指ししない。
    const again: string[] = [];
    const off2 = onRowChange((c) => { if (c.origin === 'touch') again.push(c.rowId); });
    w.tick();
    off2();
    expect(again).toEqual([]);
  });

  it('どちらかが実行中でなくなったら写しを消す', () => {
    const w = watch();
    edit('a', 9 * MIN); edit('b', 9.5 * MIN);
    w.tick();
    expect(count()).toEqual({ n: 2 });
    live = [liveOf('a', 'busy')];
    w.tick();
    expect(count()).toEqual({ n: 0 });
  });

  it('「このファイルでは表示しない」は組の向きによらず効く', () => {
    const w = watch();
    edit('a', 9 * MIN); edit('b', 9.5 * MIN);
    w.tick();
    expect(count()).toEqual({ n: 2 });
    dismissOverlap(db, 'b', 'a', ['/w/rank.ts'], now);
    w.tick();
    expect(count()).toEqual({ n: 0 });
  });

  it('作業中かどうかは、登録の状態の移り変わりから決める', () => {
    const w = new OverlapWatch({ db, live: () => live, now: () => now });
    now = 1 * MIN;
    w.noteLive([liveOf('a', 'busy'), liveOf('b', 'idle')]);
    now = 3 * MIN;
    // a はターンを終えた。その後に b が書いたので、順に頼んだだけである。
    w.noteLive([liveOf('a', 'idle'), liveOf('b', 'busy')]);
    edit('a', 2 * MIN); edit('b', 4 * MIN);
    now = 5 * MIN;
    w.tick();
    expect(count()).toEqual({ n: 0 });
    // a がターンの途中だったなら出る。
    edit('b', 2.5 * MIN);
    w.tick();
    expect(count()).toEqual({ n: 2 });
  });
});
