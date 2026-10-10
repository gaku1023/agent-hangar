import { describe, expect, it } from 'vitest';
import type { CompatDto, ConfigSyncDto, ReadinessDto, RetentionDto, SessionDto, SessionStateDto, SettingsDto, SyncStatusBody } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import type { State } from '../mediator/types.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentNotices } from './notices.ts';

/** 2026-10-02（金）の朝 9 時。 */
const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const MIN = 60_000;
const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, returnTime: null, setBy: null, setAt: null, candidate: null, ...o });
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 5 * H, lastActivityAt: NOW - 4 * H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });
const paused = (id: string, returnOn: string | null, returnTime: string | null = null, note = `${id} を確かめる`) => dto(id, { state: st({ status: 'paused', note, returnOn, returnTime, setBy: 'user', setAt: 1 }) });
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', paused: false, url: 'https://w', lastPushAt: null, lastPullAt: NOW - MIN, pending: 0, error: null, deviceCount: 1, limitedUntil: null, skipped: [], sweepPending: 0, oncePass: false, ...o });
const compatSummary = (driftCount: number, localVersion: string | null = '2.4.2') => ({ compat: { verifiedVersion: '2.4.0', localVersion, driftCount } }) as unknown as ReadinessDto;
const drift = (n: number, lastSeenAt = NOW - 12 * MIN): CompatDto => ({ verifiedVersion: '2.4.0', localVersion: '2.4.2', drifts: Array.from({ length: n }, (_, i) => ({ contract: 'registry' as const, value: `status=v${i}`, version: '2.4.2', count: 3, firstSeenAt: lastSeenAt - H, lastSeenAt: lastSeenAt - i * MIN })) });
const retention = (o: Partial<RetentionDto> = {}): RetentionDto => ({ days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null, ...o });
const cfgSync = (o: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...o });
const storeOf = (over: Partial<Store> = {}): Store => ({ ...initialStore(), bootstrapped: true, ...over });
const withSessions = (list: SessionDto[]) => ({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
const read = (keys: string[]): State => ({ ...initialState(), noticesRead: keys });
const en = { language: 'en' } as unknown as SettingsDto;

describe('presentNotices：事実から行を組む', () => {
  it('どの事実も無ければ行は無く、未読も 0 である', () => {
    const p = presentNotices(initialState(), storeOf(), NOW);
    expect(p).toMatchObject({ rows: [], unread: 0, keys: [] });
  });

  it('同期が止まっていない間（オフ、同期済み、1 回だけ同期中）は行を作らない', () => {
    for (const s of [sync({ state: 'off', url: null }), sync(), sync({ state: 'pushing' }), sync({ state: 'pulling' })]) {
      expect(presentNotices(initialState(), storeOf({ sync: s }), NOW).rows, s.state).toEqual([]);
    }
    // 状態がまだ届いていない間も作らない。
    expect(presentNotices(initialState(), storeOf({ sync: null }), NOW).rows).toEqual([]);
  });

  it('同期のエラーは赤の行にして、理由を添え、同期の設定へ移る', () => {
    const [row] = presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: 'サーバが 503 を返しました' }) }), NOW).rows;
    expect(row).toMatchObject({ key: 'sync|error|サーバが 503 を返しました', kind: 'sync', tone: 'err', kindLabel: '同期', title: '同期エラー', detail: 'サーバが 503 を返しました', when: null, unread: true });
    expect(row!.action).toEqual({ label: '同期の設定を開く', intent: { type: 'nav.go', to: { name: 'settings', at: 'sync' } } });
  });

  it('理由が無いエラーは「同期に失敗しました」と言い、止めているときはその旨を足す', () => {
    const [a] = presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: null }) }), NOW).rows;
    expect(a).toMatchObject({ key: 'sync|error|', detail: '同期に失敗しました' });
    const [b] = presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: '版が合いません', paused: true }) }), NOW).rows;
    expect(b).toMatchObject({ key: 'sync|error|版が合いません|paused', tone: 'err', detail: '版が合いません。同期は一時停止中です' });
  });

  it('利用者が止めた一時停止は黄の行、無料枠で退いているときは戻る時刻を言う', () => {
    const [user] = presentNotices(initialState(), storeOf({ sync: sync({ state: 'paused', paused: true }) }), NOW).rows;
    expect(user).toMatchObject({ key: 'sync|paused|user', tone: 'warn', title: '同期を一時停止中', detail: null });
    const until = Date.UTC(2026, 9, 2, 0, 0);
    const [quota] = presentNotices(initialState(), storeOf({ sync: sync({ state: 'paused', paused: true, limitedUntil: until }) }), NOW, 'Asia/Tokyo').rows;
    expect(quota).toMatchObject({ key: `sync|paused|quota|${until}`, tone: 'warn', title: '無料枠で停止 · 9:00 にリセット' });
  });

  it('今日戻るの Paused は、時刻つきなら時刻、過ぎていれば過ぎた長さを言い、そのセッションを開く', () => {
    const store = storeOf(withSessions([paused('pay', '2026-10-02', '13:30', '夜間の再計測を見る'), paused('slow', '2026-10-02', '08:35'), paused('stale', '2026-09-29'), paused('plain', '2026-10-02')]));
    const rows = presentNotices(initialState(), store, NOW).rows;
    const by = Object.fromEntries(rows.map((r) => [r.key.split('|')[1]!, r]));
    expect(by.pay).toMatchObject({ key: 'reminder|pay|2026-10-02 13:30', kind: 'reminder', tone: 'warn', kindLabel: 'リマインダー', title: 'pay', detail: '夜間の再計測を見る', when: '今日 13:30', unread: true });
    expect(by.pay!.action).toEqual({ label: 'セッションを開く', intent: { type: 'session.open', id: 'pay' } });
    expect(by.slow!.when).toBe('25 分過ぎ');
    expect(by.stale).toMatchObject({ key: 'reminder|stale|2026-09-29', when: '3 日過ぎ' });
    expect(by.plain!.when).toBe('今日');
  });

  it('先の日の Paused、状態の無いセッション、生きているセッションは行にしない。理由が無ければ detail は null', () => {
    const live = { ...paused('busy', '2026-10-01'), live: 'busy' as const };
    const store = storeOf(withSessions([paused('later', '2026-10-05'), dto('plain'), live, paused('bare', '2026-10-02', null, '')]));
    const rows = presentNotices(initialState(), store, NOW).rows;
    expect(rows.map((r) => r.key)).toEqual(['reminder|bare|2026-10-02']);
    expect(rows[0]!.detail).toBeNull();
  });

  it('戻る日が壊れた Paused は「日付なし」の行にする', () => {
    const [row] = presentNotices(initialState(), storeOf(withSessions([paused('x', null)])), NOW).rows;
    expect(row).toMatchObject({ key: 'reminder|x|none', when: '日付なし' });
  });

  it('互換は、変更点があるときだけ行にする。未検証の版と変更点なしは行にしない', () => {
    expect(presentNotices(initialState(), storeOf({ readiness: compatSummary(0) }), NOW).rows).toEqual([]);
    expect(presentNotices(initialState(), storeOf({ readiness: compatSummary(0, '2.5.0') }), NOW).rows).toEqual([]);
    const [row] = presentNotices(initialState(), storeOf({ readiness: compatSummary(1) }), NOW).rows;
    expect(row).toMatchObject({ key: 'compat|2.4.2|1 change', kind: 'compat', tone: 'warn', kindLabel: '互換性', title: '変更点あり', detail: 'Claude Code 2.4.2：変更点 1 件', when: null, unread: true });
    // 設定の互換の節は、足す切り替え先がまだ無いので、設定の頭へ移る（at は設定の目次の作り直しで足す）。
    expect(row!.action).toEqual({ label: '詳細を開く', intent: { type: 'nav.go', to: { name: 'settings' } } });
  });

  it('互換の中身（GET /api/compat）が届いたら、件数は中身にそろえ、最後に見た時刻を添える', () => {
    const [row] = presentNotices(initialState(), storeOf({ readiness: compatSummary(1), compat: drift(3) }), NOW).rows;
    expect(row).toMatchObject({ key: 'compat|2.4.2|3 change', detail: 'Claude Code 2.4.2：変更点 3 件', when: '12 分前' });
  });

  it('手元の版が読めないときは「版は不明」と言う', () => {
    const [row] = presentNotices(initialState(), storeOf({ readiness: compatSummary(2, null) }), NOW).rows;
    expect(row).toMatchObject({ key: 'compat|unknown|2 change', detail: 'Claude Code：変更点 2 件（手元の版は不明）' });
  });

  it('古いサーバ（readiness に compat が無い）でも落ちず、行を作らない', () => {
    expect(presentNotices(initialState(), storeOf({ readiness: {} as ReadinessDto }), NOW).rows).toEqual([]);
  });

  it('保持期間は、既定のままで書き換えられるときだけ行にする', () => {
    for (const r of [null, retention({ source: 'user', userValue: 365, days: 365 }), retention({ source: 'managed', writable: false }), retention({ writable: false })]) {
      expect(presentNotices(initialState(), storeOf({ retention: r }), NOW).rows).toEqual([]);
    }
    const [row] = presentNotices(initialState(), storeOf({ retention: retention() }), NOW).rows;
    expect(row).toMatchObject({ key: 'retention|30|rule', kind: 'retention', tone: 'warn', kindLabel: '保持期間', title: 'トランスクリプトは 30 日で削除されます', detail: 'hangar の履歴からも消えます', when: null });
    expect(row!.action).toEqual({ label: '保持期間を延長…', intent: { type: 'nav.go', to: { name: 'settings' } } });
  });

  it('消えかけのトランスクリプトがあれば、その件数を言う', () => {
    const old = (id: string, days: number) => dto(id, { hasTranscript: true, transcriptMtime: NOW - days * 86_400_000 });
    const store = storeOf({ retention: retention(), ...withSessions([old('a', 27), old('b', 25), old('c', 1)]) });
    const [row] = presentNotices(initialState(), store, NOW).rows;
    expect(row).toMatchObject({ key: 'retention|30|soon', title: 'セッションのトランスクリプト 2 件が、まもなく削除されます', detail: 'Claude Code は 30 日でトランスクリプトを削除します' });
  });

  // 本文を降ろせなかったときの error のトーストは、サーバから外した（PR 29）。事実は同期の状態の skipped に残るので、ベルの行にする。
  it('降ろせなかった本文（諦めた項目）があれば、同期の状態とは別の赤の行にして、最初の理由を添える', () => {
    const skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }, { key: 'transcripts/mini/u2.jsonl.gz', attempts: 3, message: '壊れています' }];
    const rows = presentNotices(initialState(), storeOf({ sync: sync({ skipped }) }), NOW).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'sync|skipped|2', kind: 'sync', tone: 'err', kindLabel: '同期', title: '降ろせなかったトランスクリプト 2 件', detail: '復号できません', unread: true });
    expect(rows[0]!.action.intent).toEqual({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
    // 状態の行（エラー）と並べても、別の行になる。状態の行が先。
    const both = presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: 'x', skipped }) }), NOW).rows;
    expect(both.map((r) => r.key)).toEqual(['sync|error|x', 'sync|skipped|2']);
    // 数が変われば鍵が変わり、また未読になる。同期を使っていない端末には出さない。
    expect(presentNotices(read(['sync|skipped|2']), storeOf({ sync: sync({ skipped }) }), NOW).unread).toBe(0);
    expect(presentNotices(read(['sync|skipped|2']), storeOf({ sync: sync({ skipped: skipped.slice(0, 1) }) }), NOW).unread).toBe(1);
    expect(presentNotices(initialState(), storeOf({ sync: sync({ state: 'off', url: null, skipped }) }), NOW).rows).toEqual([]);
  });

  // 通知の誘いは右下の積みの上から外し、ベルの一覧の行にした（PR 29）。
  it('通知を出せるのに受け取っていないときだけ、「通知を受け取る」の行を出し、押すと受け取りを入れる', () => {
    const rows = (notify: { available: boolean; on: boolean; blocked: boolean }) => presentNotices(initialState(), storeOf({ notify }), NOW).rows;
    const [row] = rows({ available: true, on: false, blocked: false });
    expect(row).toMatchObject({ key: 'notify|offer', kind: 'notify', tone: 'info', kindLabel: '通知', title: '離れていても気づけます', unread: true });
    expect(row!.action).toEqual({ label: '通知を受け取る', intent: { type: 'notify.set', on: true } });
    expect(rows({ available: true, on: true, blocked: false })).toEqual([]);
    expect(rows({ available: false, on: false, blocked: false })).toEqual([]);
    // OS で切られているときは勧めない。直し方は設定の通知の節に出す。
    expect(rows({ available: true, on: false, blocked: true })).toEqual([]);
  });

  // 設定の同期で送らなかった項目（段 4 の PR 19）。事実は ConfigSyncDto.unsent の件数で、件数が 0 に戻れば行も消える。
  it('設定の同期で送らなかった項目があれば、件数を言う行にして、送らなかった項目の常設の行へ移る', () => {
    const [row] = presentNotices(initialState(), storeOf({ configSync: cfgSync({ unsent: 3 }) }), NOW).rows;
    expect(row).toMatchObject({ key: 'config|unsent|3', kind: 'config', tone: 'warn', icon: 'settings', kindLabel: '設定の同期', title: '送らなかった項目 3 件', when: null, unread: true });
    expect(row!.detail).toContain('それでも送る');
    expect(row!.action).toEqual({ label: '送らなかった項目を開く', intent: { type: 'nav.go', to: { name: 'settings', at: 'unsent' } } });
  });

  it('送らなかった項目が 0 件、設定の同期が切、まだ届いていない（古いサーバ）なら行にしない', () => {
    for (const c of [cfgSync(), cfgSync({ enabled: false, unsent: 2 }), null]) {
      expect(presentNotices(initialState(), storeOf({ configSync: c }), NOW).rows, String(c?.unsent)).toEqual([]);
    }
  });

  it('送らなかった項目の件数が、既読にした時点より増えたときだけ未読に戻る。減ったときは既読のまま、0 になれば行も消える', () => {
    const state = read(['config|unsent|2']);
    expect(presentNotices(state, storeOf({ configSync: cfgSync({ unsent: 2 }) }), NOW).unread).toBe(0);
    expect(presentNotices(state, storeOf({ configSync: cfgSync({ unsent: 3 }) }), NOW).unread).toBe(1);
    const fewer = presentNotices(state, storeOf({ configSync: cfgSync({ unsent: 1 }) }), NOW);
    expect(fewer.rows).toHaveLength(1);
    expect(fewer.unread).toBe(0);
    expect(presentNotices(state, storeOf({ configSync: cfgSync({ unsent: 0 }) }), NOW).rows).toEqual([]);
    // 1 件の時点で既読にして、2 件に増えたときは未読に戻る。
    expect(presentNotices(read(['config|unsent|1']), storeOf({ configSync: cfgSync({ unsent: 2 }) }), NOW).unread).toBe(1);
  });

  it('種類の並びは、リマインダー、同期、互換、保持期間、設定の同期、通知', () => {
    const store = storeOf({ ...withSessions([paused('p', '2026-10-02')]), sync: sync({ state: 'error', error: 'x' }), readiness: compatSummary(1), retention: retention(), configSync: cfgSync({ unsent: 1 }), notify: { available: true, on: false, blocked: false } });
    expect(presentNotices(initialState(), store, NOW).rows.map((r) => r.kind)).toEqual(['reminder', 'sync', 'compat', 'retention', 'config', 'notify']);
  });

  it('既読の鍵の行は未読でなくなり、未読の数と鍵の一覧に反映する', () => {
    const store = storeOf({ ...withSessions([paused('p', '2026-10-02')]), sync: sync({ state: 'error', error: 'x' }), readiness: compatSummary(1) });
    const all = presentNotices(initialState(), store, NOW);
    expect(all.keys).toEqual(['reminder|p|2026-10-02', 'sync|error|x', 'compat|2.4.2|1 change']);
    expect(all.unread).toBe(3);
    const some = presentNotices(read(['sync|error|x']), store, NOW);
    expect(some.rows.map((r) => r.unread)).toEqual([true, false, true]);
    expect(some.unread).toBe(2);
    // 行は残る（閉じても残る）。
    expect(some.rows).toHaveLength(3);
  });

  it('事実の版が変わると鍵が変わり、既読にしていても未読に戻る', () => {
    const state = read(['compat|2.4.2|1 change']);
    expect(presentNotices(state, storeOf({ readiness: compatSummary(1) }), NOW).unread).toBe(0);
    expect(presentNotices(state, storeOf({ readiness: compatSummary(2) }), NOW).unread).toBe(1);
    expect(presentNotices(state, storeOf({ readiness: compatSummary(1, '2.4.3') }), NOW).unread).toBe(1);
  });

  it('事実が無くなれば行も消える。既読の鍵が残っていても、行は出ない', () => {
    const state = read(['sync|error|x']);
    expect(presentNotices(state, storeOf({ sync: sync({ state: 'error', error: 'x' }) }), NOW).rows).toHaveLength(1);
    expect(presentNotices(state, storeOf({ sync: sync() }), NOW).rows).toEqual([]);
  });

  it('壊れた既読（配列でない）でも落ちない', () => {
    const state = { ...initialState(), noticesRead: undefined } as unknown as State;
    expect(presentNotices(state, storeOf({ sync: sync({ state: 'error', error: 'x' }) }), NOW).unread).toBe(1);
  });

  it('ベルの名前は、未読があれば数を添える', () => {
    expect(presentNotices(initialState(), storeOf(), NOW).label).toBe('通知');
    expect(presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: 'x' }) }), NOW).label).toBe('通知、未読 1 件');
  });

  it('English では、同じ事実から英語の文を引く', () => {
    const store = storeOf({ settings: en, ...withSessions([paused('p', '2026-10-02', '08:35')]), sync: sync({ state: 'error', error: 'HTTP 503' }), readiness: compatSummary(1), retention: retention(), configSync: cfgSync({ unsent: 2 }) });
    const p = presentNotices(initialState(), store, NOW);
    expect(p.label).toBe('Notifications, 5 unread');
    expect(p.rows.map((r) => [r.kindLabel, r.title])).toEqual([['Reminder', 'p'], ['Sync', 'Sync error'], ['Compatibility', 'Changes detected'], ['Retention', 'Transcripts are deleted after 30 days'], ['Config sync', '2 items not sent']]);
    expect(p.rows[0]!.when).toBe('25 min overdue');
    expect(p.rows[2]!.detail).toBe('Claude Code 2.4.2: 1 change');
    expect(p.rows.map((r) => r.action.label)).toEqual(['Open session', 'Open sync settings', 'Open details', 'Extend retention…', 'Show unsent items']);
  });
});
