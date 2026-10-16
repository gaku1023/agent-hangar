import { randomToken, sha256Hex } from './util.ts';

const MAX_NAME_CHARS = 128;

/** C0 と DEL と C1。改行と NUL を名前に混ぜられると、ログと控えの名前が壊れる。 */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** ファイル名に入れると困る文字。控えは `memo.conflict-<端末名>-<時刻>.md` という名前になる。 */
const NAME_BANNED_RE = /[<>:"/\\|?*]/;

/**
 * 端末の名前。
 * ホスト名がそのまま入るので、空白と非 ASCII は通す。
 * 制御文字とパスの区切りだけを断る。
 */
export const isSafeName = (s: string): boolean => s.trim().length > 0 && s.length <= MAX_NAME_CHARS && !CONTROL_RE.test(s) && !NAME_BANNED_RE.test(s);

/**
 * 端末トークンを 1 つ発行する。PC の参加とスマホの参加（mobile.ts）が共有する。
 * 返す平文のトークンは応答にだけ載せ、D1 には SHA-256 のハッシュだけを置く。
 * 何を確かめてから発行するかは呼び手ごとに違うので、ここでは照合しない。
 * 参加用の秘密で参加する口（POST /join）は互換の版 9 で消した。PC は参加コードで参加する。
 */
export async function issueDeviceToken(): Promise<{ token: string; tokenHash: string }> {
  const token = randomToken(32);
  return { token, tokenHash: await sha256Hex(token) };
}
