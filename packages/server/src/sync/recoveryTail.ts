/**
 * リカバリーキーの末尾 4 文字の入力を、照合する形にそろえる。
 * NFKC で全角を半角にし、空白とハイフンを捨て、大文字にする。
 * CLI（hangar setup cloud の確認）とサーバー（再発行の確認）が同じこの関数を使う（cliEntry.ts から配る）。
 */
export function normalizeRecoveryTail(s: string): string {
  return String(s).normalize('NFKC').replace(/[\s-]/g, '').toUpperCase();
}
