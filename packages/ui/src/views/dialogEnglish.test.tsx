import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { IntentRoot } from '../intent/chain.tsx';
import { KEYMAP } from '../keys.ts';
import { presentAccounts, switchLabel } from '../presenters/accounts.ts';
import { pauseChoices } from '../presenters/pause.ts';
import { usageBar } from '../presenters/retentionDialog.ts';
import type { HeaderAccountProps } from '../presenters/shell.ts';
import { initialStore } from '../store/store.ts';
import { accountsFixture } from '../test/accounts.ts';
import { AccountSwitcher } from './AccountSwitcher.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { NewProjectDialog } from './NewProjectDialog.tsx';
import { PauseDialog } from './PauseDialog.tsx';
import { PromoteDialog, PromotedDialog } from './PromoteDialog.tsx';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';
import { RetentionDialog } from './RetentionDialog.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { LanguageRoot } from './primitives/language.tsx';

/** 言語を英語にしたとき、ダイアログ類の文が英語で出る。日本語の文が混ざらないことも見る。 */
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const en = translator('en');
const NOW = new Date(2026, 9, 6, 12, 0).getTime();

const inEnglish = (ui: React.ReactNode) => render(<LanguageRoot language="en"><IntentRoot onIntent={vi.fn()}>{ui}</IntentRoot></LanguageRoot>);
const noJapanese = (node: HTMLElement = document.body) => expect(node.textContent ?? '').not.toMatch(JAPANESE);

