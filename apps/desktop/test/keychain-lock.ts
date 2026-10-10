import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 実際の証明書で署名する試験を、試験のファイルをまたいで 1 つずつ走らせるための錠。
 * CI のランナーでは、署名の前にユーザーのキーチェーンの検索リストと System の信頼設定（機械全体のもの）を書き換える。
 * 別のファイルの試験が同時に検索リストを読み書きすると、互いの足したキーチェーンを消し合い、codesign が「no identity found」で落ちた（CI で実測）。
 * vitest はファイルを別のプロセスで並べて走らせるので、mkdir の原子性で錠を取る。
 */
const LOCK = path.join(os.tmpdir(), 'hangar-keychain-test.lock');
const STALE_MS = 300_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withKeychainLock<T>(fn: () => T): T {
  const until = Date.now() + STALE_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // 落ちた試験が残した錠は、古ければ外す
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE_MS) fs.rmSync(LOCK, { recursive: true, force: true });
      } catch {
        // 他が先に外した
      }
      if (Date.now() > until) throw new Error(`キーチェーンの試験の錠が空かない: ${LOCK}`);
      sleep(100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}
