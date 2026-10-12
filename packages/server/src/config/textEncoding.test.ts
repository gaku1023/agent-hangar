import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readUtf8Text, utf8Problem } from './textEncoding.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-enc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const utf16le = (s: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
const utf16be = (s: string) => { const le = Buffer.from(s, 'utf16le'); const be = Buffer.alloc(le.length); for (let i = 0; i < le.length; i += 2) { be[i] = le[i + 1]!; be[i + 1] = le[i]!; } return Buffer.concat([Buffer.from([0xfe, 0xff]), be]); };

describe('utf8Problem（利用者のファイルを UTF-8 として書き換えてよいか）', () => {
  it('UTF-8 と、UTF-8 の BOM 付きは書き換えてよい', () => {
    expect(utf8Problem(Buffer.from('#!/bin/bash\necho 日本語\n', 'utf8'))).toBe(false);
    expect(utf8Problem(Buffer.from('﻿$j = 1\r\n', 'utf8'))).toBe(false);
    expect(utf8Problem(Buffer.alloc(0))).toBe(false);
  });

  it('UTF-16 の LE と BE（BOM 付き）、BOM の無い UTF-16、NUL を含むもの、UTF-8 として読めないもの（Shift_JIS など）は断る', () => {
    expect(utf8Problem(utf16le('$j = 1\r\n'))).toBe(true);
    expect(utf8Problem(utf16be('$j = 1\r\n'))).toBe(true);
    expect(utf8Problem(Buffer.from('$j = 1\r\n', 'utf16le'))).toBe(true);
    expect(utf8Problem(Buffer.from([0x23, 0x21, 0x00, 0x0a]))).toBe(true);
    // 「日本」を Shift_JIS で書いたもの。
    expect(utf8Problem(Buffer.from([0x23, 0x20, 0x93, 0xfa, 0x96, 0x7b, 0x0a]))).toBe(true);
  });
});

describe('readUtf8Text', () => {
  it('無いファイルは null、UTF-8 は中身、UTF-8 でないものは not-utf8', () => {
    expect(readUtf8Text(path.join(dir, 'none'))).toBeNull();
    fs.writeFileSync(path.join(dir, 'a'), 'echo x\n');
    expect(readUtf8Text(path.join(dir, 'a'))).toEqual({ text: 'echo x\n' });
    fs.writeFileSync(path.join(dir, 'b'), utf16le('echo x\n'));
    expect(readUtf8Text(path.join(dir, 'b'))).toEqual({ problem: 'not-utf8' });
  });
});
