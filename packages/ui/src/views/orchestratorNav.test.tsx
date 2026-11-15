import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { OrchestratorNavProps } from '../presenters/orchestrator.ts';
import type { SideLiveProps } from '../presenters/shell.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { Sidebar } from './Sidebar.tsx';
import { resetOrchestratorOpen, setOrchestratorOpen, useOrchestratorOpen } from './orchestratorOpen.ts';

const live: SideLiveProps = { count: 0, ids: [], rows: [], groups: [], pins: [] };
const orch = (o: Partial<OrchestratorNavProps> = {}): OrchestratorNavProps => ({ label: '統括', tone: 'idle', statusLabel: '待機中', count: 0, waiting: 0, unread: 0, ...o });
const nav = [{ route: { name: 'home' as const }, label: 'ホーム', current: false, count: 0 }, { route: { name: 'schedules' as const }, label: '予定', current: false, count: 0 }];
const Probe = () => <i data-testid="open">{String(useOrchestratorOpen())}</i>;
const mount = (o: OrchestratorNavProps | null, collapsed = false) =>
  render(<LanguageRoot language="ja"><ActionRoot onAction={() => {}}><Sidebar nav={nav} foot={[]} collapsed={collapsed} live={live} orch={o} /><Probe /></ActionRoot></LanguageRoot>);

beforeEach(() => { localStorage.clear(); resetOrchestratorOpen(); });
afterEach(() => { cleanup(); });

describe('サイドバーの「統括」の行', () => {
  it('予定の下に、ラベルと状態の丸を持って出る。統括が無ければ出ない', () => {
    const { container, unmount } = mount(orch({ tone: 'busy' }));
    const row = screen.getByRole('button', { name: /統括/ });
    expect(row.previousElementSibling?.textContent).toContain('予定');
    expect(row.querySelector('.nav-orch-dot')?.getAttribute('data-tone')).toBe('busy');
    expect(container.querySelector('.nav-orch .nav-count')).toBeNull();
    unmount();
    mount(null);
    expect(screen.queryByRole('button', { name: /統括/ })).toBeNull();
  });
  it('数があれば札を出す', () => {
    const { container } = mount(orch({ tone: 'waiting', waiting: 1, unread: 2, count: 3 }));
    expect(container.querySelector('.nav-orch .nav-count')?.textContent).toContain('3');
  });
  it('押すと柱の開閉が反転する（柱と同じ値）', () => {
    mount(orch());
    expect(screen.getByTestId('open').textContent).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: /統括/ }));
    expect(screen.getByTestId('open').textContent).toBe('true');
    expect(localStorage.getItem('hangar.orchestrator.open')).toBe('1');
    fireEvent.click(screen.getByRole('button', { name: /統括/ }));
    expect(screen.getByTestId('open').textContent).toBe('false');
    act(() => setOrchestratorOpen(true));
    expect(screen.getByRole('button', { name: /統括/ }).getAttribute('aria-pressed')).toBe('true');
  });
});
