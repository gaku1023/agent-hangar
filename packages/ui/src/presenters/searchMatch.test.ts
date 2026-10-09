import { describe, expect, it } from 'vitest';
import type { SearchHitDto, SessionDto } from '@agent-hangar/shared';
import { initialState } from '../mediator/transition.ts';
import { initialStore, type Store } from '../store/store.ts';
import { presentSessionList } from './sessions.ts';

const NOW = Date.parse('2026-09-02T12:00:00Z');
const session = (id: string, name: string): SessionDto => ({
  id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: null, name, cwd: '/w/alpha', firstPrompt: null, aiTitle: null, startedAt: NOW - 7_200_000, lastActivityAt: NOW - 60_000, memo: null, hasTranscript: true, live: null,
  summary: { title: 't', oneLiner: '要約の 1 文', body: 'b', state: 'done', nextSteps: [], source: 'baseline', sourceId: null, sourceModel: null, basedOnTurns: 2, updatedAt: 1 },
  stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null },
  fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null,
});
const snippet = (text: string) => ({ seq: 3, role: 'user', text, agentId: null });
const search = (hits: SearchHitDto[], total: number, text = 'CSV'): { state: ReturnType<typeof initialState>; store: Store } => {
  const store = initialStore();
  store.sessions = { a: session('a', 'CSV の書き出し'), b: session('b', '請求書の出力'), c: session('c', '集計の見直し'), d: session('d', '月次の処理') };
  store.search = { params: { q: text }, result: { hits, total }, loading: false };
  return { state: { ...initialState(), screen: { name: 'home', q: text }, search: { text, filter: {}, page: 1 } }, store };
};
const heads = (r: ReturnType<typeof presentSessionList>) => (r.items ?? []).flatMap((it) => (it.kind === 'head' ? [{ id: it.id, label: it.label, count: it.count }] : []));
const order = (r: ReturnType<typeof presentSessionList>) => (r.items ?? []).map((it) => (it.kind === 'head' ? `#${it.id}` : it.row.id));

