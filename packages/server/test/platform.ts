import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

export const isWindows = process.platform === 'win32';

/** Unix にしか意味のない試験。Windows では飛ばす。使う所には理由をコメントで書く。 */
export const posixIt = it.skipIf(isWindows);
export const posixDescribe = describe.skipIf(isWindows);

/** ファイルのモードを確かめる。Windows の Node はモードを 0666 か 0444 としか返さないので、そこでは確かめない。 */
export function expectMode(file: string, mode: number): void {
  if (isWindows) return;
  expect(fs.statSync(file).mode & 0o777).toBe(mode);
}
