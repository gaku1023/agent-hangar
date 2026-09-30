import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IntentRoot } from '../intent/chain.tsx';
import type { PaletteItem } from '../presenters/palette.ts';
import { fakeMotionTokens } from '../test/motion.ts';
import { CommandPalette } from './CommandPalette.tsx';
import { PromoteDialog, PromotedDialog } from './PromoteDialog.tsx';
import { ResolveProjectDialog } from './ResolveProjectDialog.tsx';

// new URL(..., import.meta.url) は Vite が資産の URL に書き換えるので、パスを自分で組む。
const paletteCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'styles', 'palette.css'), 'utf8');

const items: PaletteItem[] = [
  { id: 'cmd:new-session', label: '新しいセッション', hint: '⌘N', kind: 'command' },
  { id: 'project:p1', label: 'alpha', hint: '/w/alpha', kind: 'project' },
  { id: 'session:s1', label: '動画の変換', hint: '動画を mp4 に変換した', kind: 'session' },
];

describe('CommandPalette', () => {
  it('入力を親へ返し、矢印と Enter で実行する', () => {
    const onIntent = vi.fn();
    const onQuery = vi.fn();
    render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={onQuery} /></IntentRoot>);
    const input = screen.getByLabelText('コマンドを検索');
    expect(input.getAttribute('id')).toBe('palette-input');
    fireEvent.change(input, { target: { value: 'al' } });
    expect(onQuery).toHaveBeenCalledWith('al');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'project:p1', label: 'alpha' } });
  });

  it('クリックでも実行し、Esc で閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByText('動画の変換'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'session:s1', label: '動画の変換' } });
    fireEvent.keyDown(screen.getByLabelText('コマンドを検索'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.close' });
  });

  it('端で止まり、項目が無ければ何も起きない', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    const input = screen.getByLabelText('コマンドを検索');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'cmd:new-session', label: '新しいセッション' } });
    onIntent.mockClear();
    rerender(<IntentRoot onIntent={onIntent}><CommandPalette query="zzz" items={[]} onQuery={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByLabelText('コマンドを検索'), { key: 'Enter' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.getByText('一致する項目がありません')).toBeTruthy();
  });

  // palette.open は focus の効果を出さないので、入力欄へのフォーカスはパレット自身が当てる。
  it('開いた時点で入力欄にフォーカスが当たる', () => {
    render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    expect(document.activeElement).toBe(screen.getByLabelText('コマンドを検索'));
  });

  it('入力が変わると選択は先頭に戻る', () => {
    const onIntent = vi.fn();
    const { rerender } = render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByLabelText('コマンドを検索'), { key: 'ArrowDown' });
    rerender(<IntentRoot onIntent={onIntent}><CommandPalette query="a" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByLabelText('コマンドを検索'), { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.run', command: { id: 'cmd:new-session', label: '新しいセッション' } });
  });

  // 変換中の Enter は確定のための打鍵なので、実行に使わない。
  it('変換中の Enter では実行しない', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.keyDown(screen.getByLabelText('コマンドを検索'), { key: 'Enter', isComposing: true });
    expect(onIntent).not.toHaveBeenCalled();
  });

  // 器は読み上げに対してダイアログである。
  // 入力欄とは別の名前を付けて、どちらも名前で引けるようにする。
  it('器は名前を持つ modal なダイアログである', () => {
    render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: 'コマンドパレット' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.classList.contains('palette')).toBe(true);
    expect(dialog.contains(screen.getByLabelText('コマンドを検索'))).toBe(true);
  });

  it('外側を押すと閉じ、中身を押しても閉じない', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.click(container.querySelector('.dialog')!);
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'palette.close' });
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
      render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate.mock.contexts[0]).toBe(document.querySelector('.palette'));
      const [frames, opts] = animate.mock.calls[0]!;
      expect(frames).toEqual([{ transform: 'translate(-100px, -50px) scale(0.5, 0.25)', opacity: 0.4 }, { transform: 'none', opacity: 1 }]);
      expect(opts).toEqual({ duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
      expect(document.activeElement).toBe(screen.getByLabelText('コマンドを検索'));
    });
    it('検索欄が無ければ、その場でふわりと現れる', () => {
      render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
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
    render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    const input = screen.getByLabelText('コマンドを検索');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(calls.at(-1)?.el.textContent).toContain('動画の変換');
    expect(calls.at(-1)?.arg).toEqual({ block: 'nearest' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(calls.at(-1)?.el.textContent).toContain('alpha');
  });

  it('マウスで乗せただけでは一覧を動かさない', () => {
    render(<IntentRoot onIntent={() => {}}><CommandPalette query="" items={items} onQuery={() => {}} /></IntentRoot>);
    fireEvent.mouseEnter(screen.getByText('動画の変換').closest('li')!);
    expect(calls).toHaveLength(0);
  });
});

