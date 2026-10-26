import fs from 'node:fs';

export type NewLine = { offset: number; length: number; text: string };

/**
 * fromByte 以降の完全な行だけを返す。
 * 改行で終わらない末尾の断片は次回に回し、nextByte をその先頭に留める。
 * ファイルが fromByte より短くなっていたら作り直されたとみなし、reset を立てて先頭から読み直す。
 * 空行は返さない。
 */
export function readNewLines(path: string, fromByte: number): { lines: NewLine[]; nextByte: number; reset: boolean } {
  const size = fs.statSync(path).size;
  let start = fromByte;
  let reset = false;
  if (size < fromByte) { start = 0; reset = true; }
  if (size === start) return { lines: [], nextByte: start, reset };
  const fd = fs.openSync(path, 'r');
  const buf = Buffer.alloc(size - start);
  try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  return { ...splitLines(buf, start), reset };
}

/**
 * buf（ファイルの start バイト目から後ろ）を、改行で終わった完全な行に分ける。
 * 改行で終わらない末尾の断片は返さず、nextByte をその先頭に留める。空行は返さない。
 * 圧縮された本文を展開したバイト列からも同じ規則で読めるよう、ファイルを開く部分と分けてある。
 */
export function splitLines(buf: Buffer, start: number): { lines: NewLine[]; nextByte: number } {
  const lines: NewLine[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(10, pos);
    if (nl === -1) break;
    const length = nl - pos;
    if (length > 0) lines.push({ offset: start + pos, length, text: buf.subarray(pos, nl).toString('utf8') });
    pos = nl + 1;
  }
  return { lines, nextByte: start + pos };
}
