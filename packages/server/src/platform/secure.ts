import fs from 'node:fs';

// 本人だけが読めるファイルの扱い。
// macOS と Linux はモード（0600、0700）で絞る。
// Windows の Node はモードを 0666 か 0444 としか返さず、chmod も読み取り専用の切り替えしかできない。
// Windows では置き場をユーザーのプロファイルの下にして、その権限を受け継ぐことで守る。ここではモードを読まないし、直さない。

/** モードの下 9 ビット。Windows と、無いファイルは null。 */
export function modeOf(file: string, platform: NodeJS.Platform = process.platform): number | null {
  if (platform === 'win32') return null;
  const st = fs.statSync(file, { throwIfNoEntry: false });
  return st ? st.mode & 0o777 : null;
}

/** 本人以外にも読み書きできる権限か。 */
export function isLoose(file: string, platform: NodeJS.Platform = process.platform): boolean {
  const m = modeOf(file, platform);
  return m !== null && (m & 0o077) !== 0;
}

/** モードが合っているか。Windows は、ファイルがあれば合っているとする。 */
export function hasMode(file: string, mode: number, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return fs.existsSync(file);
  return modeOf(file, platform) === mode;
}

/** モードが違えば直す。無いファイルと Windows では何もしない。 */
export function ensureMode(file: string, mode: number, platform: NodeJS.Platform = process.platform): void {
  const m = modeOf(file, platform);
  if (m !== null && m !== mode) fs.chmodSync(file, mode);
}
