import type { MobileFeed } from '@agent-hangar/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openInbox } from '../inbox.ts';
import type { LaunchSpec } from '../launchRun.ts';
import { at1, feedOf, inboxOf, makeKey, ring } from '../test/fixtures.ts';
import { WORKER } from '../test/pairText.ts';
import { clearLaunchDefaults } from '../launchDefaults.ts';
import { NewSessionScreen } from './NewSessionScreen.tsx';

let key: CryptoKey;
const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };

beforeEach(async () => {
  key = await makeKey();
  clearLaunchDefaults();
});
afterEach(() => vi.clearAllMocks());

const feed = (caps: MobileFeed['caps']): MobileFeed[] => [feedOf('pc-1', 'Mac', { caps })];
const ALL = { asks: true, images: true, effort: true, launchExtras: true };

async function setup(feeds: MobileFeed[]) {
  const onLaunch = vi.fn<(s: LaunchSpec) => void>();
  const view = await openInbox(await inboxOf(key, feeds, { now: Date.now() }), ring(key), new Date());
  render(<NewSessionScreen view={view} pairing={pairing} phoneKey={at1(key)} onLaunch={onLaunch} onClose={vi.fn()} />);
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'プロジェクト' })).getByRole('radio', { name: /project-a/ }));
  fireEvent.change(screen.getByRole('textbox', { name: '初期プロンプト' }), { target: { value: 'やって' } });
  return onLaunch;
}
const open = () => fireEvent.click(screen.getByRole('button', { name: /詳しい設定/ }));

describe('NewSessionScreen の worktree と名前', () => {
  it('caps.launchExtras の無い PC には 2 つの欄を出さない', async () => {
    await setup(feed({ asks: true, images: true, effort: true }));
    open();
    expect(screen.queryByRole('textbox', { name: 'worktree' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: '名前' })).toBeNull();
  });

  it('caps.launchExtras のある PC では、worktree と名前を依頼に入れる', async () => {
    const onLaunch = await setup(feed(ALL));
    open();
    fireEvent.change(screen.getByRole('textbox', { name: 'worktree' }), { target: { value: 'fix-login' } });
    fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: ' ログインの直し ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(onLaunch.mock.calls[0]![0].payload).toMatchObject({ worktree: 'fix-login', name: 'ログインの直し' });
  });

  it('空の欄は依頼に入れない', async () => {
    const onLaunch = await setup(feed(ALL));
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    const p = onLaunch.mock.calls[0]![0].payload;
    expect('worktree' in p).toBe(false);
    expect('name' in p).toBe(false);
  });

  it('worktree の形が合わなければ始められない', async () => {
    await setup(feed(ALL));
    open();
    fireEvent.change(screen.getByRole('textbox', { name: 'worktree' }), { target: { value: '../x' } });
    expect(screen.getByRole('button', { name: 'Mac で始める' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'worktree' })).toHaveAttribute('aria-invalid', 'true');
  });

  it('opencode には worktree を出さず、名前だけ入れる', async () => {
    const onLaunch = await setup(feed({ ...ALL, agents: ['claude-code', 'opencode'] }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'エージェント' })).getByRole('radio', { name: /opencode/ }));
    open();
    expect(screen.queryByRole('textbox', { name: 'worktree' })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '名前' }), { target: { value: '調べもの' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    const p = onLaunch.mock.calls[0]![0].payload;
    expect(p).toMatchObject({ agent: 'opencode', name: '調べもの' });
    expect('worktree' in p).toBe(false);
  });
});

describe('NewSessionScreen の Bypass permissions', () => {
  it('Bypass permissions を選ぶと、起動のボタンが赤の「Bypass permissions で起動」になる', async () => {
    await setup(feed(ALL));
    open();
    fireEvent.click(within(screen.getByRole('radiogroup', { name: '権限モード' })).getByRole('radio', { name: /Bypass permissions/ }));
    const go = screen.getByRole('button', { name: 'Bypass permissions で起動' });
    expect(go.className).toContain('danger');
  });
});
