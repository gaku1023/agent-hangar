import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { countHits } from '../../presenters/highlight.ts';
import { mdLeaves, parseMarkdown } from '../../presenters/markdown.ts';
import { MarkProvider } from './Hl.tsx';
import type { ProjectDto, SessionDto } from '@agent-hangar/shared';
import { ActionRoot } from '../../action/chain.tsx';
import { initialStore, type Store } from '../../store/store.ts';
import { sessionDto } from '../../test/sessionDto.ts';
import { Markdown, SessionLinkContext } from './Markdown.tsx';

afterEach(cleanup);

describe('Markdown', () => {
  it('太字とインラインのコードは記号を外して描く', () => {
    const { container } = render(<Markdown text={'**1. main へ入れる** には `git merge` を打つ'} />);
    expect(container.querySelector('strong')?.textContent).toBe('1. main へ入れる');
    expect(container.querySelector('code')?.textContent).toBe('git merge');
    expect(container.textContent).toBe('1. main へ入れる には git merge を打つ');
  });
  it('対になっていない記号はそのまま出す', () => {
    const { container } = render(<Markdown text={'a ** b と `c'} />);
    expect(container.textContent).toBe('a ** b と `c');
    expect(container.querySelector('strong')).toBeNull();
  });
  it('コードの塊の中では太字の記号を解釈しない', () => {
    const { container } = render(<Markdown text={'```\n**x**\n```'} />);
    expect(container.querySelector('pre')?.textContent).toBe('**x**');
  });
  it('HTML は文字として出す', () => {
    const { container } = render(<Markdown text={'<b>x</b><script>alert(1)</script>'} />);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toBe('<b>x</b><script>alert(1)</script>');
  });
  it('見出しは段に合わせた見出しの要素にする', () => {
    const { container } = render(<Markdown text={'## 変えたところ\n### 細かい所'} />);
    expect(container.querySelector('h2')?.textContent).toBe('変えたところ');
    expect(container.querySelector('h3')?.textContent).toBe('細かい所');
  });
  it('箇条書きは入れ子の ul、番号付きは始まりの番号を持つ ol にする', () => {
    const { container } = render(<Markdown text={'- a\n  - b\n\n3. c\n4. d'} />);
    expect(container.querySelector('ul > li > ul > li')?.textContent).toBe('b');
    const ol = container.querySelector('ol');
    expect(ol?.getAttribute('start')).toBe('3');
    expect(ol?.querySelectorAll('li')).toHaveLength(2);
  });
  it('表は見出しの行と本体の行を持つ table にする', () => {
    const { container } = render(<Markdown text={'| 欄 | 条件 |\n|---|---:|\n| メール | 形 |'} />);
    expect([...container.querySelectorAll('th')].map((x) => x.textContent)).toEqual(['欄', '条件']);
    expect([...container.querySelectorAll('tbody td')].map((x) => x.textContent)).toEqual(['メール', '形']);
    expect((container.querySelectorAll('td')[1] as HTMLElement).style.textAlign).toBe('right');
  });
  it('http と https のリンクは外で開くリンクにし、ほかはリンクにしない', () => {
    const { container } = render(<Markdown text={'[説明](https://example.com/a) と [悪い](javascript:alert(1))'} />);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://example.com/a');
    expect(links[0]!.getAttribute('target')).toBe('_blank');
    expect(links[0]!.getAttribute('rel')).toContain('noreferrer');
    expect(container.textContent).toContain('悪い');
  });
  it('囲みのコードは言語名とコピーのボタンを持ち、押すと中身を写す', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container, getByRole } = render(<Markdown text={'```ts\nconst a = 1;\n```'} />);
    expect(container.querySelector('.code-lang')?.textContent).toBe('ts');
    await act(async () => { fireEvent.click(getByRole('button', { name: 'コピー' })); });
    expect(writeText).toHaveBeenCalledWith('const a = 1;');
    expect(getByRole('button', { name: 'コピーしました' })).toBeInTheDocument();
  });
  it('印の文脈があれば、描いた葉の一致に印を付け、その数はデータで数えた数と同じ', () => {
    const text = '## バリデーション\n入力の**バリデーション**を足す。\n\n| 欄 | バリデーション |\n|---|---|\n| a | b |\n\n- [バリデーション](https://x.example)\n\n```\nバリデーション()\n```';
    const { container } = render(<MarkProvider value={{ query: 'バリデーション', literal: true, caseSensitive: false }}><Markdown text={text} /></MarkProvider>);
    const want = mdLeaves(parseMarkdown(text)).reduce((n, leaf) => n + countHits(leaf, 'バリデーション', { literal: true }), 0);
    expect(want).toBe(5);
    expect(container.querySelectorAll('mark.hit')).toHaveLength(want);
  });
});

