import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { PromptCommandDto } from '@agent-hangar/shared';
import { IntentRoot } from '../../intent/chain.tsx';
import { Clamp } from './Clamp.tsx';
import { CommandLine, CopyButton } from './CommandLine.tsx';
import { CopyButton as PlainCopyButton } from './CopyButton.tsx';
import { Dialog } from './Dialog.tsx';
import { LanguageRoot } from './language.tsx';
import { Listbox } from './Listbox.tsx';
import { NO_ASSIST, PromptAssistContext, type PromptAssist } from './promptAssist.ts';
import { PromptComposer } from './PromptComposer.tsx';
import type { Attachment } from './promptComposerModel.ts';
import { RollingNumber } from './RollingNumber.tsx';
import { Stepper } from './Stepper.tsx';

/** 言語を英語にしたとき、共通の部品の文が英語で出る。日本語の文が混ざらないことも見る。 */
const JAPANESE = /[぀-ヿ㐀-鿿]/;
const inEnglish = (ui: React.ReactNode) => render(<LanguageRoot language="en"><IntentRoot onIntent={vi.fn()}>{ui}</IntentRoot></LanguageRoot>);
const noJapanese = () => expect(document.body.textContent ?? '').not.toMatch(JAPANESE);

describe('共通の部品（英語）', () => {
  it('畳み：残りの行数が英語で出て、開くと Collapse になる', () => {
    const { unmount } = inEnglish(<Clamp seq={1} part="a" lines={20} shown={15} children={() => 'body'} />);
    expect(screen.getByRole('button', { name: 'Show all (5 more lines)' })).toBeInTheDocument();
    unmount();
    inEnglish(<Clamp seq={1} part="b" lines={19} shown={15} children={() => 'body'} />);
    expect(screen.getByRole('button', { name: 'Show all (4 more lines)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button', { name: 'Collapse' })).toBeInTheDocument();
    noJapanese();
  });
  it('コピーのボタン：名前と、押したあとの文', () => {
    inEnglish(<CommandLine command="brew install tmux" />);
    expect(screen.getByRole('button', { name: 'Copy brew install tmux' })).toHaveTextContent('Copy');
    noJapanese();
  });
  it('コピーのボタン：名前を渡せば、その名前で読み上げる', () => {
    inEnglish(<CopyButton text="tok" name="Token" label="Copy" />);
    expect(screen.getByRole('button', { name: 'Copy Token' })).toBeInTheDocument();
    noJapanese();
  });
  it('コピーのボタン（単独）：ラベルが英語で、押すと Copied になる', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    inEnglish(<PlainCopyButton text="x" />);
    expect(screen.getByRole('button')).toHaveTextContent('Copy');
    await act(async () => { fireEvent.click(screen.getByRole('button')); });
    expect(screen.getByRole('button')).toHaveTextContent('Copied');
    noJapanese();
  });
  it('ダイアログ：閉じるの名前', () => {
    inEnglish(<Dialog title="Title" onClose={() => {}}>body</Dialog>);
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    noJapanese();
  });
  it('選択欄：置き文字、検索欄、一致なし、キーの案内', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ value: `p${i}`, label: `proj-${i}` }));
    inEnglish(<Listbox label="Project" value={null} options={many} onChange={() => {}} />);
    const face = screen.getByRole('button', { name: 'Project' });
    expect(face).toHaveTextContent('Select');
    fireEvent.click(face);
    const box = screen.getByRole('combobox', { name: 'Search Project' });
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.getByText(/Navigate/)).toBeInTheDocument();
    expect(screen.getByText(/Close/)).toBeInTheDocument();
    noJapanese();
  });
  it('数の欄：増減ボタンの名前', () => {
    inEnglish(<Stepper label="Limit" value="5" min={1} max={9} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Decrease Limit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Increase Limit' })).toBeInTheDocument();
    noJapanese();
  });
  it('数：読めない値は Not available と書く', () => {
    inEnglish(<RollingNumber value={null} />);
    expect(document.body).toHaveTextContent('Not available');
    noJapanese();
  });
});

