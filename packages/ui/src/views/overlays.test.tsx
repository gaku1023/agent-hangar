import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionRoot } from '../action/chain.tsx';
import type { PaletteItem, PaletteSection } from '../presenters/palette.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { PromoteDialog, PromotedDialog } from './PromoteDialog.tsx';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';

// new URL(..., import.meta.url) は Vite が資産の URL に書き換えるので、パスを自分で組む。
const paletteCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'palette.css'), 'utf8');

const items: PaletteItem[] = [
  { id: 'cmd:new-session', label: '新しいセッション', kind: 'command', lead: { kind: 'icon', icon: 'add' }, sub: '', meta: '', keys: '⌘N' },
  { id: 'settings:cloud', label: 'クラウド同期', kind: 'command', lead: { kind: 'icon', icon: 'cloud' }, sub: '設定', meta: '', keys: '' },
  { id: 'session:s1', label: '動画の変換', kind: 'session', lead: { kind: 'dot', live: 'waiting', aside: false }, sub: 'alpha', meta: '4 分待っている', keys: '' },
];
const sections: PaletteSection[] = [
  { title: 'コマンド', count: 1, limit: null, items: [items[0]!] },
  { title: '設定', count: 4, limit: '上位 4', items: [items[1]!] },
  { title: '入力待ち', count: 1, limit: null, items: [items[2]!] },
];
const searchRow: PaletteItem = { id: 'search:動画', label: 'ホームで『動画』をトランスクリプトから検索', kind: 'search', lead: { kind: 'icon', icon: 'fulltext' }, sub: '', meta: '12 件', keys: '⌘↵' };

