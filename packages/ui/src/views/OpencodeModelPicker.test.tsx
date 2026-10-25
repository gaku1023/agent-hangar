import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { OpencodeModelOption, OpencodeProviderOption } from '@agent-hangar/shared';
import { OpencodeModelPicker, type OpencodeModelPickerProps } from './OpencodeModelPicker.tsx';

const m = (id: string, label: string, over: Partial<OpencodeModelOption> = {}): OpencodeModelOption => {
  const provider = id.split('/')[0]!;
  return { id, label, group: provider, provider, tools: true, context: 200_000, cost: null, ...over };
};
const PROVIDERS: OpencodeProviderOption[] = [
  { id: 'lmstudio', name: 'LM Studio (local)', where: 'device' },
  { id: 'opencode', name: 'OpenCode', where: 'remote' },
];
const MODELS = [
  m('lmstudio/qwen3.6-35b-a3b', 'Qwen3.6 35B A3B'),
  m('lmstudio/laguna-xs', 'Laguna XS', { tools: false }),
  m('opencode/big-pickle', 'Big Pickle', { cost: { input: 0, output: 0 } }),
  m('opencode/glm-5.3-flash-free', 'GLM-5.3 Flash Free', { cost: { input: 0, output: 0 } }),
];

function mount(over: Partial<OpencodeModelPickerProps> = {}) {
  const props: OpencodeModelPickerProps = {
    label: 'モデル', value: '', models: MODELS, providers: PROVIDERS, defaultModel: 'lmstudio/qwen3.6-35b-a3b', pricesAt: null, fetchedAt: new Date(2026, 9, 25).getTime(),
    reset: false, reloading: false, onChange: vi.fn(), onReload: vi.fn(), onManage: vi.fn(), ...over,
  };
  const view = render(<div><OpencodeModelPicker {...props} /></div>);
  const open = () => fireEvent.click(screen.getByRole('button', { name: 'モデル' }));
  return { props, view, open };
}
const list = () => screen.getByRole('listbox', { name: 'モデル' });

