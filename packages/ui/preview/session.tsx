// セッション画面 C の部品の試験用の例（試作は docs/superpowers/specs/2026-10-09-session-screen/options.html の C）。
// 値はすべて作り物で、試作の web-shop のセッションに合わせてある。primitives.tsx の ?only=session から使う。
import type { CSSProperties } from 'react';
import { translator, type LiveAgentDto, type SessionDto, type StepCell, type TranscriptEvent } from '@agent-hangar/shared';
import { presentNowStrip, type NowStripProps, type StripInput } from '../src/presenters/live.ts';
import type { ArtifactCardProps } from '../src/presenters/project.ts';
import { presentLeadCard, presentSessionBadges, type LeadCardProps, type TurnRowProps } from '../src/presenters/session.ts';
import { LeadCard } from '../src/views/LeadCard.tsx';
import { NowStrip } from '../src/views/NowStrip.tsx';
import { PageHeading } from '../src/views/PageHeading.tsx';
import { InfoPopover } from '../src/views/primitives/Popover.tsx';
import { StatusDot } from '../src/views/primitives/StatusDot.tsx';
import { Icon } from '../src/views/primitives/Icon.tsx';
import { SessionBadges } from '../src/views/SessionBadges.tsx';
import { TocPane, TocToggle } from '../src/views/TocPane.tsx';
import { TurnIndex } from '../src/views/TurnIndex.tsx';

const ja = translator('ja');
const NOW = Date.UTC(2026, 9, 9, 3, 0, 0);
const DAY = 86_400_000;

let seq = 0;
const call = (name: string, input: unknown): TranscriptEvent => ({ kind: 'tool_call', seq: seq++, ts: 0, toolId: `t${seq}`, name, input, summary: name });
const res = (c: TranscriptEvent): TranscriptEvent => ({ kind: 'tool_result', seq: seq++, toolId: (c as { toolId: string }).toolId, text: '', isError: false });
const agent = (p: Partial<LiveAgentDto>): LiveAgentDto => ({ agentId: 'a', title: '担当', state: 'running', startedAt: NOW - 120_000, lastAt: NOW - 60_000, last: null, report: null, endNote: null, linked: true, ...p });
const artifact = (id: string, title: string, when: string, canOpenEditor = false): ArtifactCardProps => ({ id, title, description: null, favicon: '📄', url: 'https://example.invalid', lastPublished: when, versionCount: 1, canOpenEditor });

/** 試作の「入力待ち」の例。読んだ 2 回と、答えを待っている問い。 */
function waitingEvents(): TranscriptEvent[] {
  seq = 0;
  const r1 = call('Read', { file_path: '/code/web-shop/src/checkout/form.ts' });
  const r2 = call('Read', { file_path: '/code/web-shop/src/checkout/form.test.ts' });
  return [{ kind: 'user', seq: seq++, text: '決済フォームの入力の検証を、サーバ側にも足して' }, r1, res(r1), r2, res(r2), call('AskUserQuestion', { questions: [] })];
}
/** 作業中の例。直近の 4 回を超える呼び出しと、サブエージェント 3 本と、アーティファクト 2 件。 */
function busyEvents(): TranscriptEvent[] {
  seq = 0;
  const out: TranscriptEvent[] = [{ kind: 'user', seq: seq++, text: 'カード番号の検証を Luhn に' }];
  const step = (name: string, input: unknown, open = false) => { const c = call(name, input); out.push(c); if (!open) out.push(res(c)); };
  step('Read', { file_path: '/code/web-shop/src/checkout/card.ts' });
  step('Grep', { pattern: 'luhn' });
  step('Edit', { file_path: '/code/web-shop/src/checkout/card.ts', old_string: 'a', new_string: 'b' });
  step('Write', { file_path: '/code/web-shop/src/checkout/luhn.ts', content: 'x' });
  step('Bash', { command: 'npm test -- card', description: 'カードの検証のテストを走らせる' });
  step('Edit', { file_path: '/code/web-shop/src/checkout/card.test.ts', old_string: 'a', new_string: 'b' }, true);
  return out;
}

const base = (p: Partial<StripInput>): StripInput => ({
  digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] }, events: [], turnFrom: 0, turnNo: 9, live: 'busy', activity: null, now: NOW, viewingAgent: false, clock: () => '10:01', idleFor: '3 分',
  waited: '4 分', contextPercent: 41, cost: '$0.86', turns: 9, tokens: '31k', artifacts: [], note: null, ...p,
});
const intent = { text: 'フォームの検証をサーバ側へ寄せる', at: 0, stepsSince: 3, inThisTurn: true };

