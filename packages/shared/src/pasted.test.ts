import { describe, expect, it } from 'vitest';
import { pastedParts, utteranceHead, stripPasted } from './pasted.ts';

const P = (id: string, body: string) => `<pasted_content id="${id}">\n${body}\n</pasted_content id="${id}">`;

describe('pastedParts', () => {
  it('貼り付けと本人の文を書かれた順に分け、タグと前後の空行を外す', () => {
    const text = `\n\n${P('bf73', 'いちばん見込みがある\n\n全部買付')}\n\nこれについて、なんか私の方で対応することある？`;
    expect(pastedParts(text)).toEqual([
      { paste: true, text: 'いちばん見込みがある\n\n全部買付' },
      { paste: false, text: 'これについて、なんか私の方で対応することある？' },
    ]);
  });

  it('貼り付けが複数あれば、本人の文を挟んで別の部分にする', () => {
    const text = `前置き\n${P('a1', '一つ目')}\nあいだ\n${P('b2', '二つ目')}`;
    expect(pastedParts(text)).toEqual([
      { paste: false, text: '前置き' },
      { paste: true, text: '一つ目' },
      { paste: false, text: 'あいだ' },
      { paste: true, text: '二つ目' },
    ]);
  });

  it('タグが無ければ本文 1 つをそのまま返す（空白も触らない）', () => {
    expect(pastedParts('  ふつうの指示\n')).toEqual([{ paste: false, text: '  ふつうの指示\n' }]);
  });

  it('id のそろわない閉じタグや閉じの無い開きタグは、手を付けない', () => {
    const odd = '<pasted_content id="a">\n中身\n</pasted_content id="b">';
    expect(pastedParts(odd)).toEqual([{ paste: false, text: odd }]);
    const open = 'まえ <pasted_content id="a">\n中身';
    expect(pastedParts(open)).toEqual([{ paste: false, text: open }]);
  });

  it('頭が開きタグで閉じが無い（200 字で切った一行）ときは、開きタグだけ外して貼り付けとして扱う', () => {
    expect(pastedParts('\n\n<pasted_content id="a">\n途中まで')).toEqual([{ paste: true, text: '途中まで' }]);
  });
});

describe('utteranceHead', () => {
  it('本人の文を先に出す', () => {
    expect(utteranceHead(`${P('a', '貼り付け')}\n\n対応することある？`)).toBe('対応することある？');
  });
  it('本人の文が無ければ貼り付けの中身を出す', () => {
    expect(utteranceHead(`\n\n${P('a', '貼り付けだけ')}\n`)).toBe('貼り付けだけ');
  });
  it('タグが無ければそのまま', () => {
    expect(utteranceHead('そのまま')).toBe('そのまま');
  });
});

describe('stripPasted', () => {
  it('タグだけ外して書かれた順に並べる（検索の索引向け）', () => {
    expect(stripPasted(`${P('a', '中身')}\n\n問い`)).toBe('中身\n問い');
  });
});
