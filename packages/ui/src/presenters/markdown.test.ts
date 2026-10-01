import { describe, expect, it } from 'vitest';
import { mdLeaves, parseInline, parseMarkdown, safeHref } from './markdown.ts';

describe('parseMarkdown の塊', () => {
  it('囲みのコードは言語名と中身の塊にし、前後の文は段落にする', () => {
    expect(parseMarkdown('前の文\n```ts\nconst a = 1;\n```\n後の文')).toEqual([
      { t: 'p', inl: [{ t: 'text', text: '前の文' }] },
      { t: 'code', lang: 'ts', text: 'const a = 1;' },
      { t: 'p', inl: [{ t: 'text', text: '後の文' }] },
    ]);
  });
  it('閉じていない囲みは末尾までコードにする', () => {
    expect(parseMarkdown('説明\n```\nnpm run build')).toEqual([
      { t: 'p', inl: [{ t: 'text', text: '説明' }] },
      { t: 'code', lang: '', text: 'npm run build' },
    ]);
  });
  it('# の数を見出しの段にする', () => {
    expect(parseMarkdown('## 結果\n本文')).toEqual([
      { t: 'h', level: 2, inl: [{ t: 'text', text: '結果' }] },
      { t: 'p', inl: [{ t: 'text', text: '本文' }] },
    ]);
  });
  it('見出しの閉じの # と前後の空白は落とす。# の後に空白が無ければ見出しにしない', () => {
    const h = (src: string) => parseMarkdown(src)[0];
    expect(h('## 結果 ##')).toEqual({ t: 'h', level: 2, inl: [{ t: 'text', text: '結果' }] });
    expect(h('#   題  #  ')).toEqual({ t: 'h', level: 1, inl: [{ t: 'text', text: '題' }] });
    expect(h('# 題#')).toEqual({ t: 'h', level: 1, inl: [{ t: 'text', text: '題' }] });
    expect(h('#  #')).toEqual({ t: 'h', level: 1, inl: [] });
    expect(h('   ### 三')).toEqual({ t: 'h', level: 3, inl: [{ t: 'text', text: '三' }] });
    expect(h('#題')).toEqual({ t: 'p', inl: [{ t: 'text', text: '#題' }] });
    expect(h('####### 七')).toEqual({ t: 'p', inl: [{ t: 'text', text: '####### 七' }] });
    expect(h('    # 字下げ')?.t).not.toBe('h');
  });
  // 見出しの読み取りは、長い空白を挟んでも入力の長さに比例する時間で終わる。
  // 正規表現で閉じの # と空白を落とすと、空白 4000 個で 10 秒近くかかっていた。
  it('長い空白の見出しも時間がかからない', () => {
    for (const src of ['# a' + ' '.repeat(10000) + 'x', '# ' + ' '.repeat(10000) + '#'.repeat(10000) + 'x', '#' + ' \t'.repeat(10000)]) {
      const t0 = performance.now();
      parseMarkdown(src);
      expect(performance.now() - t0).toBeLessThan(50);
    }
    expect(parseMarkdown('# a' + ' '.repeat(10000) + 'x')).toEqual([{ t: 'h', level: 1, inl: [{ t: 'text', text: 'a' + ' '.repeat(10000) + 'x' }] }]);
  });
  it('空行で段落を分け、段落の中の改行は残す', () => {
    expect(parseMarkdown('一行目\n二行目\n\n次の段落')).toEqual([
      { t: 'p', inl: [{ t: 'text', text: '一行目\n二行目' }] },
      { t: 'p', inl: [{ t: 'text', text: '次の段落' }] },
    ]);
  });
  it('箇条書きは入れ子を持てる', () => {
    expect(parseMarkdown('- メール\n- パスワード\n  - 8 文字以上\n  - 英字と数字')).toEqual([
      { t: 'list', ordered: false, start: 1, items: [
        [{ t: 'p', inl: [{ t: 'text', text: 'メール' }] }],
        [{ t: 'p', inl: [{ t: 'text', text: 'パスワード' }] }, { t: 'list', ordered: false, start: 1, items: [
          [{ t: 'p', inl: [{ t: 'text', text: '8 文字以上' }] }],
          [{ t: 'p', inl: [{ t: 'text', text: '英字と数字' }] }],
        ] }],
      ] },
    ]);
  });
  it('番号付きは始まりの番号を覚え、番号の下に 3 字下げた箇条書きを入れ子にする', () => {
    expect(parseMarkdown('3. 足した\n   - 条件\n4. 流した')).toEqual([
      { t: 'list', ordered: true, start: 3, items: [
        [{ t: 'p', inl: [{ t: 'text', text: '足した' }] }, { t: 'list', ordered: false, start: 1, items: [[{ t: 'p', inl: [{ t: 'text', text: '条件' }] }]] }],
        [{ t: 'p', inl: [{ t: 'text', text: '流した' }] }],
      ] },
    ]);
  });
  it('項目の間に空行があっても 1 つの一覧のままにする', () => {
    const blocks = parseMarkdown('1. 一つ目\n\n2. 二つ目');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ t: 'list', ordered: true, items: [[{ t: 'p' }], [{ t: 'p' }]] });
  });
  it('項目の中の囲みのコードは、字下げを外してコードにする', () => {
    expect(parseMarkdown('- 打つ\n  ```sh\n  npm test\n  ```')).toEqual([
      { t: 'list', ordered: false, start: 1, items: [[{ t: 'p', inl: [{ t: 'text', text: '打つ' }] }, { t: 'code', lang: 'sh', text: 'npm test' }]] },
    ]);
  });
  it('表は見出しの行と区切りの行で見分け、寄せ方も読む', () => {
    expect(parseMarkdown('| 欄 | 条件 |\n|:---|---:|\n| メール | 形 |\n| パスワード | 8 文字 |')).toEqual([
      { t: 'table', align: ['left', 'right'], head: [[{ t: 'text', text: '欄' }], [{ t: 'text', text: '条件' }]], rows: [
        [[{ t: 'text', text: 'メール' }], [{ t: 'text', text: '形' }]],
        [[{ t: 'text', text: 'パスワード' }], [{ t: 'text', text: '8 文字' }]],
      ] },
    ]);
  });
  it('区切りの行の無い縦線は表にしない', () => {
    expect(parseMarkdown('a | b')).toEqual([{ t: 'p', inl: [{ t: 'text', text: 'a | b' }] }]);
  });
  it('表の行の欄が足りなければ空で埋め、多ければ切る', () => {
    const [table] = parseMarkdown('| a | b |\n|---|---|\n| 1 |\n| 1 | 2 | 3 |');
    expect(table).toMatchObject({ rows: [[[{ t: 'text', text: '1' }], []], [[{ t: 'text', text: '1' }], [{ t: 'text', text: '2' }]]] });
  });
  it('引用は中身を塊として読む', () => {
    expect(parseMarkdown('> push はまだです。\n> - 残り')).toEqual([
      { t: 'quote', children: [{ t: 'p', inl: [{ t: 'text', text: 'push はまだです。' }] }, { t: 'list', ordered: false, start: 1, items: [[{ t: 'p', inl: [{ t: 'text', text: '残り' }] }]] }] },
    ]);
  });
  it('横線', () => {
    expect(parseMarkdown('上\n\n---\n\n下')).toEqual([
      { t: 'p', inl: [{ t: 'text', text: '上' }] }, { t: 'hr' }, { t: 'p', inl: [{ t: 'text', text: '下' }] },
    ]);
  });
});

