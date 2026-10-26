import { Decompress } from 'fzstd';

// zstd の展開を、この 1 か所に閉じる。純 JS の fzstd を使う（ネイティブの依存を足さず、全 OS で同じに動く）。
// Node の zlib に zstd が入った（22.15 以上）あとは、ここに typeof zlib.zstdDecompressSync を先に見る分岐を足せば、依存を外せる。

/** 展開後の大きさの上限。超えたら読まない（仮置き。実物の大きさの分布を見てから決める）。 */
export const ZSTD_MAX_BYTES = 256 * 1024 * 1024;

export class ZstdTooLargeError extends Error {
  constructor(readonly limit: number) { super(`decompressed size exceeds ${limit} bytes`); this.name = 'ZstdTooLargeError'; }
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