describe('ダイアログ類（英語）', () => {
  it('確認：プロジェクトを一覧から削除する', () => {
    inEnglish(<ConfirmDialog confirm={{ kind: 'unlinkProject', projectId: 'p1' }} project={{ name: 'demo', sessions: 3 }} />);
    expect(screen.getByRole('dialog', { name: 'Remove from list?' })).toBeInTheDocument();
    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove from list' })).toBeInTheDocument();
    noJapanese();
  });
  it('確認：停止、hangar への移動、アカウント、トランスクリプトの置き換え', () => {
    const { unmount } = inEnglish(<ConfirmDialog confirm={{ kind: 'killRun', runId: 'r1', working: true, shellTabs: 2 }} />);
    expect(screen.getByRole('dialog', { name: 'Stop this session?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    noJapanese();
    unmount();
    const adopt = inEnglish(<ConfirmDialog confirm={{ kind: 'adoptSession', sessionId: 's1' }} />);
    expect(screen.getByRole('dialog', { name: 'Move to Hangar?' })).toBeInTheDocument();
    expect(screen.getByText('claude -r')).toBeInTheDocument();
    noJapanese();
    adopt.unmount();
    const sw = inEnglish(<ConfirmDialog confirm={{ kind: 'switchAccount', sessionId: 's1', accountId: 'a1', working: true }} accountName="Work" />);
    expect(screen.getByRole('dialog', { name: 'Switch to Work?' })).toBeInTheDocument();
    noJapanese();
    sw.unmount();
    const rm = inEnglish(<ConfirmDialog confirm={{ kind: 'removeAccount', accountId: 'a1' }} accountName="Work" />);
    expect(screen.getByRole('dialog', { name: 'Remove Work?' })).toBeInTheDocument();
    noJapanese();
    rm.unmount();
    inEnglish(<ConfirmDialog confirm={{ kind: 'overwriteTranscript', sessionId: 's1', localSize: 1024, remoteSize: 4096 }} />);
    expect(screen.getByRole('dialog', { name: 'Replace transcript?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Overwrite and resume' })).toBeInTheDocument();
    noJapanese();
  });

  it('Paused の入力：札、欄、字数', () => {
    const choices = pauseChoices(NOW, en);
    expect(choices.map((c) => c.label)).toEqual(['This evening', 'Tomorrow', 'Monday', 'Next week', 'Pick a date…']);
    inEnglish(<PauseDialog sessionId="s1" sessionName="Demo" from="candidate" draft="" candidateNote={null} initialReturnOn="2026-10-07" initialReturnTime="" candidateReturnTime={null} today="2026-10-06" choices={choices} />);
    expect(screen.getByRole('dialog', { name: 'Mark as Paused' })).toBeInTheDocument();
    expect(screen.getByText('Suggestion')).toBeInTheDocument();
    expect(screen.getByLabelText('Reminder time (optional)')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    expect(screen.getByText(/^0 \/ \d+ characters$/)).toBeInTheDocument();
    noJapanese();
  });

  it('昇格：入力と完了', () => {
    const { unmount } = inEnglish(<PromoteDialog sessionId="s1" sessionName="Demo" runAlive submitting={false} error={null} />);
    expect(screen.getByRole('dialog', { name: 'Promote to project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Promote' })).toBeInTheDocument();
    expect(screen.getByText(/^Files are not moved/)).toBeInTheDocument();
    noJapanese();
    unmount();
    inEnglish(<PromotedDialog projectId="p1" projectName="demo" moved reason={null} />);
    expect(screen.getByRole('dialog', { name: 'Promoted demo to a project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start a new session here' })).toBeInTheDocument();
    noJapanese();
  });

  it('新しいプロジェクト', () => {
    inEnglish(<NewProjectDialog dirs={[]} workspaceRoot="/work" desktop picked={null} submitting={false} error={null} />);
    expect(screen.getByRole('dialog', { name: 'New project' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create and start' })).toBeInTheDocument();
    expect(screen.getByText('Create new folder')).toBeInTheDocument();
    expect(screen.getByText('Run git init')).toBeInTheDocument();
    noJapanese();
  });

  it('保持期間：書き込みの確認', () => {
    inEnglish(<RetentionDialog title="Extend the transcript retention period to 1 year" lead="lead" path="/x" lines={[]} bar={null} backupDir="/b/" otherPcs shrinkNote={null} reloaded showOther writing={false} previewError={null} />);
    expect(screen.getByRole('button', { name: 'Write' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Other periods…' })).toBeInTheDocument();
    expect(screen.getByText('Backup')).toBeInTheDocument();
    noJapanese();
  });
  it('保持期間の見出しと使用量は、期間と大きさを英語で作る', () => {
    const bar = usageBar({ bytes: 1024 ** 3, freeBytes: 0, dailyBytes: 0 } as never, 2 * 1024 ** 3, 365, en);
    expect(bar).toMatchObject({ nowLabel: 'Now 1 GB', projLabel: 'About 2 GB after 1 year', freeLabel: 'Free space unknown' });
  });

  it('キーボードショートカット：全部の行が英語で出る', () => {
    inEnglish(<ShortcutsDialog />);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    expect(screen.getByText('Start a quick session')).toBeInTheDocument();
    expect(screen.getByText('Find in transcript')).toBeInTheDocument();
    expect(screen.getAllByText(/^(Anywhere|Session|List)$/)).toHaveLength(3);
    noJapanese();
    expect(KEYMAP.length).toBeGreaterThan(0);
  });

  it('アカウントの切り替え：ボタンの読み上げと一覧', () => {
    const list = presentAccounts({ ...initialStore(), accounts: accountsFixture }, NOW);
    const account: NonNullable<HeaderAccountProps> = { shown: list[0]!, list, sessionId: null, working: false };
    expect(switchLabel(en, { ...list[0]!, fiveHour: { percent: 82.4, high: true, resets: null }, sevenDay: { percent: 40.6, high: false, resets: null } })).toBe(`Switch account (current: ${list[0]!.name}, 5-hour 82%, Weekly 41%)`);
    inEnglish(<AccountSwitcher account={account}><span /></AccountSwitcher>);
    fireEvent.click(screen.getByRole('button', { name: /^Switch account/ }));
    expect(screen.getByRole('dialog', { name: 'Switch account' })).toBeInTheDocument();
    expect(screen.getByText('Account settings')).toBeInTheDocument();
    expect(screen.getByText('Current account')).toBeInTheDocument();
  });

  it('未解決のプロジェクト：この PC で消えたものと、他の PC から届いただけのもの', () => {
    const { unmount } = inEnglish(<ResolveProjectDialog projectId="p1" name="demo" previousPath="/w/demo" candidates={['/w/demo2']} onQueryCandidates={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'demo: folder not found' })).toBeInTheDocument();
    expect(screen.getByText('Previous path')).toBeInTheDocument();
    expect(screen.getByText('Candidates in the projects folder')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'New path' })).toBeInTheDocument();
    for (const name of ['Use this location', 'Mark as Archived', 'Remove from list', 'Later']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    noJapanese();
    unmount();
    inEnglish(<ResolveProjectDialog projectId="p1" name="demo" elsewhere deviceName="Mac mini" previousPath="/o/demo" candidates={[]} onQueryCandidates={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'No path on this computer for demo' })).toBeInTheDocument();
    expect(screen.getByText('Path on Mac mini')).toBeInTheDocument();
    noJapanese();
  });
});