describe('parseInline', () => {
  it('太字とインラインのコード', () => {
    expect(parseInline('**1. main へ入れる** には `git merge` を打つ')).toEqual([
      { t: 'strong', children: [{ t: 'text', text: '1. main へ入れる' }] },
      { t: 'text', text: ' には ' },
      { t: 'code', text: 'git merge' },
      { t: 'text', text: ' を打つ' },
    ]);
  });
  it('対になっていない記号はそのまま文字にする', () => {
    expect(parseInline('a ** b と `c')).toEqual([{ t: 'text', text: 'a ** b と `c' }]);
  });
  it('斜体と打ち消し', () => {
    expect(parseInline('*軽く* と ~~消した~~')).toEqual([
      { t: 'em', children: [{ t: 'text', text: '軽く' }] }, { t: 'text', text: ' と ' }, { t: 'del', children: [{ t: 'text', text: '消した' }] },
    ]);
  });
  it('識別子の中のアンダースコアや掛け算の星は解釈しない', () => {
    expect(parseInline('snake_case_name と 2 * 3 * 4')).toEqual([{ t: 'text', text: 'snake_case_name と 2 * 3 * 4' }]);
  });
  it('http と https のリンクだけをリンクにする', () => {
    expect(parseInline('[説明](https://example.com/a) と [ファイル](src/a.ts) と [悪い](javascript:alert(1))')).toEqual([
      { t: 'link', href: 'https://example.com/a', children: [{ t: 'text', text: '説明' }] },
      { t: 'text', text: ' と ファイル と 悪い' },
    ]);
  });
  it('裸の URL もリンクにし、後ろの日本語と句読点は含めない', () => {
    expect(parseInline('見て https://example.com/docs?a=1。次へ')).toEqual([
      { t: 'text', text: '見て ' },
      { t: 'link', href: 'https://example.com/docs?a=1', children: [{ t: 'text', text: 'https://example.com/docs?a=1' }] },
      { t: 'text', text: '。次へ' },
    ]);
  });
  it('コードの中は解釈しない', () => {
    expect(parseInline('`**x** [a](https://b)`')).toEqual([{ t: 'code', text: '**x** [a](https://b)' }]);
  });
});

describe('safeHref', () => {
  it('http と https のほかは通さない', () => {
    expect(safeHref('https://a.example/x')).toBe('https://a.example/x');
    expect(safeHref('HTTP://a.example')).toBe('HTTP://a.example');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('//evil.example')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
  });
  // 先頭から末尾までが http(s) の URL であることを見る。途中に http:// を含むだけのものや、空白を挟んだものは通さない。
  it('先頭と末尾を固定して見る', () => {
    expect(safeHref('javascript:x//http://a')).toBeNull();
    expect(safeHref('javascript:alert(1)//https://a.example')).toBeNull();
    expect(safeHref(' https://a.example')).toBeNull();
    expect(safeHref('https://a.example x')).toBeNull();
    expect(safeHref('https://a.example\njavascript:x')).toBeNull();
    expect(safeHref('HTTPS://A.EXAMPLE/X')).toBe('HTTPS://A.EXAMPLE/X');
    expect(safeHref('Https://a.example')).toBe('Https://a.example');
  });
});

describe('mdLeaves', () => {
  it('描く順に文字の葉を並べる。リンクの宛先は葉にしない', () => {
    const blocks = parseMarkdown('## 見出し\n**太字** と [名前](https://x.example)\n\n| a |\n|---|\n| b |\n\n```\ncode\n```');
    expect(mdLeaves(blocks)).toEqual(['見出し', '太字', ' と ', '名前', 'a', 'b', 'code']);
  });
});