describe('ホームの検索の結果（名前、要約、トランスクリプトの見出し）', () => {
  const hits: SearchHitDto[] = [
    { sessionId: 'a', matchCount: 2, snippets: [snippet('…CSV を出す…')], matched: ['name', 'transcript'] },
    { sessionId: 'b', matchCount: 0, snippets: [], matched: ['summary'] },
    { sessionId: 'c', matchCount: 4, snippets: [snippet('…CSV…')], matched: ['transcript'] },
    { sessionId: 'd', matchCount: 1, snippets: [snippet('…CSV…')], matched: ['transcript'] },
  ];

  it('名前か要約に当たった行を「名前に一致」の下に、トランスクリプトだけの行を「トランスクリプトに一致」の下に並べる', () => {
    const { state, store } = search(hits, 4);
    const r = presentSessionList(state, store, NOW);
    expect(order(r)).toEqual(['#nameMatch', 'a', 'b', '#transcriptMatch', 'c', 'd']);
    expect(heads(r)).toEqual([{ id: 'nameMatch', label: '名前に一致', count: 2 }, { id: 'transcriptMatch', label: 'トランスクリプトに一致', count: 2 }]);
    // 行の並びは見出しを除いてサーバの順のまま。
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('名前に当たった行は、名前の一致する語に印を付ける。名前に当たらない行には付けない', () => {
    const { state, store } = search(hits, 4);
    const r = presentSessionList(state, store, NOW);
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId.a!.nameMarks).toEqual([{ text: 'CSV', hit: true }, { text: ' の書き出し', hit: false }]);
    expect(byId.b!.nameMarks).toBeUndefined();
    expect(byId.c!.nameMarks).toBeUndefined();
  });

  it('要約に当たった行には「要約に一致」の札の印を付ける', () => {
    const { state, store } = search(hits, 4);
    const r = presentSessionList(state, store, NOW);
    const byId = Object.fromEntries(r.rows.map((x) => [x.id, x]));
    expect(byId.b!.summaryMatch).toBe(true);
    expect(byId.a!.summaryMatch).toBeFalsy();
    expect(byId.c!.summaryMatch).toBeFalsy();
  });

  it('名前と要約だけに当たった行は抜粋を持たず、2 段目に要約の 1 文を出す', () => {
    const { state, store } = search(hits, 4);
    const b = presentSessionList(state, store, NOW).rows.find((x) => x.id === 'b')!;
    expect(b.excerpt).toEqual([]);
    expect(b.oneLiner).toBe('要約の 1 文');
    expect(b.jump).toBeUndefined();
  });

  it('名前にもトランスクリプトにも当たった行は、抜粋を持ち、開くと一致へ跳ぶ', () => {
    const { state, store } = search(hits, 4);
    const a = presentSessionList(state, store, NOW).rows.find((x) => x.id === 'a')!;
    expect(a.excerpt).toEqual([{ text: '…', hit: false }, { text: 'CSV', hit: true }, { text: ' を出す…', hit: false }]);
    expect(a.jump).toEqual({ seq: 3, q: 'CSV' });
  });

  it('見出しの件数は、全件の数から数える。続きを読み込んでいない間も、トランスクリプトの全件が分かる', () => {
    // 全 40 件のうち、名前の組 2 件とトランスクリプトの 2 件だけを読んだ。
    const { state, store } = search(hits, 40);
    expect(heads(presentSessionList(state, store, NOW))).toEqual([{ id: 'nameMatch', label: '名前に一致', count: 2 }, { id: 'transcriptMatch', label: 'トランスクリプトに一致', count: 38 }]);
  });

  it('名前の組を読み切っていないとき（読んだ行がみな名前の組）は、件数を言わない', () => {
    const { state, store } = search(hits.slice(0, 2), 40);
    const r = presentSessionList(state, store, NOW);
    expect(order(r)).toEqual(['#nameMatch', 'a', 'b']);
    expect(heads(r)).toEqual([{ id: 'nameMatch', label: '名前に一致', count: null }]);
  });

  it('トランスクリプトだけに当たった結果にも、見出しを 1 つ付ける', () => {
    const { state, store } = search(hits.slice(2), 2);
    const r = presentSessionList(state, store, NOW);
    expect(order(r)).toEqual(['#transcriptMatch', 'c', 'd']);
    expect(heads(r)).toEqual([{ id: 'transcriptMatch', label: 'トランスクリプトに一致', count: 2 }]);
  });

  it('当たった場所を送らない古いサーバの結果は、見出しなしの平らな一覧のまま', () => {
    const old: SearchHitDto[] = hits.map(({ matched: _matched, ...h }) => h);
    const { state, store } = search(old, 4);
    const r = presentSessionList(state, store, NOW);
    expect(r.items).toBeNull();
    expect(r.rows.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.rows.every((x) => x.nameMarks === undefined && !x.summaryMatch)).toBe(true);
  });

  it('語の無い検索（触ったファイルだけ）と、手元の一覧は、見出しを付けない', () => {
    const files = search(hits.map((h) => ({ sessionId: h.sessionId, matchCount: 1, snippets: [] })), 4, '');
    const withFile = { ...files.state, search: { text: '', filter: { file: 'a.ts' }, page: 1 } };
    expect(presentSessionList(withFile, files.store, NOW).items).toBeNull();
    expect(presentSessionList(initialState(), files.store, NOW).items).toBeNull();
  });

  it('結果が空なら見出しも出さない', () => {
    const { state, store } = search([], 0);
    const r = presentSessionList(state, store, NOW);
    expect(r.items).toBeNull();
    expect(r.rows).toEqual([]);
  });

  it('英語の画面では見出しも英語', () => {
    const { state, store } = search(hits, 4);
    store.settings = { language: 'en' } as Store['settings'];
    expect(heads(presentSessionList(state, store, NOW)).map((h) => h.label)).toEqual(['Name matches', 'Transcript matches']);
  });
});
