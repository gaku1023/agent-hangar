import { v7 as uuidv7 } from 'uuid';

/** 共有テーブルの行 ID。端末をまたいで衝突せず、時刻順に並ぶ。 */
export function newId(): string {
  return uuidv7();
}

/** 表示用の短い ID。時刻の上位の桁なので、近い時刻に作った ID どうしでは同じになる。一意さが要る所には使わない。 */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}

/**
 * run の tmux セッション名に使う ID。
 * uuidv7 の先頭 8 桁はミリ秒の時刻の上位 32 ビットで、約 65.5 秒のあいだ変わらない。
 * それだけを名前にすると、その間に起こした 2 つ目の run が tmux の duplicate session で落ちる。
 * 末尾 8 桁（乱数）を足して重ならないようにする。先頭は時刻のままなので、名前の並びは作った順に近い。
 */
export function runTmuxId(id: string): string {
  const hex = id.replace(/-/g, '');
  return hex.slice(0, 8) + hex.slice(-8);
}