export const STRIP_CASES: { id: string; title: string; width?: number; strip: NowStripProps }[] = [
  { id: 'waiting', title: '入力待ち（試作 C の実行中）', strip: presentNowStrip(base({
    live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: '既存のテストを書き換えてよいですか？' }, events: waitingEvents(), turnFrom: 0,
    digest: { sessionId: 's1', turnStartSeq: 0, intent, agents: [agent({ agentId: 'a1', title: 'テストの一覧を集める', state: 'done', report: 'checkout/ の 12 件を列挙した' })] },
    artifacts: [artifact('a1', '検証の仕様', '12 分前')], note: '決済は Stripe の v3。テストは checkout/ 以下に置く',
  }), ja) },
  { id: 'busy', title: '作業中（呼び出しが 4 つを超える。サブエージェントが動いている）', strip: presentNowStrip(base({
    events: busyEvents(), turnFrom: 0,
    digest: { sessionId: 's1', turnStartSeq: 0, intent: { ...intent, text: 'カード番号の検証を Luhn のアルゴリズムにする', stepsSince: 6 }, agents: [
      agent({ agentId: 'a1', title: '型を直す', last: { text: 'form.ts の型を読んだ', mono: false, kind: 'read', isError: false } }),
      agent({ agentId: 'a2', title: 'テストの一覧を集める', state: 'done', report: 'checkout/ の 12 件を列挙した' }),
      agent({ agentId: 'a3', title: 'lint を通す', state: 'error', report: 'eslint が見つからない' }),
    ] },
    artifacts: [artifact('a1', '検証の仕様', '12 分前', true), artifact('a2', '計測の結果', '3 日前')],
  }), ja) },
  { id: 'aside', title: '裏だけ動いている（メイン会話は入力を受け付けている）', strip: presentNowStrip(base({
    aside: { shell: false, agents: 2 }, digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [agent({ agentId: 'a1', title: '型を直す' }), agent({ agentId: 'a2', title: 'テストを書く' })] },
    note: '休み明けに続き',
  }), ja) },
  { id: 'idle', title: 'アイドルで、コンテキスト使用量もコストも届いていない', strip: presentNowStrip(base({ live: 'idle', contextPercent: null, cost: '', events: [], digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] } }), ja) },
  { id: 'narrow', title: '帯の幅が 640px（いまの値が 3 行目に下がる）', width: 640, strip: presentNowStrip(base({
    live: 'waiting', activity: { tool: 'AskUserQuestion', summary: 'q', question: '既存のテストを書き換えてよいですか？' }, events: waitingEvents(), turnFrom: 0,
    digest: { sessionId: 's1', turnStartSeq: 0, intent, agents: [agent({ agentId: 'a1', title: 'テストの一覧を集める', state: 'done', report: 'checkout/ の 12 件を列挙した' })] },
    artifacts: [artifact('a1', '検証の仕様', '12 分前')], note: '決済は Stripe の v3',
  }), ja) },
];

const session = (p: Partial<SessionDto> = {}): SessionDto => ({
  id: 's7', provider: 'claude-code', providerSessionId: 'u7', projectId: 'p1', name: '画像の遅延読み込み', cwd: '/code/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOW - 3 * DAY - 3 * 3_600_000, lastActivityAt: NOW - 3 * DAY, memo: '詳細の頁は別のセッションで',
  hasTranscript: true, live: null,
  summary: { title: 't', oneLiner: 'o', body: '商品一覧の画像を IntersectionObserver で遅延読み込みにし、LCP を 3.1 秒から 1.8 秒に縮めて PR #88 をマージした。先頭の 4 枚は即時に読む。枠の高さは固定にすると決めた（ターン 6）。', state: 'done', nextSteps: ['詳細の頁の画像にも同じ部品を使う'], source: 'post_hoc', sourceId: 'lmstudio', sourceModel: 'qwen3-8b', basedOnTurns: 11, updatedAt: NOW - 2 * DAY - 6 * 3_600_000 },
  stats: { turns: 11, model: 'claude-sonnet-4-5', effort: null, filesChanged: 5, prUrl: 'https://example.invalid/o/r/pull/88', inputTokens: 12_000, outputTokens: 8_000, contextPercent: null, costUsd: 0.42 },
  fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: null, activity: null,
  state: { status: 'done', note: null, returnOn: null, returnTime: null, setBy: 'user', setAt: NOW - 3 * DAY, candidate: null }, parked: false, stoppedByStatus: false, liveAside: null, ...p,
});
const leadInput = (p: Partial<Parameters<typeof presentLeadCard>[0]> = {}) => ({
  session: session(), now: NOW, gone: false, summaryPending: false, summaryError: null, artifacts: [artifact('a1', '計測の結果', '3 日前')],
  files: [{ path: '/code/web-shop/src/components/ProductImage.tsx', edits: 5, agentId: null }, { path: '/code/web-shop/src/pages/products.tsx', edits: 2, agentId: null }, { path: '/code/web-shop/src/components/ProductImage.test.tsx', edits: 1, agentId: null }, { path: '/code/web-shop/src/lib/observer.ts', edits: 1, agentId: 'a1' }, { path: '/code/web-shop/README.md', edits: 1, agentId: 'a1' }],
  windowFiles: [
    { path: '/code/web-shop/src/components/ProductImage.tsx', dir: '', base: '', added: 52, removed: 18, created: false },
    { path: '/code/web-shop/src/pages/products.tsx', dir: '', base: '', added: 6, removed: 2, created: false },
    { path: '/code/web-shop/src/components/ProductImage.test.tsx', dir: '', base: '', added: 40, removed: 0, created: true },
  ],
  ...p,
});
export const LEAD_CASES: { id: string; title: string; lead: LeadCardProps }[] = [
  { id: 'done', title: 'Done（試作 C の終わった後）', lead: presentLeadCard(leadInput(), ja) },
  { id: 'stopped', title: 'Paused にしたので止めた。ノートは空。要約は作成中', lead: presentLeadCard(leadInput({
    session: session({ memo: null, stoppedByStatus: true, state: { status: 'paused', note: null, returnOn: '2026-10-12', returnTime: null, setBy: 'user', setAt: NOW - DAY, candidate: null }, stats: { ...session().stats, prUrl: null } }), summaryPending: true, artifacts: [], files: [], windowFiles: [],
  }), ja) },
  { id: 'gone', title: '本文が消えた会話（要約のみ）', lead: presentLeadCard(leadInput({ gone: true, session: session({ hasTranscript: false }), files: null, windowFiles: [] }), ja) },
];

