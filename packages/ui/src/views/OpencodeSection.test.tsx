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
  });
});
