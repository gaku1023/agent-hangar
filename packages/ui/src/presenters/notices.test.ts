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
const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name: id, cwd: '/w/alpha', firstPrompt: 'first', aiTitle: null, startedAt: NOW - 5 * H, lastActivityAt: NOW - 4 * H, lastTurnAt: null, hasTranscript: true, live: null, summary: null, stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, woke: false, liveAside: null, waitingFor: null, permission: null, limit: null, interrupted: null, overlap: null, newerElsewhere: false, takenOver: null, fromPhone: null, pinnedAt: null, unread: null, spawnedBy: null, ...over });
const paused = (id: string, returnOn: string | null, returnTime: string | null = null, note = `${id} を確かめる`) => dto(id, { state: st({ status: 'paused', note, returnOn, returnTime, setBy: 'user', setAt: 1 }) });
const sync = (o: Partial<SyncStatusBody> = {}): SyncStatusBody => ({ state: 'idle', paused: false, url: 'https://w', lastPushAt: null, lastPullAt: NOW - MIN, pending: 0, error: null, deviceCount: 1, limitedUntil: null, skipped: [], sweepPending: 0, oncePass: false, diskShort: null, ...o });
const compatSummary = (driftCount: number, localVersion: string | null = '2.4.2') => ({ compat: { verifiedVersion: '2.4.0', localVersion, driftCount } }) as unknown as ReadinessDto;
const drift = (n: number, lastSeenAt = NOW - 12 * MIN): CompatDto => ({ verifiedVersion: '2.4.0', localVersion: '2.4.2', drifts: Array.from({ length: n }, (_, i) => ({ contract: 'registry' as const, value: `status=v${i}`, version: '2.4.2', count: 3, firstSeenAt: lastSeenAt - H, lastSeenAt: lastSeenAt - i * MIN })) });
const retention = (o: Partial<RetentionDto> = {}): RetentionDto => ({ days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null, ...o });
const cfgSync = (o: Partial<ConfigSyncDto> = {}): ConfigSyncDto => ({ enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 0, backups: 0, applyOrder: null, lastSentAt: null, ...o });
const storeOf = (over: Partial<Store> = {}): Store => ({ ...initialStore(), bootstrapped: true, ...over });
const withSessions = (list: SessionDto[]) => ({ sessions: Object.fromEntries(list.map((s) => [s.id, s])) });
const read = (keys: string[]): State => ({ ...initialState(), noticesRead: keys });
const en = { language: 'en' } as unknown as SettingsDto;
/**
 * 空きが足りずに止めたときの行の文（会話 3 件、取得していない分 2.4 GB、残す分 5 GB、今の空き 6 GB）。札も同じ題を使う。
 * 説明の数は「あと空ける量」の 1 つだけにする（2.4 + 5 − 6 = 1.4 GB）。
 */