const turnList: [string, string, number, string][] = [
  ['08:52', '決済フォームの構成を読んで要点をまとめて', 3, 'rrr'], ['08:58', 'クライアント側の検証の一覧を出して', 2, 'rr'], ['09:06', '金額の上限の検証を足して', 4, 'rrew'],
  ['09:14', 'form.ts を読んで要点を', 1, 'r'], ['09:21', 'バリデーションの順を直して', 5, 'rewwe'], ['09:33', 'エラー文を i18n の鍵にして', 6, 'rrwwwe'],
  ['09:41', 'テストを通して', 7, 'eeefeee'], ['09:52', 'カード番号の検証を Luhn に', 4, 'rwwe'], ['10:01', '決済フォームの入力の検証を、サーバ側にも足して', 3, 'rr'],
];
const CELL: Record<string, StepCell> = { r: 'read', w: 'write', e: 'run', g: 'git', f: 'fail' };
const turnRows: TurnRowProps[] = turnList.map(([when, text, tools, band], n) => ({ seq: n + 1, when, text, head: text.slice(0, 20), tools, open: false, band: [...band].map((k) => CELL[k]!) }));

const frame: CSSProperties = { width: 1032, padding: 16, borderRadius: 12, background: 'var(--bg)', boxShadow: '0 0 0 1px rgba(30, 40, 90, 0.14)' };
const termStyle: CSSProperties = { flex: 1, minHeight: 0, borderRadius: 'var(--r-lg)', background: 'var(--term-bg)', color: 'var(--term-fg)', padding: '14px 16px', font: '12px/1.6 var(--font-mono)', whiteSpace: 'pre', overflow: 'hidden', boxShadow: 'var(--term-lift)' };
const tab: CSSProperties = { display: 'inline-flex', alignItems: 'center', height: 28, padding: '0 12px', borderRadius: 'var(--r) var(--r) 0 0', background: 'var(--term-bg)', color: 'var(--term-fg)' };

/** 見出しの行。ロックの札、要約の 1 文、主の操作、(i)。試作 C の見出しに合わせる。 */
function Heading(props: { badges: ReturnType<typeof presentSessionBadges>; live: 'waiting' | null; name: string; oneLiner: string; primary: string }) {
  return (
    <PageHeading title={props.name} parent={{ label: 'web-shop', route: { name: 'projects' } }} lead={<StatusDot status={props.live} />} titleClassName="session-name" rowClassName="session-hero">
      <SessionBadges badges={props.badges} />
      <span className="session-oneliner">{props.oneLiner}</span>
      <button type="button" className="btn btn-primary"><Icon name="openEditor" /><span className="btn-label">{props.primary}</span></button>
      <InfoPopover rows={[{ name: 'モデル', value: 'opus', mono: true }, { name: '権限モード', value: 'Accept edits', mono: true }, { name: '開始', value: '今日 08:52', mono: true }]} />
    </PageHeading>
  );
}

