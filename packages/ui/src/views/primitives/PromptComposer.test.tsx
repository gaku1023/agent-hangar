import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { NO_ASSIST, PromptAssistContext, type PromptAssist } from './promptAssist.ts';
import { PromptComposer } from './PromptComposer.tsx';
import type { Attachment } from './promptComposerModel.ts';

const cmd = (name: string, uses = 0, source: PromptCommandDto['source'] = 'user', argumentHint: string | null = null): PromptCommandDto => ({ name, description: `${name} の説明`, argumentHint, source, uses });
const COMMANDS = [cmd('goal', 27, 'user', '<ゴール>'), cmd('find-session', 42), cmd('init', 0, 'builtin'), cmd('grill', 0)];

function Host(props: { projectId?: string | null; onValue?: (v: string) => void; initial?: Attachment[]; onAttachments?: (a: Attachment[]) => void; onPending?: (n: number) => void }) {
  const [value, setValue] = useState('');
  const [atts, setAtts] = useState<Attachment[]>(props.initial ?? []);
  return <PromptComposer id="p" value={value} onChange={(v) => { setValue(v); props.onValue?.(v); }} projectId={props.projectId ?? null} attachments={atts} onAttachmentsChange={(a) => { setAtts(a); props.onAttachments?.(a); }} onPendingChange={props.onPending} />;
}
async function mount(assist: Partial<PromptAssist> = {}, host: Parameters<typeof Host>[0] = {}) {
  const full: PromptAssist = { ...NO_ASSIST, commands: vi.fn(() => Promise.resolve(COMMANDS)), ...assist };
  const onKeyDown = vi.fn();
  render(<PromptAssistContext.Provider value={full}><div onKeyDown={onKeyDown}><label htmlFor="p">初期プロンプト（任意）</label><Host {...host} /></div></PromptAssistContext.Provider>);
  await act(async () => {});
  return { assist: full, outerKeyDown: onKeyDown, ta: screen.getByLabelText('初期プロンプト（任意）') as HTMLTextAreaElement };
}
const type = (ta: HTMLTextAreaElement, value: string) => { fireEvent.focus(ta); fireEvent.change(ta, { target: { value, selectionStart: value.length, selectionEnd: value.length } }); };
const options = () => screen.queryAllByRole('option').map((o) => o.getAttribute('data-value'));

