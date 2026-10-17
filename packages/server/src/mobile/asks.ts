import { aadAsk, aadReply, isSafeRelPath, MOBILE_REPLY_MAX_BYTES, open, seal, type MobileReply } from '@agent-hangar/shared';
import { changedFiles, listProjectFiles, listRecentFiles } from '../prompt/files.ts';
import { listPromptCommandsWithKind, type PromptCommandKind } from '../provider/claude-code/prompt/commands.ts';
import { mobileKeyFor } from './publisher.ts';

/** `@` の問いが空のときに返す件数。 */
export const ASK_RECENT_FILES = 30;
/** `@` の問いがあるときに返す件数。PC の指示欄（listProjectFiles の既定）と同じ。 */
export const ASK_SEARCH_FILES = 50;
/** `/` の候補の件数の上限。 */
export const ASK_COMMANDS_MAX = 200;
/** `/` の候補の説明の字数の上限。 */
export const ASK_DESCRIPTION_MAX = 120;

type CommandRow = { name: string; description: string; kind: PromptCommandKind; uses: number };

export type AskDeps = {
  /** 参加の秘密。スマホの鍵（mobileKeyFor）を導く。 */
  joinSecret: string;
  /** この PC の端末 ID。問い合わせの封の AAD（aadAsk）の宛先と照らす。 */
  deviceId: string;
  /** この PC にあるプロジェクトの根。無ければ null。 */
  projectPath(projectId: string): string | null;
  /** この PC にあるアカウントの設定フォルダ（AccountStore の dir）。無ければ null。 */
  accountDir(accountId: string): string | null;
  /** ファイルの読み取り。既定は prompt/files.ts。試験が差し替える。 */
  files?: {
    recent(root: string, n: number): Promise<{ path: string; changed: boolean }[]>;
    search(root: string, q: string, n: number): Promise<string[]>;
    changed(root: string): Promise<Set<string>>;
  };
  /** `/` の候補の読み取り。既定は listPromptCommandsWithKind。 */
  commands?: (o: { claudeDir: string; projectPath: string | null }) => CommandRow[];
};

const DEFAULT_FILES: NonNullable<AskDeps['files']> = { recent: listRecentFiles, search: listProjectFiles, changed: changedFiles };

/**
 * プロジェクトの根の中に留まる相対パスか。
 * 絶対パス、`..` と `.` の区切り、\ の区切り、ドライブ名で始まるものは返さない。
 * 一覧は git と歩いた結果なので外へは出ないはずだが、スマホへ渡す前にもう一度ここで締める。
 */