describe('CommandPalette', () => {
  it('入力を親へ返し、矢印と Enter で実行する', () => {
    const onAction = vi.fn();
    const onQuery = vi.fn();
    render(<ActionRoot onAction={onAction}><CommandPalette query="" sections={sections} noMatch={false} onQuery={onQuery} /></ActionRoot>);
    const input = screen.getByLabelText('移動・操作');
    expect(input.getAttribute('id')).toBe('palette-input');
    fireEvent.change(input, { target: { value: 'al' } });
    expect(onQuery).toHaveBeenCalledWith('al');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'settings:cloud', label: 'クラウド同期' } });
  });

  it('クリックでも実行し、Esc で閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.click(screen.getByText('動画の変換'));
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'session:s1', label: '動画の変換' } });
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.close' });
  });

  it('端で止まり、項目が無ければ何も起きない', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    const input = screen.getByLabelText('移動・操作');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'cmd:new-session', label: '新しいセッション' } });
    onAction.mockClear();
    rerender(<ActionRoot onAction={onAction}><CommandPalette query="zzz" sections={[]} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'Enter' });
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByText('一致する項目がありません')).toBeTruthy();
  });

  // palette.open は focus の効果を出さないので、入力欄へのフォーカスはパレット自身が当てる。
  it('開いた時点で入力欄にフォーカスが当たる', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    expect(document.activeElement).toBe(screen.getByLabelText('移動・操作'));
  });

  it('入力が変わると選択は先頭に戻る', () => {
    const onAction = vi.fn();
    const { rerender } = render(<ActionRoot onAction={onAction}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'ArrowDown' });
    rerender(<ActionRoot onAction={onAction}><CommandPalette query="a" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'cmd:new-session', label: '新しいセッション' } });
  });

  // 変換中の Enter は確定のための打鍵なので、実行に使わない。
  it('変換中の Enter では実行しない', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'Enter', isComposing: true });
    expect(onAction).not.toHaveBeenCalled();
  });

  // 器は読み上げに対してダイアログである。
  // 入力欄とは別の名前を付けて、どちらも名前で引けるようにする。
  it('器は名前を持つ modal なダイアログである', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: 'コマンドパレット' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('palette')).toBe(true);
    expect(dialog.contains(screen.getByLabelText('移動・操作'))).toBe(true);
  });

  it('外側を押すと閉じ、中身を押しても閉じない', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.click(container.querySelector('.dialog')!);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.close' });
  });

  it('群の見出しに件数と上限を添え、行には状態の点とプロジェクト名と右端の語を出す', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    const group = screen.getByRole('group', { name: '設定' });
    expect(group).toHaveTextContent('設定4上位 4');
    const waiting = screen.getByRole('option', { name: /動画の変換/ });
    expect(waiting.querySelector('.dot')).toHaveAttribute('data-status', 'waiting');
    expect(waiting).toHaveTextContent('alpha');
    expect(waiting).toHaveTextContent('4 分待っている');
    // 設定の節の行は、絵と「設定」の添え書きを持つ。
    expect(screen.getByRole('option', { name: /クラウド同期/ }).querySelector('svg')).toHaveAttribute('data-icon', 'cloud');
    expect(screen.getByRole('option', { name: /クラウド同期/ })).toHaveTextContent('設定');
    expect(screen.getByRole('option', { name: /新しいセッション/ }).querySelector('svg')).toHaveAttribute('data-icon', 'add');
    expect(screen.getByRole('option', { name: /新しいセッション/ })).toHaveTextContent('⌘N');
  });

  it('打った語に一致する名前の部分を印で囲む', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="変換" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    expect(screen.getByRole('option', { name: /動画の変換/ }).querySelector('mark')).toHaveTextContent('変換');
  });

  it('⌘↵ はどの行を選んでいても、ホームへ渡す行を実行する', () => {
    const onAction = vi.fn();
    const withSearch = [...sections, { title: 'ホーム', count: null, limit: null, items: [searchRow] }];
    render(<ActionRoot onAction={onAction}><CommandPalette query="動画" sections={withSearch} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.keyDown(screen.getByLabelText('移動・操作'), { key: 'Enter', metaKey: true });
    expect(onAction).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'search:動画', label: 'ホームで『動画』をトランスクリプトから検索' } });
    expect(screen.getByRole('option', { name: /トランスクリプトから検索/ })).toHaveTextContent('12 件');
  });

  it('名前に一致しないときはそう知らせ、ホームへ渡す行だけを出す', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="zzz" sections={[{ title: 'ホーム', count: null, limit: null, items: [searchRow] }]} noMatch onQuery={() => {}} /></ActionRoot>);
    expect(screen.getByText('名前にも操作にも一致しません。')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('下に打鍵の案内を出し、トランスクリプトはホームの欄で探すと添える', () => {
    const { container } = render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    expect(container.querySelector('.palette-foot')).toHaveTextContent('↑↓ 選ぶ↵ 開くesc 閉じるトランスクリプトはホームの欄で');
    expect(screen.getByPlaceholderText('セッションへ移動、または操作を実行')).toBeInTheDocument();
  });

  describe('開く動き', () => {
    let restore = () => {};
    const animate = vi.fn();
    const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    beforeEach(() => {
      restore = fakeMotionTokens();
      (HTMLElement.prototype as unknown as { animate: unknown }).animate = animate;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
        if (this.id === 'global-search') return rect(100, 10, 200, 30);
        if (this.classList.contains('palette')) return rect(200, 60, 400, 120);
        return rect(0, 0, 0, 0);
      });
    });
    afterEach(() => { restore(); animate.mockReset(); vi.restoreAllMocks(); delete (HTMLElement.prototype as unknown as { animate?: unknown }).animate; document.getElementById('global-search')?.remove(); });

    it('ヘッダの検索欄の錠剤から広がって開き、入力欄はその描画でフォーカスを持つ', () => {
      const pill = document.createElement('input');
      pill.id = 'global-search';
      document.body.append(pill);
      render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.contexts[0]).toBe(document.querySelector('.palette'));
      const [frames, opts] = animate.mock.calls[0]!;
      expect(frames).toEqual([{ transform: 'translate(-100px, -50px) scale(0.5, 0.25)', opacity: 0.4 }, { transform: 'none', opacity: 1 }]);
      expect(opts).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      expect(document.activeElement).toBe(screen.getByLabelText('移動・操作'));
    });
    it('検索欄が無ければ、その場でふわりと現れる', () => {
      render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
      expect(animate.mock.calls[0]![0]).toEqual([{ transform: 'scale(0.96)', opacity: 0.4 }, { transform: 'none', opacity: 1 }]);
    });
  });
});

