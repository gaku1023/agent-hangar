import {
  aadAsk,
  aadReply,
  isMobileMode,
  isModelName,
  isSafeRelPath,
  MOBILE_AGENT_LABEL_MAX,
  MOBILE_AGENT_MODELS_MAX,
  MOBILE_AGENT_MODES_MAX,
  MOBILE_REPLY_MAX_BYTES,
  modelCostKind,
  modelDataUse,
  open,
  seal,
  type MobileAgentOptions,
  type MobileModelOption,
  type MobileReply,
  type OpencodeOptionsDto,
} from '@agent-hangar/shared';
import { changedFiles, listProjectFiles, listRecentFiles } from '../prompt/files.ts';
import { listPromptCommandsWithKind, type PromptCommandKind } from '../provider/claude-code/prompt/commands.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';

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
  /** スマホ用の鍵 M。問い合わせが名乗る世代（呼び鈴の epoch）の M で開き、答えも同じ世代で封じる。 */
  phoneKeys: Pick<PhoneKeySource, 'at'>;
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
  /**
   * opencode の口（0.10.0 で足した）。省けば opencode を使えない PC として答える。
   * ready は設定で有効にしているか。options と commands は手元に持った一覧（provider/opencode/options.ts の last と lastCommands）で、取りに行かない。
   * 場所（プロジェクトの根）を省くと、ホームか最後に取った場所の一覧になる。持っていなければ null。
   */
  opencode?: {
    ready(): boolean;
    options(dir: string | null): OpencodeOptionsDto | null;
    commands(dir: string | null): { name: string; description: string; kind: 'skill' | 'command' }[] | null;
  };
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

/** opencode の問い合わせの場所。プロジェクトが無ければ null（ホームか最後に取った場所）、手元に無いプロジェクトなら undefined。 */
function opencodeDir(d: AskDeps, projectId: string | null): string | null | undefined {
  if (projectId === null) return null;
  return d.projectPath(projectId) ?? undefined;
}

/**
 * PC の選択肢（OpencodeOptionsDto）をスマホの形に縮める。
 * モードとモデルは、起動の依頼で PC が受ける形（isMobileMode、isModelName）のものだけを残す。ツール呼び出しに対応しないモデルはエージェントで使えないので載せない。
 * 費用の型とデータの扱いは、PC のモデルの小窓と同じ表（shared/modelFacts.ts）から付ける。この PC のプロバイダーは「PC 外への送信なし」、ほかのローカルは付けない。
 */
export function mobileAgentOptions(dto: OpencodeOptionsDto): MobileAgentOptions {
  const whereOf = new Map(dto.providers.map((p) => [p.id, p.where]));
  const models: MobileModelOption[] = [];
  for (const m of dto.models) {
    if (models.length >= MOBILE_AGENT_MODELS_MAX) break;
    if (!m.tools || !isModelName(m.id)) continue;
    const where = whereOf.get(m.provider) ?? 'remote';
    const cost = modelCostKind(m.provider, m.cost, where);
    const data = modelDataUse(m, cost, where);
    models.push({ id: m.id, label: clip(m.label, MOBILE_AGENT_LABEL_MAX), group: clip(m.group, MOBILE_AGENT_LABEL_MAX), cost, data });
  }
  return {
    version: dto.version,
    verified: dto.verified,
    modes: dto.modes.filter((m) => isMobileMode(m.id)).slice(0, MOBILE_AGENT_MODES_MAX).map((m) => ({ id: m.id, description: m.description === null ? null : clip(m.description, ASK_DESCRIPTION_MAX) })),
    models,
    defaultModel: dto.defaultModel !== null && isModelName(dto.defaultModel) ? dto.defaultModel : null,
    stale: dto.stale,
    fetchedAt: dto.fetchedAt,
  };
}

function agentOptionsReply(d: AskDeps, projectId: string | null): MobileReply {
  if (!d.opencode?.ready()) return { error: 'agent-missing' };
  const dir = opencodeDir(d, projectId);
  if (dir === undefined) return { error: 'project-missing' };
  const dto = d.opencode.options(dir);
  return { agentOptions: dto ? mobileAgentOptions(dto) : null };
}

function opencodeCommandsReply(d: AskDeps, projectId: string | null): MobileReply {
  if (!d.opencode?.ready()) return { error: 'agent-missing' };
  const dir = opencodeDir(d, projectId);
  if (dir === undefined) return { error: 'project-missing' };
  const rows = d.opencode.commands(dir) ?? [];
  return { commands: rows.slice(0, ASK_COMMANDS_MAX).map((c) => ({ name: c.name, description: clip(c.description, ASK_DESCRIPTION_MAX), kind: c.kind })) };
}

/**
 * 開けた問い合わせ（MobileAsk）に答える。形が違えば bad-request。
 * opencode の問い合わせ（agent-options と、agent が opencode の commands）は、PC が手元に持った一覧で答え、取りに行かない。opencode を使えない PC は agent-missing。
 * 手元に無いプロジェクトは project-missing、手元に無いアカウントは account-missing。投げない。
 */
export async function replyTo(d: AskDeps, ask: unknown): Promise<MobileReply> {
  if (!isRecord(ask) || ask.v !== 1) return { error: 'bad-request' };
  if (ask.kind === 'files' && typeof ask.projectId === 'string' && typeof ask.q === 'string') return filesReply(d, ask.projectId, ask.q);
  const projectOk = ask.projectId === null || typeof ask.projectId === 'string';
  if (ask.kind === 'commands' && projectOk && typeof ask.accountId === 'string') {
    if (ask.agent === undefined) return commandsReply(d, ask.projectId as string | null, ask.accountId);
    if (ask.agent === 'opencode') return opencodeCommandsReply(d, ask.projectId as string | null);
    return { error: 'bad-request' };
  }
  if (ask.kind === 'agent-options' && projectOk && ask.agent === 'opencode') return agentOptionsReply(d, ask.projectId as string | null);
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
  if ('agentOptions' in reply && reply.agentOptions) {
    const models = [...reply.agentOptions.models];
    while (models.length > 0 && size({ agentOptions: { ...reply.agentOptions, models } }) > budget) models.pop();
    return { agentOptions: { ...reply.agentOptions, models } };
  }
  return reply;
}

/**
 * 呼び鈴で届いた問い合わせ（`{t:'ask', id, sealed, epoch}`）に答える。
 * 封はスマホ用の鍵 M の epoch の世代で、AAD は aadAsk(id, この PC)。
 * その世代の鍵が無い（名簿を読み直しても見つからない）か、開けなければ（別の宛先、別の ID、別の鍵、壊れた封）null を返し、答えない。スマホは 5 秒で待つのをやめる。
 * 答えは同じ世代の M と aadReply(id) で封じ、呼び鈴の 1 通が MOBILE_REPLY_MAX_BYTES に収まるまで一覧の後ろから落とす。
 * Worker と Durable Object は中身を読めない。投げない。
 */
export async function answerAsk(d: AskDeps, id: string, sealed: string, epoch: number): Promise<string | null> {
  let key: CryptoKey;
  let ask: unknown;
  try {
    const phoneKey = await d.phoneKeys.at(epoch);
    if (!phoneKey) return null;
    key = phoneKey.key;
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
