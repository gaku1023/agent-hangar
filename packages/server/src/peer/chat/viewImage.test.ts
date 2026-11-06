import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDropImage } from './viewImage.ts';

// 画面が POST /api/drops で置いた画像を、置き場の中のファイルだけから読む。

let dir: string;
let outside: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drops-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('readDropImage', () => {
  it('置き場のファイルを、名前でも絶対パス（DropDto.path）でも読み、種類を拡張子から決める', () => {
    fs.writeFileSync(path.join(dir, '1-0-shot.png'), Buffer.from([1, 2, 3]));
    fs.writeFileSync(path.join(dir, '2-0-photo.JPG'), Buffer.from([4]));
    fs.writeFileSync(path.join(dir, '3-0-pic.webp'), Buffer.from([5]));
    expect(readDropImage(dir, '1-0-shot.png')).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(readDropImage(dir, path.join(dir, '1-0-shot.png'))).toEqual({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' });
    expect(readDropImage(dir, '2-0-photo.JPG')?.mime).toBe('image/jpeg');
    expect(readDropImage(dir, '3-0-pic.webp')?.mime).toBe('image/webp');
  });

  it('置き場の外のパス、区切りを含む名前、フォルダ、無いファイルは読まない', () => {
    fs.writeFileSync(path.join(outside, 'secret.png'), Buffer.from([9]));
    fs.mkdirSync(path.join(dir, 'sub.png'));
    expect(readDropImage(dir, path.join(outside, 'secret.png'))).toBeNull();
    expect(readDropImage(dir, '../x.png')).toBeNull();
    expect(readDropImage(dir, 'sub/../x.png')).toBeNull();
    expect(readDropImage(dir, 'sub.png')).toBeNull();
    expect(readDropImage(dir, 'missing.png')).toBeNull();
    expect(readDropImage(dir, '')).toBeNull();
  });

  it('送れない種類（gif や拡張子の無いもの）は読まない', () => {
    fs.writeFileSync(path.join(dir, 'a.gif'), Buffer.from([1]));
    fs.writeFileSync(path.join(dir, 'noext'), Buffer.from([1]));
    expect(readDropImage(dir, 'a.gif')).toBeNull();
    expect(readDropImage(dir, 'noext')).toBeNull();
  });

  it('上限を超えるファイルも、そのまま返す（上限は呼び手が見て too-large にする）', () => {
    fs.writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(5 * 1024 * 1024 + 1));
    const r = readDropImage(dir, 'big.png');
    expect(r?.bytes.byteLength).toBe(5 * 1024 * 1024 + 1);
  });
});