const cmd = (name: string, uses: number, source: PromptCommandDto['source']): PromptCommandDto => ({ name, description: '', argumentHint: null, source, uses });

function Host(props: { projectId: string | null; initial?: Attachment[] }) {
  const [value, setValue] = useState('');
  const [atts, setAtts] = useState<Attachment[]>(props.initial ?? []);
  return <PromptComposer id="p" value={value} onChange={setValue} projectId={props.projectId} attachments={atts} onAttachmentsChange={setAtts} />;
}
async function mountComposer(assist: Partial<PromptAssist>, projectId: string | null) {
  const full: PromptAssist = { ...NO_ASSIST, ...assist };
  render(<LanguageRoot language="en"><PromptAssistContext.Provider value={full}><label htmlFor="p">Prompt</label><Host projectId={projectId} initial={[{ path: '/x/a.txt', name: 'a.txt', size: 2048 }]} /></PromptAssistContext.Provider></LanguageRoot>);
  await act(async () => {});
  return screen.getByLabelText('Prompt') as HTMLTextAreaElement;
}
const type = (ta: HTMLTextAreaElement, value: string) => { fireEvent.focus(ta); fireEvent.change(ta, { target: { value, selectionStart: value.length, selectionEnd: value.length } }); };

describe('初期プロンプト欄（英語）', () => {
  it('道具の釦、案内、添付の札が英語で出る。プロジェクト未選択のファイルの釦は理由を添える', async () => {
    await mountComposer({}, null);
    expect(screen.getByRole('button', { name: 'Skills' })).toBeInTheDocument();
    const files = screen.getByRole('button', { name: 'Files' });
    expect(files).toBeDisabled();
    expect(files).toHaveAttribute('title', 'Select a project to use this');
    expect(screen.getByRole('button', { name: /Attach/ })).toBeInTheDocument();
    expect(screen.getByText('You can also paste images with ⌘V')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Attachments' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove a.txt' })).toBeInTheDocument();
    noJapanese();
  });
  it('/ の候補：群の見出しと出どころが英語で出る', async () => {
    const ta = await mountComposer({ commands: () => Promise.resolve([cmd('goal', 3, 'user'), cmd('init', 0, 'builtin'), cmd('deploy', 0, 'project')]) }, 'p1');
    type(ta, '/');
    expect(screen.getByRole('listbox', { name: 'Skills and commands' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Frequently used' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'This project' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Built-in' })).toBeInTheDocument();
    expect(screen.getAllByText('Personal').length).toBeGreaterThan(0);
    noJapanese();
  });
  it('/ の候補：読めなかったときと一致なし', async () => {
    const ta = await mountComposer({ commands: () => Promise.reject(new Error('x')) }, 'p1');
    type(ta, '/');
    expect(screen.getByText('Could not load')).toBeInTheDocument();
    noJapanese();
  });
  it('@ の候補：見出しが英語で出る', async () => {
    const ta = await mountComposer({ files: () => Promise.resolve(['src/a.ts']) }, 'p1');
    type(ta, '@');
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(screen.getByRole('listbox', { name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('Changed files')).toBeInTheDocument();
    noJapanese();
  });
  it('添付できなかったときの知らせが英語で出る（大きすぎる、使えない）', async () => {
    const notify = vi.fn();
    await mountComposer({ notify }, 'p1');
    const picker = screen.getByTestId('pc-picker');
    const big = new File(['x'], 'big.bin');
    Object.defineProperty(big, 'size', { value: 21 * 1024 * 1024 });
    fireEvent.change(picker, { target: { files: [big] } });
    expect(notify).toHaveBeenCalledWith('big.bin is over 20 MB and cannot be attached');
    fireEvent.change(picker, { target: { files: [new File(['x'], 'a.txt')] } });
    await act(async () => {});
    expect(notify).toHaveBeenLastCalledWith('Could not attach a.txt (Attachments are not available)');
  });
});
