import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { translator } from '@agent-hangar/shared';
import { EditableNote } from './EditableNote.tsx';
import { sessionNoteTexts } from './NoteEditor.tsx';
import { LanguageRoot } from './primitives/language.tsx';

// 読む表示と編集の欄を切り替えるノート。セッション画面の冒頭の 1 枚とプロジェクトの画面の右パネルが同じ部品を使う。
const ja = translator('ja');
const head = (button: React.ReactNode) => <div className="h"><span>ノートの見出し</span>{button}</div>;

function mount(text: string, onSave = vi.fn<(t: string) => void>()) {
  const ui = (t: string) => <LanguageRoot language="ja"><EditableNote text={t} onSave={onSave} texts={sessionNoteTexts(ja)} head={head} /></LanguageRoot>;
  const r = render(ui(text));
  return { onSave, rerender: (t: string) => r.rerender(ui(t)) };
}
const area = () => screen.getByRole('textbox', { name: 'ノート' }) as HTMLTextAreaElement;

describe('EditableNote の読む表示', () => {
  it('中身があれば本文を読む形で出し、入力欄は出さない。ボタンは「ノートを編集」', () => {
    mount('決済は v3');
    expect(screen.getByText('決済は v3')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'ノートを編集' })).toBeInTheDocument();
  });
  it('空なら本文は出さず、ボタンは「ノートを書く」', () => {
    mount('  ');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'ノートを書く' })).toBeInTheDocument();
  });
  it('見出しは呼び手が組む。ボタンはその中に入る', () => {
    mount('a');
    expect(screen.getByText('ノートの見出し').parentElement).toContainElement(screen.getByRole('button', { name: 'ノートを編集' }));
  });
});

describe('EditableNote の編集', () => {
  it('「ノートを編集」で欄が開き、今の本文が入る。ボタンは消える', () => {
    mount('決済は v3');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    expect(area()).toHaveValue('決済は v3');
    expect(area()).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'ノートを編集' })).toBeNull();
  });
  it('書き換えていなければ保存できない', () => {
    mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
  it('保存のボタンで onSave を呼び、読む表示に戻る', () => {
    const { onSave } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('⌘Enter でも保存する。変換中の Enter では保存しない', () => {
    const { onSave } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: 'b' } });
    fireEvent.keyDown(area(), { key: 'Enter', metaKey: true, keyCode: 229 });
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.keyDown(area(), { key: 'Enter', metaKey: true });
    expect(onSave).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('Esc で編集をやめ、書きかけは捨てる。開き直すと元の本文', () => {
    const { onSave } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: '書きかけ' } });
    fireEvent.keyDown(area(), { key: 'Escape' });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('a')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    expect(area()).toHaveValue('a');
  });
  it('変換中の Esc では閉じない', () => {
    mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.keyDown(area(), { key: 'Escape', keyCode: 229 });
    expect(area()).toBeInTheDocument();
  });
  it('空にして保存すると空を渡し、「ノートを書く」に戻る', () => {
    const { onSave, rerender } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledWith('');
    rerender('');
    expect(screen.getByRole('button', { name: 'ノートを書く' })).toBeInTheDocument();
  });
});

describe('EditableNote の保存の失敗と外の更新', () => {
  it('保存が通らず本文が変わらなかったときは、開き直すと書いた下書きが残っていて、また保存できる', () => {
    const { onSave } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    // 失敗はトーストで知らされ、本文（props）は変わらない。
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    expect(area()).toHaveValue('b');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(onSave).toHaveBeenCalledTimes(2);
  });
  it('保存が通って本文が戻ってきたあとは、開き直しても元の欄に新しい本文が入る', () => {
    const { rerender } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    rerender('b');
    expect(screen.getByText('b')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    expect(area()).toHaveValue('b');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
  it('編集していないときに外から変わったら、読む表示がそのまま追う', () => {
    const { rerender } = mount('a');
    rerender('外');
    expect(screen.getByText('外')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    expect(area()).toHaveValue('外');
  });
  it('書きかけがあるときに外から変わったら、捨てずに知らせ、「読み込む」で差し替える', () => {
    const { rerender } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: '書きかけ' } });
    rerender('外');
    expect(area()).toHaveValue('書きかけ');
    expect(screen.getByText('ほかで更新されました')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '読み込む' }));
    expect(area()).toHaveValue('外');
    expect(screen.queryByText('ほかで更新されました')).toBeNull();
  });
  it('編集を始めただけで書き換えていなければ、外の更新を知らせず追う', () => {
    const { rerender } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    rerender('外');
    expect(area()).toHaveValue('外');
    expect(screen.queryByText('ほかで更新されました')).toBeNull();
  });
  it('編集中に自分の保存が戻ってきても、外の更新とは言わない', () => {
    const { rerender } = mount('a');
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    fireEvent.click(screen.getByRole('button', { name: 'ノートを編集' }));
    fireEvent.change(area(), { target: { value: 'b の続き' } });
    rerender('b');
    expect(screen.queryByText('ほかで更新されました')).toBeNull();
    expect(area()).toHaveValue('b の続き');
  });
});
