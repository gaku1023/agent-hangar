import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionStateDto } from '@agent-hangar/shared';
import { periodStart } from '../mediator/screen.ts';
import { returnOnLabel, sortForSections, type SessionRowProps } from './row.ts';
import { DONE_HEAD, matchesStatus, returnKey, sectionRows, type ListItem } from './sections.ts';

/** 2026-10-02（金）の朝 9 時。 */
const NOW = new Date(2026, 9, 2, 9, 0).getTime();
const H = 3_600_000;
const DAY = 24 * H;
const IMPORT_AT = new Date(2026, 9, 1, 8, 0).getTime();

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: id, oneLiner: '', projectName: 'agent-hangar', live: null, stateLabel: '', summaryState: null, model: '', effort: '', when: '', whenAbs: '', filesChanged: 0, prUrl: null, memo: null, hasTranscript: true, transcript: 'present', cost: '', runId: null, state: null, returnOn: null, overdueDays: null, candidate: null, setBy: null, ...over });
const paused = (id: string, returnOn: string | null, over: Partial<SessionRowProps> = {}) => row(id, { state: 'paused', returnOn, setBy: 'user', ...over });
const done = (id: string, over: Partial<SessionRowProps> = {}) => row(id, { state: 'done', setBy: 'import', ...over });
const cand = (status: 'paused' | 'done') => ({ status, note: '直した', returnOn: status === 'paused' ? '2026-10-03' : null, source: 'in_session' as const, ago: '1 時間前' });
/** 見出しを「# id 件数 [ボタン→先]」、行を id にして並びを読む。 */
const shape = (items: ListItem[]) => items.map((i) => (i.kind === 'head' ? `# ${i.id} ${i.count}${i.more ? ` [${i.more.label}→${i.more.target}]` : ''}` : i.row.id));
const project = (rows: SessionRowProps[], expanded: string[] = [], now = NOW) => shape(sectionRows(rows, 'project', { now, doneHead: DONE_HEAD, expanded: new Set(expanded) }));
const sessions = (rows: SessionRowProps[], expanded: string[] = [], now = NOW) => shape(sectionRows(rows, 'sessions', { now, doneHead: DONE_HEAD, expanded: new Set(expanded) }));

