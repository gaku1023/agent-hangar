import type { MobileCaps, MobileCodexOptions, MobileFeed } from '@agent-hangar/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asker } from '../ask.ts';
import { openInbox } from '../inbox.ts';
import { clearLaunchDefaults, saveLaunchDefaults, EMPTY_DEFAULTS } from '../launchDefaults.ts';
import type { LaunchSpec } from '../launchRun.ts';
import { at1, feedOf, inboxOf, makeKey, MIN, ring } from '../test/fixtures.ts';
import { WORKER } from '../test/pairText.ts';
import { NewSessionScreen } from './NewSessionScreen.tsx';

let key: CryptoKey;
const pairing = { url: WORKER, token: 'tok-1', deviceId: 'phone-1' };

beforeEach(async () => {
  key = await makeKey();
  vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  clearLaunchDefaults();
});

const BOTH: MobileCaps = { asks: true, images: true, effort: true, agents: ['claude-code', 'codex', 'opencode'] };
const CODEX_ONLY: MobileCaps = { asks: true, images: true, effort: true, agents: ['claude-code', 'codex'] };

const OPTIONS: MobileCodexOptions = {
  version: '0.164.0',
  verified: true,
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', efforts: ['low', 'medium'], defaultEffort: null },
  ],
  stale: false,
  fetchedAt: Date.now(),
};

const feeds = (): MobileFeed[] => [
  feedOf('pc-1', 'Mac', { caps: CODEX_ONLY, projects: [{ id: 'p-a', name: 'project-a', lastUsedAt: Date.now() - 5 * MIN }] }),
  feedOf('pc-2', 'Both', { caps: BOTH, projects: [{ id: 'p-c', name: 'project-c', lastUsedAt: Date.now() - 3 * MIN }] }),
  feedOf('pc-3', 'Old', { projects: [{ id: 'p-b', name: 'project-b', lastUsedAt: Date.now() - MIN }] }),
];

const askerOf = (o: { codex?: () => Promise<MobileCodexOptions | null> } = {}): Asker => ({
  commands: vi.fn(async () => []),
  files: vi.fn(async () => []),
  agentOptions: vi.fn(async () => null),
  codexOptions: vi.fn(o.codex ?? (async () => OPTIONS)),
});

async function setup(asker: Asker = askerOf()) {
  const onLaunch = vi.fn<(s: LaunchSpec) => void>();
  const view = await openInbox(await inboxOf(key, feeds(), { now: Date.now() }), ring(key), new Date());
  render(<NewSessionScreen view={view} pairing={pairing} phoneKey={at1(key)} deps={{ asker }} onLaunch={onLaunch} onClose={vi.fn()} />);
  return { onLaunch, asker };
}

const group = (name: string) => screen.getByRole('radiogroup', { name });
const queryGroup = (name: string) => screen.queryByRole('radiogroup', { name });
const pick = (groupName: string, option: RegExp | string) => fireEvent.click(within(group(groupName)).getByRole('radio', { name: option }));
const prompt = () => screen.getByRole('textbox', { name: '初期プロンプト' });
const advanced = () => screen.getByRole('button', { name: /詳しい設定/ });