const DISK_TITLE_JA = '空き容量が不足しているため、会話 3 件の取得を中断しました';
const DISK_DETAIL_JA = 'ディスクの空きをあと 1.4 GB 増やすと、残りの会話をすべて取得できます。空きができしだい、自動で再開します。';

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
    const [row] = presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: 'サーバーが 503 を返しました' }) }), NOW).rows;
    expect(row).toMatchObject({ key: 'sync|error|サーバーが 503 を返しました', kind: 'sync', tone: 'err', kindLabel: '同期', title: '同期エラー', detail: 'サーバーが 503 を返しました', when: null, unread: true });
    expect(row!.action).toEqual({ label: '同期の設定を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'sync' } } });
    // 「エージェントで調査…」へ、同期のエラーの文を渡す。
    expect(row!.investigate).toEqual({ op: 'sync', message: 'サーバーが 503 を返しました' });
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
    expect(quota).toMatchObject({ key: `sync|paused|quota|${until}`, tone: 'warn', title: '無料枠の上限で停止 · 9:00 にリセット' });
  });

  // リマインダーはホームの帯（要対応）にあるので、注意には入れない（2026-10-13 の決定、9a）。
  it('Paused のリマインダーは、今日でも過ぎていても行にしない', () => {
    const store = storeOf(withSessions([paused('pay', '2026-10-02', '08:35'), paused('stale', '2026-09-29'), paused('x', null)]));
    expect(presentNotices(initialState(), store, NOW).rows).toEqual([]);
  });

  it('互換は、変更点があるときだけ行にする。未検証の版と変更点なしは行にしない', () => {
    expect(presentNotices(initialState(), storeOf({ readiness: compatSummary(0) }), NOW).rows).toEqual([]);
    expect(presentNotices(initialState(), storeOf({ readiness: compatSummary(0, '2.5.0') }), NOW).rows).toEqual([]);
    const [row] = presentNotices(initialState(), storeOf({ readiness: compatSummary(1) }), NOW).rows;
    expect(row).toMatchObject({ key: 'compat|2.4.2|1 change', kind: 'compat', tone: 'warn', kindLabel: '互換性', title: '変更点あり', detail: 'Claude Code 2.4.2：変更点 1 件', when: null, unread: true });
    expect(row!.investigate).toEqual({ op: 'compat', message: '変更点あり\nClaude Code 2.4.2：変更点 1 件', agent: 'claude-code' });
    // 設定の互換の節は、足す切り替え先がまだ無いので、設定の頭へ移る（at は設定の目次の作り直しで足す）。
    expect(row!.action).toEqual({ label: '詳細を開く', send: { type: 'nav.go', to: { name: 'settings' } } });
  });

  it('互換の中身（GET /api/compat）が届いたら、件数は中身にそろえ、最後に見た時刻を添える', () => {
    const [row] = presentNotices(initialState(), storeOf({ readiness: compatSummary(1), compat: drift(3) }), NOW).rows;
    expect(row).toMatchObject({ key: 'compat|2.4.2|3 change', detail: 'Claude Code 2.4.2：変更点 3 件', when: '12 分前' });
  });

  it('手元の版が読めないときは「版は不明」と言う', () => {
    const [row] = presentNotices(initialState(), storeOf({ readiness: compatSummary(2, null) }), NOW).rows;
    expect(row).toMatchObject({ key: 'compat|unknown|2 change', detail: 'Claude Code：変更点 2 件（インストール済みのバージョンは不明）' });
  });

  it('古いサーバ（readiness に compat が無い）でも落ちず、行を作らない', () => {
    expect(presentNotices(initialState(), storeOf({ readiness: {} as ReadinessDto }), NOW).rows).toEqual([]);
  });

  // 保持期間の日数（決まり）は設定の「セッション」の目次に残し、注意には消えかけがあるときだけ出す（9a）。
  it('保持期間は、消えかけのトランスクリプトが無ければ行にしない', () => {
    for (const r of [null, retention(), retention({ source: 'user', userValue: 365, days: 365 }), retention({ source: 'managed', writable: false }), retention({ writable: false })]) {
      expect(presentNotices(initialState(), storeOf({ retention: r }), NOW).rows).toEqual([]);
    }
  });

  it('消えかけのトランスクリプトがあれば、その件数を言う', () => {
    const old = (id: string, days: number) => dto(id, { hasTranscript: true, transcriptMtime: NOW - days * 86_400_000 });
    const store = storeOf({ retention: retention(), ...withSessions([old('a', 27), old('b', 25), old('c', 1)]) });
    const [row] = presentNotices(initialState(), store, NOW).rows;
    expect(row).toMatchObject({ key: 'retention|30|soon', kind: 'retention', tone: 'warn', kindLabel: '保持期間', title: 'セッションのトランスクリプト 2 件が、まもなく削除されます', detail: 'Claude Code は 30 日でトランスクリプトを削除します' });
    expect(row!.action).toEqual({ label: '保持期間を延長…', send: { type: 'nav.go', to: { name: 'settings' } } });
    // 自分で値を入れた人、書き換えられない人には、消えかけがあっても出さない。
    for (const r of [retention({ source: 'user', userValue: 30 }), retention({ writable: false })]) {
      expect(presentNotices(initialState(), { ...store, retention: r }, NOW).rows).toEqual([]);
    }
  });

  // 本文を降ろせなかったときの error のトーストは、サーバから外した（PR 29）。事実は同期の状態の skipped に残るので、ベルの行にする。
  it('降ろせなかった本文（諦めた項目）があれば、同期の状態とは別の赤の行にして、最初の理由を添える', () => {
    const skipped = [{ key: 'transcripts/mini/u1.jsonl.gz', attempts: 3, message: '復号できません' }, { key: 'transcripts/mini/u2.jsonl.gz', attempts: 3, message: '壊れています' }];
    const rows = presentNotices(initialState(), storeOf({ sync: sync({ skipped }) }), NOW).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'sync|skipped|2', kind: 'sync', tone: 'err', kindLabel: '同期', title: '取得できなかったトランスクリプト 2 件', detail: '復号できません', unread: true });
    expect(rows[0]!.action.send).toEqual({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
    expect(rows[0]!.investigate).toEqual({ op: 'sync', message: '取得できなかったトランスクリプト 2 件\ntranscripts/mini/u1.jsonl.gz: 復号できません\ntranscripts/mini/u2.jsonl.gz: 壊れています' });
    // 状態の行（エラー）と並べても、別の行になる。状態の行が先。
    const both = presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: 'x', skipped }) }), NOW).rows;
    expect(both.map((r) => r.key)).toEqual(['sync|error|x', 'sync|skipped|2']);
    // 数が変われば鍵が変わり、また未読になる。同期を使っていない端末には出さない。
    expect(presentNotices(read(['sync|skipped|2']), storeOf({ sync: sync({ skipped }) }), NOW).unread).toBe(0);
    expect(presentNotices(read(['sync|skipped|2']), storeOf({ sync: sync({ skipped: skipped.slice(0, 1) }) }), NOW).unread).toBe(1);
    expect(presentNotices(initialState(), storeOf({ sync: sync({ state: 'off', url: null, skipped }) }), NOW).rows).toEqual([]);
  });

  it('空きが足りずに取得を止めていれば、黄の行で会話の数と要る大きさを言い、同期の設定へ移る', () => {
    const GB = 1e9;
    const diskShort = { sessions: 3, needBytes: 2.4 * GB, freeBytes: 6 * GB, reserveBytes: 5 * GB };
    const rows = presentNotices(initialState(), storeOf({ sync: sync({ diskShort }) }), NOW).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'sync|diskShort|3', kind: 'sync', tone: 'warn', title: DISK_TITLE_JA, detail: DISK_DETAIL_JA, unread: true });
    // その場で空ける口は無いので、注意の文でエージェントに調べさせる。
    expect(rows[0]!.investigate).toEqual({ op: 'disk', message: `${DISK_TITLE_JA}\n${DISK_DETAIL_JA}` });
    expect(rows[0]!.action.send).toEqual({ type: 'nav.go', to: { name: 'settings', at: 'sync' } });
    // 同期を使っていない端末では出さない。止めていなければ出さない。
    expect(presentNotices(initialState(), storeOf({ sync: sync({ state: 'off', url: null, diskShort }) }), NOW).rows).toEqual([]);
    expect(presentNotices(initialState(), storeOf({ sync: sync() }), NOW).rows).toEqual([]);
  });

  // 通知の誘いは注意から外し、始める前の確認の任意の行にした（9c）。
  it('通知を受け取っていなくても、行にしない', () => {
    for (const notify of [{ available: true, on: false, blocked: false }, { available: true, on: true, blocked: false, ask: true as const }]) {
      expect(presentNotices(initialState(), storeOf({ notify }), NOW).rows).toEqual([]);
    }
  });

  // 設定の同期で送らなかった項目（段 4 の PR 19）。事実は ConfigSyncDto.unsent の件数で、件数が 0 に戻れば行も消える。
  it('設定の同期で送らなかった項目があれば、件数を言う行にして、送らなかった項目の常設の行へ移る', () => {
    const [row] = presentNotices(initialState(), storeOf({ configSync: cfgSync({ unsent: 3 }) }), NOW).rows;
    expect(row).toMatchObject({ key: 'config|unsent|3', kind: 'config', tone: 'warn', icon: 'settings', kindLabel: '設定の同期', title: '送信しなかった項目 3 件', when: null, unread: true });
    expect(row!.detail).toContain('それでも送信');
    expect(row!.action).toEqual({ label: '送信しなかった項目を開く', send: { type: 'nav.go', to: { name: 'settings', at: 'unsent' } } });
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

  it('種類の並びは、同期、互換、保持期間、設定の同期', () => {
    const old = dto('old', { hasTranscript: true, transcriptMtime: NOW - 27 * 86_400_000 });
    const store = storeOf({ ...withSessions([paused('p', '2026-10-02'), old]), sync: sync({ state: 'error', error: 'x' }), readiness: compatSummary(1), retention: retention(), configSync: cfgSync({ unsent: 1 }), notify: { available: true, on: false, blocked: false } });
    expect(presentNotices(initialState(), store, NOW).rows.map((r) => r.kind)).toEqual(['sync', 'compat', 'retention', 'config']);
  });

  it('既読の鍵の行は未読でなくなり、未読の数と鍵の一覧に反映する', () => {
    const store = storeOf({ sync: sync({ state: 'error', error: 'x' }), readiness: compatSummary(1), configSync: cfgSync({ unsent: 1 }) });
    const all = presentNotices(initialState(), store, NOW);
    expect(all.keys).toEqual(['sync|error|x', 'compat|2.4.2|1 change', 'config|unsent|1']);
    expect(all.unread).toBe(3);
    const some = presentNotices(read(['sync|error|x']), store, NOW);
    expect(some.rows.map((r) => r.unread)).toEqual([false, true, true]);
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

  it('注意の名前は、未読があれば数を添える', () => {
    expect(presentNotices(initialState(), storeOf(), NOW).label).toBe('通知');
    expect(presentNotices(initialState(), storeOf({ sync: sync({ state: 'error', error: 'x' }) }), NOW).label).toBe('通知、未読 1 件');
  });

  it('English では、同じ事実から英語の文を引く', () => {
    const old = dto('old', { hasTranscript: true, transcriptMtime: NOW - 27 * 86_400_000 });
    const store = storeOf({ settings: en, ...withSessions([paused('p', '2026-10-02', '08:35'), old]), sync: sync({ state: 'error', error: 'HTTP 503' }), readiness: compatSummary(1), retention: retention(), configSync: cfgSync({ unsent: 2 }) });
    const p = presentNotices(initialState(), store, NOW);
    expect(p.label).toBe('Notifications, 4 unread');
    expect(p.rows.map((r) => [r.kindLabel, r.title])).toEqual([['Sync', 'Sync error'], ['Compatibility', 'Changes detected'], ['Retention', '1 session transcript will be deleted soon'], ['Config sync', '2 items not sent']]);
    expect(p.rows[1]!.detail).toBe('Claude Code 2.4.2: 1 change');
    expect(p.rows.map((r) => r.action.label)).toEqual(['Open sync settings', 'Open details', 'Extend retention…', 'Show unsent items']);
  });
});
