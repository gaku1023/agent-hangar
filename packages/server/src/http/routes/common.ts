import type { Context } from 'hono';
import { DEFAULT_LANGUAGE, type Language, type SyncStatusBody, type Translate } from '@agent-hangar/shared';
import { getProject, getSession } from '../../db/queries.ts';
import type { GetLanguage } from '../../i18n/language.ts';
import { errorText } from '../../i18n/message.ts';
import { RunError } from '../../runs/manager.ts';
import type { AppDeps, LanguageDeps } from '../deps.ts';

/**
 * 経路のファイルが共通で使う補助。
 * 本文の読み方と上限、失敗の包み方、依存から組む小さな読み手を置く。
 */

/**
 * 本文の大きさの上限。かならずバイト数で測る。
 * 文字数で測ると、日本語は 1 文字 3 バイトなので上限の 3 倍まで通ってしまう。
 */
export const BODY_LIMITS = {
  /** 経路ごとの指定が無い JSON の本文。 */
  default: 64 * 1024,
  statusline: 256 * 1024,
  /** ターミナルの包み方からの起動。シェルの環境変数をまるごと載せるので、ほかより大きく取る。 */
  terminal: 512 * 1024,
  memo: 1024 * 1024,
  todo: 4 * 1024,
  url: 2 * 1024,
} as const;

export const numberOr = (v: string | undefined): number | undefined => (v ? Number(v) : undefined);
export const isEnoent = (e: unknown): boolean => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/**
 * 本文をバイト数で測ってから読む。上限を超えていれば null を返し、呼び手は 413 にする。
 * Content-Length があれば読む前に切り、無ければ読んでから測る。
 */
export async function readBody(c: Context, limit: number): Promise<string | null> {
  const declared = Number(c.req.header('content-length'));
  if (Number.isFinite(declared) && declared > limit) return null;
  const text = await c.req.text();
  return Buffer.byteLength(text) > limit ? null : text;
}

/** 本文を読んで JSON にする。壊れた JSON と空の本文は undefined にして、呼び手の既定値に任せる。 */
export async function readJson(c: Context, limit: number): Promise<{ tooLarge: true } | { tooLarge: false; value: unknown }> {
  const text = await readBody(c, limit);
  if (text === null) return { tooLarge: true };
  try {
    return { tooLarge: false, value: JSON.parse(text) as unknown };
  } catch {
    return { tooLarge: false, value: undefined };
  }
}

// 上限が 1 MB 以上のちょうどの MB なら MB で、それ以外は KB で読ませる（添付の 20 MB が「20480KB」では読みにくいため）。
export const sizeLabel = (limit: number) => (limit >= 1024 * 1024 && limit % (1024 * 1024) === 0 ? `${limit / (1024 * 1024)}MB` : `${Math.round(limit / 1024)}KB`);
export const tooLargeResult = (c: Context, limit: number, tr: Translate) => c.json({ error: tr('http.request.tooLarge', { limit: sizeLabel(limit) }) }, 413);

/** RunError は status 付きで、いまの言語の文にして返し、それ以外は投げ直す。 */
export function runResult<T>(c: Context, language: GetLanguage, fn: () => T, status: 200 | 201 = 200) {
  try {
    return c.json(fn() as object, status);
  } catch (e) {
    if (e instanceof RunError) return c.json({ error: errorText(language(), e) }, e.status);
    throw e;
  }
}

/** runResult の非同期版。引き取りは元の claude が終わるのを待つので、応答まで数秒かかる。 */
export async function runResultAsync<T>(c: Context, language: GetLanguage, fn: () => Promise<T>, status: 200 | 201 = 200) {
  try {
    return c.json((await fn()) as object, status);
  } catch (e) {
    if (e instanceof RunError) return c.json({ error: errorText(language(), e) }, e.status);
    throw e;
  }
}

/** 応答に載せる失敗の文言の上限。RunManager と同じ長さにする。 */
const MAX_ERROR_LEN = 200;

/**
 * 外部コマンドの失敗を応答に載せる前に整える。
 * RunManager.safeError と同じ覆いである。いまの呼び先にトークンは渡らないが、
 * 覆いが片方にしか無いと、呼び先が増えたときに漏れる。
 * 辞書の文を持つ失敗は、渡された言語の文にする。
 */
export function safeExternalMessage(e: unknown, token: string, language: Language = DEFAULT_LANGUAGE): string {
  const line = errorText(language, e).split('\n')[0]!.trim();
  const masked = token ? line.replaceAll(token, '***') : line;
  return masked.length > MAX_ERROR_LEN ? `${masked.slice(0, MAX_ERROR_LEN)}…` : masked;
}

/** 外部連携の失敗は 500 で理由を返す。UI はこれをそのままトーストに出す。 */
export async function externalResult(c: Context, token: string, fn: () => Promise<unknown>, empty = false, language: Language = DEFAULT_LANGUAGE) {
  try {
    const r = await fn();
    return empty ? c.body(null, 204) : c.json(r as object);
  } catch (e) {
    return c.json({ error: safeExternalMessage(e, token, language) }, 500);
  }
}

/**
 * セッションを引くときは必ず自端末の ID を渡す。
 * 渡さないと lockMap が空のまま返るので、他端末で走っている run が「ロック中」として出てこない。
 */
export const sessionOf = (deps: Pick<AppDeps, 'db' | 'deviceId' | 'live'>) => (id: string) => getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
/** プロジェクトを 1 件引く。無ければ null で、呼び手は 404 にする。 */
export const projectOf = (deps: Pick<AppDeps, 'db' | 'deviceId' | 'live'>) => (id: string) => getProject(deps.db, deps.deviceId, deps.live(), id);
/** 外部連携の失敗の文言は、必ずトークンの覆いを通してから応答に載せる。 */
export const externalOf = (deps: Pick<AppDeps, 'token'> & LanguageDeps) => (c: Context, fn: () => Promise<unknown>, empty = false) => externalResult(c, deps.token, fn, empty, deps.language());
/** 同期の状態。諦めた項目と、取り残しの残り件数を添えて返す。 */
export const syncStatusOf = (deps: Pick<AppDeps, 'sync' | 'syncSkipped' | 'syncSweep' | 'syncOncePass'>) => (): SyncStatusBody => ({ ...deps.sync.status(), skipped: deps.syncSkipped(), sweepPending: deps.syncSweep(), oncePass: deps.syncOncePass() });
/**
 * セッションを起こす前に、他端末の変更を 2 秒だけ待って取り込む。
 * 間に合わなくても起動は続ける。同期の失敗で起動を止めない。
 */
export const beforeLaunchOf = (deps: Pick<AppDeps, 'sync'>) => () => deps.sync.pullBeforeLaunch(2000).catch(() => false);
