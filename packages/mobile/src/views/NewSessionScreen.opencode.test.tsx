import type { MobileAgentOptions, MobileCaps, MobileFeed } from '@agent-hangar/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AskError, type Asker } from '../ask.ts';
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

const OC_CAPS: MobileCaps = { asks: true, images: true, effort: true, agents: ['claude-code', 'opencode'] };

const OPTIONS: MobileAgentOptions = {
  version: '2.1.4',
  verified: true,
  modes: [{ id: 'build', description: 'The default agent.' }, { id: 'plan', description: null }],
  models: [
    { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode Zen', cost: 'free', data: 'no-training' },
    { id: 'opencode/big-pickle', label: 'Big Pickle', group: 'OpenCode Zen', cost: 'free', data: 'may-train' },
    { id: 'lmstudio/qwen/qwen3-coder-30b', label: 'Qwen3 Coder 30B', group: 'LM Studio', cost: 'local', data: 'on-device' },
  ],
  defaultModel: 'lmstudio/qwen/qwen3-coder-30b',
  stale: false,
  fetchedAt: Date.now(),
};

/** Mac は opencode を有効にした PC、Old は caps に agents の無い（opencode を知らないか、無効の）PC。 */
const feeds = (): MobileFeed[] => [
  feedOf('pc-1', 'Mac', { caps: OC_CAPS, projects: [{ id: 'p-a', name: 'project-a', lastUsedAt: Date.now() - 5 * MIN }] }),
  feedOf('pc-2', 'Old', { projects: [{ id: 'p-b', name: 'project-b', lastUsedAt: Date.now() - MIN }] }),
];

const askerOf = (o: { options?: () => Promise<MobileAgentOptions | null> } = {}): Asker => ({
  commands: vi.fn(async () => [{ name: 'init', description: 'create/update AGENTS.md', kind: 'command' as const }]),
  files: vi.fn(async () => []),
  agentOptions: vi.fn(o.options ?? (async () => OPTIONS)),
});

async function setup(asker: Asker = askerOf(), fs: MobileFeed[] = feeds()) {
  const onLaunch = vi.fn<(s: LaunchSpec) => void>();
  const view = await openInbox(await inboxOf(key, fs, { now: Date.now() }), ring(key), new Date());
  render(<NewSessionScreen view={view} pairing={pairing} phoneKey={at1(key)} deps={{ asker }} onLaunch={onLaunch} onClose={vi.fn()} />);
  return { onLaunch, asker };
}

const group = (name: string) => screen.getByRole('radiogroup', { name });
const queryGroup = (name: string) => screen.queryByRole('radiogroup', { name });
const pick = (groupName: string, option: RegExp | string) => fireEvent.click(within(group(groupName)).getByRole('radio', { name: option }));
const prompt = () => screen.getByRole('textbox', { name: '初期プロンプト' });
const advanced = () => screen.getByRole('button', { name: /詳しい設定/ });
const specOf = (fn: ReturnType<typeof vi.fn<(s: LaunchSpec) => void>>): LaunchSpec => fn.mock.calls[0]![0];

describe('NewSessionScreen のエージェント', () => {
  it('caps.agents の無い PC には、エージェントの段を出さない', async () => {
    await setup();
    pick('プロジェクト', /project-b/);
    expect(within(group('PC')).getByRole('radio', { name: /Old/ })).toHaveAttribute('aria-checked', 'true');
    expect(queryGroup('エージェント')).not.toBeInTheDocument();
    expect(group('アカウント')).toBeInTheDocument();
  });

  it('caps.agents に opencode のある PC を選ぶと、PC の次にエージェントの段が出る。既定は Claude Code', async () => {
    await setup();
    pick('プロジェクト', /project-a/);
    const radios = within(group('エージェント')).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual(['Claude Code', expect.stringContaining('opencode')]);
    expect(radios[1]).toHaveTextContent('ベータ');
    expect(radios[0]).toHaveAttribute('aria-checked', 'true');
  });

  it('新しいスマホ × 古い PC：既定が opencode でも、caps.agents の無い PC への依頼に agent を入れず、Claude の依頼にする', async () => {
    saveLaunchDefaults({ ...EMPTY_DEFAULTS, agent: 'opencode' });
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-b/);
    expect(queryGroup('エージェント')).not.toBeInTheDocument();
    pick('アカウント', /アカウント 1/);
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Old で始める' }));
    const p = specOf(onLaunch).payload;
    expect(p).not.toHaveProperty('agent');
    expect(p).not.toHaveProperty('mode');
    expect(p).not.toHaveProperty('autoApprove');
    expect(p.accountId).toBe('acc-1');
  });

  it('opencode を選ぶとアカウントの段を畳み、詳しい設定がモード、モデル、自動承認に変わる', async () => {
    const { asker } = await setup();
    pick('プロジェクト', /project-a/);
    fireEvent.click(advanced());
    expect(group('権限モード')).toBeInTheDocument();
    pick('エージェント', /opencode/);
    await waitFor(() => expect(queryGroup('アカウント')).not.toBeInTheDocument());
    await waitFor(() => expect(queryGroup('権限モード')).not.toBeInTheDocument());
    expect(queryGroup('effort')).not.toBeInTheDocument();
    expect(asker.agentOptions).toHaveBeenCalledWith('pc-1', 'p-a');
    await waitFor(() => expect(within(group('モード')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['デフォルト', 'build', 'plan']));
    const models = within(group('モデル')).getAllByRole('radio');
    expect(models.map((r) => r.getAttribute('data-value'))).toEqual(['', 'opencode/glm-5.3-flash-free', 'opencode/big-pickle', 'lmstudio/qwen/qwen3-coder-30b']);
    // デフォルトには opencode.json の既定を添え、モデルにはプロバイダー、費用の型、気を付けるデータの扱いを添える。
    expect(models[0]).toHaveTextContent('lmstudio/qwen/qwen3-coder-30b');
    expect(models[2]).toHaveTextContent('OpenCode Zen · 無料 · ⚠ 学習利用の可能性あり');
    expect(models[3]).toHaveTextContent('LM Studio · ローカル · PC 外への送信なし');
    expect(within(group('自動承認')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['オフ', 'オン（--auto）']);
    expect(screen.getByText('ask のツールは実行前に確認')).toBeInTheDocument();
    // 選択肢の説明に版を出す。
    expect(within(group('エージェント')).getByRole('radio', { name: /opencode/ })).toHaveTextContent('2.1.4 · 検証済み');
    // Claude Code に戻すと、アカウントと権限モードが戻る。
    pick('エージェント', 'Claude Code');
    await waitFor(() => expect(group('アカウント')).toBeInTheDocument());
    await waitFor(() => expect(queryGroup('モード')).not.toBeInTheDocument());
    expect(group('権限モード')).toBeInTheDocument();
  });

  it('opencode の依頼は agent、mode、model、autoApprove を持ち、アカウントと権限モードは空、effort は無い', async () => {
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    fireEvent.click(advanced());
    await waitFor(() => expect(within(group('モード')).getAllByRole('radio')).toHaveLength(3));
    pick('モード', 'plan');
    pick('モデル', /GLM-5.3-Flash Free/);
    pick('自動承認', 'オン（--auto）');
    expect(screen.getByText('deny 以外をすべて許可')).toBeInTheDocument();
    expect(advanced()).toHaveTextContent('モード plan · モデル GLM-5.3-Flash Free · 自動承認 オン');
    fireEvent.change(prompt(), { target: { value: '読んで' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    const spec = specOf(onLaunch);
    expect(spec.payload).toEqual({ projectId: 'p-a', scratch: false, accountId: '', permissionMode: '', model: 'opencode/glm-5.3-flash-free', prompt: '読んで', agent: 'opencode', mode: 'plan', autoApprove: true });
    expect(spec).toMatchObject({ accountId: '', accountName: null, accountColor: null });
  });

  it('opencode の既定（モードとモデルをデフォルト、自動承認オフ）では mode と autoApprove を依頼に入れない', async () => {
    const { onLaunch } = await setup();
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    expect(advanced()).toHaveTextContent('モード デフォルト · モデル デフォルト · 自動承認 オフ');
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    const p = specOf(onLaunch).payload;
    expect(p).toMatchObject({ agent: 'opencode', model: '', accountId: '', permissionMode: '' });
    expect(p).not.toHaveProperty('mode');
    expect(p).not.toHaveProperty('autoApprove');
    expect(p).not.toHaveProperty('effort');
  });

  it('アカウントの無い PC でも opencode なら始められる', async () => {
    const fs = feeds();
    fs[0] = { ...fs[0]!, accounts: [] };
    const { onLaunch } = await setup(askerOf(), fs);
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(onLaunch).toHaveBeenCalledTimes(1);
  });

  it('学習に使わないモデル（GLM と DeepSeek の無料など）には、PC の小窓と同じ「学習への利用なし」を添える', async () => {
    const models: MobileAgentOptions['models'] = [
      { id: 'opencode/glm-5.3-flash-free', label: 'GLM-5.3-Flash Free', group: 'OpenCode Zen', cost: 'free', data: 'no-training' },
      { id: 'opencode/deepseek-v4-flash-free', label: 'DeepSeek V4 Flash Free', group: 'OpenCode Zen', cost: 'free', data: 'no-training' },
    ];
    await setup(askerOf({ options: async () => ({ ...OPTIONS, models }) }));
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    fireEvent.click(advanced());
    await waitFor(() => expect(within(group('モデル')).getAllByRole('radio')).toHaveLength(3));
    const radios = within(group('モデル')).getAllByRole('radio');
    expect(radios[1]).toHaveTextContent('OpenCode Zen · 無料 · 学習への利用なし');
    expect(radios[2]).toHaveTextContent('OpenCode Zen · 無料 · 学習への利用なし');
  });

  it('PC の一覧が古ければ「PC の一覧（更新が古い可能性があります）」を添える', async () => {
    await setup(askerOf({ options: async () => ({ ...OPTIONS, stale: true }) }));
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    fireEvent.click(advanced());
    expect(await screen.findByText('PC の一覧（更新が古い可能性があります）')).toBeInTheDocument();
  });

  it('PC が一覧を持っていない、または問い合わせが通らなければ「モデルの一覧を取得できません。デフォルトで起動します。」', async () => {
    await setup(askerOf({ options: async () => null }));
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    fireEvent.click(advanced());
    expect(await screen.findByText('モデルの一覧を取得できません。デフォルトで起動します。')).toBeInTheDocument();
    expect(within(group('モデル')).getAllByRole('radio').map((r) => r.textContent)).toEqual(['デフォルト']);
  });

  it('問い合わせが失敗しても、取得できない旨を出してデフォルトで始められる', async () => {
    const { onLaunch } = await setup(askerOf({ options: async () => { throw new AskError('pc-timeout'); } }));
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    fireEvent.click(advanced());
    expect(await screen.findByText('モデルの一覧を取得できません。デフォルトで起動します。')).toBeInTheDocument();
    fireEvent.change(prompt(), { target: { value: 'a' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mac で始める' }));
    expect(specOf(onLaunch).payload).toMatchObject({ agent: 'opencode', model: '' });
  });

  it('opencode の / は、アカウントなしで opencode のコマンドとスキルを問い合わせる', async () => {
    const { asker } = await setup();
    pick('プロジェクト', /project-a/);
    pick('エージェント', /opencode/);
    act(() => prompt().focus());
    fireEvent.change(prompt(), { target: { value: '/', selectionStart: 1, selectionEnd: 1 } });
    await waitFor(() => expect(screen.getByRole('button', { name: /\/init/ })).toBeInTheDocument());
    expect(asker.commands).toHaveBeenCalledWith('pc-1', 'p-a', '', 'opencode');
    expect(screen.getByText('Mac · opencode のコマンドとスキル')).toBeInTheDocument();
  });

  it('設定の既定が opencode なら、opencode のある PC で最初から opencode を選んでおく', async () => {
    saveLaunchDefaults({ ...EMPTY_DEFAULTS, agent: 'opencode' });
    await setup();
    pick('プロジェクト', /project-a/);
    expect(within(group('エージェント')).getByRole('radio', { name: /opencode/ })).toHaveAttribute('aria-checked', 'true');
    expect(queryGroup('アカウント')).not.toBeInTheDocument();
  });
});
