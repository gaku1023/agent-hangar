import { describe, expect, it } from 'vitest';
import { bundledNotes, compareVersions, notesBetween, parseNote } from './releaseNotes.ts';

const FIX = `# Hangar 0.7.2

0.7.1 に上げるときの不具合を 2 つ直しました。

## 直したこと

- クラウドを作った PC で setup cloud をやり直すと、
  同期が止まりました。いまは、新しい鍵を読み直します。
- 古い Worker に、1 回だけ変更を送っていました。
`;

const WITH_BEFORE = `# Hangar 0.7.1

## 更新の前に（クラウド同期を使っている人へ）

この版は、クラウド同期の作りを変えた版です。
古い版のアプリや Worker とは同期しません。

1. すべての PC を 0.7.1 にする。

## 追加したこと

### 同期を強制的に再開できます

- 止まっている間に押せます。

### 移した先が届きます

- 本文。

### 3 つ目

### 4 つ目
`;

const H3_BEFORE = `# Hangar 0.7.0

## 上げる前に

### 同期しているすべての PC を 0.7.0 に上げてください

- 本文。
`;

describe('parseNote：1 つの版のノートを読む', () => {
  it('節が「更新の前に」でなければ、箇条書きの各項目の最初の 1 文を要点にし、表題の行は本文から外す', () => {
    const n = parseNote('0.7.2', FIX);
    expect(n.before).toBeNull();
    expect(n.points).toEqual(['クラウドを作った PC で setup cloud をやり直すと、同期が止まりました。', '古い Worker に、1 回だけ変更を送っていました。']);
    expect(n.body.startsWith('0.7.1 に上げる')).toBe(true);
  });

  it('「更新の前に」の節は最初の段落を注意にし、ほかの節は小見出しを要点にする', () => {
    const n = parseNote('0.7.1', WITH_BEFORE);
    expect(n.before).toBe('この版は、クラウド同期の作りを変えた版です。古い版のアプリや Worker とは同期しません。');
    expect(n.points).toEqual(['同期を強制的に再開できます', '移した先が届きます', '3 つ目', '4 つ目']);
  });

  it('見出しが文の節は見出しを要点にし、「先にお読みください」の節も注意にする', () => {
    const n = parseNote('0.5.0', '# Hangar 0.5.0\n\n## 0.4.0 から上げる人へ（先にお読みください）\n\nデータベースが上がります。\n\n## エディタを選べるようになりました\n\n- 細部。\n');
    expect(n.before).toBe('データベースが上がります。');
    expect(n.points).toEqual(['エディタを選べるようになりました']);
  });

  it('「上げる前に」の節が小見出しから始まれば、その小見出しを注意にする', () => {
    expect(parseNote('0.7.0', H3_BEFORE).before).toBe('同期しているすべての PC を 0.7.0 に上げてください');
  });
});

describe('版の並びと範囲', () => {
  it('版を数として比べる', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBeGreaterThan(0);
    expect(compareVersions('0.7.2', '0.7.2')).toBe(0);
    expect(compareVersions('0.6.3', '0.7.0')).toBeLessThan(0);
  });

  it('同梱の md を、名前の版で新しい順に並べ、版の形でない名前と空のものは捨てる', () => {
    const notes = bundledNotes({ '../docs/release-notes/0.6.3.md': '# a\n\n- x', '../docs/release-notes/0.10.0.md': '# b\n\n- y', '../x/README.md': 'z', '../docs/release-notes/0.7.0.md': '' });
    expect(notes.map((n) => n.version)).toEqual(['0.10.0', '0.6.3']);
  });

  it('前に見た版より新しく、いまの版までのノートを返す。前に見た版が無ければいまの版だけ', () => {
    const notes = bundledNotes({ 'a/0.7.2.md': FIX, 'a/0.7.1.md': WITH_BEFORE, 'a/0.7.0.md': H3_BEFORE, 'a/0.8.0.md': FIX });
    expect(notesBetween(notes, '0.7.0', '0.7.2').map((n) => n.version)).toEqual(['0.7.2', '0.7.1']);
    expect(notesBetween(notes, null, '0.7.2').map((n) => n.version)).toEqual(['0.7.2']);
    expect(notesBetween(notes, '0.7.2', '0.7.2')).toEqual([]);
  });
});
