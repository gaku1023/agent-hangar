import fs from 'node:fs';

/**
 * 利用者のファイル（ステータスラインのスクリプト、~/.zshrc）を、UTF-8 の文字として読み書きしてよいかを決める。
 *
 * hangar はこれらを UTF-8 で読み、行を足して UTF-8 で書く。
 * UTF-16（Windows PowerShell 5.1 の Out-File の既定）や Shift_JIS のファイルを UTF-8 として読むと、
 * 読めない字が置き換わり、足した行と混ざって、書き戻したファイルが壊れる。
 * そこで、UTF-16 の BOM、NUL の字、UTF-8 として正しくない並びのどれかがあれば、書き換えない。
 * UTF-8 の BOM 付きは UTF-8 なので書き換えてよい（呼び手が BOM を先頭に保つ）。
 */
export function utf8Problem(buf: Buffer): boolean {
  if (buf.length >= 2 && ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))) return true;
  if (buf.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

/** ファイルを UTF-8 の文字として読む。無いか読めなければ null、UTF-8 でなければ not-utf8 を返す。 */
export function readUtf8Text(file: string): { text: string } | { problem: 'not-utf8' } | null {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (utf8Problem(buf)) return { problem: 'not-utf8' };
  return { text: buf.toString('utf8') };
}
