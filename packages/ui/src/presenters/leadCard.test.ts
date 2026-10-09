import { describe, expect, it } from 'vitest';
import { translator, type SessionDto, type SessionSummaryDto, type SessionStateDto } from '@agent-hangar/shared';
import type { ArtifactCardProps } from './project.ts';
import { presentLeadCard, presentSessionBadges, type ChangedFileProps, type LeadInput } from './session.ts';

const ja = translator('ja');
const en = translator('en');
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const DAY = 86_400_000;

const summary = (p: Partial<SessionSummaryDto> = {}): SessionSummaryDto => ({ title: 't', oneLiner: 'o', body: '商品一覧の画像を遅延読み込みにし、PR をマージした。', state: 'done', nextSteps: ['詳細の頁の画像にも同じ部品を使う'], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: 'qwen3-8b', basedOnTurns: 11, updatedAt: Date.UTC(2026, 9, 6, 9, 40), ...p });
const state = (p: Partial<SessionStateDto> = {}): SessionStateDto => ({ status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: Date.UTC(2026, 9, 6, 3, 0), candidate: null, ...p });
const session = (p: Partial<SessionDto> = {}): SessionDto => ({
  id: 's1', provider: 'claude-code', providerSessionId: 'u', projectId: 'p1', name: '画像の遅延読み込み', cwd: '/w/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOW - 4 * DAY, lastActivityAt: NOW - 3 * DAY, memo: null,
  hasTranscript: true, live: null, summary: summary(), stats: { turns: 11, model: 'claude-sonnet-4-5', effort: null, filesChanged: 5, prUrl: 'https://github.com/o/r/pull/88', inputTokens: 12_000, outputTokens: 8_000, contextPercent: null, costUsd: 0.42 },
  fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null, state: state(), parked: false, stoppedByStatus: false, liveAside: null, ...p,
});
const artifact = (id: string): ArtifactCardProps => ({ id, title: `成果 ${id}`, description: null, favicon: '📄', url: 'https://x', lastPublished: '3 日前', versionCount: 1, canOpenEditor: true });
const win = (path: string, p: Partial<ChangedFileProps> = {}): ChangedFileProps => ({ path, dir: '', base: path.split('/').pop()!, added: 1, removed: 0, created: false, ...p });
const input = (p: Partial<LeadInput> = {}): LeadInput => ({ session: session(), now: NOW, gone: false, summaryPending: false, summaryError: null, artifacts: [], files: null, windowFiles: [], ...p });
const present = (p: Partial<LeadInput> = {}, t = ja) => presentLeadCard(input(p), t);

describe('冒頭の 1 枚の 1 行目', () => {
  it('ステータスの札と設定した日、終了、ターンとトークンとコストを出す', () => {
    const c = present();
    expect(c.status).toMatchObject({ value: 'done', label: 'Done' });
    // 設定した日は端末の時刻で月と日にする。
    expect(c.status.since).toBe(`${new Date(Date.UTC(2026, 9, 6, 3, 0)).getMonth() + 1}/${new Date(Date.UTC(2026, 9, 6, 3, 0)).getDate()} に設定`);
    expect(c.ended).toBe('終了 3 日前');
    expect(c.stopped).toBeNull();
    expect(c).toMatchObject({ turns: '11 ターン', tokens: '20k トークン', cost: '$0.42' });
  });
  it('印の無いセッションは Active。設定した日は出さない', () => {
    const c = present({ session: session({ state: null }) });
    expect(c.status).toEqual({ value: 'active', label: 'Active', since: null });
    expect(present({ session: session({ state: state({ status: 'paused', setAt: null }) }) }).status).toMatchObject({ value: 'paused', label: 'Paused', since: null });
  });
  it('コストが届いていなければ null（行の桁を崩さない）', () => {
    expect(present({ session: session({ stats: { ...session().stats, costUsd: null } }) }).cost).toBeNull();
  });
  it('区切りを付けたので止めたときは、終了の代わりにその知らせを出す', () => {
    const c = present({ session: session({ stoppedByStatus: true, state: state({ status: 'paused' }) }) });
    expect(c.stopped).toBe('Paused にしたので停止しました。再開で続けられます');
    expect(c.ended).toBeNull();
    expect(present({ session: session({ stoppedByStatus: true, state: state({ status: 'done' }) }) }, en).stopped).toBe('Stopped because it was marked Done. Resume to continue');
  });
  it('本文が消えた会話は「要約のみ」、本文が無い会話は「トランスクリプトがありません」', () => {
    expect(present({ gone: true, session: session({ hasTranscript: false }) }).flags).toEqual(['要約のみ']);
    expect(present({ session: session({ hasTranscript: false }) }).flags).toEqual(['トランスクリプトがありません']);
    expect(present().flags).toEqual([]);
  });
});

