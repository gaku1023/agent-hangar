import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { ActionRoot } from '../action/chain.tsx';
import type { SessionRowProps } from '../presenters/row.ts';
import type { SideLiveProps, SideLiveRow } from '../presenters/shell.ts';
import type { TabItemProps } from '../presenters/session.ts';
import type { BandRow } from '../presenters/home.ts';
import { HomeBand } from './HomeBand.tsx';
import { SessionRows } from './SessionRows.tsx';
import { Sidebar } from './Sidebar.tsx';
import { TabStrip } from './TabStrip.tsx';

afterEach(cleanup);

// dom の project では import.meta.url が file にならないので、cwd から辿って読む。
const cssOf = (name: string) => readFileSync(['packages/ui/src/styles/', 'src/styles/'].map((r) => `${process.cwd()}/${r}${name}`).find(existsSync)!, 'utf8');

const row = (id: string, over: Partial<SessionRowProps> = {}): SessionRowProps => ({ id, name: 'n' + id, oneLiner: 'one', projectName: 'alpha', live: null, aside: false, stateLabel: '', summaryState: null, model: '', effort: '', when: '3 分前', whenAbs: '2026-10-25 10:00', filesChanged: 0, prUrl: null, hasTranscript: true, cost: '', runId: null, transcript: 'present', state: null, returnOn: null, returnTime: null, overdueDays: null, returnDue: false, returnPastMin: null, candidate: null, setBy: null, ...over });
const rowEls = () => screen.getAllByRole('row');

describe('一覧の行のアイコン（B10）', () => {
  it('全部の行で、題名の左の同じ枠に絵を置く。Claude は Clawd、opencode は公式ロゴ', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('a', { agent: 'claude-code' }), row('o', { agent: 'opencode' }), row('x', { agent: null })]} height={400} variant="search" /></ActionRoot>);
    const frames = rowEls().map((r) => r.querySelector('.row-name > .row-agent'));
    expect(frames.every((f) => f !== null)).toBe(true);
    // 枠は題名の頭にある。
    for (const r of rowEls()) expect(r.querySelector('.row-name')!.firstElementChild!.classList.contains('row-agent')).toBe(true);
    expect(frames.map((f) => f!.getAttribute('data-agent'))).toEqual(['claude-code', 'opencode', 'none']);
    expect(within(rowEls()[0]!).getByRole('img', { name: 'Claude Code' }).querySelector('svg')).not.toBeNull();
    expect(within(rowEls()[1]!).getByRole('img', { name: 'opencode' }).querySelector('svg')).not.toBeNull();
    // 知らない種類は空の枠で、題名の頭はそろう。
    expect(frames[2]!.querySelector('svg')).toBeNull();
  });

  it('Codex の行は同じ枠に Codex の絵を置く。ほかの行には Codex の名前が出ない', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('a', { agent: 'claude-code' }), row('o', { agent: 'opencode' })]} height={400} variant="search" /></ActionRoot>);
    expect(container.innerHTML.toLowerCase()).not.toMatch(/codex|openai/);
    cleanup();
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('c', { agent: 'codex' })]} height={400} variant="search" /></ActionRoot>);
    const frame = rowEls()[0]!.querySelector('.row-name > .row-agent')!;
    expect(frame.getAttribute('data-agent')).toBe('codex');
    expect(within(rowEls()[0]!).getByRole('img', { name: 'Codex' }).querySelector('svg')).not.toBeNull();
  });

  it('agent の無い行（アイコンを出さないとき）は枠ごと置かない', () => {
    render(<ActionRoot onAction={vi.fn()}><SessionRows rows={[row('a'), row('b')]} height={400} variant="search" /></ActionRoot>);
    for (const r of rowEls()) expect(r.querySelector('.row-agent')).toBeNull();
  });

  it('枠はどの行も同じ幅（20px）で、縮まない', () => {
    const rule = cssOf('rows.css').match(/\.row-agent \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/width: 20px/);
    expect(rule).toMatch(/flex: none/);
  });
});

const side = (id: string, over: Partial<SideLiveRow> = {}): SideLiveRow => ({ id, name: 'n' + id, live: 'busy', aside: false, reason: null, waited: null, current: false, menu: { stop: null } as unknown as SideLiveRow['menu'], ...over });
const sideProps = (rows: SideLiveRow[]): SideLiveProps => ({ count: rows.length, ids: rows.map((r) => r.id), rows, groups: [{ key: '', name: '未分類', open: true, waiting: 0, rows }] });

