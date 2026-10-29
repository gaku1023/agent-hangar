import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { UiAction } from '@agent-hangar/shared';
import { ActionRoot } from '../action/chain.tsx';
import type { CodexSettingsProps } from '../presenters/settings.ts';
import { CodexSection } from './CodexSection.tsx';
import { shareOff } from '../test/share.ts';

const props = (over: Partial<CodexSettingsProps> = {}): CodexSettingsProps => ({
  enabled: false, injection: 'minimal', share: shareOff('codex'),
  injectionOptions: [{ value: 'minimal', label: '最小限（意図・要約・状態）' }, { value: 'claude', label: 'Claude Code と同じ' }, { value: 'none', label: '追記しない' }],
  intercept: { available: true, on: false, note: null },
  version: { kind: 'verified', installed: '0.164.2', verified: '0.164.x', note: null, login: null },
  badge: { text: '検証済み', tone: 'ok' },
  ...over,
});
const ui = (o: CodexSettingsProps, onAction: (a: UiAction) => void = () => {}) => <ActionRoot onAction={onAction}><CodexSection o={o} /></ActionRoot>;
const section = () => screen.getByRole('region', { name: 'Codex' });

describe('設定の Codex の面', () => {
  it('見つからないときだけ、見出しの右に「エージェントで調査…」を置き、版の行の文を入れて開く', () => {
    const onAction = vi.fn();
    const note = 'codex が見つかりません（PATH を確認してください）。';
    const { unmount } = render(ui(props({ enabled: true, version: { kind: 'missing', installed: null, verified: '0.164.x', note, login: null }, badge: { text: '見つかりません', tone: 'warn' } }), onAction));
    fireEvent.click(within(section().querySelector('h3')!).getByRole('button', { name: 'エージェントで調査…' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'investigate.open', op: 'agentVersion', agent: 'codex', message: note });
    unmount();
    render(ui(props({ enabled: true, version: { kind: 'unknown', installed: null, verified: '0.164.x', note: 'x', login: null } })));
    expect(within(section()).queryByRole('button', { name: 'エージェントで調査…' })).toBeNull();
  });
  it('見出しは「Codex」と「ベータ」の小札', () => {
    render(ui(props()));
    const h = within(section()).getByRole('heading');
    expect(h).toHaveTextContent('Codex');
    expect(h.querySelector('.tag-beta')).toHaveTextContent('ベータ');
  });
  it('切のときは「有効にする」の 1 行だけが見える', () => {
    render(ui(props()));
    expect(screen.getByRole('switch', { name: 'Codex を有効にする' })).toHaveAttribute('aria-checked', 'false');
    for (const t of ['バージョン', 'codex コマンドを hangar 経由で起動', 'システムプロンプトへの追記']) expect(screen.queryByText(t)).toBeNull();
    expect(section().querySelector('.badge')).toBeNull();
  });
  it('入のときは版（インストール済み＋検証済みの範囲）、横取り、追記の行と札を出す', () => {
    render(ui(props({ enabled: true })));
    expect(screen.getByText('バージョン')).toBeInTheDocument();
    expect(section()).toHaveTextContent('インストール済み 0.164.2 · 検証済み 0.164.x');
    expect(screen.getByRole('switch', { name: 'codex コマンドを hangar 経由で起動' })).toBeInTheDocument();
    expect(screen.getByText('システムプロンプトへの追記')).toBeInTheDocument();
    expect(section().querySelector('.badge')).toHaveTextContent('検証済み');
  });
  it('ログインしていないときだけ、版の行の下に注記を出す', () => {
    const { rerender } = render(ui(props({ enabled: true })));
    expect(screen.queryByText(/codex login/)).toBeNull();
    rerender(ui(props({ enabled: true, version: { kind: 'verified', installed: '0.164.2', verified: '0.164.x', note: null, login: 'codex にログインしていません（ターミナルで codex login を実行してください）。' } })));
    expect(screen.getByText(/codex login/)).toBeInTheDocument();
  });
  it('Windows ではコマンドの横取りの行を出さない', () => {
    render(ui(props({ enabled: true, intercept: { available: false, on: false, note: null } })));
    expect(screen.queryByRole('switch', { name: 'codex コマンドを hangar 経由で起動' })).toBeNull();
  });
  it('スイッチと追記の 3 択は、選んだ時点で設定を保存するだけ', () => {
    const seen: UiAction[] = [];
    render(ui(props({ enabled: true }), (a) => seen.push(a)));
    fireEvent.click(screen.getByRole('switch', { name: 'Codex を有効にする' }));
    fireEvent.click(screen.getByRole('switch', { name: 'codex コマンドを hangar 経由で起動' }));
    expect(seen).toEqual([
      { type: 'settings.update', patch: { codexEnabled: false } },
      { type: 'settings.update', patch: { codexIntercept: true } },
    ]);
  });
  it('Claude Code の指示と MCP を渡す 2 行を、追記の行の後ろに出す。入れたときは保存と一覧の取り直しを頼む', () => {
    const seen: UiAction[] = [];
    const base = shareOff('codex');
    render(ui(props({ enabled: true, share: { ...base, instructions: { ...base.instructions, on: true } } }), (a) => seen.push(a)));
    const rows =[...section().querySelectorAll('.set-row-t')].map((e) => e.textContent);
    expect(rows.slice(-2)).toEqual(['Claude Code の指示を渡す', 'Claude Code の MCP を渡す']);
    expect(rows.indexOf('システムプロンプトへの追記')).toBeLessThan(rows.indexOf('Claude Code の指示を渡す'));
    fireEvent.click(screen.getByRole('switch', { name: 'Claude Code の MCP を渡す' }));
    expect(seen).toEqual([{ type: 'settings.update', patch: { codexShareMcp: true } }, { type: 'share.preview', agent: 'codex' }]);
    fireEvent.click(screen.getByRole('switch', { name: 'Claude Code の指示を渡す' }));
    expect(seen.slice(2)).toEqual([{ type: 'settings.update', patch: { codexShareInstructions: false } }]);
  });
  it('入のときだけ一覧の箱を出し、切ると畳む（動かない環境ではすぐ外す）', () => {
    const on = { on: true, desc: 'd', list: { empty: null, files: [{ path: '~/.claude/CLAUDE.md' }], mcp: [], skipped: [], notes: ['注記'] } };
    const base = shareOff('codex');
    const { rerender } = render(ui(props({ enabled: true, share: { ...base, instructions: on } })));
    expect(section()).toHaveTextContent('渡すファイル');
    expect(section()).toHaveTextContent('~/.claude/CLAUDE.md');
    expect(section()).toHaveTextContent('注記');
    rerender(ui(props({ enabled: true, share: base })));
    expect(section()).not.toHaveTextContent('渡すファイル');
  });
});