describe('冒頭の 1 枚の要約', () => {
  it('本文、次のステップ、進捗とターン時点、作成元の行を出す', () => {
    const s = present().summary!;
    expect(s.body).toContain('遅延読み込み');
    expect(s.nextSteps).toEqual(['詳細の頁の画像にも同じ部品を使う']);
    expect(s.nextStepsLabel).toBe('次のステップ');
    expect(s.progress).toBe('進捗 完了、11 ターン時点');
    expect(s.sourceLine).toBe(`作成元 事後、LM Studio / qwen3-8b、2026-10-06 ${new Date(Date.UTC(2026, 9, 6, 9, 40)).getHours().toString().padStart(2, '0')}:40 生成`);
  });
  it('進捗の 4 つの見立てを、用語集の語で言う', () => {
    const word = (state: SessionSummaryDto['state']) => present({ session: session({ summary: summary({ state }) }) }).summary!.progress;
    expect([word('in_progress'), word('done'), word('blocked'), word('abandoned')]).toEqual(['進捗 進行中、11 ターン時点', '進捗 完了、11 ターン時点', '進捗 ブロック中、11 ターン時点', '進捗 中止、11 ターン時点']);
    expect(present({ session: session({ summary: summary({ state: 'blocked' }) }) }, en).summary!.progress).toBe('Progress: Blocked, as of turn 11');
  });
  it('要約器を通していない要約は、作成元だけを言う（要約器の名前は出さない）', () => {
    const s = present({ session: session({ summary: summary({ source: 'in_session', sourceId: null, sourceModel: null }) }) }, en).summary!;
    expect(s.sourceLine).toMatch(/^Source: In session, generated 2026-10-06/);
  });
  it('次のステップが無ければ空の並び。要約が無ければ「要約はありません」', () => {
    expect(present({ session: session({ summary: summary({ nextSteps: [] }) }) }).summary!.nextSteps).toEqual([]);
    const none = present({ session: session({ summary: null }) });
    expect(none.summary).toBeNull();
    expect(none.empty).toBe('要約はありません');
    expect(present().empty).toBeNull();
  });
  it('作成中と失敗は、要約の上の注記にする。失敗の理由は title で読める', () => {
    expect(present({ summaryPending: true }).notice).toEqual({ kind: 'pending', text: '要約を作成しています', title: null });
    expect(present({ summaryError: 'LM Studio に届かない' }).notice).toEqual({ kind: 'failed', text: '要約を作成できませんでした', title: 'LM Studio に届かない' });
    expect(present({ summaryPending: true, summaryError: 'x' }).notice?.kind).toBe('pending');
    expect(present().notice).toBeNull();
  });
  it('再生成は、本文が消えた会話では出さない（作り直しは必ず失敗する）', () => {
    expect(present().canRegenerate).toBe(true);
    expect(present({ gone: true }).canRegenerate).toBe(false);
    expect(present().regenerate).toBe('要約を再生成');
    expect(present({}, en).regenerate).toBe('Regenerate summary');
  });
});

