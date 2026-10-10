// 部品を試作と並べて撮るための頁。`npm run dev -w @agent-hangar/ui` のあと /preview/primitives.html を開く。
// 本番の bundle には入らない（vite の入口は index.html だけ）。
// ?open=info|perm で、その部品のポップオーバーを開いた形で出す。例の値は作り物である。
// 札の列（LaunchChips）は ?state=first|regular|bypass|extras と ?w=（列の幅 px。起動ダイアログの本文は 520）で出す。
// ?only=band で、ホームの帯と引き出しの 4 つの形だけを出す（撮るとき用）。
// ?only=session で、セッション画面 C の部品（現在の帯、冒頭の 1 枚、見出しの札、目次だけの右パネル）を出す（preview/session.tsx）。
// ?only=bell で、ヘッダーのベルと知らせの一覧を出す（撮るとき用）。?case=open（既定）|closed|read|empty|en|narrow。例の値は作り物である。
import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
// 本番（src/main.tsx）と同じ順で読む。順が違うと、同じ名前の規則（.chip など）の勝ち負けが変わる。
import '../src/styles/tokens.css';
import '../src/styles/base.css';
import '../src/styles/workbench.css';
import '../src/styles/split.css';
import '../src/styles/rows.css';
import '../src/styles/home.css';
import '../src/styles/session.css';
import '../src/styles/strip.css';
import '../src/styles/transcript.css';
import '../src/styles/palette.css';
import '../src/styles/settings.css';
import '../src/styles/configSync.css';
import '../src/styles/readiness.css';
import '../src/styles/sync.css';
import '../src/styles/controls.css';
import { SessionCases } from './session.tsx';
import '../src/styles/notices.css';
import { presentHomeBand, type BandGroup, type HomeBandProps } from '../src/presenters/home.ts';
import { translator } from '@agent-hangar/shared';
import { HomeBand } from '../src/views/HomeBand.tsx';
import { LanguageRoot } from '../src/views/primitives/language.tsx';
import { IntentRoot } from '../src/intent/chain.tsx';
import { initialState } from '../src/mediator/transition.ts';
import { presentNotices } from '../src/presenters/notices.ts';
import { initialStore, type Store } from '../src/store/store.ts';
import { Bell } from '../src/views/Bell.tsx';
import { Icon } from '../src/views/primitives/Icon.tsx';
import type { CompatDto, ReadinessDto, SessionDto, SettingsDto } from '@agent-hangar/shared';
import { CountChip, SettingChip } from '../src/views/primitives/Chip.tsx';
import { InfoPopover, Popover } from '../src/views/primitives/Popover.tsx';
import { LaunchChips, type LaunchChipValues } from '../src/views/LaunchChips.tsx';

const params = new URLSearchParams(location.search);
const open = params.get('open');
const only = params.get('only');
const noop = () => {};

const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 };
const card: CSSProperties = { padding: '16px 20px', borderRadius: 14, background: 'var(--surface)', boxShadow: 'var(--surface-shadow)' };
const h2: CSSProperties = { margin: '0 0 8px', fontSize: 'var(--fs)' };

/** ホームの帯（試作 B 案の .band と .band-pill）。 */
function Band() {
  return (
    <div id="band" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 40, padding: '0 6px 0 12px', borderRadius: 14, background: 'rgba(255, 255, 255, 0.55)', boxShadow: 'var(--glass-edge)' }}>
      <CountChip label="要対応" count={4} tone="wait" icon="alert" expanded onClick={noop} />
      <CountChip label="実行中" count={2} icon="tool" expanded={false} onClick={noop} />
      <CountChip label="確認待ち" count={3} tone="cand" icon="check" expanded={false} onClick={noop} />
      <CountChip label="確認待ち" count={0} tone="cand" icon="check" expanded={false} onClick={noop} />
    </div>
  );
}

/** 小さい札（セッション画面の試作の .lead-chips）。 */
function Small() {
  return (
    <div id="small" style={row}>
      <CountChip size="sm" label="変更したファイル" count={7} icon="fileEdited" expanded={false} onClick={noop} />
      <CountChip size="sm" label="アーティファクト" count={1} icon="artifacts" expanded onClick={noop} />
      <CountChip size="sm" label="確認待ち" count={2} tone="cand" />
    </div>
  );
}

const PERMS = ['既定', 'Plan', 'Manual', 'Accept edits', 'Auto', "Don't ask"];

