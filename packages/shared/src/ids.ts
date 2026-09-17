import { v7 as uuidv7 } from 'uuid';

/** 共有テーブルの行 ID。端末をまたいで衝突せず、時刻順に並ぶ。 */
export function newId(): string {
  return uuidv7();
}

/** 表示用の短い ID。tmux セッション名などに使う。 */
export function shortId(id: string): string {
  return id.replace(/-/g, '').slice(0, 8);
}
