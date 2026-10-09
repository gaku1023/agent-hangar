import { existsSync, readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { IntentRoot, type Emit } from '../intent/chain.tsx';
import type { ProjectRowProps, ProjectsProps } from '../presenters/projects.ts';
import { LanguageRoot } from './primitives/language.tsx';
import { ProjectsScreen } from './ProjectsScreen.tsx';

// dom の project では import.meta.url が file にならないので、cwd から辿って読む。
const rowsCss = readFileSync(['packages/ui/src/styles/rows.css', 'src/styles/rows.css'].map((r) => `${process.cwd()}/${r}`).find(existsSync)!, 'utf8');

const row = (id: string, over: Partial<ProjectRowProps> = {}): ProjectRowProps => ({ id, name: id, status: 'active', place: null, now: [], sessionCount: 3, sessionsText: '3 本', lastActivity: '1 時間前', label: `${id}、Active`, ...over });
const props = (over: Partial<ProjectsProps> = {}): ProjectsProps => ({ sections: [{ status: 'active', label: 'Active', rows: [row('alpha')] }], archived: null, total: 1, empty: null, promoteSessionId: null, ...over });
const mount = (p: ProjectsProps, o: { onIntent?: Mock<Emit>; filter?: string; onFilter?: (s: string) => void; onShowArchived?: (b: boolean) => void } = {}) => {
  const onIntent = o.onIntent ?? vi.fn<Emit>();
  const ui = (next: ProjectsProps) => <IntentRoot onIntent={onIntent}><ProjectsScreen {...next} filter={o.filter ?? ''} onFilter={o.onFilter ?? (() => {})} onShowArchived={o.onShowArchived ?? (() => {})} /></IntentRoot>;
  const r = render(ui(p));
  return { onIntent, container: r.container, rerender: (next: ProjectsProps) => r.rerender(ui(next)) };
};
const opened = (onIntent: Mock<Emit>) => onIntent.mock.calls.filter(([i]) => i.type === 'project.open');
const menuOf = (name: string) => fireEvent.click(screen.getByRole('button', { name: `${name} のメニュー` }));

describe('ProjectsScreen の見出し', () => {
  it('「新しいプロジェクト」で作成のダイアログを開き、件数を見出しの横に出す', () => {
    const { onIntent, container } = mount(props({ total: 14 }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('プロジェクト');
    expect(container.querySelector('.page-sub')).toHaveTextContent('14');
    fireEvent.click(screen.getByRole('button', { name: '新しいプロジェクト' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.new.open' });
  });
  it('名前の欄は打った語を渡す。アーカイブを出し入れするボタンは見出しに置かない', () => {
    const onFilter = vi.fn();
    mount(props(), { onFilter });
    fireEvent.change(screen.getByRole('textbox', { name: '名前で絞る' }), { target: { value: 'al' } });
    expect(onFilter).toHaveBeenCalledWith('al');
    expect(screen.queryByText(/アーカイブを表示/)).toBeNull();
  });
});

describe('ProjectsScreen の表', () => {
  it('列の名前は、ステータス、名前と場所、いま、セッション、最後の活動の順に出す', () => {
    const { container } = mount(props());
    expect([...container.querySelectorAll('.pcols > span')].map((c) => c.textContent)).toEqual(['ステータス', '名前と場所', 'いま', 'セッション', '最後の活動', '']);
  });
  it('節ごとに見出しと件数を出し、見出しは 2 段目の見出しにする', () => {
    mount(props({ sections: [{ status: 'active', label: 'Active', rows: [row('a'), row('b')] }, { status: 'paused', label: 'Paused', rows: [row('c', { status: 'paused' })] }] }));
    const heads = screen.getAllByRole('heading', { level: 2 });
    expect(heads.map((h) => h.textContent)).toEqual(['Active2', 'Paused1']);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });
  it('1 行にステータスの札、名前、セッションの数、最後の活動を出す', () => {
    const { container } = mount(props({ sections: [{ status: 'paused', label: 'Paused', rows: [row('alpha', { status: 'paused', sessionsText: '12 本', lastActivity: '3 日前' })] }] }));
    const r = screen.getByRole('listitem');
    expect(within(r).getByText('Paused')).toHaveAttribute('data-s', 'paused');
    expect(within(r).getByRole('link', { name: 'alpha、Active' })).toHaveTextContent('alpha');
    expect(r).toHaveTextContent('12 本');
    expect(r).toHaveTextContent('3 日前');
    expect(container.querySelector('.card')).toBeNull();
  });
  it('「いま」は種類ごとに色の印を持ち、語に数を付ける', () => {
    mount(props({ sections: [{ status: 'active', label: 'Active', rows: [row('alpha', { now: [{ kind: 'waiting', text: '入力待ち 1' }, { kind: 'running', text: '実行中 2' }, { kind: 'pending', text: '確認待ち 1' }, { kind: 'todo', text: 'TODO 3' }, { kind: 'reminder', text: 'リマインダー 9/4（金）' }] })] }] }));
    for (const [text, kind] of [['入力待ち 1', 'waiting'], ['実行中 2', 'running'], ['確認待ち 1', 'pending'], ['TODO 3', 'todo'], ['リマインダー 9/4（金）', 'reminder']]) expect(screen.getByText(text!)).toHaveAttribute('data-kind', kind);
  });
});

describe('ProjectsScreen の行を開く', () => {
  it('名前を押すと開き、行の空いた所を押しても開く', () => {
    const { onIntent, container } = mount(props());
    fireEvent.click(screen.getByRole('link', { name: 'alpha、Active' }));
    expect(opened(onIntent)).toHaveLength(1);
    expect(opened(onIntent)[0]![0]).toEqual({ type: 'project.open', id: 'alpha' });
    fireEvent.click(container.querySelector('.prow .pn')!);
    expect(opened(onIntent)).toHaveLength(2);
  });
  it('名前は本物のリンクで、Tab で届き、リンクの先は 1 つのプロジェクトの画面', () => {
    mount(props());
    expect(screen.getByRole('link', { name: 'alpha、Active' })).toHaveAttribute('href', '#/project/alpha');
  });
  it('名前の上で ↓ ↑ を押すと、前後の行の名前へ焦点が移る。端では動かない', () => {
    mount(props({ sections: [{ status: 'active', label: 'Active', rows: [row('a'), row('b')] }, { status: 'done', label: 'Done', rows: [row('c', { status: 'done' })] }] }));
    const [a, b, c] = ['a', 'b', 'c'].map((n) => screen.getByRole('link', { name: new RegExp(`^${n}、`) }));
    a!.focus();
    fireEvent.keyDown(a!, { key: 'ArrowDown' });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b!, { key: 'ArrowDown' });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c!, { key: 'ArrowDown' });
    expect(c).toHaveFocus();
    fireEvent.keyDown(c!, { key: 'ArrowUp' });
    expect(b).toHaveFocus();
    fireEvent.keyDown(b!, { key: 'Home' });
    expect(a).toHaveFocus();
    fireEvent.keyDown(a!, { key: 'End' });
    expect(c).toHaveFocus();
  });
});

describe('ProjectsScreen の場所', () => {
  it('親フォルダの外のパスは、名前の横に出して title に全文を持つ', () => {
    const { container } = mount(props({ sections: [{ status: 'active', label: 'Active', rows: [row('alpha', { place: { kind: 'outside', path: '/elsewhere/tools/alpha' } })] }] }));
    expect(container.querySelector('.ppath')).toHaveTextContent('/elsewhere/tools/alpha');
    expect(container.querySelector('.ppath')).toHaveAttribute('title', '/elsewhere/tools/alpha');
  });
  it('場所が無い行は、パスの欄を出さない', () => {
    const { container } = mount(props());
    expect(container.querySelector('.ppath')).toBeNull();
    expect(container.querySelector('.pwarn')).toBeNull();
  });
  it('パスが見つからない行は赤い札を出し、押すと場所の再指定へ進む。行は開かない', () => {
    const { onIntent } = mount(props({ sections: [{ status: 'active', label: 'Active', rows: [row('alpha', { place: { kind: 'missing' } })] }] }));
    const warn = screen.getByRole('button', { name: 'この PC にパスがありません' });
    expect(warn.querySelector('svg')?.getAttribute('data-icon')).toBe('warning');
    fireEvent.click(warn);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
    expect(opened(onIntent)).toHaveLength(0);
  });
});

describe('ProjectsScreen の「…」のメニュー', () => {
  it('新しいセッションを、その行のプロジェクトで開く。行は開かない', () => {
    const { onIntent } = mount(props());
    menuOf('alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: '新しいセッション' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.new.open', projectId: 'alpha' });
    expect(opened(onIntent)).toHaveLength(0);
  });
  it('ステータスを変える項目は、いまのもの以外を出す', () => {
    const { onIntent } = mount(props());
    menuOf('alpha');
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['新しいセッション', 'Paused にする', 'Done にする', 'Archived にする']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Paused にする' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.setStatus', id: 'alpha', status: 'paused' });
    expect(opened(onIntent)).toHaveLength(0);
  });
  it('Active でないプロジェクトは「Active に戻す」を出す', () => {
    mount(props({ sections: [{ status: 'done', label: 'Done', rows: [row('alpha', { status: 'done' })] }] }));
    menuOf('alpha');
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['新しいセッション', 'Active に戻す', 'Paused にする', 'Archived にする']);
  });
  it('場所を再指定は、パスが見つからない行にだけ出す', () => {
    const { onIntent } = mount(props({ sections: [{ status: 'active', label: 'Active', rows: [row('alpha', { place: { kind: 'missing' } })] }] }));
    menuOf('alpha');
    fireEvent.click(screen.getByRole('menuitem', { name: '場所を再指定' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.resolve.open', id: 'alpha' });
    cleanup();
    mount(props());
    menuOf('alpha');
    expect(screen.queryByRole('menuitem', { name: '場所を再指定' })).toBeNull();
  });
});

describe('ProjectsScreen の Archived の末尾の 1 行', () => {
  const arch = (open: boolean) => props({ archived: { count: 2, open, rows: open ? [row('x', { status: 'archived' }), row('y', { status: 'archived' })] : [] } });
  it('閉じているときは見出しと数と「Archived を表示」だけで、押すと開く', () => {
    const onShow = vi.fn();
    const { container } = mount(arch(false), { onShowArchived: onShow });
    const head = container.querySelector('.prow-head[data-section="archived"]')!;
    expect(head).toHaveTextContent('Archived2');
    expect(screen.queryByRole('link', { name: /^x、/ })).toBeNull();
    const toggle = within(head as HTMLElement).getByRole('button', { name: 'Archived を表示' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(onShow).toHaveBeenCalledWith(true);
  });
  it('開いているときは行を下に出し、押すと閉じる。行は Archived の印を持つ', () => {
    const onShow = vi.fn();
    const { container } = mount(arch(true), { onShowArchived: onShow });
    expect(screen.getByRole('link', { name: /^x、/ }).closest('.prow')).toHaveAttribute('data-archived', 'true');
    // Archived の見出しは最後の行で、その下に Archived の行が続く。
    expect(container.querySelector('.prow-head[data-section="archived"]')!.nextElementSibling).toContainElement(screen.getByRole('link', { name: /^x、/ }));
    const toggle = screen.getByRole('button', { name: 'Archived を非表示' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(onShow).toHaveBeenCalledWith(false);
  });
  it('Archived が無ければ、行を出さない', () => {
    const { container } = mount(props());
    expect(container.querySelector('[data-section="archived"]')).toBeNull();
  });
});

describe('ProjectsScreen の空の状態', () => {
  const none = (over: Partial<ProjectsProps> = {}) => props({ sections: [], total: 0, empty: 'none', ...over });
  it('プロジェクトが無い人には、できるようになることの 2 文と「新しいプロジェクト」を出し、表と名前の欄は出さない', () => {
    const { container, onIntent } = mount(none());
    expect(screen.getByRole('heading', { name: 'プロジェクトはまだありません' })).toBeInTheDocument();
    expect(screen.getByText('フォルダを登録すると、そのフォルダのセッションがここにまとまります。')).toBeInTheDocument();
    expect(screen.getByText('TODO とノートも、プロジェクトごとに置けるようになります。')).toBeInTheDocument();
    expect(container.querySelector('.pcols')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    const buttons = screen.getAllByRole('button', { name: '新しいプロジェクト' });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[1]!);
    expect(onIntent).toHaveBeenCalledWith({ type: 'project.new.open' });
  });
  it('クイックセッションがあれば、昇格の入口を出す。無ければ出さない', () => {
    const { onIntent } = mount(none({ promoteSessionId: 'q1' }));
    fireEvent.click(screen.getByRole('button', { name: 'クイックセッションをプロジェクトに昇格' }));
    expect(onIntent).toHaveBeenCalledWith({ type: 'session.promote.open', id: 'q1' });
    cleanup();
    mount(none());
    expect(screen.queryByRole('button', { name: /昇格/ })).toBeNull();
  });
  it('絞り込みで 0 件のときは、表の代わりに一言だけ出し、名前の欄は残す', () => {
    mount(props({ sections: [], total: 5, empty: 'noMatch' }), { filter: 'zzz' });
    expect(screen.getByText('あてはまるプロジェクトはありません')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '名前で絞る' })).toHaveValue('zzz');
  });
});

describe('ProjectsScreen の言語と見た目', () => {
  it('English では列と語が英語になる（ステータスの札は英語のまま）', () => {
    const p = props({ sections: [{ status: 'paused', label: 'Paused', rows: [row('alpha', { status: 'paused', sessionsText: '3' })] }] });
    const { container } = render(<LanguageRoot language="en"><IntentRoot onIntent={vi.fn()}><ProjectsScreen {...p} filter="" onFilter={() => {}} onShowArchived={() => {}} /></IntentRoot></LanguageRoot>);
    expect([...container.querySelectorAll('.pcols > span')].map((c) => c.textContent)).toEqual(['Status', 'Name and location', 'Now', 'Sessions', 'Last activity', '']);
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Menu for alpha' }));
    expect(screen.getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['New session', 'Mark as Active', 'Mark as Done', 'Mark as Archived']);
  });
  it('列の見出しと行は、同じ列の幅の変数を引く（ずれない）', () => {
    expect(rowsCss).toMatch(/\.pcols \{[^}]*grid-template-columns: var\(--pcols\);/);
    expect(rowsCss).toMatch(/\.prow \{[^}]*grid-template-columns: var\(--pcols\);/);
  });
});
