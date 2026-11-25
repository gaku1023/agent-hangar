import { describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/open.ts';
import { UsageShare, usageShareId } from './share.ts';
import { UsageTracker } from './statusline.ts';
import { AgentUsageTracker } from './agentUsage.ts';
import { onRowChange } from '../db/notify.ts';
import { applyRemoteBatch } from '../sync/apply.ts';

const payload = (five: number, seven: number) => ({ session_id: 'u1', rate_limits: { five_hour: { used_percentage: five, resets_at: 1_900_000_000 }, seven_day: { used_percentage: seven, resets_at: 1_900_500_000 } } });

/** もう 1 台の PC が書いて、同期で降りてきた行（sync/apply.ts が当てたのと同じ形）。 */
function remoteRow(db: Db, agent: 'claude' | 'codex', name: string, five: number | null, seven: number | null, observedAt: number, plan: string | null = null): void {
  const w = (p: number | null, r: number) => (p === null ? null : JSON.stringify({ usedPercent: p, resetsAt: r }));
  db.prepare('insert or replace into account_usage (id, agent, account_name, five_hour, seven_day, plan, observed_at, updated_at, origin_device) values (?,?,?,?,?,?,?,?,?)')
    .run(usageShareId(agent, name), agent, name, w(five, 1_900_000_000_000), w(seven, 1_900_500_000_000), plan, observedAt, observedAt, 'other-pc');
}

const changesOf = (db: Db) => db.prepare("select row_id, payload from changes where table_name = 'account_usage' order by seq").all() as { row_id: string; payload: string }[];

describe('UsageShare', () => {
  it('アカウントの名前ごとに 1 行を共有表に書き、changes に積む', () => {
    const db = openDb(':memory:');
    const share = new UsageShare(db, 'me');
    share.publish('claude', '会社', { fiveHour: { usedPercent: 10, resetsAt: 5 }, sevenDay: null, plan: null, observedAt: 100 });
    expect(share.read('claude', '会社')).toEqual({ fiveHour: { usedPercent: 10, resetsAt: 5 }, sevenDay: null, plan: null, observedAt: 100 });
    expect(share.read('codex', '会社')).toBeNull();
    expect(changesOf(db).map((c) => c.row_id)).toEqual([usageShareId('claude', '会社')]);
  });
  it('手元より新しい観測が表にあれば、古い観測では書き直さない', () => {
    const db = openDb(':memory:');
    const share = new UsageShare(db, 'me');
    remoteRow(db, 'claude', '会社', 50, 20, 2_000);
    share.publish('claude', '会社', { fiveHour: { usedPercent: 30, resetsAt: 5 }, sevenDay: null, plan: null, observedAt: 1_000 });
    expect(share.read('claude', '会社')?.observedAt).toBe(2_000);
    expect(changesOf(db)).toEqual([]);
  });
});

describe('UsageTracker と共有', () => {
  const setup = (t: { now: number }) => {
    const db = openDb(':memory:');
    const share = new UsageShare(db, 'me');
    const names: Record<string, string> = { primary: 'メイン', a2: '会社' };
    const tr = new UsageTracker(db, { now: () => t.now, accountOf: () => 'a2', share: { usage: share, nameOf: (id) => names[id] ?? null } });
    return { db, share, tr };
  };

  it('別の PC の新しい観測を、同じ名前の手元のアカウントの値として返す', () => {
    const t = { now: 1_000 };
    const { db, tr } = setup(t);
    tr.ingest(payload(10, 5));
    t.now = 3_000;
    remoteRow(db, 'claude', '会社', 60, 25, 2_000);
    expect(tr.of('a2')).toEqual({ fiveHour: { usedPercent: 60, resetsAt: 1_900_000_000_000 }, sevenDay: { usedPercent: 25, resetsAt: 1_900_500_000_000 }, updatedAt: 2_000 });
    // 名前の違うアカウントには混ぜない。
    expect(tr.of('primary').fiveHour).toBeNull();
  });
  it('手元の観測の方が新しければ手元の値を返す', () => {
    const t = { now: 3_000 };
    const { db, tr } = setup(t);
    remoteRow(db, 'claude', '会社', 60, 25, 2_000);
    tr.ingest(payload(70, 26));
    expect(tr.of('a2')).toMatchObject({ fiveHour: { usedPercent: 70 }, updatedAt: 3_000 });
  });
  it('使用率が変わった観測だけを共有表に書く。同じ値の payload では書かない', () => {
    const t = { now: 1_000 };
    const { db, share, tr } = setup(t);
    const last = () => JSON.parse(changesOf(db).at(-1)!.payload) as { observed_at: number; five_hour: string };
    tr.ingest(payload(10, 5));
    expect(last().observed_at).toBe(1_000);
    t.now = 2_000;
    tr.ingest(payload(10, 5));
    expect(share.read('claude', '会社')?.observedAt).toBe(1_000);
    expect(last().observed_at).toBe(1_000);
    t.now = 3_000;
    tr.ingest(payload(11, 5));
    // まだ送っていない前の変更は、同じ行の新しい変更に置き換わる（db/shared.ts の dropUnpushed）。
    expect(changesOf(db)).toHaveLength(1);
    expect(last().observed_at).toBe(3_000);
    expect(JSON.parse(last().five_hour)).toEqual({ usedPercent: 11, resetsAt: 1_900_000_000_000 });
  });
  it('別の PC の新しい値と手元の観測が食い違えば、手元の観測で書き直す', () => {
    const t = { now: 3_000 };
    const { db, tr } = setup(t);
    tr.ingest(payload(10, 5));
    remoteRow(db, 'claude', '会社', 60, 25, 3_500);
    t.now = 4_000;
    const r = tr.ingest(payload(62, 25))!;
    expect(r.usageChanged).toBe(true);
    expect(tr.of('a2')).toMatchObject({ fiveHour: { usedPercent: 62 }, updatedAt: 4_000 });
    expect(changesOf(db).at(-1)!.row_id).toBe(usageShareId('claude', '会社'));
    expect((JSON.parse(changesOf(db).at(-1)!.payload) as { observed_at: number }).observed_at).toBe(4_000);
  });
  it('名前の引けないアカウントは書かず、読まない', () => {
    const db = openDb(':memory:');
    const share = new UsageShare(db, 'me');
    const tr = new UsageTracker(db, { now: () => 1_000, accountOf: () => 'gone', share: { usage: share, nameOf: () => null } });
    tr.ingest(payload(10, 5));
    expect(changesOf(db)).toEqual([]);
    expect(tr.of('gone').fiveHour).toMatchObject({ usedPercent: 10 });
  });
});

describe('AgentUsageTracker と共有', () => {
  const w = (p: number) => ({ usedPercent: p, resetsAt: 1_900_000_000_000 });
  it('Codex の枠も名前ごとに書き、新しい方を返す', () => {
    const db = openDb(':memory:');
    const share = new UsageShare(db, 'me');
    const tr = new AgentUsageTracker({ now: () => 5_000, share: { usage: share, nameOf: (_agent, id) => (id === 'primary' ? 'メイン' : null) } });
    expect(tr.set('codex', { fiveHour: w(10), sevenDay: w(3), plan: 'plus' }, 1_000)).toBe(true);
    expect(share.read('codex', 'メイン')).toMatchObject({ fiveHour: { usedPercent: 10 }, plan: 'plus', observedAt: 1_000 });
    remoteRow(db, 'codex', 'メイン', 40, 9, 2_000, 'pro');
    expect(tr.of('codex')).toEqual({ fiveHour: w(40), sevenDay: { usedPercent: 9, resetsAt: 1_900_500_000_000 }, plan: 'pro', updatedAt: 2_000 });
    expect(tr.all()).toMatchObject({ codex: { plan: 'pro' } });
  });
  it('同じ値の観測では書き直さない', () => {
    const db = openDb(':memory:');
    const share = new UsageShare(db, 'me');
    const tr = new AgentUsageTracker({ now: () => 5_000, share: { usage: share, nameOf: () => 'メイン' } });
    tr.set('codex', { fiveHour: w(10), sevenDay: null, plan: null }, 1_000);
    tr.set('codex', { fiveHour: w(10), sevenDay: null, plan: null }, 2_000);
    expect(changesOf(db)).toHaveLength(1);
  });
});

describe('2 台の往復', () => {
  it('A の PC が書いた行を B の PC が当てると、B の同じ名前のアカウントの計器に出て、配り直しの知らせが出る', async () => {
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    const trA = new UsageTracker(a, { now: () => 5_000, accountOf: () => 'x1', share: { usage: new UsageShare(a, 'pc-a'), nameOf: () => '大学' } });
    trA.ingest(payload(42, 17));
    const c = a.prepare("select * from changes where table_name = 'account_usage'").get() as { seq: number; row_id: string; op: 'upsert'; payload: string; updated_at: number; device_id: string };
    const seen: string[] = [];
    const off = onRowChange((r) => { if (r.db === b) seen.push(`${r.table}:${r.origin}`); });
    expect(applyRemoteBatch(b, [{ seq: c.seq, tableName: 'account_usage', rowId: c.row_id, op: c.op, deviceId: c.device_id, updatedAt: c.updated_at, payload: JSON.parse(c.payload) as Record<string, unknown> }], { ownDeviceId: 'pc-b', skipOwn: true })).toHaveLength(1);
    // 適用はトランザクションの中なので、知らせは最外が終わってから届く（db/notify.ts）。
    await new Promise((r) => setTimeout(r, 0));
    off();
    // B では「大学」の id が違ってもよい（アカウントの一覧は PC ごと）。
    const trB = new UsageTracker(b, { now: () => 6_000, share: { usage: new UsageShare(b, 'pc-b'), nameOf: (id) => (id === 'y9' ? '大学' : null) } });
    expect(trB.of('y9')).toMatchObject({ fiveHour: { usedPercent: 42 }, sevenDay: { usedPercent: 17 }, updatedAt: 5_000 });
    expect(seen).toContain('account_usage:apply');
  });
});