const TERM = ['> 決済フォームの入力の検証を、サーバ側にも足して', '● サーバ側の検証を追加します。既存のフォームのテストが前提を変えるので、先に確認します。', '● Read(src/checkout/form.ts)', '  ⎿  Read 142 lines', '● AskUserQuestion', '  既存のテストを書き換えてよいですか？', '  ❯ 1. はい、書き換える', '    2. 新しいテストを足す'].join('\n');

/** 試作 C の実行中の画面に近い並び：見出し、タブ、帯、ターミナル、右の目次。 */
function LiveMock(props: { strip: NowStripProps }) {
  return (
    <div style={frame} id="mock-live">
      <Heading badges={[]} live="waiting" name="決済フォームの検証を直す" oneLiner="入力の検証をサーバ側へ寄せ、フォームのテストを更新中" primary="VS Code で開く" />
      <div style={{ display: 'flex', alignItems: 'flex-end', height: 28, marginTop: 8 }}><span style={tab}>Claude</span></div>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 240px', gap: 8, height: 440 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0, minHeight: 0 }}>
          <NowStrip sessionId="s1" {...props.strip} />
          <div style={termStyle}>{TERM}</div>
        </div>
        <TocPane>
          <TurnIndex sessionId="s1" runId={null} rows={turnRows} complete openItems={[]} turnJump={null} hasMore={false} loading={false} remaining={0} agentId={null} lead={<TocToggle open />} />
        </TocPane>
      </div>
    </div>
  );
}

/** 終わった後の画面に近い並び：見出し、冒頭の 1 枚、右の目次。 */
function EndedMock(props: { lead: LeadCardProps }) {
  const s = session();
  return (
    <div style={frame} id="mock-ended">
      <Heading badges={presentSessionBadges(s, NOW, ja)} live={null} name={s.name ?? ''} oneLiner="IntersectionObserver で置き換え、PR #88 をマージ" primary="再開" />
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 240px', gap: 8, height: 560, marginTop: 12 }}>
        <section className="tr-sheet" style={{ minWidth: 0, padding: '8px 12px', borderRadius: 'var(--r-lg)', background: 'var(--surface)', boxShadow: 'var(--surface-shadow)', overflow: 'hidden' }}>
          <LeadCard sessionId="s7" {...props.lead} />
        </section>
        <TocPane>
          <TurnIndex sessionId="s7" runId={null} rows={turnRows.map((r) => ({ ...r, open: r.seq === 6 }))} complete openItems={[]} turnJump={null} hasMore={false} loading={false} remaining={0} agentId={null} lead={<TocToggle open />} />
        </TocPane>
      </div>
    </div>
  );
}

const lockedSession = (p: Partial<SessionDto>) => presentSessionBadges(session(p), NOW, ja);

/** ?only=session で出す頁。 */
export function SessionCases() {
  const box: CSSProperties = { padding: '16px 20px', borderRadius: 14, background: 'var(--surface)', boxShadow: 'var(--surface-shadow)' };
  const h2: CSSProperties = { margin: '0 0 8px', fontSize: 'var(--fs)' };
  return (
    <div style={{ width: 1100, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
      <h1 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>セッション画面の部品</h1>
      <section style={box}><h2 style={h2}>実行中の並び（見出し、タブ、帯、ターミナル、目次）</h2><LiveMock strip={STRIP_CASES[0]!.strip} /></section>
      {STRIP_CASES.map((c) => (
        <section key={c.id} style={box}><h2 style={h2}>帯：{c.title}</h2><div id={`strip-${c.id}`} style={{ width: c.width ?? 760 }}><NowStrip sessionId="s1" {...c.strip} /></div></section>
      ))}
      <section style={box}><h2 style={h2}>終わった後の並び（見出し、冒頭の 1 枚、目次）</h2><EndedMock lead={LEAD_CASES[0]!.lead} /></section>
      {LEAD_CASES.map((c) => (
        <section key={c.id} style={box}><h2 style={h2}>冒頭の 1 枚：{c.title}</h2><div id={`lead-${c.id}`} style={{ width: 760, background: 'var(--surface)' }}><LeadCard sessionId="s7" {...c.lead} /></div></section>
      ))}
      <section style={box}>
        <h2 style={h2}>見出しの名前の横の札</h2>
        <div id="badges" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SessionBadges badges={lockedSession({ lock: { deviceId: 'd2', deviceName: 'office-pc', runId: 'r9', heartbeatAt: NOW - 5 * 60_000, stale: false } })} />
          <SessionBadges badges={lockedSession({ lock: { deviceId: 'd2', deviceName: 'office-pc', runId: 'r9', heartbeatAt: NOW - 3_600_000, stale: true } })} />
          <SessionBadges badges={lockedSession({ remoteOnly: true })} />
        </div>
      </section>
    </div>
  );
}
