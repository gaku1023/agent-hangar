import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { OpencodeSettingsProps } from '../presenters/settings.ts';
import { OpencodeSection } from './OpencodeSection.tsx';
import { LanguageRoot } from './primitives/language.tsx';

const OPTIONS: OpencodeSettingsProps['injectionOptions'] = [
  { value: 'minimal', label: '最小限（意図と要約）' },
  { value: 'claude', label: 'Claude Code と同じ' },
  { value: 'none', label: '追記しない' },
];
const props = (over: Partial<OpencodeSettingsProps> = {}): OpencodeSettingsProps => ({
  available: true, enabled: false, injection: 'minimal', injectionOptions: OPTIONS, claudeNote: null,
  full: [{ label: '最小限（意図と要約）', off: false, mark: null, pieces: [{ kind: 'text', text: 'あなたは agent-hangar から起動されたセッションです。' }] }],
  intercept: { available: true, on: false, note: null },
  permissionPreset: { on: true, byConfig: false, note: null },
  version: { kind: 'verified', installed: '2.1.4', verified: '2.1.x', note: null },
  badge: { text: '検証済み', tone: 'ok' },
  ...over,
});
const ui = (o: OpencodeSettingsProps, onAction: (a: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}><OpencodeSection o={o} /></ActionRoot>;
const section = () => screen.getByRole('region', { name: 'opencode' });

describe('設定の opencode の面', () => {
  it('見出しは「opencode」と「ベータ」の小札', () => {
    render(ui(props()));
    const h = within(section()).getByRole('heading');
    expect(h).toHaveTextContent('opencode');
    expect(h.querySelector('.tag-beta')).toHaveTextContent('ベータ');
  });

  it('切のときは有効にする行だけで、バージョンと追記の行と右端の札が無い', () => {
    render(ui(props()));
    expect(screen.getByRole('switch', { name: 'opencode を有効にする' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('バージョン')).toBeNull();
    expect(screen.queryByText('システムプロンプトへの追記')).toBeNull();
    expect(section().querySelector('.badge')).toBeNull();
  });

  it('入のときはバージョンと追記の行と「検証済み」の札を出す', () => {
    render(ui(props({ enabled: true })));
    expect(screen.getByRole('switch', { name: 'opencode を有効にする' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('バージョン')).toBeInTheDocument();
    expect(section().querySelector('.oc-vers')).toHaveTextContent('インストール済み 2.1.4 · 検証済み 2.1.x');
    expect(screen.getByText('システムプロンプトへの追記')).toBeInTheDocument();
    expect(section().querySelector('.badge')).toHaveTextContent('検証済み');
  });

  it('切り替えると opencodeEnabled を保存する', () => {
    const onAction = vi.fn();
    render(ui(props(), onAction));
    fireEvent.click(screen.getByRole('switch', { name: 'opencode を有効にする' }));
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings.update', patch: { opencodeEnabled: true } }));
  });

  it('切にすると下の行を外す', () => {
    const { rerender } = render(ui(props({ enabled: true })));
    expect(screen.getByText('バージョン')).toBeInTheDocument();
    rerender(ui(props({ enabled: false })));
    expect(screen.queryByText('バージョン')).toBeNull();
    expect(screen.queryByText('システムプロンプトへの追記')).toBeNull();
  });

  it('未検証の版は版の並びの下に注意を添える', () => {
    render(ui(props({ enabled: true, version: { kind: 'unverified', installed: '2.2.0', verified: '2.1.x', note: '未検証のバージョンです。API の変更により、状態や権限確認が正しく表示されない可能性があります。' }, badge: { text: '未検証のバージョン', tone: 'info' } })));
    expect(section().querySelector('.oc-vers')).toHaveTextContent('インストール済み 2.2.0 · 検証済み 2.1.x');
    expect(screen.getByText('未検証のバージョンです。API の変更により、状態や権限確認が正しく表示されない可能性があります。')).toBeInTheDocument();
    expect(section().querySelector('.badge')).toHaveAttribute('data-tone', 'info');
  });

  it('見つからないときは版の並びを出さず、PATH を確かめる文を出す', () => {
    render(ui(props({ enabled: true, version: { kind: 'missing', installed: null, verified: '2.1.x', note: 'opencode が見つかりません（PATH を確認してください）。' }, badge: { text: '見つかりません', tone: 'warn' } })));
    expect(section().querySelector('.oc-vers')).toBeNull();
    expect(screen.getByText('opencode が見つかりません（PATH を確認してください）。')).toBeInTheDocument();
  });

  it('答えが届く前は「読み込み中…」を出す', () => {
    render(ui(props({ enabled: true, version: null, badge: null })));
    expect(within(section()).getByText('読み込み中…')).toBeInTheDocument();
  });

  it('「Claude Code と同じ」の注記は、渡されたときだけ出す', () => {
    const { rerender } = render(ui(props({ enabled: true, injection: 'claude', claudeNote: 'モデルによっては、状態の提案を確認せずに確定させることがあります。' })));
    expect(screen.getByText('モデルによっては、状態の提案を確認せずに確定させることがあります。')).toBeInTheDocument();
    rerender(ui(props({ enabled: true })));
    expect(screen.queryByText('モデルによっては、状態の提案を確認せずに確定させることがあります。')).toBeNull();
  });

  it('入のときは、バージョンと追記の間にコマンドの横取りの行を出し、切り替えると opencodeIntercept を保存する', () => {
    const onAction = vi.fn();
    render(ui(props({ enabled: true }), onAction));
    const sw = screen.getByRole('switch', { name: 'opencode コマンドを hangar 経由で起動' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    const titles = [...section().querySelectorAll('.oc-more .set-row-t')].map((e) => e.textContent);
    const order = ['バージョン', 'opencode コマンドを hangar 経由で起動', 'システムプロンプトへの追記'].map((x) => titles.findIndex((tt) => tt?.includes(x)));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    fireEvent.click(sw);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings.update', patch: { opencodeIntercept: true } }));
  });

  it('横取りの行は、切のときと、出さない OS（intercept.available が偽）では出さない。入れ方の注記は渡されたときだけ出す', () => {
    const { rerender } = render(ui(props()));
    expect(screen.queryByRole('switch', { name: 'opencode コマンドを hangar 経由で起動' })).toBeNull();
    rerender(ui(props({ enabled: true, intercept: { available: false, on: false, note: null } })));
    expect(screen.queryByRole('switch', { name: 'opencode コマンドを hangar 経由で起動' })).toBeNull();
    rerender(ui(props({ enabled: true, intercept: { available: true, on: true, note: 'この PC にシェル連携をインストールすると使えます。' } })));
    expect(screen.getByRole('switch', { name: 'opencode コマンドを hangar 経由で起動' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('この PC にシェル連携をインストールすると使えます。')).toBeInTheDocument();
  });

  it('コマンドの実行前の確認の行は、入のときだけ出し、押すと opencodePermissionPreset を保存する。利用者の設定が決めているときは無効にして注記を出す', () => {
    const onAction = vi.fn();
    const { rerender } = render(ui(props(), onAction));
    expect(screen.queryByRole('switch', { name: 'コマンド実行前に確認' })).toBeNull();
    rerender(ui(props({ enabled: true }), onAction));
    const sw = screen.getByRole('switch', { name: 'コマンド実行前に確認' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'settings.update', patch: { opencodePermissionPreset: false } }));
    rerender(ui(props({ enabled: true, permissionPreset: { on: false, byConfig: true, note: 'opencode.json の permission 設定が適用されています。' } }), onAction));
    expect(screen.getByRole('switch', { name: 'コマンド実行前に確認' })).toBeDisabled();
    expect(screen.getByText('opencode.json の permission 設定が適用されています。')).toBeInTheDocument();
  });

  it('Windows（available が偽）では面ごと出さない', () => {
    const { container } = render(ui(props({ available: false, enabled: true })));
    expect(container).toBeEmptyDOMElement();
  });

  it('英語の文面', () => {
    render(<LanguageRoot language="en">{ui(props({ enabled: true }))}</LanguageRoot>);
    expect(section().querySelector('.tag-beta')).toHaveTextContent('Beta');
    expect(screen.getByRole('switch', { name: 'Enable opencode' })).toBeInTheDocument();
    expect(screen.getByText('Version')).toBeInTheDocument();
    expect(section().querySelector('.oc-vers')).toHaveTextContent('Installed 2.1.4 · Verified 2.1.x');
    expect(screen.getByText('System prompt additions')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Launch the opencode command through hangar' })).toBeInTheDocument();
  });

  it('追記の行の下に、選んでいる量で送る全文を Claude と同じ畳みで出す', () => {
    render(ui(props({ enabled: true })));
    const fold = section().querySelector('details.cp-more');
    expect(fold).not.toBeNull();
    expect(fold!.querySelector('summary')).toHaveTextContent('追加する指示の全文を表示');
    expect(fold!.querySelector('.inject-part-k')).toHaveTextContent('最小限（意図と要約）');
    expect(fold).toHaveTextContent('あなたは agent-hangar から起動されたセッションです。');
  });

  it('切った段は打ち消しの印で残す', () => {
    render(ui(props({ enabled: true, injection: 'claude', full: [{ label: 'ターンの意図', off: true, mark: null, pieces: [{ kind: 'text', text: '意図の段' }] }] })));
    expect(screen.getByText('意図の段').parentElement).toHaveClass('inject-off');
  });

  it('追記しないときは全文の畳みを出さない', () => {
    render(ui(props({ enabled: true, injection: 'none', full: [] })));
    expect(section().querySelector('details.cp-more')).toBeNull();
  });
});