/** 新しいセッションの札の列（試作 N2 の .set-row）。権限モードの札は、開いた先をポップオーバーで出す。 */
function Settings() {
  return (
    <div id="settings" style={row}>
      <SettingChip name="プロジェクト" value="web-shop" icon="folder" onClick={noop} aria-haspopup="dialog" aria-expanded={false} />
      <SettingChip name="モデル" value="opus" showName onClick={noop} />
      <SettingChip name="effort レベル" value="high" showName onClick={noop} />
      <Popover label="権限モード" width={240} align="start" defaultOpen={open === 'perm'}
        face={(p) => <SettingChip name="権限モード" value="Accept edits" showName {...p} />}>
        <div className="pop-title" style={{ fontSize: 'var(--fs-xs)', color: 'var(--ink-3)' }}>権限モード</div>
        {PERMS.map((x) => <button key={x} type="button" className="menu-item"><span className="menu-item-text"><span>{x}</span></span></button>)}
      </Popover>
      <SettingChip name="worktree" value="なし" showName tone="muted" onClick={noop} />
      <SettingChip name="権限モード" value="Bypass permissions" showName tone="danger" onClick={noop} />
    </div>
  );
}

/** 見出しの右端の (i)（試作 C 案の popC）。行は試作の文のまま。 */
function InfoHeader() {
  const rows = [
    { name: 'モデル', value: 'opus', mono: true },
    { name: 'effort レベル', value: 'high', mono: true },
    { name: '権限モード', value: 'Accept edits', mono: true },
    { name: '開始', value: '今日 08:52', mono: true },
    { name: '作業ディレクトリ', value: '~/code/web-shop', mono: true },
    { name: 'アカウント', value: '仕事用', mono: true },
    { name: '起動', value: '新しいセッション · 08:52', mono: true },
  ];
  return (
    <div id="info" style={{ display: 'flex', alignItems: 'center', gap: 8, height: 44 }}>
      <b style={{ fontSize: 'var(--fs-md)' }}>金額の上限のテストを足す</b>
      <span style={{ flex: 1 }} />
      <InfoPopover rows={rows} defaultOpen={open === 'info'} />
    </div>
  );
}

const LAUNCH_STATES: Record<string, Partial<LaunchChipValues>> = {
  first: {},
  regular: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits' },
  bypass: { model: 'opus', effort: 'high', permissionMode: 'bypassPermissions' },
  extras: { model: 'opus', effort: 'high', permissionMode: 'acceptEdits', name: '決済の検証', addDirs: '/work/shared\n/work/docs' },
};
const BASE_VALUES: LaunchChipValues = { model: '', effort: '', permissionMode: '', worktree: '', name: '', addDirs: '' };

/** 新しいセッションの札の列（試作 N2 の .set-row）。値は部品の中で変わる。例のアカウントとプロジェクトは作り物である。 */
function Launch() {
  const params = new URLSearchParams(location.search);
  const [values, setValues] = useState<LaunchChipValues>({ ...BASE_VALUES, ...LAUNCH_STATES[params.get('state') ?? 'regular'] });
  const [account, setAccount] = useState('work');
  const width = Number(params.get('w')) || 520;
  return (
    <div id="launch" style={{ width }}>
      <LaunchChips
        lead={<SettingChip name="プロジェクト" value="web-shop" icon="folder" aria-haspopup="dialog" aria-expanded={false} />}
        account={{ value: account, options: [{ value: 'work', label: '仕事用' }, { value: 'home', label: '個人用' }], onChange: setAccount }}
        values={values}
        previousPermission="acceptEdits"
        onChange={(patch) => setValues((v) => ({ ...v, ...patch }))}
      />
    </div>
  );
}