describe('OpencodeModelPicker（モデルの小窓）', () => {
  it('札は名前を「モデル」で読ませ、値（選んだモデルの名前かデフォルト）を見せる', () => {
    mount({ value: 'opencode/big-pickle' });
    expect(screen.getByRole('button', { name: 'モデル' })).toHaveTextContent('Big Pickle');
    mount({ reset: true });
    expect(screen.getAllByRole('button', { name: 'モデル' })[1]).toHaveAttribute('data-reset', 'true');
  });

  it('開くと、検索、デフォルトの行、プロバイダーごとのまとまり、管理への行、料金の出どころを出す', () => {
    const { open } = mount();
    open();
    const dialog = screen.getByRole('dialog', { name: 'モデル' });
    expect(within(dialog).getByPlaceholderText('モデル名で絞り込み（例：qwen、glm）')).toHaveFocus();
    expect(within(dialog).getAllByRole('button', { expanded: true }).map((b) => b.getAttribute('aria-label'))).toEqual(['LM Studio（2）', 'OpenCode Zen（2）']);
    expect(within(dialog).getByText('起動中 · 自動で取得')).toBeInTheDocument();
    expect(within(dialog).getByText('API キー不要 · 期間限定')).toBeInTheDocument();
    expect(within(list()).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['デフォルト', 'Qwen3.6 35B A3B', 'Laguna XS', 'Big Pickle', 'GLM-5.3 Flash Free']);
    expect(within(dialog).getByRole('button', { name: 'プロバイダーを管理…' })).toBeInTheDocument();
    expect(within(dialog).getByText('料金は models.dev と各社の公開情報（10/25 取得）。')).toBeInTheDocument();
    expect(within(dialog).getByText('⚠ 学習利用の可能性あり')).toHaveAttribute('data-tone', 'warn');
  });

  it('行を押すと選んで閉じる。デフォルトの行は空を渡す', () => {
    const { open, props } = mount({ value: 'opencode/big-pickle' });
    open();
    fireEvent.click(within(list()).getByRole('option', { name: 'GLM-5.3 Flash Free' }));
    expect(props.onChange).toHaveBeenLastCalledWith('opencode/glm-5.3-flash-free');
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    fireEvent.click(within(list()).getByRole('option', { name: 'デフォルト' }));
    expect(props.onChange).toHaveBeenLastCalledWith('');
  });

  it('ツール呼び出しに対応しない行は薄く、押しても選べず、理由を添える', () => {
    const { open, props } = mount();
    open();
    const off = within(list()).getByRole('option', { name: 'Laguna XS' });
    expect(off).toHaveAttribute('aria-disabled', 'true');
    expect(off).toHaveAttribute('title', 'ツール呼び出しに対応していないため、エージェントでは使えません');
    expect(off).toHaveTextContent('ツール非対応');
    fireEvent.click(off);
    expect(props.onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('矢印キーは選べる行だけを辿り、Enter で選ぶ。Enter は外（起動のダイアログ）へ伝えない', () => {
    const outer = vi.fn();
    const onChange = vi.fn();
    render(<div onKeyDown={(e) => outer(e.key)}><OpencodeModelPicker label="モデル" value="" models={MODELS} providers={PROVIDERS} defaultModel={null} pricesAt={null} fetchedAt={0} reset={false} reloading={false} onChange={onChange} onReload={vi.fn()} onManage={vi.fn()} /></div>);
    fireEvent.click(screen.getByRole('button', { name: 'モデル' }));
    const search = screen.getByRole('combobox');
    const active = () => document.getElementById(search.getAttribute('aria-activedescendant') ?? '')?.getAttribute('aria-label');
    expect(active()).toBe('デフォルト');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe('Qwen3.6 35B A3B');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(active()).toBe('Big Pickle');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(active()).toBe('デフォルト');
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    expect(active()).toBe('GLM-5.3 Flash Free');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('opencode/glm-5.3-flash-free');
    expect(outer).not.toHaveBeenCalledWith('Enter');
  });

  it('まとまりは見出しで畳め、畳んだまとまりの行は出さず、矢印でも辿らない。開き直すと戻る', async () => {
    const { open } = mount();
    open();
    const head = screen.getByRole('button', { name: 'LM Studio（2）' });
    await act(async () => { fireEvent.click(head); });
    expect(head).toHaveAttribute('aria-expanded', 'false');
    expect(within(list()).queryByRole('option', { name: 'Qwen3.6 35B A3B' })).toBeNull();
    const search = screen.getByRole('combobox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(document.getElementById(search.getAttribute('aria-activedescendant') ?? '')?.getAttribute('aria-label')).toBe('Big Pickle');
    await act(async () => { fireEvent.click(head); });
    expect(within(list()).getByRole('option', { name: 'Qwen3.6 35B A3B' })).toBeInTheDocument();
  });

  it('畳んだまとまりは、閉じて開き直しても畳んだまま', async () => {
    const { open } = mount();
    open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'OpenCode Zen（2）' })); });
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    open();
    expect(screen.getByRole('button', { name: 'OpenCode Zen（2）' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('絞り込む間は、畳んだまとまりも開いて合う行を見せる。消すと畳んだ形に戻る', async () => {
    const { open } = mount();
    open();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'LM Studio（2）' })); });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'qwen' } });
    expect(within(list()).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['Qwen3.6 35B A3B']);
    expect(screen.getByRole('button', { name: 'LM Studio（1）' })).toHaveAttribute('aria-expanded', 'true');
    await act(async () => { fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } }); });
    expect(screen.getByRole('button', { name: 'LM Studio（2）' })).toHaveAttribute('aria-expanded', 'false');
  });
  it('絞り込むと合う行だけを残し、合わなければそう言う', () => {
    const { open } = mount();
    open();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'glm' } });
    expect(within(list()).getAllByRole('option').map((o) => o.getAttribute('aria-label'))).toEqual(['GLM-5.3 Flash Free']);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzz' } });
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
  });

  it('LM Studio のまとまりにだけ再読み込みを置き、押すと取り直しを頼む。取り直す間は「取得中…」', () => {
    const { open, props, view } = mount();
    open();
    expect(screen.getByText('LM Studio のモデルを自動で検出します')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '再読み込み' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
    expect(props.onReload).toHaveBeenCalledTimes(1);
    view.rerender(<div><OpencodeModelPicker {...props} reloading /></div>);
    expect(screen.getByRole('button', { name: '取得中…' })).toBeDisabled();
  });

  it('「プロバイダーを管理…」は小窓を閉じて設定へ移ることを頼む', () => {
    const { open, props } = mount();
    open();
    fireEvent.click(screen.getByRole('button', { name: 'プロバイダーを管理…' }));
    expect(props.onManage).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
