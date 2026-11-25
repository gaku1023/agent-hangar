import { Decompress } from 'fzstd';

// zstd の展開を、この 1 か所に閉じる。純 JS の fzstd を使う（ネイティブの依存を足さず、全 OS で同じに動く）。
// Node の zlib に zstd が入った（22.15 以上）あとは、ここに typeof zlib.zstdDecompressSync を先に見る分岐を足せば、依存を外せる。

/** 展開後の大きさの上限。超えたら読まない（仮置き。実物の大きさの分布を見てから決める）。 */
export const ZSTD_MAX_BYTES = 256 * 1024 * 1024;

export class ZstdTooLargeError extends Error {
  constructor(readonly limit: number) { super(`decompressed size exceeds ${limit} bytes`); this.name = 'ZstdTooLargeError'; }
}

class HeadFound extends Error {}

/** zstd の先頭から、最初の 1 行（改行まで）だけを展開する。全体を展開しない。改行まで届かなければ null。壊れていれば投げる。 */
export function decompressZstdHeadLine(input: Uint8Array, maxBytes = 4 * 1024 * 1024): string | null {
  const chunks: Buffer[] = [];
  let total = 0;
  let line: Buffer | null = null;
  const d = new Decompress((chunk) => {
    const b = Buffer.from(chunk);
    const nl = b.indexOf(10);
    if (nl !== -1) { line = Buffer.concat([...chunks, b.subarray(0, nl)]); throw new HeadFound(); }
    chunks.push(b);
    total += b.length;
    if (total > maxBytes) throw new HeadFound();
  });
  try { d.push(input, false); } catch (e) { if (!(e instanceof HeadFound)) throw e; }
  return line === null ? null : (line as Buffer).toString('utf8');
}

/** zstd のフレームを展開する。壊れていれば投げ、展開後が maxBytes を超えたら ZstdTooLargeError を投げる。 */
export function decompressZstd(input: Uint8Array, maxBytes: number = ZSTD_MAX_BYTES): Buffer {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  const d = new Decompress((chunk, final) => {
    total += chunk.length;
    if (total > maxBytes) throw new ZstdTooLargeError(maxBytes);
    chunks.push(chunk);
    if (final) finished = true;
  });
  d.push(input, true);
  // 途中で切れた入力は fzstd が投げずに終わることがあるので、最後の塊が来たかを自分で見る。
  if (!finished && input.length > 0) throw new Error('zstd stream ended before the final block');
  return Buffer.concat(chunks, total);
}