describe('sectionRows（プロジェクト画面の P3）', () => {
  it('導入の翌日：全部 Done なら Done の節だけで、直近 3 件と「ほか N 件」を出し、広げれば全件', () => {
    const rows = [done('cpu'), done('nfd'), done('resp'), done('ux')];
    expect(project(rows)).toEqual(['# done 4 [ほか 1 件 ▸→done]', 'cpu', 'nfd', 'resp']);
    expect(project(rows, ['done'])).toEqual(['# done 4 [畳む ▴→done]', 'cpu', 'nfd', 'resp', 'ux']);
  });
  it('平日の朝：今日戻る → 続き → Done の順で、中身の無い節（いま動いている）は出さない', () => {
    const rows = [row('backspace'), row('nfd', { candidate: cand('done') }), done('resp'), paused('sync', '2026-10-02'), paused('explainer', '2026-10-09'), row('apple'), paused('retention', '2026-10-06')];
    // 続きは印なし、提案あり、戻る日が先の Paused を、渡された並び（新しい順）のまま並べる。目当ての backspace は j 2 回で届く。
    expect(project(rows)).toEqual(['# returning 1', 'sync', '# continue 5', 'backspace', 'nfd', 'explainer', 'apple', 'retention', '# done 1', 'resp']);
  });
  it('作業中：動いているものは状態に関わらず「いま動いている」に、入力待ち → 実行中の並びのまま置く', () => {
    const rows = [row('newui', { live: 'waiting' }), done('status', { live: 'busy', setBy: 'user' }), row('trial', { state: 'archived', live: 'idle' }), row('boot', { runId: 'r1' }), done('ux', { setBy: 'user' }), row('backspace'), paused('sync', '2026-10-03'), done('resp')];
    expect(project(rows)).toEqual(['# live 4', 'newui', 'status', 'trial', 'boot', '# continue 2', 'backspace', 'sync', '# done 2', 'ux', 'resp']);
  });
  it('2 週間後：期限の過ぎた Paused 4 件は、利用者が決めるまで「今日戻る」に戻る日の古い順で残る', () => {
    const later = new Date(2026, 9, 16, 9, 0).getTime();
    const rows = [row('impl'), paused('newui', '2026-10-03'), paused('sync', '2026-10-04'), paused('explainer', '2026-10-07'), paused('retention', '2026-10-06'), done('nfd')];
    expect(project(rows, [], later)).toEqual(['# returning 4', 'newui', 'sync', 'retention', 'explainer', '# continue 1', 'impl', '# done 1', 'nfd']);
  });
  it('Archived は末尾の 1 行にまとめ、広げると行を出す', () => {
    const rows = [row('a'), row('trash', { state: 'archived' }), row('try', { state: 'archived' })];
    expect(project(rows)).toEqual(['# continue 1', 'a', '# archived 2 [表示 ▸→archived]']);
    expect(project(rows, ['archived'])).toEqual(['# continue 1', 'a', '# archived 2 [隠す ▴→archived]', 'trash', 'try']);
  });
  it('中身がある節だけを出し、何も無ければ空', () => {
    expect(project([])).toEqual([]);
    expect(project([done('x')])).toEqual(['# done 1', 'x']);
  });
  it('「今日」の境は手元の暦の 0 時（periodStart(1, now) と同じ）', () => {
    const midnight = periodStart(1, NOW);
    const rows = [paused('p', '2026-10-02')];
    expect(project(rows, [], midnight)).toEqual(['# returning 1', 'p']);
    expect(project(rows, [], midnight - 1)).toEqual(['# continue 1', 'p']);
  });
  // 同期や古い端末から、戻る日の無い Paused が届くことがある。続きに紛れると、しおりを見失う。
  it('戻る日が欠けた Paused と暦に無い日の Paused は、落とさずに「今日戻る」の先頭に置く', () => {
    const rows = [paused('ok', '2026-10-01'), paused('none', null), paused('broken', '2026-02-30'), paused('later', '2026-10-05')];
    expect(project(rows)).toEqual(['# returning 3', 'none', 'broken', 'ok', '# continue 1', 'later']);
    expect(sessions(rows)).toEqual(['# returning 3', 'none', 'broken', 'ok', '# paused 1 [この節だけ見る ▸→paused]', 'later']);
  });
});

describe('戻る日が壊れた Paused（Ruling 2A）', () => {
  it('欠けた・暦に無い・形が違うものは「今日戻る」の先頭で、札は「日付なし」', () => {
    const rows = [paused('ok', '2026-10-01'), paused('missing', null), paused('feb30', '2026-02-30'), paused('someday', 'いつか')];
    expect(project(rows)).toEqual(['# returning 4', 'missing', 'feb30', 'someday', 'ok']);
    for (const r of rows.slice(1)) expect(returnOnLabel(r.returnOn, r.overdueDays)).toBe('日付なし');
    expect(returnOnLabel(rows[0]!.returnOn, 1)).toBe('1 日過ぎ');
  });
  it('returnKey は正しい戻る日をそのまま、欠けた日と壊れた日を空にする（Home が使い回す）', () => {
    expect(returnKey(paused('a', '2026-10-05'))).toBe('2026-10-05');
    expect(returnKey(paused('b', null))).toBe('');
    expect(returnKey(paused('c', 'いつか'))).toBe('');
    expect(returnKey(paused('d', '2026-02-30'))).toBe('');
  });
});

