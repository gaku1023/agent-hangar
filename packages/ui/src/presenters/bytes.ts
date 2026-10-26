import { clientPlatform } from '../keys.ts';

/**
 * 容量を割る単位。OS のファイルの画面と比べられる数にそろえる（2026-10-26、0.10.1 の S15）。
 * macOS の Finder と Linux のファイルの画面は 1000 で割り、Windows のエクスプローラは 1024 で割る。単位の字はどちらも KB・MB・GB と書く。
 * platform は画面を開いている OS（keys.ts の clientPlatform）で、hangar はサーバと同じ PC で開くので、ディスクの OS と同じになる。試験では差し込む。
 */
export const byteBase = (platform: string = clientPlatform()): number => (platform === 'win32' ? 1024 : 1000);

/**
 * 容量の言い方。GB・MB・KB の大きい方で言い、GB は 10 未満なら小数 1 桁、ほかは整数にする。
 * round を 'up' にすると切り上げる。足りない量を言うときに使い、言った量を空ければ足りるようにする。
 */
export function bytesLabel(bytes: number, platform: string = clientPlatform(), round: 'near' | 'up' = 'near'): string {
  const k = byteBase(platform);
  const r = round === 'up' ? Math.ceil : Math.round;
  // 割った値の小さな誤差（6e9 / 1e9 が 6.000000001 になるなど）で切り上げすぎないよう、先に小数 6 桁で丸める。
  const at = (unit: number, digits = 0): number => { const p = 10 ** digits; return r(Number((bytes / unit * p).toFixed(6))) / p; };
  if (bytes >= k ** 3) { const v = bytes / k ** 3; return `${v >= 10 ? at(k ** 3) : at(k ** 3, 1)} GB`; }
  if (bytes >= k ** 2) return `${at(k ** 2)} MB`;
  return `${at(k)} KB`;
}
