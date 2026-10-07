import { describe, expect, it } from 'vitest';
import type { SessionDto, SessionSummaryDto } from '@agent-hangar/shared';
import { cardExcerpt, meaningfulUtterance } from './excerpt.ts';

const summary = (oneLiner: string, source: SessionSummaryDto['source'] = 'in_session'): SessionSummaryDto => ({ title: 't', oneLiner, body: '', state: 'in_progress', nextSteps: [], source, sourceId: null, sourceModel: null, basedOnTurns: 1, updatedAt: 1 });
const session = (id: string, at: number, over: Partial<SessionDto> = {}): SessionDto => ({ id, provider: 'claude-code', providerSessionId: 'u' + id, projectId: 'p', name: id, cwd: '/w/p', firstPrompt: null, aiTitle: null, startedAt: at, lastActivityAt: at, memo: null, hasTranscript: true, live: null, summary: null, stats: { turns: 1, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: null, parked: false, stoppedByStatus: false, liveAside: null, ...over });

describe('meaningfulUtterance（抜粋から除く雑音の規則）', () => {
  it('HTML やコードだけの発言は除く', () => {
    expect(meaningfulUtterance('<input class="txt1" id="PhoneNo" style="width:120px">')).toBeNull();
    expect(meaningfulUtterance('<command-message>init</command-message>\n<command-name>/init</command-name>')).toBeNull();
    expect(meaningfulUtterance('```ts\nconst a = 1;\n```')).toBeNull();
  });
  it('貼り付けの置き換え表記は除き、残りがあればそれを使う', () => {
    expect(meaningfulUtterance('[Pasted text #1 +5 lines]')).toBeNull();
    expect(meaningfulUtterance('[Pasted text #1 +5 lines] [Image #2]')).toBeNull();
    expect(meaningfulUtterance('このログを見て [Pasted text #1 +12 lines]')).toBe('このログを見て');
  });
  it('終わりの打鍵と、exit のような英字 1 語だけの発言は除く', () => {
    for (const t of ['exit', 'q', ':q', 'quit', 'ok', 'yes', ' continue ']) expect(meaningfulUtterance(t), t).toBeNull();
  });
  it('スラッシュコマンドは引数があっても除く', () => {
    for (const t of ['/init', '/clear', '/compact', '/exit', '/compact 認証の話だけ残して', '/mcp__server:tool x']) expect(meaningfulUtterance(t), t).toBeNull();
  });
  it('URL だけの発言は除く', () => {
    expect(meaningfulUtterance('https://example.com/a/b?c=1')).toBeNull();
    expect(meaningfulUtterance('  http://localhost:4177/#/home  ')).toBeNull();
  });
  it('空と空白だけは除く', () => {
    expect(meaningfulUtterance('')).toBeNull();
    expect(meaningfulUtterance('   \n ')).toBeNull();
    expect(meaningfulUtterance(null)).toBeNull();
  });
  it('意味のある発言は前後の空白を落としてそのまま返す', () => {
    expect(meaningfulUtterance('  画像の圧縮率を 3 形式で比べたい \n')).toBe('画像の圧縮率を 3 形式で比べたい');
    expect(meaningfulUtterance('fix the flaky test')).toBe('fix the flaky test');
    expect(meaningfulUtterance('/Users/satog/foo.ts を読んで')).toBe('/Users/satog/foo.ts を読んで');
    expect(meaningfulUtterance('https://example.com を見て直して')).toBe('https://example.com を見て直して');
    expect(meaningfulUtterance('a < b のときに落ちる')).toBe('a < b のときに落ちる');
  });
});

describe('cardExcerpt（カードの抜粋）', () => {
  it('いちばん新しいセッションの要約を、発言より先に使う', () => {
    const list = [session('old', 1, { firstPrompt: '古い依頼' }), session('new', 2, { firstPrompt: '<input class="txt1">', summary: summary('トークン更新の競合を調べている') })];
    expect(cardExcerpt(list)).toEqual({ text: 'トークン更新の競合を調べている', fromPrompt: false });
  });
  it('土台の要約は発言の写しなので要約とみなさず、雑音なら次へ進む', () => {
    const list = [session('a', 2, { firstPrompt: '/init', summary: summary('/init', 'baseline') }), session('b', 1, { firstPrompt: '画像の圧縮率を 3 形式で比べたい' })];
    expect(cardExcerpt(list)).toEqual({ text: '画像の圧縮率を 3 形式で比べたい', fromPrompt: true });
  });
  it('要約が無ければ雑音を除いた発言を使い、発言から取ったことを添える', () => {
    expect(cardExcerpt([session('a', 1, { firstPrompt: '導入の節を書き直したい' })])).toEqual({ text: '導入の節を書き直したい', fromPrompt: true });
  });
  it('新しいセッションから順に見て、要約も意味のある発言も無ければ null', () => {
    expect(cardExcerpt([session('a', 2, { firstPrompt: 'exit' }), session('b', 1, { firstPrompt: '[Pasted text #1 +5 lines]' })])).toBeNull();
    expect(cardExcerpt([])).toBeNull();
  });
  it('並びは最後に動いた時刻の新しい順で、渡した順によらない', () => {
    const list = [session('new', 5, { firstPrompt: '新しい依頼' }), session('old', 1, { summary: summary('古い要約') })];
    expect(cardExcerpt(list)).toEqual({ text: '新しい依頼', fromPrompt: true });
    expect(cardExcerpt([...list].reverse())).toEqual({ text: '新しい依頼', fromPrompt: true });
  });
});