describe('sectionRows（Sessions 画面の ★）', () => {
  it('今日戻る → 確かめる → いま動いている → Paused → 印なし → Done、Archived は末尾の 1 行', () => {
    const rows = [row('newui', { live: 'waiting' }), row('status', { live: 'busy' }), row('nfd', { candidate: cand('done') }), row('video', { candidate: cand('paused') }), row('e2e', { candidate: cand('done') }), row('backspace'), paused('sync', '2026-10-02'), paused('parkour', '2026-10-09'), done('resp'), done('subs'), row('apple', { state: 'archived' })];
    expect(sessions(rows)).toEqual([
      '# returning 1', 'sync',
      '# proposed 3 [この節だけ見る ▸→proposed]', 'nfd', 'video', 'e2e',
      '# live 2 [この節だけ見る ▸→live]', 'newui', 'status',
      '# paused 1 [この節だけ見る ▸→paused]', 'parkour',
      '# none 1 [この節だけ見る ▸→none]', 'backspace',
      '# done 2 [この節だけ見る ▸→done]', 'resp', 'subs',
      '# archived 1 [表示 ▸→archived]',
    ]);
  });
  it('「ほか N 件」の数字は桁を区切る', () => {
    const rows = Array.from({ length: 1224 }, (_, k) => done('d' + k));
    const head = sessions(rows)[0];
    expect(head).toBe('# done 1224 [ほか 1,221 件 ▸→done]');
  });
  it('Done は直近 3 件と「ほか N 件」で、広げる代わりにタブへ移るので expanded を使わない', () => {
    const rows = [done('a'), done('b'), done('c'), done('d'), done('e')];
    expect(sessions(rows, ['done'])).toEqual(['# done 5 [ほか 2 件 ▸→done]', 'a', 'b', 'c']);
  });
});

describe('matchesStatus（タブの絞り込み）', () => {
  it('節の振り分けではなく、行の持ち物だけで決める', () => {
    const liveDone = row('l', { live: 'idle', state: 'done' });
    expect(matchesStatus(liveDone, 'active')).toBe(true);
    expect(matchesStatus(liveDone, 'done')).toBe(true);
    expect(matchesStatus(row('b', { runId: 'r1' }), 'active')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'proposed')).toBe(true);
    expect(matchesStatus(row('c', { candidate: cand('done') }), 'none')).toBe(false);
    expect(matchesStatus(row('n'), 'none')).toBe(true);
    expect(matchesStatus(row('n'), 'active')).toBe(false);
    expect(matchesStatus(paused('p', '2026-10-09'), 'paused')).toBe(true);
    expect(matchesStatus(row('z', { state: 'archived' }), 'archived')).toBe(true);
  });
});

describe('sortForSections', () => {
  const st = (o: Partial<SessionStateDto>): SessionStateDto => ({ status: null, note: null, returnOn: null, setBy: null, setAt: null, candidate: null, ...o });
  const dto = (id: string, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'alpha', name: id, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: null, lastActivityAt: NOW - H, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, state: null, ...over });
  // 確定した行や手で Done にした行は、最後に動いた時刻が古くても Done の節の先頭に来る。畳んだ中に消えないように。
  it('Done の行は Done にした時刻の新しい順、導入時の一括（同じ時刻）の中は最後に動いた時刻の新しい順', () => {
    const list = [
      dto('imp-old', { lastActivityAt: NOW - 3 * DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
      dto('open', { lastActivityAt: NOW - 2 * H }),
      dto('confirmed', { lastActivityAt: NOW - 10 * DAY, state: st({ status: 'done', setBy: 'user', setAt: NOW - 60_000 }) }),
      dto('imp-new', { lastActivityAt: NOW - DAY, state: st({ status: 'done', setBy: 'import', setAt: IMPORT_AT }) }),
      dto('live', { live: 'busy', lastActivityAt: NOW - 5 * DAY, state: st({ status: 'done', setBy: 'user', setAt: NOW }) }),
      dto('older', { lastActivityAt: NOW - 4 * DAY }),
    ];
    const ids = sortForSections(list).map((s) => s.id);
    expect(ids[0]).toBe('live');
    expect(ids.filter((id) => ['confirmed', 'imp-new', 'imp-old'].includes(id))).toEqual(['confirmed', 'imp-new', 'imp-old']);
    expect(ids.filter((id) => ['open', 'older'].includes(id))).toEqual(['open', 'older']);
  });
});
