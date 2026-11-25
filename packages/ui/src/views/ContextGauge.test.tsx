import { render, screen } from '@testing-library/react';
import { translator, type UiAction } from '@agent-hangar/shared';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { contextGaugeOf } from '../presenters/contextGauge.ts';
import { presentNowCard } from '../presenters/live.ts';
import type { PeerChatView } from '../presenters/peerChat.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { NowCard } from './NowCard.tsx';
import { PeerChatPane } from './PeerChatPane.tsx';
import { Shell } from './Shell.tsx';
import { SummaryCard } from './SummaryCard.tsx';
import { syncFixture } from '../test/syncProps.ts';

const ja = translator('ja');
const gauge = contextGaugeOf({ contextTokens: 448_000, contextSize: 1_000_000 }, {})!;
const menu = (id: string) => ({ id, name: id, status: null, resumeHere: null, stop: 'external' as const, moveBlocked: null });
const row = (id: string, ctx?: typeof gauge) => ({ id, name: `name-${id}`, live: 'busy' as const, aside: false, reason: null, waited: null, current: false, menu: menu(id), ...(ctx !== undefined ? { ctx } : {}) });
const shellProps = (rows: ReturnType<typeof row>[]) => ({ approvals: [], live: { count: rows.length, ids: rows.map((r) => r.id), rows, groups: [{ key: 'p', name: 'web', open: true, waiting: 0, rows }], pins: [] }, history: { back: false, forward: false }, sidebarCollapsed: false, sidebarWidth: 208, wide: false, nav: [], foot: [], conn: { visible: false, staleLabel: '', retryLabel: '', hard: false, desktop: false }, index: { phase: 'idle' as const, done: 0, total: 0 }, indexLabel: null, usage: { fiveHour: null, sevenDay: null, fiveHourResets: null, sevenDayResets: null, updatedLabel: null }, sync: syncFixture({ visible: false, state: 'off', label: '' }), notices: { rows: [], unread: 0, keys: [], label: '通知' }, account: null, newSession: {} });

describe('サイドバーの行の輪', () => {
  it('量のある行だけ輪を持ち、色の段階と label と満ち具合を載せる', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Shell {...shellProps([row('a', gauge), row('b')])} overlays={null}><div /></Shell></ActionRoot>);
    const rings = container.querySelectorAll('.side-live-row .ctx-ring');
    expect(rings).toHaveLength(1);
    const ring = rings[0] as HTMLElement;
    expect(ring.closest('.side-live-row')).toHaveAttribute('data-id', 'a');
    expect(ring).toHaveAttribute('data-level', 'alert');
    expect(ring).toHaveAttribute('title', '448K/1000K');
    expect(ring.style.getPropertyValue('--p')).toBe('44.8');
  });
});

describe('会話の画面の状態の行の右端の label', () => {
  const card = presentNowCard({ digest: { sessionId: 's1', turnStartSeq: 0, intent: null, agents: [] }, events: [], turnFrom: 0, live: 'idle', activity: null, now: 120_000, viewingAgent: false, clock: () => '10:01', idleFor: '12 分', waited: '', artifacts: [] }, ja);
  const mount = (ui: React.ReactElement) => render(<LanguageRoot language="ja"><ActionRoot onAction={vi.fn<(a: UiAction) => void>()}>{ui}</ActionRoot></LanguageRoot>);
  it('現在の札の頭の行の右端に出る。数字の部分は太字', () => {
    const { container } = mount(<NowCard sessionId="s1" {...card} ctx={gauge} />);
    const el = container.querySelector('.nc-head .ctx-label')!;
    expect(el).toHaveTextContent('448K/1000K');
    expect(el.querySelector('b')).toHaveTextContent('448K');
    expect(el).toHaveAttribute('data-level', 'alert');
  });
  it('opencode など使用量の欄があるときは、重ねて出さない', () => {
    const { container } = mount(<NowCard sessionId="s1" {...card} usage={{ percent: 34, percentLabel: '34%', chips: [] }} ctx={gauge} />);
    expect(container.querySelector('.ctx-label')).toBeNull();
  });
  it('ctx が無ければ出さない', () => {
    const { container } = mount(<NowCard sessionId="s1" {...card} />);
    expect(container.querySelector('.ctx-label')).toBeNull();
  });
  it('要約の札の頭の行の右端に出る', () => {
    const { container } = mount(<SummaryCard sessionId="s1" summary={{ body: 'b', nextSteps: [], nextStepsLabel: 'n', progress: '完了', sourceLine: '' }} notice={null} canRegenerate={false} regenerate="" ctx={gauge} />);
    expect(container.querySelector('.sc-head .ctx-label')).toHaveTextContent('448K/1000K');
  });
  it('別 PC の会話の枠の頭の状態の隣に出る', () => {
    const view = { sessionId: 's1', device: 'Office', status: 'busy', statusLabel: 'バックグラウンドで作業中', tone: 'aside', loading: false, rows: [], hasOlder: false, loadingOlder: false, jump: null, composer: { kind: 'send', sendLabel: '', placeholder: '', hint: null, offline: null, canTakeOver: false, canInterrupt: false, sending: false }, restore: null, notice: null, ctx: gauge } as unknown as PeerChatView;
    const { container } = mount(<PeerChatPane view={view} />);
    expect(container.querySelector('.pchat-bar .ctx-label')).toHaveTextContent('448K/1000K');
    expect(screen.getByText('バックグラウンドで作業中')).toBeInTheDocument();
  });
});
