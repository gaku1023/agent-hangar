import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { promptMentionsDrops, pruneDrops, resolveDrop, sanitizeDropName, saveDrop } from './drops.ts';

let dir: string;
beforeEach(() => { dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-drops-')), 'drops'); });

describe('sanitizeDropName', () => {
  it('殻（filedrop.rs）と同じく、空白と引用符とシェルの記号を _ にし、日本語は残す', () => {
    expect(sanitizeDropName('スクリーンショット 2026-09-30 19.51.52.png')).toBe('スクリーンショット_2026-09-30_19.51.52.png');
    expect(sanitizeDropName('a\'b"c$d`e\\f.png')).toBe('a_b_c_d_e_f.png');
    expect(sanitizeDropName('../../etc/passwd')).toBe('.._.._etc_passwd');
  });
  it('殻（Rust の is_control と is_whitespace）と同じく、C1 の制御文字は _ にし、U+FEFF は残す', () => {
    expect(sanitizeDropName('a\u0085b\u009fc.png')).toBe('a_b_c.png');
    expect(sanitizeDropName('a\u007fb.png')).toBe('a_b.png');
    expect(sanitizeDropName('a b　c.png')).toBe('a_b_c.png');
    expect(sanitizeDropName('a\uFEFFb.png')).toBe('a\uFEFFb.png');
  });
  it('空と、点だけの名前は file にする', () => {
    expect(sanitizeDropName('')).toBe('file');
    expect(sanitizeDropName('..')).toBe('file');
  });
});

describe('saveDrop', () => {
  it('置き場を作り、<時刻>-<連番>-<名前> で置いて、パスと大きさを返す', () => {
    const d = saveDrop(dir, 'a b.png', new Uint8Array([1, 2, 3]), 1000);
    expect(d).toEqual({ path: path.join(dir, '1000-0-a_b.png'), name: 'a b.png', size: 3 });
    expect([...fs.readFileSync(d.path)]).toEqual([1, 2, 3]);
  });
  it('同じ時刻に同じ名前を置いても、上書きせず連番を進める', () => {
    const a = saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    const b = saveDrop(dir, 'x.png', new Uint8Array([2]), 1000);
    expect(path.basename(b.path)).toBe('1000-1-x.png');
    expect([...fs.readFileSync(a.path)]).toEqual([1]);
  });
  it('名前が空なら file にする', () => {
    expect(saveDrop(dir, '', new Uint8Array([1]), 5).name).toBe('file');
  });
});

describe('resolveDrop', () => {
  it('置き場にあるファイルの名前だけを、その絶対パスにする', () => {
    const d = saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    expect(resolveDrop(dir, '1000-0-x.png')).toBe(d.path);
  });
  it('外へ抜ける名前、区切りを含む名前、無いファイル、フォルダは null', () => {
    saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, '..', 'secret'), 's');
    for (const n of ['../secret', '..', '.', '', 'sub', 'sub/../1000-0-x.png', '/etc/passwd', 'nope.png', '..\\secret']) expect(resolveDrop(dir, n)).toBeNull();
  });
});

describe('resolveDrop と シンボリックリンク', () => {
  it('置き場の中の、外を指すリンクは null（辿って読ませない）', () => {
    saveDrop(dir, 'x.png', new Uint8Array([1]), 1000);
    const outside = path.join(dir, '..', 'secret');
    fs.writeFileSync(outside, 's');
    fs.symlinkSync(outside, path.join(dir, 'link.png'));
    expect(resolveDrop(dir, 'link.png')).toBeNull();
  });
});

describe('promptMentionsDrops', () => {
  const D = '/home/u/.agent-hangar/drops';
  it('置き場の直下のパスだけの行があれば true', () => {
    expect(promptMentionsDrops(`これを見て\n\n${D}/1000-0-a.png`, D)).toBe(true);
  });
  it('引用符で包まれたパス（空白入りの名前）も、外側の引用符を 1 組外して見る', () => {
    expect(promptMentionsDrops(`見て\n\n'${D}/1000-0-a b.png'`, D)).toBe(true);
  });
  it('添付の行が複数あっても true、前後の空白は無視する', () => {
    expect(promptMentionsDrops(`x\n\n  ${D}/1-0-a.png  \n${D}/2-0-b.png\n`, D)).toBe(true);
  });
  it('本文だけ、未指定、空は false', () => {
    expect(promptMentionsDrops('こんにちは', D)).toBe(false);
    expect(promptMentionsDrops(undefined, D)).toBe(false);
    expect(promptMentionsDrops('', D)).toBe(false);
  });
  it('置き場そのもの、サブフォルダ、接頭辞だけ同じ別のフォルダは false', () => {
    expect(promptMentionsDrops(D, D)).toBe(false);
    expect(promptMentionsDrops(`${D}/`, D)).toBe(false);
    expect(promptMentionsDrops(`${D}/sub/a.png`, D)).toBe(false);
    expect(promptMentionsDrops(`${D}-old/a.png`, D)).toBe(false);
    expect(promptMentionsDrops(`/other${D}/a.png`, D)).toBe(false);
  });
  it('文の途中に書かれたパスは、ほかの字がある行なので false', () => {
    expect(promptMentionsDrops(`${D}/a.png を見て`, D)).toBe(false);
    expect(promptMentionsDrops(`見て ${D}/a.png`, D)).toBe(false);
    expect(promptMentionsDrops(`見て '${D}/a.png' を`, D)).toBe(false);
  });
  it('置き場が Windows のパスなら、\\ の区切りの行を数え、サブフォルダは数えない', () => {
    const W = 'C:\\Users\\u\\.agent-hangar\\drops';
    expect(promptMentionsDrops(`見て\n\n${W}\\1000-0-a.png`, W)).toBe(true);
    expect(promptMentionsDrops(`見て\n\n'${W}\\1000-0-画面 1.png'`, W)).toBe(true);
    expect(promptMentionsDrops(`${W}\\sub\\a.png`, W)).toBe(false);
    expect(promptMentionsDrops(`${W}\\sub/a.png`, W)).toBe(false);
    expect(promptMentionsDrops(`${W}-old\\a.png`, W)).toBe(false);
    expect(promptMentionsDrops(`${W}\\`, W)).toBe(false);
  });
  it('Windows 形式と相対パスは false', () => {
    expect(promptMentionsDrops('C:\\Users\\u\\.agent-hangar\\drops\\a.png', D)).toBe(false);
    expect(promptMentionsDrops('drops/a.png', D)).toBe(false);
    expect(promptMentionsDrops('./drops/a.png', D)).toBe(false);
  });
});

describe('pruneDrops', () => {
  it('7 日より古いファイルだけを消す', () => {
    const old = saveDrop(dir, 'old.png', new Uint8Array([1]), 1);
    const fresh = saveDrop(dir, 'new.png', new Uint8Array([1]), 2);
    const now = Date.now();
    fs.utimesSync(old.path, new Date(now - 8 * 86400_000), new Date(now - 8 * 86400_000));
    pruneDrops(dir, now);
    expect(fs.existsSync(old.path)).toBe(false);
    expect(fs.existsSync(fresh.path)).toBe(true);
  });
  it('置き場が無くても落ちない', () => {
    expect(() => pruneDrops(path.join(dir, 'none'), Date.now())).not.toThrow();
  });
});
