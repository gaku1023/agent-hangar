import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { syncFixture } from '../test/syncProps.ts';
import { Header } from './Header.tsx';
import { fadeIn } from './primitives/motionKit.ts';

vi.mock('./primitives/motionKit.ts', () => ({ fadeIn: vi.fn(() => null), collapseOut: vi.fn(() => null), motionOn: () => false }));

const base = { fiveHour: 12, sevenDay: 31, fiveHourResets: null, sevenDayResets: null, updatedLabel: null };
const claude = { ...base, agent: { key: 'claude' as const, label: 'Claude' } };
const codex = { ...base, agent: { key: 'codex' as const, label: 'Codex' } };
const header = (usage: Omit<typeof base, 'fiveHour'> & { fiveHour: number | null; fiveHourLimit?: string; agent?: { key: 'claude' | 'codex'; label: string } }) => (
  <ActionRoot onAction={() => {}}><Header indexLabel={null} usage={usage} account={null} sync={syncFixture({ visible: false, state: 'off', label: '' })} notices={{ rows: [], unread: 0, keys: [], label: '通知' }} newSession={{}} /></ActionRoot>
);

describe('ヘッダの使用量の頭の札（U1）', () => {
  beforeEach(() => { vi.mocked(fadeIn).mockClear(); });
  it('Codex の枠が無ければ札を出さず、動かさない', () => {
    const { container, rerender } = render(header(base));
    expect(container.querySelector('.gauge-agent')).toBeNull();
    rerender(header({ ...base, fiveHour: 20 }));
    expect(fadeIn).not.toHaveBeenCalled();
  });
  it('札は枠の先頭に Claude か Codex と出し、エージェントが替わったときだけ fadeIn で入れ替える', () => {
    const { container, rerender } = render(header(claude));
    expect(container.querySelector('.gauges > .gauge-agent')?.textContent).toBe('Claude');
    expect(fadeIn).not.toHaveBeenCalled();
    rerender(header(codex));
    expect(container.querySelector('.gauge-agent')?.textContent).toBe('Codex');
    expect(fadeIn).toHaveBeenCalledTimes(1);
    rerender(header({ ...codex, fiveHour: 15 }));
    expect(fadeIn).toHaveBeenCalledTimes(1);
  });
});

describe('ヘッダの 5 時間の計器', () => {
  it('週だけが届いたら 5 時間の計器を出さない。止まっている間は出す', () => {
    const { container, rerender } = render(header({ ...base, fiveHour: null }));
    expect(container.querySelector('[aria-label="5 時間の使用率"]')).toBeNull();
    expect(container.querySelector('[aria-label="週の使用率"]')).not.toBeNull();
    rerender(header({ ...base, fiveHour: null, fiveHourLimit: '14:00'}));
    expect(container.querySelector('[aria-label="5 時間の使用率"]')).not.toBeNull();
  });
});