describe('Markdown の hangar の会話へのリンク', () => {
  const URL2 = 'http://127.0.0.1:4177/#/session/s2?device=d2';
  const project = (id: string, name: string): ProjectDto => ({ id, name, status: 'active', isScratch: false, path: `/w/${id}`, resolved: true, lastActivityAt: null, runningCount: 0, openTodoCount: 0, updatedAt: 1 });
  const storeOf = (s2: Partial<SessionDto> = {}): Store => {
    const s = initialStore();
    s.device = { id: 'me', name: 'この PC' };
    s.projects = { a: project('a', 'alpha'), b: project('b', 'beta') };
    s.sessions = { s1: sessionDto({ id: 's1', name: '見ている会話', projectId: 'a' }), s2: sessionDto({ id: 's2', name: '開く先の会話', projectId: 'a', live: 'busy', ...s2 }) };
    return s;
  };
  const view = (store: Store, text = `始めました（[${URL2}](${URL2})）。`, onAction = vi.fn()) => {
    const tree = (st: Store) => <ActionRoot onAction={onAction}><SessionLinkContext.Provider value={{ store: st, viewingId: 's1' }}><Markdown text={text} /></SessionLinkContext.Provider></ActionRoot>;
    const r = render(tree(store));
    return { ...r, onAction, rerender: (st: Store) => r.rerender(tree(st)) };
  };

  it('この PC で分かる会話は、状態の丸と題の札にする。同じプロジェクトと同じ PC なら、ほかは添えない', () => {
    const { container } = view(storeOf());
    const chip = container.querySelector('a.sess-chip')!;
    expect(chip.querySelector('.dot')).toHaveAttribute('data-status', 'busy');
    expect(chip.querySelector('.sess-chip-name')).toHaveTextContent('開く先の会話');
    expect(chip.querySelector('.sess-chip-meta')).toBeNull();
  });
  it('プロジェクトが違うときだけプロジェクト名を、PC が違うときだけ PC の名前を添える', () => {
    const { container } = view(storeOf({ projectId: 'b', live: null, lock: { deviceId: 'd2', deviceName: 'MacBook', runId: 'r', heartbeatAt: 1, stale: false, live: 'idle' } }));
    expect([...container.querySelectorAll('.sess-chip-meta')].map((x) => x.textContent)).toEqual(['beta', 'MacBook']);
  });
  it('状態が変われば札の丸も変わる', () => {
    const { container, rerender } = view(storeOf());
    expect(container.querySelector('.sess-chip .dot')).toHaveAttribute('data-status', 'busy');
    rerender(storeOf({ live: 'waiting' }));
    expect(container.querySelector('.sess-chip .dot')).toHaveAttribute('data-status', 'waiting');
  });
  it('押すと今のペインでその会話を開く（外へは出さない）。1 回だけ', () => {
    const { container, onAction } = view(storeOf());
    fireEvent.click(container.querySelector('a.sess-chip')!);
    expect(onAction.mock.calls).toEqual([[{ type: 'session.open', id: 's2' }]]);
  });
  it('すでに上の層（文書の click）が開いたクリックは、重ねて開かない', () => {
    const { container, onAction } = view(storeOf());
    const a = container.querySelector('a.sess-chip')!;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    ev.preventDefault();
    a.dispatchEvent(ev);
    expect(onAction).not.toHaveBeenCalled();
  });
  it('この PC で分からない会話や、文脈が無いときは、ただのリンクのまま。押せば同じく開く', () => {
    const unknown = storeOf();
    delete unknown.sessions.s2;
    for (const r of [view(unknown), render(<ActionRoot onAction={vi.fn()}><Markdown text={`[x](${URL2})`} /></ActionRoot>)]) {
      expect(r.container.querySelector('a.sess-chip')).toBeNull();
      expect(r.container.querySelector('a')!.getAttribute('href')).toBe(URL2);
    }
    const { container, onAction } = view(unknown);
    fireEvent.click(container.querySelector('a')!);
    expect(onAction.mock.calls).toEqual([[{ type: 'session.open', id: 's2' }]]);
  });
  it('hangar:// のリンクも札になる。プロジェクトのリンクは札にせず、押すとプロジェクトを開く', () => {
    const a = view(storeOf(), '[x](hangar://session/s2)');
    expect(a.container.querySelector('a.sess-chip')).not.toBeNull();
    const b = view(storeOf(), '[案件](hangar://project/p1)');
    expect(b.container.querySelector('a.sess-chip')).toBeNull();
    fireEvent.click(b.container.querySelector('a')!);
    expect(b.onAction.mock.calls).toEqual([[{ type: 'project.open', id: 'p1' }]]);
  });
  it('ふつうの外へのリンクは、これまでどおり外で開くリンク', () => {
    const { container, onAction } = view(storeOf(), '[説明](https://example.com/a)');
    const a = container.querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    fireEvent.click(a);
    expect(onAction).not.toHaveBeenCalled();
  });
});