describe('サイドバーの行のアイコン', () => {
  it('名前の右端に、一覧と同じ絵を置く', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Sidebar nav={[]} foot={[]} collapsed={false} live={sideProps([side('a', { agent: 'claude-code' }), side('o', { agent: 'opencode' })])} /></ActionRoot>);
    const rows = [...container.querySelectorAll('.side-live-row')];
    expect(rows.map((r) => r.querySelector('.side-live-name + .side-live-agent')?.getAttribute('data-agent'))).toEqual(['claude-code', 'opencode']);
  });
  it('agent の無い行には置かない', () => {
    const { container } = render(<ActionRoot onAction={vi.fn()}><Sidebar nav={[]} foot={[]} collapsed={false} live={sideProps([side('a')])} /></ActionRoot>);
    expect(container.querySelector('.side-live-agent')).toBeNull();
  });
});

describe('ターミナルの上のタブ', () => {
  const tabs = (selected: boolean): TabItemProps[] => [{ id: 'r1', title: 'opencode', kind: 'agent', agent: 'opencode', selected, closable: false }, { id: 't1', title: 'シェル t1', kind: 'shell', selected: !selected, closable: true }];
  it('opencode のタブは公式ロゴと「opencode」。選んだタブ（板とつながる暗い地）は暗い地用の絵', () => {
    render(<ActionRoot onAction={vi.fn()}><TabStrip sessionId="s1" tabs={tabs(true)} canAdd canSplit split={false} /></ActionRoot>);
    const tab = screen.getByRole('tab', { name: 'opencode' });
    const logo = tab.querySelector('.agent-icon[data-agent="opencode"]')!;
    expect(logo.getAttribute('data-tone')).toBe('dark');
    // 絵は飾りで、名前は語が言う。
    expect(logo.getAttribute('aria-hidden')).toBe('true');
    expect(logo.querySelector('path[fill="#F1ECEC"]')).not.toBeNull();
  });
  it('選んでいないタブ（明るい地）は明るい地用の絵', () => {
    render(<ActionRoot onAction={vi.fn()}><TabStrip sessionId="s1" tabs={tabs(false)} canAdd canSplit split={false} /></ActionRoot>);
    expect(screen.getByRole('tab', { name: 'opencode' }).querySelector('.agent-icon')!.getAttribute('data-tone')).toBe('light');
  });
  it('Claude のタブはいまのまま（Clawd を置かない）', () => {
    render(<ActionRoot onAction={vi.fn()}><TabStrip sessionId="s1" tabs={[{ id: 'r1', title: 'Claude', kind: 'agent', selected: true, closable: false }]} canAdd canSplit={false} split={false} /></ActionRoot>);
    expect(screen.getByRole('tab', { name: 'Claude' }).querySelector('.agent-icon')).toBeNull();
  });
});

describe('ホームの上の帯の行のアイコン', () => {
  const bandRow = (key: string, agent?: BandRow['agent']): BandRow => ({ key, lead: { kind: 'dot', live: 'busy', aside: false }, name: 'n' + key, context: 'alpha', text: '', detail: null, tone: null, trail: [], open: null, actions: [], ...(agent !== undefined ? { agent } : {}) });
  const mountBand = (rows: BandRow[]) => render(
    <ActionRoot onAction={vi.fn()}>
      <HomeBand morning="running" groups={[{ id: 'running', label: '実行中', icon: 'tool', tone: 'default', count: rows.length, summary: '', morning: true, rows }]} />
    </ActionRoot>,
  );
  it('agent を持つ行は、名前の左の同じ幅の枠に絵を置く。知らない種類は空の枠', () => {
    const { container } = mountBand([bandRow('a', 'claude-code'), bandRow('o', 'opencode'), bandRow('x', null)]);
    const frames = [...container.querySelectorAll('.crow')].map((li) => li.querySelector('.c-agent'));
    expect(frames.map((f) => f?.getAttribute('data-agent'))).toEqual(['claude-code', 'opencode', 'none']);
    expect(frames[1]!.querySelector('.agent-icon')?.getAttribute('aria-label')).toBe('opencode');
    expect(frames[2]!.querySelector('.agent-icon')).toBeNull();
  });
  it('agent の無い行（アイコンを出さないとき）は枠ごと置かない', () => {
    const { container } = mountBand([bandRow('a'), bandRow('b')]);
    expect(container.querySelectorAll('.c-agent')).toHaveLength(0);
  });
  it('枠の幅は一覧の行と同じ 20px', () => {
    expect(cssOf('home.css')).toMatch(/\.c-agent\s*\{[^}]*width:\s*20px/);
  });
});