describe('PromptComposer の / の候補', () => {
  it('開いたときに、選んだプロジェクトの候補を読む', async () => {
    const { assist } = await mount({}, { projectId: 'p1' });
    expect(assist.commands).toHaveBeenCalledWith('p1');
  });
  it('先頭で / を打つと、よく使うものを先頭にした候補が出る', async () => {
    const { ta } = await mount();
    type(ta, '/');
    expect(within(screen.getByRole('group', { name: 'よく使う' })).getAllByRole('option').map((o) => o.getAttribute('data-value'))).toEqual(['find-session', 'goal']);
    expect(screen.getByRole('option', { name: /\/goal/ })).toHaveTextContent('<ゴール>');
    expect(screen.getByRole('option', { name: /\/goal/ })).toHaveTextContent('goal の説明');
  });
  it('打ち進めると絞り込む。一致が無ければ、その旨を出す', async () => {
    const { ta } = await mount();
    type(ta, '/g');
    expect(options()).toEqual(['goal', 'grill']);
    type(ta, '/zzz');
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
  });
  it('↓ で選び、Enter で入れて、候補を閉じる', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('/grill ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('Tab でも入る。行を押しても入る', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onValue).toHaveBeenLastCalledWith('/goal ');
    type(ta, '/gr');
    fireEvent.mouseDown(screen.getByRole('option', { name: /\/grill/ }));
    expect(onValue).toHaveBeenLastCalledWith('/grill ');
  });
  // 右ボタン（文脈メニュー）や中ボタンでも mousedown は来る。主ボタン以外では入れないが、欄のフォーカスは奪わない。
  it('行は主ボタンで押したときだけ入る。ほかのボタンでも欄のフォーカスは奪わない', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '/gr');
    onValue.mockClear();
    const row = screen.getByRole('option', { name: /\/grill/ });
    expect(fireEvent.mouseDown(row, { button: 2 })).toBe(false);
    expect(onValue).not.toHaveBeenCalled();
    expect(ta.value).toBe('/gr');
    fireEvent.mouseDown(row, { button: 0 });
    expect(onValue).toHaveBeenLastCalledWith('/grill ');
  });
  it('Esc は候補だけを閉じ、外へ伝えない。同じ語では開き直さず、打ち進めたら開く', async () => {
    const { ta, outerKeyDown } = await mount();
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outerKeyDown).not.toHaveBeenCalled();
    fireEvent.keyUp(ta, { key: 'Shift' });
    expect(screen.queryByRole('listbox')).toBeNull();
    type(ta, '/go');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('変換中の Enter では入れない', async () => {
    const onValue = vi.fn();
    const { ta, outerKeyDown } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onValue).toHaveBeenLastCalledWith('/g');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // 確定の Enter は、外（起動ダイアログ）へも漏らさない。
    expect(outerKeyDown).not.toHaveBeenCalled();
  });
  it('変換中の Esc では候補を閉じず、外へも漏らさない', async () => {
    const { ta, outerKeyDown } = await mount();
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(outerKeyDown).not.toHaveBeenCalled();
  });
  it('候補が閉じている間の Enter と Esc は、外へ伝える', async () => {
    const { ta, outerKeyDown } = await mount();
    type(ta, 'こんにちは');
    fireEvent.keyDown(ta, { key: 'Escape' });
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(outerKeyDown).toHaveBeenCalledTimes(2);
  });
  it('先頭でない / では出さない', async () => {
    const { ta } = await mount();
    type(ta, 'src/');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  // 貼ったパス（/Users/x/y）の下に「一致なし」を出しても邪魔なだけ。スキルの名前に / は入らない。
  it('先頭の語に / が入っていたら、候補を開かない', async () => {
    const { ta } = await mount();
    type(ta, '/Users/x');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('道具の段の「スキル」を押すと、先頭に / を入れて候補を開く', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '速くする');
    fireEvent.click(screen.getByRole('button', { name: 'スキル' }));
    expect(onValue).toHaveBeenLastCalledWith('/速くする');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('候補が読めなければ、候補の中にその旨を出し、欄は打てる', async () => {
    const { ta } = await mount({ commands: () => Promise.reject(new Error('x')) });
    type(ta, '/');
    expect(screen.getByText('読めませんでした')).toBeInTheDocument();
    type(ta, '/goal やる');
    expect(ta.value).toBe('/goal やる');
  });
  it('Esc で閉じた後、欄を空にして / を打ち直したら開く', async () => {
    const { ta } = await mount();
    type(ta, '/');
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    type(ta, '');
    type(ta, '/');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('一致が無いとき、↑↓ は外へ伝える（複数行の欄でカーソルを動かせる）', async () => {
    const { ta, outerKeyDown } = await mount();
    type(ta, '/zzz');
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(outerKeyDown).toHaveBeenCalledTimes(2);
  });
  it('Shift+Tab は候補を入れず、通す', async () => {
    const onValue = vi.fn();
    const { ta, outerKeyDown } = await mount({}, { onValue });
    type(ta, '/g');
    fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
    expect(onValue).toHaveBeenLastCalledWith('/g');
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
  });
  it('候補の一覧の余白を押しても、欄のフォーカスを奪わない', async () => {
    const { ta } = await mount();
    type(ta, '/');
    const pop = screen.getByRole('listbox').parentElement!;
    expect(fireEvent.mouseDown(pop)).toBe(false);
  });
  it('すでに / で始まる文で「スキル」を押しても、次の打鍵でカーソルが 1 へ跳ばない', async () => {
    const { ta } = await mount();
    type(ta, '/goal do');
    fireEvent.click(screen.getByRole('button', { name: 'スキル' }));
    expect(ta.selectionStart).toBe(1);
    fireEvent.change(ta, { target: { value: '/goal do!', selectionStart: 9, selectionEnd: 9 } });
    expect(ta.selectionStart).toBe(9);
  });
  it('文が変わらない確定では、カーソルを区切りの後ろへ置き、次の打鍵で跳ばない', async () => {
    const { ta } = await mount({ commands: () => Promise.resolve([cmd('go')]) });
    fireEvent.focus(ta);
    fireEvent.change(ta, { target: { value: '/go do', selectionStart: 3, selectionEnd: 3 } });
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(ta.value).toBe('/go do');
    expect(ta.selectionStart).toBe(4);
    fireEvent.change(ta, { target: { value: '/go dox', selectionStart: 7, selectionEnd: 7 } });
    expect(ta.selectionStart).toBe(7);
  });
});

describe('PromptComposer の @ の候補', () => {
  // 問いは打鍵ごとに送らず、120 ms 待ってまとめる。時間は偽物にして、進めて確かめる。
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(150); });
  const files = () => vi.fn((_: string, q: string) => Promise.resolve(q ? ['src/views/Dialog.tsx', 'docs/dialogs.md'].filter((f) => f.toLowerCase().includes(q.toLowerCase())) : ['README.md']));

  it('@ を打つと、プロジェクトのファイルを問いで読み、ファイル名とフォルダを分けて出す', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '見て @dia');
    await settle();
    expect(f).toHaveBeenLastCalledWith('p1', 'dia');
    const opt = screen.getByRole('option', { name: 'src/views/Dialog.tsx' });
    expect(opt).toHaveTextContent('Dialog.tsx');
    expect(opt).toHaveTextContent('src/views');
  });
  it('Enter で @パス と空白を入れる', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '見て @dia');
    await settle();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('見て @src/views/Dialog.tsx ');
  });
  it('古い問いの返事が後から届いても、いまの問いの結果を上書きしない', async () => {
    let slow: (v: string[]) => void = () => {};
    const f = vi.fn((_: string, q: string) => (q === 'd' ? new Promise<string[]>((r) => { slow = r; }) : Promise.resolve(['docs/dialogs.md'])));
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@d');
    // d の問いを実際に送らせてから、次の問いへ移る。
    await settle();
    type(ta, '@di');
    await settle();
    await act(async () => { slow(['OLD.md']); });
    expect(f).toHaveBeenCalledTimes(2);
    expect(options()).toEqual(['docs/dialogs.md']);
  });
  it('プロジェクトが無い（スクラッチ）と、@ では候補を出さず、ボタンも押せない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: null });
    type(ta, '@a');
    await settle();
    expect(f).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
    const b = screen.getByRole('button', { name: 'ファイル' });
    expect(b).toBeDisabled();
    expect(b).toHaveAttribute('title', 'プロジェクトを選択すると使えます');
  });
  it('道具の段の「ファイル」は、カーソルの位置に @ を入れて候補を開く。前が空白でなければ空白を挟む', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '見て');
    fireEvent.click(screen.getByRole('button', { name: 'ファイル' }));
    // 問いが空（@ だけ）のときは待たずに送る。時間は進めない。
    await act(async () => {});
    expect(onValue).toHaveBeenLastCalledWith('見て @');
    expect(screen.getByRole('option', { name: 'README.md' })).toBeInTheDocument();
  });
  it('ファイルが読めなければ、候補の中にその旨を出す', async () => {
    const { ta } = await mount({ files: () => Promise.reject(new Error('x')) }, { projectId: 'p1' });
    type(ta, '@a');
    await settle();
    expect(screen.getByText('読めませんでした')).toBeInTheDocument();
  });

  it('速く打ち進めたら、問いは 1 回だけ、打ち終わった語で送る', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@d');
    type(ta, '@di');
    expect(f).not.toHaveBeenCalled();
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith('p1', 'di');
  });
  it('問いが空（@ だけ）なら待たずに送り、最近変えたファイルの見出しを出す', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@');
    await act(async () => {});
    expect(f).toHaveBeenCalledWith('p1', '');
    expect(screen.getByText('最近変えたファイル')).toBeInTheDocument();
  });
  it('語を打ち進めて新しい返事を待つ間は、前の一覧を出したままにし、「読み込んでいます」に替えない', async () => {
    let second: (v: string[]) => void = () => {};
    const f = vi.fn((_: string, q: string) => (q === 'di' ? new Promise<string[]>((r) => { second = r; }) : Promise.resolve(['src/views/Dialog.tsx', 'docs/dialogs.md'])));
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@d');
    await settle();
    expect(options()).toEqual(['src/views/Dialog.tsx', 'docs/dialogs.md']);
    type(ta, '@di');
    await settle();
    expect(screen.queryByText('読み込んでいます')).toBeNull();
    expect(options()).toEqual(['src/views/Dialog.tsx', 'docs/dialogs.md']);
    await act(async () => { second(['docs/dialogs.md']); });
    expect(options()).toEqual(['docs/dialogs.md']);
  });
  it('出すものがまだ無い間だけ、「読み込んでいます」を出す', async () => {
    const { ta } = await mount({ files: () => new Promise<string[]>(() => {}) }, { projectId: 'p1' });
    type(ta, '@d');
    await settle();
    expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
  });
  it('一致が無ければ、その旨を出す', async () => {
    const { ta } = await mount({ files: () => Promise.resolve([]) }, { projectId: 'p1' });
    type(ta, '@zzz');
    await settle();
    expect(screen.getByText('一致するものはありません')).toBeInTheDocument();
  });
  it('パスには / が入る。@src/vi でも候補を閉じない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@src/vi');
    await settle();
    expect(f).toHaveBeenLastCalledWith('p1', 'src/vi');
    expect(screen.getByRole('listbox', { name: 'ファイル' })).toBeInTheDocument();
  });
  it('語の途中の @（メールアドレスなど）では、候補を出さず、問いも送らない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, 'a@b');
    await settle();
    expect(f).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('↓ で選んだ行を Tab で入れる。行を押しても入る', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '@d');
    await settle();
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'docs/dialogs.md' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(ta, { key: 'Tab' });
    expect(onValue).toHaveBeenLastCalledWith('@docs/dialogs.md ');
    type(ta, '@d');
    await settle();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'src/views/Dialog.tsx' }));
    expect(onValue).toHaveBeenLastCalledWith('@src/views/Dialog.tsx ');
  });
  it('空白を含むパスは、@"…" で囲んで入れる', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: () => Promise.resolve(['my docs/a b.md']) }, { projectId: 'p1', onValue });
    type(ta, '見て @a');
    await settle();
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('見て @"my docs/a b.md" ');
  });
  it('Esc は候補だけを閉じ、外へ伝えない。同じ語では開き直さず、打ち進めたら開く', async () => {
    const { ta, outerKeyDown } = await mount({ files: files() }, { projectId: 'p1' });
    type(ta, '@d');
    await settle();
    fireEvent.keyDown(ta, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(outerKeyDown).not.toHaveBeenCalled();
    fireEvent.keyUp(ta, { key: 'Shift' });
    expect(screen.queryByRole('listbox')).toBeNull();
    type(ta, '@di');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
  it('変換中の Enter では入れず、外へも漏らさない', async () => {
    const onValue = vi.fn();
    const { ta, outerKeyDown } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '見て @dia');
    await settle();
    fireEvent.keyDown(ta, { key: 'Enter', isComposing: true, keyCode: 229 });
    expect(onValue).toHaveBeenLastCalledWith('見て @dia');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(outerKeyDown).not.toHaveBeenCalled();
  });
  it('変換中の Esc では候補を閉じず、外へも漏らさない', async () => {
    const { ta, outerKeyDown } = await mount({ files: files() }, { projectId: 'p1' });
    type(ta, '@d');
    await settle();
    fireEvent.keyDown(ta, { key: 'Escape', isComposing: true, keyCode: 229 });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(outerKeyDown).not.toHaveBeenCalled();
  });
  it('⌘Enter は候補が開いていても、入れずに外（起動）へ通す', async () => {
    const onValue = vi.fn();
    const { ta, outerKeyDown } = await mount({ files: files() }, { projectId: 'p1', onValue });
    type(ta, '@d');
    await settle();
    fireEvent.keyDown(ta, { key: 'Enter', metaKey: true });
    expect(onValue).toHaveBeenLastCalledWith('@d');
    expect(outerKeyDown).toHaveBeenCalledTimes(1);
  });
  it('一致が無いとき、↑↓ は外へ伝える', async () => {
    const { ta, outerKeyDown } = await mount({ files: () => Promise.resolve([]) }, { projectId: 'p1' });
    type(ta, '@zzz');
    await settle();
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(outerKeyDown).toHaveBeenCalledTimes(2);
  });
  it('欄を外した後は、待っていた問いを送らない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@d');
    fireEvent.blur(ta);
    await settle();
    expect(f).not.toHaveBeenCalled();
  });
  it('部品を外した後は、待っていた問いを送らない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '@d');
    cleanup();
    await settle();
    expect(f).not.toHaveBeenCalled();
  });
  it('/ の候補は、これまでどおり / を含む語では開かない（@ の規則を持ち込まない）', async () => {
    const { ta } = await mount({ files: files() }, { projectId: 'p1' });
    type(ta, '/Users/x');
    await settle();
    expect(screen.queryByRole('listbox')).toBeNull();
  });
  it('語の途中の @ は、先頭が / の語の中でも、日本語に続く @ でも、@ の候補を開かない', async () => {
    const f = files();
    const { ta } = await mount({ files: f }, { projectId: 'p1' });
    type(ta, '/a@b');
    await settle();
    expect(screen.queryByRole('listbox', { name: 'ファイル' })).toBeNull();
    type(ta, '見て@x');
    await settle();
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  describe('前の問いの一覧を残している間（まだ返事が来ていない）', () => {
    /** 問いごとに手で解決できる files。'' はすぐ返す。 */
    function byQuery(first: Record<string, string[]>) {
      const waiting: Record<string, (v: string[]) => void> = {};
      const f = vi.fn((_: string, q: string) => (q in first ? Promise.resolve(first[q]!) : new Promise<string[]>((r) => { waiting[q] = r; })));
      return { f, waiting };
    }

    // 通すと、Enter はテキストエリアに改行を入れ、@ の語がそこで終わってしまう。返事を待つ間は、改行も確定もしない。
    it('Enter は何も入れず、改行にもならず外へも出ない。返事が来たら、その一覧の行を入れる', async () => {
      const onValue = vi.fn();
      const { f, waiting } = byQuery({ '': ['README.md'] });
      const { ta, outerKeyDown } = await mount({ files: f }, { projectId: 'p1', onValue });
      type(ta, '@');
      await act(async () => {});
      expect(options()).toEqual(['README.md']);
      type(ta, '@src');
      // 送る前も、送った後も、返事が来るまでは「@src」の候補ではない。
      expect(fireEvent.keyDown(ta, { key: 'Enter' })).toBe(false);
      await settle();
      expect(f).toHaveBeenLastCalledWith('p1', 'src');
      expect(options()).toEqual(['README.md']);
      expect(fireEvent.keyDown(ta, { key: 'Enter' })).toBe(false);
      expect(onValue).toHaveBeenLastCalledWith('@src');
      expect(ta.value).toBe('@src');
      expect(outerKeyDown).not.toHaveBeenCalled();
      await act(async () => { waiting.src!(['src/a.ts']); });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(onValue).toHaveBeenLastCalledWith('@src/a.ts ');
    });
    it('Tab も何も入れず、外へも出ない', async () => {
      const onValue = vi.fn();
      const { f } = byQuery({ d: ['docs/dialogs.md', 'src/views/Dialog.tsx'] });
      const { ta, outerKeyDown } = await mount({ files: f }, { projectId: 'p1', onValue });
      type(ta, '@d');
      await settle();
      expect(options()).toEqual(['docs/dialogs.md', 'src/views/Dialog.tsx']);
      type(ta, '@di');
      await settle();
      expect(fireEvent.keyDown(ta, { key: 'Tab' })).toBe(false);
      expect(onValue).toHaveBeenLastCalledWith('@di');
      expect(outerKeyDown).not.toHaveBeenCalled();
      // Shift+Tab は逆向きの移動なので、待っている間も通す。
      fireEvent.keyDown(ta, { key: 'Tab', shiftKey: true });
      expect(outerKeyDown).toHaveBeenCalledTimes(1);
    });
    it('⌘Enter は返事を待つ間も、外（起動）へ通す', async () => {
      const { f } = byQuery({ d: ['docs/dialogs.md'] });
      const { ta, outerKeyDown } = await mount({ files: f }, { projectId: 'p1' });
      type(ta, '@d');
      await settle();
      type(ta, '@di');
      expect(fireEvent.keyDown(ta, { key: 'Enter', metaKey: true })).toBe(true);
      expect(outerKeyDown).toHaveBeenCalledTimes(1);
    });
    it('最初の返事を待つ間（一覧がまだ無い）も、Enter と Tab は何も入れず、外へも出ない', async () => {
      const onValue = vi.fn();
      const { f, waiting } = byQuery({});
      const { ta, outerKeyDown } = await mount({ files: f }, { projectId: 'p1', onValue });
      type(ta, '@sr');
      await settle();
      expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
      expect(fireEvent.keyDown(ta, { key: 'Enter' })).toBe(false);
      expect(fireEvent.keyDown(ta, { key: 'Tab' })).toBe(false);
      expect(ta.value).toBe('@sr');
      expect(outerKeyDown).not.toHaveBeenCalled();
      await act(async () => { waiting.sr!(['src/a.ts']); });
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(onValue).toHaveBeenLastCalledWith('@src/a.ts ');
    });
    it('どの行も選ばれた印を持たず、↑↓ は通し、列には古い印を付ける', async () => {
      const { f } = byQuery({ d: ['docs/dialogs.md', 'src/views/Dialog.tsx'] });
      const { ta, outerKeyDown } = await mount({ files: f }, { projectId: 'p1' });
      type(ta, '@d');
      await settle();
      // 返事の来た一覧は、1 行目が選ばれている。
      expect(screen.getByRole('listbox')).not.toHaveAttribute('data-stale');
      expect(screen.getAllByRole('option')[0]).toHaveAttribute('data-active', 'true');
      type(ta, '@di');
      await settle();
      expect(screen.getByRole('listbox')).toHaveAttribute('data-stale', 'true');
      for (const o of screen.getAllByRole('option')) {
        expect(o).toHaveAttribute('aria-selected', 'false');
        expect(o).not.toHaveAttribute('data-active');
      }
      expect(ta).not.toHaveAttribute('aria-activedescendant');
      fireEvent.keyDown(ta, { key: 'ArrowDown' });
      fireEvent.keyDown(ta, { key: 'ArrowUp' });
      expect(outerKeyDown).toHaveBeenCalledTimes(2);
    });
    it('行を押しても入らない（欄のフォーカスは奪わない）', async () => {
      const onValue = vi.fn();
      const { f } = byQuery({ d: ['docs/dialogs.md'] });
      const { ta } = await mount({ files: f }, { projectId: 'p1', onValue });
      type(ta, '@d');
      await settle();
      type(ta, '@di');
      await settle();
      expect(fireEvent.mouseDown(screen.getByRole('option', { name: 'docs/dialogs.md' }))).toBe(false);
      expect(onValue).toHaveBeenLastCalledWith('@di');
    });
    it('Enter で入れて閉じた後の別の @x は、前の一覧ではなく「読み込んでいます」から始める', async () => {
      const { f } = byQuery({ d: ['docs/dialogs.md'] });
      const { ta } = await mount({ files: f }, { projectId: 'p1' });
      type(ta, '@d');
      await settle();
      fireEvent.keyDown(ta, { key: 'Enter' });
      expect(ta.value).toBe('@docs/dialogs.md ');
      type(ta, '@docs/dialogs.md @x');
      await settle();
      expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });
    it('Esc で閉じた後に同じ位置で打ち直した @ も、前の一覧を持ち越さない', async () => {
      const { f } = byQuery({ d: ['docs/dialogs.md'] });
      const { ta } = await mount({ files: f }, { projectId: 'p1' });
      type(ta, '@d');
      await settle();
      fireEvent.keyDown(ta, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      type(ta, '@dx');
      await settle();
      expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });
    it('欄を外して戻ったときも、前の一覧を持ち越さない', async () => {
      const { f } = byQuery({ d: ['docs/dialogs.md'] });
      const { ta } = await mount({ files: f }, { projectId: 'p1' });
      type(ta, '@d');
      await settle();
      fireEvent.blur(ta);
      type(ta, '@dz');
      await settle();
      expect(screen.getByText('読み込んでいます')).toBeInTheDocument();
      expect(screen.queryAllByRole('option')).toHaveLength(0);
    });
  });

  it('@ を開いたままプロジェクトが変わったら、前のプロジェクトの一覧は出さず、入れもしない', async () => {
    const onValue = vi.fn();
    const f = vi.fn((p: string) => (p === 'p1' ? Promise.resolve(['one.ts']) : new Promise<string[]>(() => {})));
    function Switch() {
      const [project, setProject] = useState('p1');
      return <><button type="button" onClick={() => setProject('p2')}>切り替え</button><Host projectId={project} onValue={onValue} /></>;
    }
    render(<PromptAssistContext.Provider value={{ ...NO_ASSIST, commands: () => Promise.resolve(COMMANDS), files: f }}><label htmlFor="p">初期プロンプト（任意）</label><Switch /></PromptAssistContext.Provider>);
    const ta = screen.getByLabelText('初期プロンプト（任意）') as HTMLTextAreaElement;
    type(ta, '@o');
    await settle();
    expect(options()).toEqual(['one.ts']);
    fireEvent.click(screen.getByRole('button', { name: '切り替え' }));
    await settle();
    expect(f).toHaveBeenLastCalledWith('p2', 'o');
    expect(options()).toEqual([]);
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('@o');
  });
});

describe('PromptComposer の候補の高さ（窓に収める）', () => {
  // jsdom は寸法を持たない。欄の位置、窓の高さ、一覧の高さ（offsetHeight）を差し替えて、置く側の高さの上限を確かめる。
  const saved = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
  const innerHeight = window.innerHeight;
  // 一覧の高さを読む（= 描き直しを強いる）たびに呼ぶ。本物の窓が、上限の変更に合わせて scrollTop を詰める動きを写すのに使う。
  let onLayout: () => void = () => {};
  afterEach(() => {
    vi.restoreAllMocks();
    onLayout = () => {};
    if (saved) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', saved); else delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: innerHeight });
  });
  async function openAt(top: number, bottom: number) {
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: 600 });
    // 一覧は 300px 分の行を持つ（上限どおり）。
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get(this: HTMLElement) { if (!this.classList.contains('pc-pop')) return 0; onLayout(); return 300; } });
    const { ta } = await mount();
    const rect = vi.spyOn(ta.closest('.pc-box')!, 'getBoundingClientRect').mockReturnValue({ top, bottom, left: 10, right: 410, width: 400, height: bottom - top, x: 10, y: top, toJSON: () => ({}) });
    type(ta, '/');
    const rows = screen.getByRole('listbox');
    return { pop: rows.parentElement as HTMLElement, rows, rect };
  }
  it('上に開くときは、欄の上にある高さより高くしない（窓の上へはみ出さない）', async () => {
    // 下は 600-380-14=206、上は 260-14=246。300px の一覧は下に入らず、広い上へ開く。
    const { pop } = await openAt(260, 380);
    expect(pop).toHaveAttribute('data-up', 'true');
    expect(pop.style.maxHeight).toBe('246px');
  });
  it('下に十分あれば、下へ開き、上限は 300px のまま', async () => {
    const { pop } = await openAt(100, 220);
    expect(pop).not.toHaveAttribute('data-up');
    expect(pop.style.maxHeight).toBe('300px');
  });
  it('一覧の中のスクロールでは測り直さない。ほかの要素のスクロールでは置き直す', async () => {
    const { pop, rows, rect } = await openAt(260, 380);
    const calls = rect.mock.calls.length;
    fireEvent.scroll(rows);
    expect(rect.mock.calls.length).toBe(calls);
    expect(pop.style.maxHeight).toBe('246px');
    fireEvent.scroll(document.body);
    expect(rect.mock.calls.length).toBe(calls + 1);
  });
  it('窓の大きさが変わって置き直しても、上限が効いている一覧のスクロール位置は動かない', async () => {
    const { pop, rows } = await openAt(260, 380);
    // 行は 600px 分。上限 300 のときの scrollTop の最大は 300、上限 246 なら 354。本物の窓は、上限を戻した時点で scrollTop を詰める。
    let stored = 0;
    const clamp = () => { stored = Math.min(stored, Math.max(0, 600 - parseFloat(pop.style.maxHeight || '300'))); };
    Object.defineProperty(rows, 'scrollTop', { configurable: true, get: () => stored, set: (v: number) => { stored = v; clamp(); } });
    onLayout = clamp;
    rows.scrollTop = 340;
    expect(rows.scrollTop).toBe(340);
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(pop.style.maxHeight).toBe('246px');
    expect(rows.scrollTop).toBe(340);
  });
});