/* ---- ホームの帯と引き出し（試作 B）。例の値は作り物である。 ---- */
const T = translator('ja');
const busyMorning = presentHomeBand({
  attention: [
    { id: 'a1', name: '支払い画面の結合試験', projectName: 'web-shop', waited: '18分', question: 'テストの DB を作り直してよいですか', answer: 'terminal' },
    { id: 'a2', name: '在庫の同期バッチ', projectName: 'web-shop', waited: '6分', question: 'package.json に依存を 1 つ足します。許可しますか', answer: 'terminal' },
    { id: 'a3', name: 'ログ基盤の移行', projectName: 'infra', waited: '3分', question: '古い設定ファイルを削除します', answer: 'adopt' },
    { id: 'a4', name: '通知の文言の見直し', projectName: null, waited: '1分', question: '入力を待っています', answer: 'terminal' },
  ],
  returning: [{ id: 'r1', name: '検索の速度の計測', projectName: 'web-shop', reason: '夜間の再計測の結果を確かめる', returnOn: '2026-10-09', returnTime: '15:00', overdueDays: 0, due: false, pastMin: null }],
  running: [
    { id: 'x1', name: '金額の上限のテストを足す', live: 'busy', aside: false, elapsed: '4分', meta: 'web-shop · opus · high', intent: '上限を超えた注文を断るテストを足す', activity: { tool: 'Edit', summary: 'src/order/limit.test.ts' }, note: null, contextPercent: 42, contextLabel: '42%' },
    { id: 'x2', name: '請求書の PDF 化', live: 'idle', aside: false, elapsed: '31分', meta: 'web-shop · sonnet', intent: null, activity: null, note: '休み。最後の返答から 6分', contextPercent: 71, contextLabel: '71%' },
  ],
  confirm: [
    { kind: 'todo', id: 't1', text: 'メール送信の再試行を足す', projectId: 'p1', projectName: 'web-shop', sessionName: '通知の見直し', ago: '2 時間前', note: '再試行の実装と試験が入った' },
    { kind: 'session', id: 's1', name: '古い管理画面の調査', projectName: 'legacy-admin', status: 'done', label: 'Done にする？', note: '移行の計画が取り下げられた', ago: '5 時間前' },
    { kind: 'session', id: 's2', name: 'CI の高速化', projectName: 'infra', status: 'paused', label: 'Paused · 10/12（月）？', note: '結果は週明けに確かめる', ago: '1 日前' },
  ],
}, T);
const quiet = presentHomeBand({
  attention: [],
  returning: [],
  running: [{ id: 'x1', name: '金額の上限のテストを足す', live: 'busy', aside: false, elapsed: '4分', meta: 'web-shop · opus · high', intent: '上限を超えた注文を断るテストを足す', activity: { tool: 'Edit', summary: 'src/order/limit.test.ts' }, note: null, contextPercent: 42, contextLabel: '42%' }],
  confirm: [],
}, T);
/** 4 つ目の錠剤（PR 33 が足す形）。作り物の群を extra に渡すだけで増える。 */
const unresolved: BandGroup = {
  id: 'unresolved', label: '場所の不明なプロジェクト', icon: 'repoint', tone: 'default', count: 1, summary: '1 件', morning: false,
  rows: [{ key: 'pj:p1', lead: { kind: 'todo' }, name: 'old-shop', context: 'セッション 3', text: '前のパス /work/old-shop', detail: null, tone: null, trail: [], open: null, actions: [{ id: 'relocate', label: '場所を再指定', ariaLabel: '場所を再指定、old-shop', primary: false, ghost: false, intent: { type: 'nav.go', to: { name: 'projects' } } }] }],
};
const withFourth: HomeBandProps = { ...busyMorning, groups: [...busyMorning.groups, unresolved] };

function BandCases() {
  return (
    <LanguageRoot language="ja">
      <section style={card}><h2 style={h2}>朝（要対応が開いている。4 つ目の錠剤つき）</h2><div id="band-morning"><HomeBand {...withFourth} /></div></section>
      <section style={card}><h2 style={h2}>要対応が無い日（実行中が開く）</h2><div id="band-quiet"><HomeBand {...quiet} /></div></section>
      <section style={card}><h2 style={h2}>実行中の引き出し</h2><div id="band-running"><HomeBand {...busyMorning} morning="running" /></div></section>
      <section style={card}><h2 style={h2}>確認待ちの引き出し</h2><div id="band-pending"><HomeBand {...busyMorning} morning="pending" /></div></section>
      <section style={card}><h2 style={h2}>検索の最中</h2><div id="band-search"><HomeBand {...busyMorning} searching /></div></section>
    </LanguageRoot>
  );
}