function insideProject(rel: string): boolean {
  if (rel.includes('\\') || /^[A-Za-z]:/.test(rel)) return false;
  return isSafeRelPath(rel);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 字数で切る（サロゲートの組を割らない）。 */
const clip = (s: string, n: number): string => {
  const cs = Array.from(s);
  return cs.length <= n ? s : cs.slice(0, n).join('');
};

async function filesReply(d: AskDeps, projectId: string, q: string): Promise<MobileReply> {
  const root = d.projectPath(projectId);
  if (root === null) return { error: 'project-missing' };
  const f = d.files ?? DEFAULT_FILES;
  const query = q.trim();
  try {
    if (!query) {
      const list = await f.recent(root, ASK_RECENT_FILES);
      return { files: list.filter((x) => insideProject(x.path)).slice(0, ASK_RECENT_FILES).map((x) => ({ path: x.path, changed: x.changed === true })) };
    }
    const [hits, changed] = await Promise.all([f.search(root, query, ASK_SEARCH_FILES), f.changed(root).catch(() => new Set<string>())]);
    return { files: hits.filter(insideProject).slice(0, ASK_SEARCH_FILES).map((p) => ({ path: p, changed: changed.has(p) })) };
  } catch (e) {
    console.error('[mobile] could not list the project files', e instanceof Error ? e.constructor.name : typeof e);
    return { files: [] };
  }
}

function commandsReply(d: AskDeps, projectId: string | null, accountId: string): MobileReply {
  const claudeDir = d.accountDir(accountId);
  if (claudeDir === null) return { error: 'account-missing' };
  let projectPath: string | null = null;
  if (projectId !== null) {
    projectPath = d.projectPath(projectId);
    if (projectPath === null) return { error: 'project-missing' };
  }
  let rows: CommandRow[];
  try {
    rows = (d.commands ?? listPromptCommandsWithKind)({ claudeDir, projectPath });
  } catch (e) {
    console.error('[mobile] could not list the prompt commands', e instanceof Error ? e.constructor.name : typeof e);
    rows = [];
  }
  // 上限で切るときに、よく使うものを残す。同じ回数なら読んだ順（プロジェクト、自分の、プラグイン、組み込み）のまま。
  const ordered = rows.map((c, i) => ({ c, i })).sort((a, b) => b.c.uses - a.c.uses || a.i - b.i).map((x) => x.c);
  return { commands: ordered.slice(0, ASK_COMMANDS_MAX).map((c) => ({ name: c.name, description: clip(c.description, ASK_DESCRIPTION_MAX), kind: c.kind })) };
}

/**
 * 開けた問い合わせ（MobileAsk）に答える。形が違えば bad-request。
 * 手元に無いプロジェクトは project-missing、手元に無いアカウントは account-missing。投げない。
 */
export async function replyTo(d: AskDeps, ask: unknown): Promise<MobileReply> {
  if (!isRecord(ask) || ask.v !== 1) return { error: 'bad-request' };
  if (ask.kind === 'files' && typeof ask.projectId === 'string' && typeof ask.q === 'string') return filesReply(d, ask.projectId, ask.q);
  if (ask.kind === 'commands' && (ask.projectId === null || typeof ask.projectId === 'string') && typeof ask.accountId === 'string') return commandsReply(d, ask.projectId, ask.accountId);
  return { error: 'bad-request' };
}

/**
 * 封じた答えを呼び鈴の 1 通（`{"t":"reply","id","sealed"}`）に入れたとき、MOBILE_REPLY_MAX_BYTES に収まる中身の JSON のバイト数の上限。
 * 封は base64url(IV 12 バイト、暗号文、タグ 16 バイト) なので、中身の 4/3 に 28 バイトの分が足される。
 */
function plainBudget(id: string): number {
  const frame = Buffer.byteLength(JSON.stringify({ t: 'reply', id, sealed: '' }));
  return Math.floor(((MOBILE_REPLY_MAX_BYTES - frame) * 3) / 4) - 28;
}

/** 答えの一覧を、中身の JSON が budget に収まるまで後ろから落とす。 */
function fitReply(reply: MobileReply, budget: number): MobileReply {
  const size = (r: MobileReply) => Buffer.byteLength(JSON.stringify(r));
  if (size(reply) <= budget) return reply;
  if ('files' in reply) {
    const files = [...reply.files];
    while (files.length > 0 && size({ files }) > budget) files.pop();
    return { files };
  }
  if ('commands' in reply) {
    const commands = [...reply.commands];
    while (commands.length > 0 && size({ commands }) > budget) commands.pop();
    return { commands };
  }
  return reply;
}

/**
 * 呼び鈴で届いた問い合わせ（`{t:'ask', id, sealed}`）に答える。
 * 封はスマホの鍵で、AAD は aadAsk(id, この PC)。開けなければ（別の宛先、別の ID、別の鍵、壊れた封）null を返し、答えない。
 * 答えは aadReply(id) で封じ、呼び鈴の 1 通が MOBILE_REPLY_MAX_BYTES に収まるまで一覧の後ろから落とす。
 * Worker と Durable Object は中身を読めない。投げない。
 */
export async function answerAsk(d: AskDeps, id: string, sealed: string): Promise<string | null> {
  let key: CryptoKey;
  let ask: unknown;
  try {
    key = await mobileKeyFor(d.joinSecret);
    ask = await open<unknown>(key, aadAsk(id, d.deviceId), sealed);
  } catch {
    return null;
  }
  try {
    const reply = fitReply(await replyTo(d, ask), plainBudget(id));
    return await seal(key, aadReply(id), reply);
  } catch (e) {
    console.error('[mobile] could not answer the ask', e instanceof Error ? e.constructor.name : typeof e);
    return null;
  }
}