describe('CommandPalette の選択を見える位置に保つ（C2）', () => {
  let calls: { el: Element; arg: unknown }[] = [];
  beforeEach(() => {
    calls = [];
    // jsdom は scrollIntoView を実装していないので、呼ばれたことだけを見る。
    (Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (this: Element, arg: unknown) { calls.push({ el: this, arg }); };
  });
  afterEach(() => { delete (Element.prototype as unknown as { scrollIntoView?: unknown }).scrollIntoView; });

  it('矢印で動かした選択の行を、一覧の見える位置へ寄せる', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    const input = screen.getByLabelText('移動・操作');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(calls.at(-1)?.el.textContent).toContain('動画の変換');
    expect(calls.at(-1)?.arg).toEqual({ block: 'nearest' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(calls.at(-1)?.el.textContent).toContain('クラウド同期');
  });

  it('マウスで乗せただけでは一覧を動かさない', () => {
    render(<ActionRoot onAction={() => {}}><CommandPalette query="" sections={sections} noMatch={false} onQuery={() => {}} /></ActionRoot>);
    fireEvent.mouseEnter(screen.getByText('動画の変換').closest('[role="option"]')!);
    expect(calls).toHaveLength(0);
  });
});

describe('PromoteDialog', () => {
  it('名前と 2 つの選択を送る', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><PromoteDialog sessionId="s1" sessionName="動画の変換" runAlive={false} submitting={false} error={null} /></ActionRoot>);
    const name = screen.getByLabelText('プロジェクト名');
    expect(name.getAttribute('id')).toBe('promote-name');
    fireEvent.change(name, { target: { value: 'newp' } });
    fireEvent.click(screen.getByLabelText('git init を実行'));
    fireEvent.click(screen.getByText('昇格'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: true });
  });

  it('run が生きているとファイルを移動できない', () => {
    render(<ActionRoot onAction={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></ActionRoot>);
    expect(screen.getByLabelText('ファイルを移動')).toBeDisabled();
    expect(screen.getByText('実行中のセッションがあるので、ファイルは移動しません')).toBeTruthy();
  });

  it('run が生きているときは moveFiles を偽にして送る', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></ActionRoot>);
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'newp' } });
    fireEvent.click(screen.getByText('昇格'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: false });
  });

  it('名前の欄の Enter でも送る', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></ActionRoot>);
    const name = screen.getByLabelText('プロジェクト名');
    fireEvent.change(name, { target: { value: 'newp' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onAction).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: true });
  });

  it('送信中はボタンを止め、失敗は文言で出す', () => {
    render(<ActionRoot onAction={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting error="同じ名前があります" /></ActionRoot>);
    expect((screen.getByText('昇格') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('同じ名前があります')).toBeTruthy();
  });

  it('2 つの選択は、何が起きるかを添えたカードで並ぶ', () => {
    render(<ActionRoot onAction={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></ActionRoot>);
    expect(screen.getByRole('checkbox', { name: 'git init を実行' })).toHaveAccessibleDescription('空のリポジトリを作成してから移します');
    expect(screen.getByRole('checkbox', { name: 'ファイルを移動' })).toHaveAccessibleDescription('クイックセッションのファイルをプロジェクトの親フォルダへ移します');
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'true']);
  });
  it('run が生きているとき、ファイルを移動するのカードは印を外して押せない', () => {
    render(<ActionRoot onAction={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></ActionRoot>);
    expect(screen.getByRole('checkbox', { name: 'ファイルを移動' })).toHaveAttribute('aria-checked', 'false');
  });

  // 名前を打ちかけたまま背景を押し違えても、書きかけを失わない。
  it('入力のあるダイアログなので、背景を押しても閉じない', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></ActionRoot>);
    expect(screen.getByLabelText('プロジェクト名')).toHaveFocus();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('キャンセルすると Esc で閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></ActionRoot>);
    fireEvent.click(screen.getByText('キャンセル'));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
    onAction.mockClear();
    fireEvent.keyDown(screen.getByLabelText('プロジェクト名'), { key: 'Escape' });
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

// 未解決プロジェクトのダイアログは、押して開くので、閉じる手（Esc、背景、×、あとで）を持つ（設計書 2.11.5）。
describe('ResolveProjectDialog', () => {
  it('覆いの外側を押す、Esc、× のどれでも閉じる', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><ResolveProjectDialog projectId="p1" name="alpha" previousPath="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></ActionRoot>);
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'overlay.close' });
    fireEvent.keyDown(screen.getByLabelText('新しいパス'), { key: 'Escape' });
    expect(onAction).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: '閉じる' }));
    expect(onAction).toHaveBeenCalledTimes(3);
    expect(onAction).toHaveBeenLastCalledWith({ type: 'overlay.close' });
  });
  it('あとでを押すと閉じる', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><ResolveProjectDialog projectId="p1" name="alpha" previousPath="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></ActionRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
  it('他の PC から届いただけのものは、見出しと前のパスの札でそれを言う。パスが分からなければ「（パスなし）」', () => {
    const { unmount } = render(<ActionRoot onAction={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" elsewhere deviceName="Mac mini" previousPath="/o/alpha" candidates={[]} onQueryCandidates={() => {}} /></ActionRoot>);
    expect(screen.getByRole('dialog', { name: 'alpha はこの PC にパスがありません' })).toBeInTheDocument();
    expect(screen.getByText('Mac mini でのパス')).toBeInTheDocument();
    expect(screen.getByText('/o/alpha')).toBeInTheDocument();
    // 移動や改名の説明ではなく、他の PC のものだという説明を出す。
    expect(screen.getByText(/他の PC のプロジェクトです/)).toBeInTheDocument();
    unmount();
    render(<ActionRoot onAction={vi.fn()}><ResolveProjectDialog projectId="p1" name="alpha" elsewhere deviceName={null} previousPath={null} candidates={[]} onQueryCandidates={() => {}} /></ActionRoot>);
    expect(screen.getByText('前のパス')).toBeInTheDocument();
    expect(screen.getByText('（パスなし）')).toBeInTheDocument();
  });
});

describe('PromotedDialog', () => {
  it('移動の可否と次の一手を出す', () => {
    const onAction = vi.fn();
    render(<ActionRoot onAction={onAction}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></ActionRoot>);
    expect(screen.getByText('ファイルを移しました')).toBeTruthy();
    fireEvent.click(screen.getByText('ここで新しいセッションを開始'));
    expect(onAction).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p9' });
    fireEvent.click(screen.getByText('プロジェクトを開く'));
    expect(onAction).toHaveBeenCalledWith({ type: 'project.open', id: 'p9' });
  });

  // 3 つのボタンが 480px の器に収まらず、日本語の語の途中で 2 行に割れていた。
  // 器を広げ、ボタンの中では折り返さず、入り切らないときはボタンごと次の行へ落とす。
  it('ボタンが語の途中で折り返さない', () => {
    render(<ActionRoot onAction={() => {}}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></ActionRoot>);
    const dialog = screen.getByRole('dialog', { name: 'newp に昇格しました' });
    expect(dialog.classList.contains('dialog-wide')).toBe(true);
    expect(dialog.classList.contains('dialog-promote')).toBe(true);
    expect(paletteCss).toContain('.dialog-promote .btn { white-space: nowrap; }');
    expect(paletteCss).toContain('.dialog-promote .dialog-foot { flex-wrap: wrap;');
  });

  // 完了ダイアログは読んで終わりなので、覆いの外側を押しても閉じる。
  // 閉じないと、左のナビをマウスで押せないまま閉じ込められる。
  it('覆いの外側を押すと閉じ、中身を押しても閉じない', () => {
    const onAction = vi.fn();
    const { container } = render(<ActionRoot onAction={onAction}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></ActionRoot>);
    fireEvent.click(container.querySelector('.dialog')!);
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onAction).toHaveBeenCalledWith({ type: 'overlay.close' });
  });

  it('移動しなかった理由を出す', () => {
    render(<ActionRoot onAction={() => {}}><PromotedDialog projectId="p9" projectName="newp" moved={false} reason="実行中の run があります" /></ActionRoot>);
    expect(screen.getByText('実行中の run があります')).toBeTruthy();
  });
});