describe('PromoteDialog', () => {
  it('名前と 2 つの選択を送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromoteDialog sessionId="s1" sessionName="動画の変換" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    const name = screen.getByLabelText('プロジェクト名');
    expect(name.getAttribute('id')).toBe('promote-name');
    fireEvent.change(name, { target: { value: 'newp' } });
    fireEvent.click(screen.getByLabelText('git init する'));
    fireEvent.click(screen.getByText('昇格'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: false, moveFiles: true });
  });

  it('run が生きているとファイルを移動できない', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></IntentRoot>);
    expect(screen.getByLabelText('ファイルを移動する')).toBeDisabled();
    expect(screen.getByText('実行中のセッションがあるので、ファイルは移動しません')).toBeTruthy();
  });

  it('run が生きているときは moveFiles を偽にして送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></IntentRoot>);
    fireEvent.change(screen.getByLabelText('プロジェクト名'), { target: { value: 'newp' } });
    fireEvent.click(screen.getByText('昇格'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: false });
  });

  it('名前の欄の Enter でも送る', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    const name = screen.getByLabelText('プロジェクト名');
    fireEvent.change(name, { target: { value: 'newp' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.submit', id: 's1', name: 'newp', gitInit: true, moveFiles: true });
  });

  it('送信中はボタンを止め、失敗は文言で出す', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting error="同じ名前があります" /></IntentRoot>);
    expect((screen.getByText('昇格') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('同じ名前があります')).toBeTruthy();
  });

  it('2 つの選択は、何が起きるかを添えたカードで並ぶ', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    expect(screen.getByRole('checkbox', { name: 'git init する' })).toHaveAccessibleDescription('空のリポジトリを作ってから移します');
    expect(screen.getByRole('checkbox', { name: 'ファイルを移動する' })).toHaveAccessibleDescription('スクラッチのファイルをワークスペースへ移します');
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-checked'))).toEqual(['true', 'true']);
  });
  it('run が生きているとき、ファイルを移動するのカードは印を外して押せない', () => {
    render(<IntentRoot onIntent={() => {}}><PromoteDialog sessionId="s1" sessionName="x" runAlive submitting={false} error={null} /></IntentRoot>);
    expect(screen.getByRole('checkbox', { name: 'ファイルを移動する' })).toHaveAttribute('aria-checked', 'false');
  });

  // 名前を打ちかけたまま背景を押し違えても、書きかけを失わない。
  it('入力のあるダイアログなので、背景を押しても閉じない', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    expect(screen.getByLabelText('プロジェクト名')).toHaveFocus();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onIntent).not.toHaveBeenCalled();
  });

  it('やめると Esc で閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromoteDialog sessionId="s1" sessionName="x" runAlive={false} submitting={false} error={null} /></IntentRoot>);
    fireEvent.click(screen.getByText('やめる'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
    onIntent.mockClear();
    fireEvent.keyDown(screen.getByLabelText('プロジェクト名'), { key: 'Escape' });
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

// 未解決プロジェクトのダイアログだけは、決めるまで閉じない性質を保つ。
describe('ResolveProjectDialog', () => {
  it('覆いの外側を押しても、Esc でも閉じない', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    fireEvent.click(container.querySelector('.overlay')!);
    fireEvent.keyDown(screen.getByLabelText('新しいパス'), { key: 'Escape' });
    expect(onIntent).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '閉じる' })).toBeNull();
  });
  it('あとでを押すと閉じる', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><ResolveProjectDialog projectId="p1" name="alpha" path="/w/alpha" candidates={[]} onQueryCandidates={() => {}} /></IntentRoot>);
    fireEvent.click(screen.getByRole('button', { name: 'あとで' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });
});

describe('PromotedDialog', () => {
  it('移動の可否と次の一手を出す', () => {
    const onIntent = vi.fn();
    render(<IntentRoot onIntent={onIntent}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></IntentRoot>);
    expect(screen.getByText('ファイルを移しました')).toBeTruthy();
    fireEvent.click(screen.getByText('ここで新しいセッションを始める'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'p9' });
    fireEvent.click(screen.getByText('プロジェクトを開く'));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.open', id: 'p9' });
  });

  // 3 つのボタンが 480px の器に収まらず、日本語の語の途中で 2 行に割れていた。
  // 器を広げ、ボタンの中では折り返さず、入り切らないときはボタンごと次の行へ落とす。
  it('ボタンが語の途中で折り返さない', () => {
    render(<IntentRoot onIntent={() => {}}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></IntentRoot>);
    const dialog = screen.getByRole('dialog', { name: 'newp に昇格しました' });
    expect(dialog.classList.contains('dialog-wide')).toBe(true);
    expect(dialog.classList.contains('dialog-promote')).toBe(true);
    expect(paletteCss).toContain('.dialog-promote .btn { white-space: nowrap; }');
    expect(paletteCss).toContain('.dialog-promote .dialog-foot { flex-wrap: wrap;');
  });

  // 完了ダイアログは読んで終わりなので、覆いの外側を押しても閉じる。
  // 閉じないと、左のナビをマウスで押せないまま閉じ込められる。
  it('覆いの外側を押すと閉じ、中身を押しても閉じない', () => {
    const onIntent = vi.fn();
    const { container } = render(<IntentRoot onIntent={onIntent}><PromotedDialog projectId="p9" projectName="newp" moved reason={null} /></IntentRoot>);
    fireEvent.click(container.querySelector('.dialog')!);
    expect(onIntent).not.toHaveBeenCalled();
    fireEvent.click(container.querySelector('.overlay')!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'overlay.close' });
  });

  it('移動しなかった理由を出す', () => {
    render(<IntentRoot onIntent={() => {}}><PromotedDialog projectId="p9" projectName="newp" moved={false} reason="実行中の run があります" /></IntentRoot>);
    expect(screen.getByText('実行中の run があります')).toBeTruthy();
  });
});
