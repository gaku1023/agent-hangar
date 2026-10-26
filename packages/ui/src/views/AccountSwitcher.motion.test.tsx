import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import { presentAccounts } from '../presenters/accounts.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { AccountSwitcher } from './AccountSwitcher.tsx';
import { staggerIn } from './primitives/motionKit.ts';

vi.mock('./primitives/motionKit.ts', () => ({ staggerIn: vi.fn(() => []) }));

const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, new Date(2026, 9, 6, 12, 0).getTime());
const codex = { here: false, usage: { plan: 'Plus', fiveHour: { percent: 23, high: false, resets: null }, sevenDay: null, updatedLabel: null } };

describe('AccountSwitcher の開く動き', () => {
  it('開くたびに一度だけ、節の見出しと札を上から順に staggerIn で浮かせる', () => {
    render(<ActionRoot onAction={() => {}}><AccountSwitcher account={{ shown: list[0]!, list, sessionId: null, working: false, codex }}><span>計器</span></AccountSwitcher></ActionRoot>);
    const face = screen.getByRole('button', { name: /^アカウントを切り替え/ });
    fireEvent.click(face);
    expect(staggerIn).toHaveBeenCalledTimes(1);
    const els = vi.mocked(staggerIn).mock.calls[0]![0];
    expect(els.map((e) => e.className)).toEqual(['account-sec', 'account-card', 'account-card', 'account-sec', 'account-card']);
    fireEvent.click(face);
    fireEvent.click(face);
    expect(staggerIn).toHaveBeenCalledTimes(2);
  });
});
