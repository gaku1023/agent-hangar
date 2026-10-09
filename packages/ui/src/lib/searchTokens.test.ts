import { describe, expect, it } from 'vitest';
import type { SearchFilter } from '@agent-hangar/shared';
import { badTokens, formatQuery, parseQuery, queryTokens } from './searchTokens.ts';

const projects = [
  { id: 'p1', name: 'agent-hangar' }, { id: 'p2', name: 'agent' }, { id: 'p3', name: 'みかん畑プロジェクト' },
  { id: 'p4', name: 'my app' }, { id: 'p5', name: 'hangar-ui' }, { id: 'p6', name: 'hangar' },
];

describe('parseQuery', () => {
  it('is: since: project: file: を読み、残りを検索語にする', () => {
    expect(parseQuery('is:paused 動画 since:30d project:agent-h file:rows.css', projects)).toEqual({ text: '動画', filter: { status: 'paused', days: 30, projectId: 'p1', file: 'rows.css' } });
  });
  it('is: は状態の 5 つと、動きの running と waiting を受け、大文字小文字を問わない', () => {
    for (const s of ['paused', 'done', 'archived', 'active', 'proposed'] as const) expect(parseQuery(`is:${s}`).filter).toEqual({ status: s });
    expect(parseQuery('is:running').filter).toEqual({ live: 'running' });
    expect(parseQuery('is:waiting').filter).toEqual({ live: 'waiting' });
    expect(parseQuery('IS:Paused').filter).toEqual({ status: 'paused' });
  });
  // 状態が無いものは Active と呼ぶので none は無い。習慣で打った is:none は黙って捨てず、読めないトークンとして知らせる。
  it('is:none は条件として読まず、語に残して badTokens が拾う', () => {
    expect(parseQuery('is:none 動画')).toEqual({ text: 'is:none 動画', filter: {} });
    expect(badTokens('is:none 動画')).toEqual(['is:none']);
  });
  it('同じ項目が 2 度あれば後ろが勝つ。状態と動きは別の項目なので両方残る', () => {
    expect(parseQuery('is:paused is:done').filter).toEqual({ status: 'done' });
    expect(parseQuery('is:running is:paused').filter).toEqual({ live: 'running', status: 'paused' });
  });
  it('project: は名前がそのまま同じものを先に、無ければ前方一致のうち短い名前を取る', () => {
    expect(parseQuery('project:agent', projects).filter).toEqual({ projectId: 'p2' });
    expect(parseQuery('project:AGENT-H', projects).filter).toEqual({ projectId: 'p1' });
    expect(parseQuery('project:han', projects).filter).toEqual({ projectId: 'p6' });
  });
  it('project: は NFD と NFC の違いを問わずに当たる', () => {
    expect(parseQuery(`project:${'みかん畑プロ'.normalize('NFD')}`, projects).filter).toEqual({ projectId: 'p3' });
    expect(parseQuery('project:ご注文', [{ id: 'q1', name: 'ご注文ガイド'.normalize('NFD') }]).filter).toEqual({ projectId: 'q1' });
  });
  it('空白を含む値は二重引用符で包んで書ける', () => {
    expect(parseQuery('project:"my app" file:"docs/a b.md" x', projects)).toEqual({ text: 'x', filter: { projectId: 'p4', file: 'docs/a b.md' } });
  });
  it('since: は 1 日から 3650 日まで', () => {
    expect(parseQuery('since:3650d').filter).toEqual({ days: 3650 });
    expect(parseQuery('since:3651d').filter).toEqual({});
  });
  // 黙って捨てると、絞り込みが効いたように見えて実は全件を見ていることになる。
  it('読めないトークンは捨てずに検索語に残し、badTokens が拾う', () => {
    const q = 'is:pasued since:7 since:0d project:nope file: 動画';
    expect(parseQuery(q, projects)).toEqual({ text: 'is:pasued since:7 since:0d project:nope file: 動画', filter: {} });
    expect(badTokens(q, projects)).toEqual(['is:pasued', 'since:7', 'since:0d', 'project:nope', 'file:']);
  });
  it('projects を渡さなければ project: は読めず、語として残る', () => {
    expect(parseQuery('project:agent')).toEqual({ text: 'project:agent', filter: {} });
    expect(badTokens('project:agent')).toEqual(['project:agent']);
  });
  it('知らない鍵のコロンは、ただの語として扱い、知らせない', () => {
    expect(parseQuery('https://x.dev 12:30 foo:bar')).toEqual({ text: 'https://x.dev 12:30 foo:bar', filter: {} });
    expect(badTokens('https://x.dev 12:30 foo:bar')).toEqual([]);
  });
});

describe('formatQuery と queryTokens', () => {
  it('状態、動き、期間、プロジェクト、ファイル、語の順に書き、空白を含む値は引用符で包む', () => {
    expect(formatQuery('動画', { status: 'paused', live: 'waiting', days: 7, projectId: 'p4', file: 'a b.md' }, projects)).toBe('is:paused is:waiting since:7d project:"my app" file:"a b.md" 動画');
    expect(formatQuery('', {})).toBe('');
    expect(formatQuery('動画', {})).toBe('動画');
  });
  it('終了（ended）と until はトークンを持たない', () => {
    expect(queryTokens({ live: 'ended', until: 5 })).toEqual([]);
  });
  it('チップは項目の名前を持つので、× で外す先が分かる', () => {
    expect(queryTokens({ status: 'done', projectId: 'p1' }, projects)).toEqual([{ key: 'status', token: 'is:done' }, { key: 'projectId', token: 'project:agent-hangar' }]);
  });
  it('書いたものを読み直すと同じ条件に戻る', () => {
    const cases: [string, Partial<SearchFilter>][] = [
      ['動画 本文', { status: 'proposed', days: 30 }],
      ['', { live: 'running', projectId: 'p4', file: 'docs/a b.md' }],
      ['x', { projectId: 'p3' }],
      ['', { status: 'active', projectId: 'p6' }],
    ];
    for (const [text, filter] of cases) expect(parseQuery(formatQuery(text, filter, projects), projects)).toEqual({ text, filter });
  });
  // フォルダ名は NFD で来ることがある。名前の綴りをそのまま欄に書いても、読み直すと同じプロジェクトに戻る。
  it('空白・引用符・NFD を含む名前やパスでも、書いて読み直すと同じ条件に戻る', () => {
    const nfd = [
      { id: 'n1', name: 'ぷろじぇくと ご注文'.normalize('NFD') },
      { id: 'n2', name: 'ぷろじぇくと' .normalize('NFD') },
    ];
    const filter: Partial<SearchFilter> = { projectId: 'n1', file: 'docs/ばぐ 修正.md'.normalize('NFD') };
    const s = formatQuery('動画', filter, nfd);
    expect(s).toContain('project:"');
    expect(parseQuery(s, nfd)).toEqual({ text: '動画', filter });
    // NFC で打った前方一致も NFD の名前に当たる。
    expect(parseQuery('project:ぷろじぇくと', nfd).filter).toEqual({ projectId: 'n2' });
    expect(parseQuery('project:"ぷろじぇくと ご"', nfd).filter).toEqual({ projectId: 'n1' });
  });
  it('引用符を含む値は引用符を落として書く（読み直しても壊れない）', () => {
    const s = formatQuery('', { file: 'a "b" c.md' });
    expect(parseQuery(s).filter).toEqual({ file: 'a b c.md' });
  });
});