describe('PromptComposer の道具の段と、カーソルの後ろの文', () => {
  it('「スキル」を押した文の後ろの文は、候補を入れても残る', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({}, { onValue });
    type(ta, '速くする');
    fireEvent.click(screen.getByRole('button', { name: 'スキル' }));
    fireEvent.keyDown(ta, { key: 'Enter' });
    // 先頭の候補は、よく使うの find-session。
    expect(onValue).toHaveBeenLastCalledWith('/find-session 速くする');
  });
  it('「ファイル」を文の先頭のカーソルで押しても、後ろの語は残る', async () => {
    const onValue = vi.fn();
    const { ta } = await mount({ files: () => Promise.resolve(['README.md']) }, { projectId: 'p1', onValue });
    type(ta, 'fix this');
    ta.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole('button', { name: 'ファイル' }));
    await act(async () => {});
    expect(onValue).toHaveBeenLastCalledWith('@fix this');
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(onValue).toHaveBeenLastCalledWith('@README.md fix this');
  });
});

describe('PromptComposer の添付', () => {
  const png = () => new File([new Uint8Array([1, 2, 3])], '画面 1.png', { type: 'image/png' });
  const upload = () => vi.fn((f: File) => Promise.resolve({ path: `/Users/a/.agent-hangar/drops/1700-0-${f.name.replaceAll(' ', '_')}`, name: f.name, size: f.size }));

  it('貼り付けたファイルを置き場に送り、絵の札で出す', async () => {
    const up = upload();
    const onAttachments = vi.fn();
    const { ta } = await mount({ upload: up }, { onAttachments });
    fireEvent.paste(ta, { clipboardData: { files: [png()] } });
    await act(async () => {});
    expect(up).toHaveBeenCalledTimes(1);
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/Users/a/.agent-hangar/drops/1700-0-画面_1.png', name: '画面 1.png', size: 3 }]);
    const card = screen.getByRole('listitem', { name: '画面 1.png' });
    // 絵は飾り（alt が空）なので、役割では取れない。
    expect(card.querySelector('img')).toHaveAttribute('src', '/api/drops/1700-0-%E7%94%BB%E9%9D%A2_1.png');
    expect(card).toHaveTextContent('1 KB');
  });
  it('ファイルの無い貼り付け（文字だけ）は、そのまま欄に任せる', async () => {
    const up = upload();
    const { ta } = await mount({ upload: up });
    const ev = fireEvent.paste(ta, { clipboardData: { files: [] } });
    expect(ev).toBe(true);
    expect(up).not.toHaveBeenCalled();
  });
  // 表計算や文書ソフトからのコピーは、セルの絵とテキストを同時にクリップボードへ置く。絵だけを添付にして文字を捨てると、文字を貼れなくなる。
  describe('ファイルと文字が一緒に来た貼り付け', () => {
    const clip = (files: File[], text: string) => ({ files, getData: (t: string) => (t === 'text/plain' ? text : '') });
    it('文字がファイル名と関係なければ、ファイルは添付にし、文字は欄に貼らせる（既定の動きを止めない）', async () => {
      const up = upload();
      const { ta } = await mount({ upload: up });
      const notPrevented = fireEvent.paste(ta, { clipboardData: clip([png()], 'A1\tB1\nA2\tB2') });
      await act(async () => {});
      expect(up).toHaveBeenCalledTimes(1);
      expect(notPrevented).toBe(true);
    });
    it('文字がファイル名だけなら（Finder のコピー）、文字は貼らせずファイルだけ添付にする', async () => {
      const up = upload();
      const { ta } = await mount({ upload: up });
      const notPrevented = fireEvent.paste(ta, { clipboardData: clip([png(), new File(['x'], 'b.log')], '画面 1.png\nb.log\n') });
      await act(async () => {});
      expect(up).toHaveBeenCalledTimes(2);
      expect(notPrevented).toBe(false);
    });
    it('ファイルだけなら、既定の動きを止めて添付にする', async () => {
      const up = upload();
      const { ta } = await mount({ upload: up });
      const notPrevented = fireEvent.paste(ta, { clipboardData: clip([png()], '') });
      await act(async () => {});
      expect(up).toHaveBeenCalledTimes(1);
      expect(notPrevented).toBe(false);
    });
    it('文字だけなら、何も送らず、そのまま欄に任せる', async () => {
      const up = upload();
      const { ta } = await mount({ upload: up });
      const notPrevented = fireEvent.paste(ta, { clipboardData: clip([], 'ただの文') });
      expect(up).not.toHaveBeenCalled();
      expect(notPrevented).toBe(true);
    });
  });
  it('画像でないものは、拡張子の印の札にする', async () => {
    const { ta } = await mount({ upload: upload() });
    fireEvent.paste(ta, { clipboardData: { files: [new File(['x'], 'server.log')] } });
    await act(async () => {});
    expect(screen.getByRole('listitem', { name: 'server.log' })).toHaveTextContent('LOG');
  });
  it('× で外す', async () => {
    const onAttachments = vi.fn();
    await mount({}, { initial: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 10 }], onAttachments });
    fireEvent.click(screen.getByRole('button', { name: 'a.png を解除' }));
    expect(onAttachments).toHaveBeenLastCalledWith([]);
  });
  it('添付ボタンで選んだファイルも同じ道を通る', async () => {
    const up = upload();
    await mount({ upload: up });
    fireEvent.change(screen.getByTestId('pc-picker'), { target: { files: [png()] } });
    await act(async () => {});
    expect(up).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('listitem', { name: '画面 1.png' })).toBeInTheDocument();
  });
  it('20 MB を超えるものは送らず、知らせを出す', async () => {
    const up = upload();
    const notify = vi.fn();
    const { ta } = await mount({ upload: up, notify });
    const big = new File([new Uint8Array(1)], 'big.bin');
    Object.defineProperty(big, 'size', { value: 20 * 1024 * 1024 + 1 });
    fireEvent.paste(ta, { clipboardData: { files: [big] } });
    await act(async () => {});
    expect(up).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('big.bin は 20 MB を超えているので添付できません');
  });
  it('送るのに失敗したら知らせを出し、札は足さない', async () => {
    const notify = vi.fn();
    const { ta } = await mount({ upload: () => Promise.reject(new Error('だめ')), notify });
    fireEvent.paste(ta, { clipboardData: { files: [png()] } });
    await act(async () => {});
    expect(notify).toHaveBeenCalledWith('画面 1.png を添付できませんでした（だめ）');
    expect(screen.queryByRole('listitem')).toBeNull();
  });
  it('ブラウザで欄に落としたファイルも送る', async () => {
    const up = upload();
    const { ta } = await mount({ upload: up });
    fireEvent.drop(ta, { dataTransfer: { files: [png()] } });
    await act(async () => {});
    expect(up).toHaveBeenCalledTimes(1);
  });
  // ブラウザで欄を少し外してファイルを落とすと、ページがそのファイルへ移り、書きかけの内容が消える。欄の外では何も添付せず、既定の動きだけを止める。
  describe('欄の外へ落としたファイル', () => {
    it('部品がある間は、ページのどこへ落としても既定の動き（ファイルを開く）を止め、何も添付しない', async () => {
      const up = upload();
      await mount({ upload: up });
      const files = { types: ['Files'], files: [png()] };
      expect(fireEvent.dragOver(document.body, { dataTransfer: files })).toBe(false);
      expect(fireEvent.drop(document.body, { dataTransfer: files })).toBe(false);
      await act(async () => {});
      expect(up).not.toHaveBeenCalled();
      expect(screen.queryByRole('listitem')).toBeNull();
    });
    it('ファイルでないもの（選んだ文字など）の drag と drop は止めない', async () => {
      await mount({ upload: upload() });
      const text = { types: ['text/plain'], files: [] };
      expect(fireEvent.dragOver(document.body, { dataTransfer: text })).toBe(true);
      expect(fireEvent.drop(document.body, { dataTransfer: text })).toBe(true);
    });
    it('部品を外した後は止めない', async () => {
      await mount({ upload: upload() });
      cleanup();
      const files = { types: ['Files'], files: [png()] };
      expect(fireEvent.dragOver(document.body, { dataTransfer: files })).toBe(true);
      expect(fireEvent.drop(document.body, { dataTransfer: files })).toBe(true);
    });
  });
  // jsdom には elementFromPoint が無い。spyOn が掴めるよう、先に空の実装を置く。
  const pointAt = (el: Element | null) => {
    if (!document.elementFromPoint) Object.defineProperty(document, 'elementFromPoint', { configurable: true, writable: true, value: () => null });
    return vi.spyOn(document, 'elementFromPoint').mockReturnValue(el);
  };
  it('殻からのドロップは、落とした位置が欄のときだけ、届いたパスを添付にする', async () => {
    const onAttachments = vi.fn();
    const { ta } = await mount({}, { onAttachments });
    const hit = pointAt(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/Users/a/.agent-hangar/drops/1700-0-shot.png'], x: 5, y: 6 } })); });
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/Users/a/.agent-hangar/drops/1700-0-shot.png', name: 'shot.png', size: null }]);
    hit.mockReturnValue(document.body);
    onAttachments.mockClear();
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/x.png'], x: 5, y: 6 } })); });
    expect(onAttachments).not.toHaveBeenCalled();
    hit.mockRestore();
  });
  it('殻のドラッグが欄の上にある間だけ、落とせる印を付ける', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    const hit = pointAt(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 1, y: 1 } })); });
    expect(box).toHaveAttribute('data-drop', 'true');
    hit.mockReturnValue(document.body);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 900, y: 1 } })); });
    expect(box).not.toHaveAttribute('data-drop');
    hit.mockReturnValue(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 1, y: 1 } })); });
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: null })); });
    expect(box).not.toHaveAttribute('data-drop');
    hit.mockRestore();
  });
  it('ブラウザでファイルを欄の上へ運んでいる間も、落とせる印を付ける', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    fireEvent.dragOver(ta, { dataTransfer: { types: ['Files'], files: [] } });
    expect(box).toHaveAttribute('data-drop', 'true');
    fireEvent.dragLeave(ta);
    expect(box).not.toHaveAttribute('data-drop');
  });
  it('殻のドロップが届いたら、欄の中でも外でも、落とせる印を消す', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    const hit = pointAt(ta);
    for (const landing of [ta, document.body]) {
      act(() => { window.dispatchEvent(new CustomEvent('hangar:drag', { detail: { x: 1, y: 1 } })); });
      expect(box).toHaveAttribute('data-drop', 'true');
      hit.mockReturnValue(landing);
      act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/x.png'], x: 1, y: 1 } })); });
      expect(box).not.toHaveAttribute('data-drop');
      hit.mockReturnValue(ta);
    }
    hit.mockRestore();
  });
  it('ブラウザで欄に落としたら、落とせる印を消し、ファイルは送る', async () => {
    const up = upload();
    const { ta } = await mount({ upload: up });
    const box = ta.closest('.pc-box')!;
    fireEvent.dragOver(ta, { dataTransfer: { types: ['Files'], files: [] } });
    expect(box).toHaveAttribute('data-drop', 'true');
    fireEvent.drop(ta, { dataTransfer: { files: [png()] } });
    await act(async () => {});
    expect(box).not.toHaveAttribute('data-drop');
    expect(up).toHaveBeenCalledTimes(1);
  });
  it('ブラウザで運んでいるものが欄の中の別の部品へ移るだけなら印を残し、欄の外へ出たら（行き先が不明でも）消す', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    const inside = screen.getByRole('button', { name: /スキル/ });
    const outside = document.body;
    fireEvent.dragOver(ta, { dataTransfer: { types: ['Files'], files: [] } });
    // jsdom の dragleave は初期値の relatedTarget を捨てるので、イベントに直に持たせる。
    const leaveTo = (to: EventTarget) => {
      const ev = createEvent.dragLeave(ta);
      Object.defineProperty(ev, 'relatedTarget', { value: to });
      fireEvent(ta, ev);
    };
    leaveTo(inside);
    expect(box).toHaveAttribute('data-drop', 'true');
    leaveTo(outside);
    expect(box).not.toHaveAttribute('data-drop');
    fireEvent.dragOver(ta, { dataTransfer: { types: ['Files'], files: [] } });
    fireEvent.dragLeave(ta);
    expect(box).not.toHaveAttribute('data-drop');
  });
  it('ファイルでないもの（選んだ文字など）を運んでいる間は、印を付けない', async () => {
    const { ta } = await mount();
    const box = ta.closest('.pc-box')!;
    fireEvent.dragOver(ta, { dataTransfer: { types: ['text/plain'], files: [] } });
    expect(box).not.toHaveAttribute('data-drop');
  });
  it('同じパスは 2 度足さない', async () => {
    const onAttachments = vi.fn();
    const { ta } = await mount({}, { initial: [{ path: '/x.png', name: 'x.png', size: null }], onAttachments });
    const hit = pointAt(ta);
    act(() => { window.dispatchEvent(new CustomEvent('hangar:drop', { detail: { paths: ['/x.png'], x: 1, y: 1 } })); });
    expect(onAttachments).not.toHaveBeenCalled();
    hit.mockRestore();
  });
  it('開いたときに置き場から消えていた添付は、札から外す', async () => {
    const onAttachments = vi.fn();
    await mount({ existing: (paths) => Promise.resolve(paths.filter((p) => p.endsWith('b.png'))) }, { initial: [{ path: '/d/a.png', name: 'a.png', size: 1 }, { path: '/d/b.png', name: 'b.png', size: 1 }], onAttachments });
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/d/b.png', name: 'b.png', size: 1 }]);
  });
  it('あるかどうかを確かめられなかったら、添付はそのまま残す', async () => {
    const onAttachments = vi.fn();
    await mount({ existing: () => Promise.reject(new Error('x')) }, { initial: [{ path: '/d/a.png', name: 'a.png', size: 1 }], onAttachments });
    expect(onAttachments).not.toHaveBeenCalled();
    expect(screen.getByRole('listitem', { name: 'a.png' })).toBeInTheDocument();
  });
});