describe('NewSessionScreen の Codex', () => {
  it('caps.agents に codex のある PC だけエージェントの段に Codex を出す。並びは Claude Code、Codex、opencode', async () => {
    await setup();
    pick('プロジェクト', /project-a/);
    expect(within(group('エージェント')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Claude Code', expect.stringContaining('Codex')]);
    expect(within(group('エージェント')).getByRole('radio', { name: /Codex/ })).toHaveTextContent('ベータ');
    pick('プロジェクト', /project-c/);
    expect(within(group('エージェント')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Claude Code', expect.stringContaining('Codex'), expect.stringContaining('opencode')]);
    pick('プロジェクト', /project-b/);
    expect(queryGroup('エージェント')).not.toBeInTheDocument();
  });

  it('Codex を選ぶとアカウントと権限モードの段が畳まれ、詳しい設定が権限、モデル、推論の強さに変わる。一覧は PC ごとに問い合わせる', async () => {
    const { asker } = await setup();
    pick('プロジェクト', /project-a/);
    fireEvent.click(advanced());
    pick('エージェント', /Codex/);
    await waitFor(() => expect(queryGroup('アカウント')).not.toBeInTheDocument());
    await waitFor(() => expect(queryGroup('権限モード')).not.toBeInTheDocument());
    expect(asker.codexOptions).toHaveBeenCalledWith('pc-1');
    expect(asker.agentOptions).not.toHaveBeenCalled();
    await waitFor(() => expect(within(group('モデル')).getAllByRole('radio').map((r) => r.getAttribute('data-value'))).toEqual(['', 'gpt-5.5', 'gpt-5.5-mini']));
    expect(within(group('権限')).getAllByRole('radio').map((r) => r.getAttribute('data-value'))).toEqual(['read-only', 'auto', 'full-access']);
    expect(within(group('権限')).getByRole('radio', { name: /自動/ })).toHaveAttribute('aria-checked', 'true');
    // モデルが既定のあいだは、どのモデルの段階も選べる。モデルを選ぶと、そのモデルの段階だけになる。
    expect(within(group('推論の強さ')).getAllByRole('radio').map((r) => r.getAttribute('data-value'))).toEqual(['', 'low', 'medium', 'high']);
    pick('モデル', /GPT-5.5 mini/);
    await waitFor(() => expect(within(group('推論の強さ')).getAllByRole('radio').map((r) => r.getAttribute('data-value'))).toEqual(['', 'low', 'medium']));
    expect(within(group('エージェント')).getByRole('radio', { name: /Codex/ })).toHaveTextContent('0.164.0 · 検証済み');
    pick('エージェント', 'Claude Code');
    await waitFor(() => expect(group('アカウント')).toBeInTheDocument());
    expect(group('権限モード')).toBeInTheDocument();
    expect(queryGroup('推論の強さ')).not.toBeInTheDocument();
  });

  it('フルアクセスを選ぶと注意を出し、読み取りのみに戻すと消える', async () => {
    await setup();
    pick('プロジェクト', /project-a/);
    pick('エージェント', /Codex/);
    fireEvent.click(advanced());
    await waitFor(() => expect(group('権限')).toBeInTheDocument());
    expect(screen.queryByText(/確認なしでコマンドを実行します/)).not.toBeInTheDocument();
    pick('権限', /フルアクセス/);
    expect(await screen.findByText(/確認なしでコマンドを実行します/)).toBeInTheDocument();
    pick('権限', /読み取りのみ/);
    await waitFor(() => expect(screen.queryByText(/確認なしでコマンドを実行します/)).not.toBeInTheDocument());
  });

  it('Codex の依頼は agent、model、effort、権限を持ち、アカウントは空。mode と autoApprove は無い', async () => {
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-a/);
    pick('エージェント', /Codex/);
    fireEvent.click(advanced());
    await waitFor(() => expect(within(group('モデル')).getAllByRole('radio')).toHaveLength(3));
    pick('モデル', /GPT-5.5$/);
    pick('推論の強さ', 'high');
    pick('権限', /読み取りのみ/);
    expect(advanced()).toHaveTextContent('権限 読み取りのみ · モデル GPT-5.5 · 推論 high');
    fireEvent.change(prompt(), { target: { value: '読んで' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    const spec = onLaunch.mock.calls[0]![0];
    expect(spec.payload).toMatchObject({ projectId: 'p-a', scratch: false, accountId: '', permissionMode: 'read-only', model: 'gpt-5.5', effort: 'high', prompt: '読んで', agent: 'codex' });
    expect(spec.payload).not.toHaveProperty('mode');
    expect(spec.payload).not.toHaveProperty('autoApprove');
    expect(spec.accountId).toBe('');
    expect(spec.accountName).toBeNull();
  });

  it('アカウントを選ばなくても始められる。何も選ばなければ権限は自動、model と effort は空（既定）', async () => {
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-a/);
    pick('エージェント', /Codex/);
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    const p = onLaunch.mock.calls[0]![0].payload;
    expect(p).toMatchObject({ accountId: '', permissionMode: 'auto', model: '', agent: 'codex' });
    expect(p).not.toHaveProperty('effort');
  });

  it('一覧が取れなければ（PC がまだ持っていない、失敗）デフォルトで起動する旨を出し、モデルは既定のまま送る', async () => {
    const { onLaunch } = await setup(askerOf({ codex: async () => null }));
    pick('プロジェクト', /project-a/);
    pick('エージェント', /Codex/);
    fireEvent.click(advanced());
    expect(await screen.findByText('モデルの一覧を取得できません。デフォルトで起動します。')).toBeInTheDocument();
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(onLaunch.mock.calls[0]![0].payload).toMatchObject({ agent: 'codex', model: '' });
  });

  it('既定のエージェントが Codex でも、選べない PC（古い PC）には agent を入れない。選べる PC では最初から Codex', async () => {
    saveLaunchDefaults({ ...EMPTY_DEFAULTS, agent: 'codex' });
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-b/);
    pick('アカウント', /アカウント 1/);
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Old で始める' }));
    expect(onLaunch.mock.calls[0]![0].payload).not.toHaveProperty('agent');
  });

  it('既定が Codex なら、Codex のある PC では最初から Codex が選ばれている', async () => {
    saveLaunchDefaults({ ...EMPTY_DEFAULTS, agent: 'codex' });
    await setup();
    pick('プロジェクト', /project-a/);
    expect(within(group('エージェント')).getByRole('radio', { name: /Codex/ })).toHaveAttribute('aria-checked', 'true');
  });
});
