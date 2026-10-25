import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { OpencodeProvidersProps } from '../presenters/opencodeProviders.ts';
import { OpencodeProviders } from './OpencodeProviders.tsx';

const props = (over: Partial<OpencodeProvidersProps> = {}): OpencodeProvidersProps => ({
  status: 'ready', failure: null, total: 3, configPath: '~/.config/opencode/opencode.json', custom: { busy: false, error: null }, login: null, back: false,
  rows: [
    { id: 'lmstudio', name: 'LM Studio', desc: 'ローカル · 自動で取得', url: '127.0.0.1:1234/v1', canChangeKey: false, canDisconnect: false, busy: null, error: null, fresh: false },
    { id: 'deepseek', name: 'DeepSeek', desc: '従量 · 接続済み', url: null, canChangeKey: true, canDisconnect: true, busy: null, error: null, fresh: false },
  ],
  catalog: [
    { id: 'opencode-go', name: 'OpenCode Go', side: '定額 · 月 $10', recommended: true, key: true, login: null, busy: false, error: null },
    { id: 'github-copilot', name: 'GitHub Copilot', side: '定額 · 要ログイン', recommended: true, key: false, login: { id: 'device', label: 'Login with GitHub Copilot' }, busy: false, error: null },
    { id: 'groq', name: 'Groq', side: '従量・無料枠あり', recommended: false, key: true, login: null, busy: false, error: null },
  ],
  ...over,
});
const ui = (p: OpencodeProvidersProps, onAction: (a: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}><OpencodeProviders p={p} /></ActionRoot>;
const typesOf = (f: ReturnType<typeof vi.fn>) => f.mock.calls.map((c) => (c[0] as UiAction).type);

afterEach(() => { vi.useRealTimers(); });

describe('設定のプロバイダー', () => {
  it('出たときに一覧を読み、見出しに API キーの注記を出す。行ごとに操作を出し分ける', () => {
    const on = vi.fn();
    render(ui(props(), on));
    expect(typesOf(on)).toEqual(['opencode.providers.load']);
    expect(screen.getByText('プロバイダー')).toBeInTheDocument();
    expect(screen.getByText('API キーは opencode が保存します（hangar には残りません）')).toBeInTheDocument();
    const lm = document.querySelector('[data-provider="lmstudio"]') as HTMLElement;
    expect(within(lm).getByText('127.0.0.1:1234/v1').tagName).toBe('CODE');
    expect(within(lm).queryByText('API キーを変更')).toBeNull();
    expect(within(lm).queryByText('接続を解除')).toBeNull();
    const ds = document.querySelector('[data-provider="deepseek"]') as HTMLElement;
    fireEvent.click(within(ds).getByText('接続を解除'));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.disconnect', id: 'deepseek' });
  });

  it('API キーを変更：欄は伏せ字で、送ると key の操作に API キーを載せる。モデル ID の欄も同じ形', () => {
    const on = vi.fn();
    render(ui(props(), on));
    const ds = document.querySelector('[data-provider="deepseek"]') as HTMLElement;
    fireEvent.click(within(ds).getByText('API キーを変更'));
    const input = within(ds).getByPlaceholderText('DeepSeek の API キー');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'sk-x' } });
    fireEvent.click(within(ds).getByRole('button', { name: '接続' }));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.key', id: 'deepseek', key: 'sk-x' });
    fireEvent.click(within(ds).getByText('モデル ID を追加'));
    const m = within(ds).getByPlaceholderText('例：qwen3.9-coder-48b');
    fireEvent.change(m, { target: { value: 'deepseek-v5' } });
    fireEvent.click(within(ds).getByRole('button', { name: '追加' }));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.model', id: 'deepseek', model: 'deepseek-v5' });
  });

  it('「＋ プロバイダーを追加」：おすすめを先に、その他を後に出し、検索で絞る。API キーで接続するか、ログインを始める', () => {
    const on = vi.fn();
    render(ui(props(), on));
    fireEvent.click(screen.getByText(/プロバイダーを追加/));
    const search = screen.getByPlaceholderText('プロバイダーを検索（3 社）');
    const heads = [...document.querySelectorAll('.ocp-pick-h')].map((h) => h.textContent);
    expect(heads).toEqual(['おすすめ', 'その他のプロバイダー']);
    expect(screen.getByText('定額 · 月 $10')).toBeInTheDocument();
    fireEvent.click(screen.getByText('OpenCode Go'));
    fireEvent.change(screen.getByPlaceholderText('OpenCode Go の API キー'), { target: { value: 'go-key' } });
    fireEvent.click(screen.getByRole('button', { name: '接続' }));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.key', id: 'opencode-go', key: 'go-key' });
    fireEvent.click(screen.getByText('GitHub Copilot'));
    fireEvent.click(screen.getByRole('button', { name: 'ブラウザでログイン' }));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.login', id: 'github-copilot', method: 'device' });
    fireEvent.change(search, { target: { value: 'gro' } });
    expect(screen.queryByText('OpenCode Go')).toBeNull();
    expect(screen.getByText('Groq')).toBeInTheDocument();
  });

  it('OpenAI 互換のサーバー：名前・URL・API キー（任意）を送る。保存先と /v1/models を添える', () => {
    const on = vi.fn();
    render(ui(props(), on));
    fireEvent.click(screen.getByText(/プロバイダーを追加/));
    fireEvent.click(screen.getByText('OpenAI 互換のサーバー'));
    expect(screen.getByText('保存時に ~/.config/opencode/opencode.json を更新します（既存の設定はバックアップ）。モデル一覧は /v1/models から取得します。')).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: 'モデルを取得して接続' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('名前'), { target: { value: '自宅の GPU' } });
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'http://192.168.3.40:8000/v1' } });
    fireEvent.click(submit);
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.custom', name: '自宅の GPU', url: 'http://192.168.3.40:8000/v1' });
    expect(screen.getByLabelText('API キー（任意）')).toHaveAttribute('placeholder', '無ければ空欄');
  });

  it('ログインの途中は、ブラウザで開くリンクと案内を出し、数秒おきに進みを聞く', () => {
    vi.useFakeTimers();
    const on = vi.fn();
    render(ui(props({ login: { id: 'github-copilot', name: 'GitHub Copilot', url: 'https://github.com/login/device', instructions: 'Enter code: AB-12', mode: 'auto', state: 'pending', note: 'ログインを待っています…', busy: false, error: null } }), on));
    fireEvent.click(screen.getByText(/プロバイダーを追加/));
    fireEvent.click(screen.getByText('GitHub Copilot'));
    expect(screen.getByRole('link', { name: 'ブラウザで開く' })).toHaveAttribute('href', 'https://github.com/login/device');
    expect(screen.getByText('Enter code: AB-12')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(4100); });
    expect(typesOf(on).filter((x) => x === 'opencode.providers.login.poll')).toHaveLength(2);
  });

  it('モデルの小窓から来たときだけ「‹ 新しいセッションに戻る」を出す。失敗したら理由と再読み込み', () => {
    const on = vi.fn();
    const { rerender } = render(ui(props({ back: true }), on));
    fireEvent.click(screen.getByText('‹ 新しいセッションに戻る'));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.back' });
    rerender(ui(props({ status: 'failed', failure: 'serve did not answer', rows: [], catalog: [] }), on));
    expect(screen.queryByText('‹ 新しいセッションに戻る')).toBeNull();
    expect(screen.getByText('opencode からプロバイダーの一覧を取得できませんでした。')).toBeInTheDocument();
    fireEvent.click(screen.getByText('再読み込み'));
    expect(on).toHaveBeenLastCalledWith({ type: 'opencode.providers.load' });
    expect(screen.queryByText(/プロバイダーを追加/)).toBeNull();
  });
});