describe('PromptComposer の送っている最中の札', () => {
  const file = (name: string) => new File([new Uint8Array([1])], name, { type: 'image/png' });
  /** 手で解決できる送信。呼んだ順に resolvers へ積む。 */
  function manual() {
    const resolvers: { name: string; ok: (path: string) => void; ng: (e: Error) => void }[] = [];
    const upload = vi.fn((f: File) => new Promise<{ path: string; name: string; size: number }>((resolve, reject) => {
      resolvers.push({ name: f.name, ok: (path) => resolve({ path, name: f.name, size: 2048 }), ng: reject });
    }));
    return { upload, resolvers };
  }

  it('送っている間は「送っています」の札を出し、件数を知らせ、終わったら本物の札に替える', async () => {
    const { upload, resolvers } = manual();
    const onPending = vi.fn();
    const { ta } = await mount({ upload }, { onPending });
    fireEvent.paste(ta, { clipboardData: { files: [file('a.png')] } });
    const busy = screen.getByRole('listitem', { name: 'a.png' });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(busy).toHaveTextContent('送っています');
    expect(within(busy).queryByRole('button')).toBeNull();
    expect(onPending.mock.calls).toEqual([[1]]);
    await act(async () => { resolvers[0]!.ok('/h/.agent-hangar/drops/1-0-a.png'); });
    const real = screen.getByRole('listitem', { name: 'a.png' });
    expect(real).not.toHaveAttribute('aria-busy');
    expect(real).toHaveTextContent('2 KB');
    expect(within(real).getByRole('button', { name: 'a.png を解除' })).toBeInTheDocument();
    expect(onPending.mock.calls).toEqual([[1], [0]]);
  });
  it('2 件送って後のほうが先に終わっても、札は渡した順に並ぶ', async () => {
    const { upload, resolvers } = manual();
    const onAttachments = vi.fn();
    const { ta } = await mount({ upload }, { onAttachments });
    fireEvent.paste(ta, { clipboardData: { files: [file('a.png'), file('b.png')] } });
    await act(async () => { resolvers[1]!.ok('/h/.agent-hangar/drops/1-1-b.png'); });
    // 先のものがまだなので、並びを崩さないよう確定は待つ。
    expect(onAttachments).not.toHaveBeenCalled();
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['a.png', 'b.png']);
    await act(async () => { resolvers[0]!.ok('/h/.agent-hangar/drops/1-0-a.png'); });
    expect(onAttachments).toHaveBeenLastCalledWith([
      { path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 2048 },
      { path: '/h/.agent-hangar/drops/1-1-b.png', name: 'b.png', size: 2048 },
    ]);
    expect(screen.getAllByRole('listitem').map((li) => li.getAttribute('aria-label'))).toEqual(['a.png', 'b.png']);
    expect(document.querySelector('[aria-busy]')).toBeNull();
  });
  it('失敗した送信の札は外し、件数を戻す。知らせは出す', async () => {
    const { upload, resolvers } = manual();
    const onPending = vi.fn();
    const notify = vi.fn();
    const { ta } = await mount({ upload, notify }, { onPending });
    fireEvent.paste(ta, { clipboardData: { files: [file('a.png')] } });
    await act(async () => { resolvers[0]!.ng(new Error('だめ')); });
    expect(screen.queryByRole('listitem')).toBeNull();
    expect(onPending.mock.calls).toEqual([[1], [0]]);
    expect(notify).toHaveBeenCalledWith('a.png を添付できませんでした（だめ）');
  });
  it('先のものが失敗したら、待っていた後のものを確定する', async () => {
    const { upload, resolvers } = manual();
    const onAttachments = vi.fn();
    const { ta } = await mount({ upload }, { onAttachments });
    fireEvent.paste(ta, { clipboardData: { files: [file('a.png'), file('b.png')] } });
    await act(async () => { resolvers[1]!.ok('/h/.agent-hangar/drops/1-1-b.png'); });
    await act(async () => { resolvers[0]!.ng(new Error('x')); });
    expect(onAttachments).toHaveBeenLastCalledWith([{ path: '/h/.agent-hangar/drops/1-1-b.png', name: 'b.png', size: 2048 }]);
  });
  it('絵が読めなければ、拡張子の印に替える', async () => {
    await mount({}, { initial: [{ path: '/h/.agent-hangar/drops/1-0-a.png', name: 'a.png', size: 10 }] });
    const card = screen.getByRole('listitem', { name: 'a.png' });
    fireEvent.error(card.querySelector('img')!);
    expect(card.querySelector('img')).toBeNull();
    expect(card).toHaveTextContent('PNG');
  });
});
