import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { OpencodeProvidersProps } from '../presenters/opencodeProviders.ts';
import { OpencodeProviders } from './OpencodeProviders.tsx';

const props = (over: Partial<OpencodeProvidersProps> = {}): OpencodeProvidersProps => ({
  status: 'ready', failure: null, total: 3, configPath: '~/.config/opencode/opencode.json', custom: { busy: false, error: null }, login: null, back: false,
  rows: [
    { id: 'lmstudio', name: 'LM Studio', desc: 'ローカル · 自動で取得', url: '127.0.0.1:1234/v1', canChangeKey: false, canDisconnect: false, busy: null, error: null, fresh: false, canPrep: false, prep: null },
    { id: 'deepseek', name: 'DeepSeek', desc: '従量 · 接続済み', url: null, canChangeKey: true, canDisconnect: true, busy: null, error: null, fresh: false, canPrep: false, prep: null },
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

describe('OpenAI 互換サーバーの行の「準備」', () => {
  const gpuRow = (prep: OpencodeProvidersProps['rows'][number]['prep']) => ({ id: 'my-gpu', name: 'my-gpu', desc: 'opencode.json', url: '127.0.0.1:18080/v1', canChangeKey: false, canDisconnect: true, busy: null, error: null, fresh: false, canPrep: true, prep });
  const mount = (prep: OpencodeProvidersProps['rows'][number]['prep'] = null) => {
    const actions: UiAction[] = [];
    const ui = (p: OpencodeProvidersProps['rows'][number]['prep']) => <ActionRoot onAction={(a) => { actions.push(a); }}><OpencodeProviders p={props({ rows: [gpuRow(p)] })} /></ActionRoot>;
    const view = render(ui(prep));
    return { actions, updates: () => actions.flatMap((a) => (a.type === 'settings.update' ? [a.patch] : [])), rerender: (p: OpencodeProvidersProps['rows'][number]['prep']) => view.rerender(ui(p)) };
  };

  it('OpenAI 互換サーバーの行だけに出し、開くと欄が伸びる', () => {
    render(<ActionRoot onAction={() => {}}><OpencodeProviders p={props()} /></ActionRoot>);
    expect(screen.queryByRole('button', { name: /準備/ })).toBeNull();
    cleanup();
    mount();
    expect(screen.queryByLabelText('始める前に')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /準備/ }));
    expect(screen.getByLabelText('始める前に')).toBeInTheDocument();
    // 止めるコマンドが空のうちは、止める時期を選べない。
    expect(screen.getByLabelText('停止のタイミング')).toBeDisabled();
  });

  it('保存でこの接続先の準備だけを送り、戻ってきたら保存中を下ろす。解除は null を送る', () => {
    const { updates, rerender } = mount();
    fireEvent.click(screen.getByRole('button', { name: /準備/ }));
    const save = screen.getByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('始める前に'), { target: { value: ' gpu up ' } });
    fireEvent.change(screen.getByLabelText('終わったあと'), { target: { value: 'gpu down' } });
    fireEvent.change(screen.getByLabelText('停止のタイミング'), { target: { value: '60' } });
    fireEvent.click(save);
    expect(updates()).toEqual([{ opencodeProviderPrep: { 'my-gpu': { start: 'gpu up', stop: 'gpu down', stopAfter: 60 } } }]);
    expect(screen.getByRole('button', { name: '保存中…' })).toBeInTheDocument();
    rerender({ start: 'gpu up', stop: 'gpu down', stopAfter: 60 });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '準備を解除' }));
    expect(updates().at(-1)).toEqual({ opencodeProviderPrep: { 'my-gpu': null } });
  });

  it('保存済みの準備を欄に入れて開く', () => {
    mount({ start: 'gpu up', stop: '', stopAfter: 15 });
    fireEvent.click(screen.getByRole('button', { name: /準備/ }));
    expect(screen.getByLabelText('始める前に')).toHaveValue('gpu up');
    expect(screen.getByLabelText('停止のタイミング')).toHaveValue('15');
  });
});