describe('冒頭の 1 枚の札（変更したファイル、アーティファクト、PR、ノート）', () => {
  it('変更したファイルは、サーバの一覧を並びとし、読み込んだ窓にある分だけ足した行と消した行を付ける', () => {
    const c = present({
      files: [{ path: '/w/web-shop/src/a.ts', edits: 2, agentId: null }, { path: '/w/web-shop/src/b.ts', edits: 1, agentId: 'abc' }, { path: '/w/web-shop/c.md', edits: 1, agentId: null }],
      windowFiles: [win('/w/web-shop/src/a.ts', { added: 52, removed: 18 }), win('/w/web-shop/c.md', { added: 3, removed: 0, created: true })],
    }).files;
    expect(c.count).toBe(3);
    expect(c.rows.map((r) => [r.dir, r.base, r.added, r.removed, r.created, r.byAgent])).toEqual([
      ['src/', 'a.ts', 52, 18, false, null],
      ['src/', 'b.ts', null, null, false, 'サブエージェント abc'],
      ['', 'c.md', 3, 0, true, null],
    ]);
    // 数の分からない行は、編集の回数で添える。窓にある分だけの数であることも言う。
    expect(c.rows[1]!.edits).toBe('1 回');
    expect(c.note).toBe('足した行と消した行は、読み込んだ分だけ出ています');
    expect(c.rows[0]!.openLabel).toBe('/w/web-shop/src/a.ts を VS Code で開く');
  });
  it('窓にある分が全部そろっていれば、注記は出さない', () => {
    const c = present({ files: [{ path: '/w/web-shop/a.ts', edits: 1, agentId: null }], windowFiles: [win('/w/web-shop/a.ts')] }).files;
    expect(c.note).toBeNull();
  });
  it('サーバの一覧が届く前は、窓から数えた分だけを出し、件数は統計の数を使う', () => {
    const c = present({ files: null, windowFiles: [win('/w/web-shop/a.ts'), win('/w/web-shop/b.ts')] }).files;
    expect(c.rows.map((r) => r.base)).toEqual(['a.ts', 'b.ts']);
    expect(c.count).toBe(5);
    expect(c.note).toBeNull();
  });
  it('変更が無ければ 0 件', () => {
    expect(present({ files: [], session: session({ stats: { ...session().stats, filesChanged: 0 } }) }).files).toMatchObject({ count: 0, rows: [] });
  });
  it('アーティファクトは件数と一覧を渡す', () => {
    const a = present({ artifacts: [artifact('a1'), artifact('a2')] }).artifacts;
    expect(a).toMatchObject({ label: 'アーティファクト', count: 2 });
    expect(a.items.map((x) => x.id)).toEqual(['a1', 'a2']);
  });
  it('PR は、URL の末尾の番号で「PR #88」。番号が取れなければ「PR」だけ。URL が無ければ出さない', () => {
    expect(present().pr).toEqual({ label: 'PR #88', url: 'https://github.com/o/r/pull/88' });
    expect(present({ session: session({ stats: { ...session().stats, prUrl: 'https://example.com/x' } }) }).pr).toEqual({ label: 'PR', url: 'https://example.com/x' });
    expect(present({ session: session({ stats: { ...session().stats, prUrl: null } }) }).pr).toBeNull();
  });
  it('ノートは本文と、中身があるかを渡す', () => {
    expect(present({ session: session({ memo: '詳細の頁は別のセッションで' }) }).note).toEqual({ text: '詳細の頁は別のセッションで', filled: true });
    expect(present().note).toEqual({ text: '', filled: false });
  });
});

describe('見出しの名前の横の札（ロックと、トランスクリプトの在りか）', () => {
  const lock = (stale: boolean) => ({ deviceId: 'd2', deviceName: 'office-pc', runId: 'r9', heartbeatAt: NOW - 5 * 60_000, stale });
  it('他の PC で実行中なら「<PC 名> で実行中」。最終確認は title で読める', () => {
    expect(presentSessionBadges(session({ lock: lock(false) }), NOW, ja)).toEqual([{ kind: 'lock', label: 'office-pc で実行中', title: '最終確認 5 分前' }]);
  });
  it('応答が途絶えていれば「<PC 名> から応答がありません」で、色の種類も替える', () => {
    expect(presentSessionBadges(session({ lock: lock(true) }), NOW, en)).toEqual([{ kind: 'stale', label: 'office-pc is not responding', title: 'Last seen 5 分前' }]);
  });
  it('トランスクリプトが他の PC にあるときは、ロックと同じ扱いの札を出す。両方あれば、ロック、トランスクリプトの順', () => {
    expect(presentSessionBadges(session({ remoteOnly: true }), NOW, ja)).toEqual([{ kind: 'remote', label: 'トランスクリプトは他の PC にあります', title: null }]);
    expect(presentSessionBadges(session({ remoteOnly: true, lock: lock(false) }), NOW, ja).map((b) => b.kind)).toEqual(['lock', 'remote']);
  });
  it('どちらも無ければ札は出さない', () => {
    expect(presentSessionBadges(session(), NOW, ja)).toEqual([]);
  });
});