/* ---- ベルと知らせの一覧（試作 small-screens の知らせ B）。事実は作り物で、Presenter が行を組む。 ---- */
const NOTICE_NOW = new Date(2026, 9, 9, 13, 25).getTime();
const noticeSession = (): SessionDto => ({
  id: 's-bench', provider: 'claude-code', providerSessionId: 'u1', projectId: null, name: '検索の速度の計測', cwd: '/work/web-shop', firstPrompt: null, aiTitle: null, startedAt: NOTICE_NOW - 6 * 3_600_000, lastActivityAt: NOTICE_NOW - 3_600_000, memo: null, hasTranscript: true, live: null, summary: null,
  stats: { turns: 2, model: null, effort: null, filesChanged: 0, prUrl: null, inputTokens: 0, outputTokens: 0, contextPercent: null, costUsd: null }, fromScratch: false, lock: null, remoteOnly: false, transcriptMtime: NOTICE_NOW - 27 * 86_400_000, activity: null,
  state: { status: 'paused', note: '夜間の再計測の結果を確かめる', returnOn: '2026-10-09', returnTime: '13:00', setBy: 'user', setAt: 1, candidate: null }, parked: false, stoppedByStatus: false, liveAside: null,
});
function noticeStore(lang: 'ja' | 'en', empty: boolean): Store {
  const base = { ...initialStore(), bootstrapped: true, settings: { language: lang } as unknown as SettingsDto };
  if (empty) return base;
  const drifts: CompatDto = { verifiedVersion: '2.4.0', localVersion: '2.4.2', drifts: [{ contract: 'registry', value: 'status=v2', version: '2.4.2', count: 3, firstSeenAt: NOTICE_NOW - 3_600_000, lastSeenAt: NOTICE_NOW - 12 * 60_000 }] };
  return {
    ...base,
    sessions: { 's-bench': noticeSession() },
    sync: { state: 'error', paused: false, url: 'https://sync.example', lastPushAt: null, lastPullAt: null, pending: 14, error: lang === 'ja' ? 'サーバが 503 を返しました' : 'The server returned 503', deviceCount: 2, limitedUntil: null, skipped: [], sweepPending: 0, oncePass: false },
    readiness: { compat: { verifiedVersion: '2.4.0', localVersion: '2.4.2', driftCount: 1 } } as unknown as ReadinessDto,
    compat: drifts,
    retention: { days: 30, source: 'default', userValue: null, writable: true, unwritableReason: null, usage: null },
    configSync: { enabled: true, workerPending: false, approval: 'each', incoming: 0, conflicts: 0, held: 0, unsent: 2, backups: 0, applyOrder: null, lastSentAt: NOTICE_NOW - 60_000 },
  };
}
/** ヘッダーの右の塊に見立てた帯の中にベルを置く。既読は頁の中だけで動き、開く、既読にする、Esc を手で確かめられる。 */
function BellCase(props: { lang: 'ja' | 'en'; empty?: boolean; allRead?: boolean; open?: boolean; width?: number }) {
  const store = noticeStore(props.lang, props.empty ?? false);
  const [read, setRead] = useState<string[]>(() => (props.allRead ? presentNotices(initialState(), store, NOTICE_NOW).keys : []));
  const p = presentNotices({ ...initialState(), noticesRead: read }, store, NOTICE_NOW, 'Asia/Tokyo');
  return (
    <LanguageRoot language={props.lang}>
      <IntentRoot onIntent={(i) => { if (i.type === 'notices.read') setRead((r) => [...new Set([...r, ...i.keys])]); }}>
        <div id="bell-strip" style={{ width: props.width, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 18, height: 44, padding: '0 12px', borderRadius: 14, background: 'rgba(255, 255, 255, 0.55)', boxShadow: 'var(--glass-edge)', fontSize: 'var(--fs-sm)' }}>
          <span className="faint">{props.lang === 'ja' ? '同期エラー' : 'Sync error'}</span>
          <Bell {...p} defaultOpen={props.open} />
          <button type="button" className="btn btn-primary"><Icon name="add" />{props.lang === 'ja' ? '新しいセッション' : 'New session'}</button>
        </div>
      </IntentRoot>
    </LanguageRoot>
  );
}
const bellCase = params.get('case') ?? 'open';
function BellPage() {
  switch (bellCase) {
    case 'closed': return <BellCase lang="ja" />;
    case 'read': return <BellCase lang="ja" allRead open />;
    case 'empty': return <BellCase lang="ja" empty open />;
    case 'en': return <BellCase lang="en" open />;
    case 'narrow': return <BellCase lang="ja" open width={420} />;
    default: return <BellCase lang="ja" open />;
  }
}

createRoot(document.getElementById('root')!).render(only === 'session' ? (
  <LanguageRoot language="ja"><SessionCases /></LanguageRoot>
) : only === 'bell' ? (
  <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
    <BellPage />
  </div>
) : only === 'band' ? (
  <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
    <h1 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>ホームの帯と引き出し</h1>
    <BandCases />
  </div>
) : (
  <div style={{ maxWidth: 960, margin: '0 auto', padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
    <h1 style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>部品の試験用の頁</h1>
    <section style={card}><h2 style={h2}>数の札（ホームの帯）</h2><Band /></section>
    <section style={card}><h2 style={h2}>数の札（小さい）</h2><Small /></section>
    <section style={card}><h2 style={h2}>設定の札（新しいセッション）</h2><Settings /></section>
    <section style={card}><h2 style={h2}>新しいセッションの札の列（LaunchChips）</h2><Launch /></section>
    <section style={card}><h2 style={h2}>見出しの (i)</h2><InfoHeader /></section>
    <BandCases />
  </div>
));
