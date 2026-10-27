// shared を入口（index.ts）から読むと PC 向けの表まで束に入るので、使うものだけを直に読む。
import { isMobileMode, type MobileAgent, type MobileAgentOptions, type MobileAsk, type MobileCodexOptions, type MobileAskIn, type MobileModelOption, type MobileReply } from '@agent-hangar/shared/src/mobile.ts';
import { isModelName } from '@agent-hangar/shared/src/summaryEngine.ts';
import { aadAsk, aadReply, MobilePairingError, open, seal } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { mobileHeaders, originOf, unpairedOf, workerCompatOf, workerTooOld, type UnpairedReason } from './api.ts';
import type { Pairing, PhoneKey } from './store.ts';

/**
 * 問い合わせが答えを返さなかった理由。
 * - pc-offline：宛先の PC が呼び鈴につないでいない（503）。眠っている PC、止まった hangar、呼び鈴を知らない古い hangar もここに入る。
 * - pc-timeout：PC が 5 秒のうちに答えなかった（504）。
 * - unsupported：口の無い古い Worker（応答の版の見出しが MOBILE_BELL_MIN_WORKER_COMPAT 未満）。
 * - not-found：宛先の PC が無いか、解除された（404）。
 * - unreadable：答えを開けないか、形が違う。
 * - project-missing、account-missing、bad-request：PC が断った（封の中の答え）。
 * - agent-missing：PC で opencode を使えない（無効か、見つからない）。
 */
export type AskFailure =
  | 'pc-offline'
  | 'pc-timeout'
  | 'unsupported'
  | 'not-found'
  | 'unreadable'
  | 'rate-limited'
  | 'too-large'
  | 'unpaired'
  | 'network'
  | 'server'
  | 'project-missing'
  | 'account-missing'
  | 'agent-missing'
  | 'bad-request';

/** 問い合わせの失敗。unpairedReason は 401 の理由。 */
export class AskError extends Error {
  constructor(
    readonly reason: AskFailure,
    readonly status: number | null = null,
    readonly unpairedReason: UnpairedReason = 'unknown',
  ) {
    super(`問い合わせが通りませんでした（${reason}）`);
    this.name = 'AskError';
  }
}

/** 問い合わせの中身（v は送るときに付ける）。 */
export type AskBody = MobileAsk extends infer A ? (A extends { v: 1 } ? Omit<A, 'v'> : never) : never;
export type CommandHit = { name: string; description: string; kind: 'skill' | 'command' };
export type FileHit = { path: string; changed: boolean };
export type AskReply = { files: FileHit[] } | { commands: CommandHit[] } | { agentOptions: MobileAgentOptions | null } | { codexOptions: MobileCodexOptions | null };

/** 打つたびの問い合わせを出すまでに待つ長さ。 */
export const ASK_DEBOUNCE_MS = 250;
/** 同じ q の files を覚えておく長さ。 */
export const FILES_CACHE_MS = 30_000;

const PC_REFUSALS = new Set<AskFailure>(['project-missing', 'account-missing', 'agent-missing', 'bad-request']);

/** 画面が受け取り、描く数の上限（設計書の答えの上限と同じ）。PC がこれを超えて返しても、画面の側で切る。 */
export const MOBILE_ASK_FILES_MAX = 50;
export const MOBILE_ASK_COMMANDS_MAX = 200;
/** パスと名前はこれを超えたら落とす（切ると別のパス、別の名前になる）。 */
export const MOBILE_ASK_NAME_MAX = 300;
/** 説明はこれで切る。 */
export const MOBILE_ASK_DESCRIPTION_MAX = 120;

const LINE_BREAK = /[\r\n\u2028\u2029]/;

/** files を、形の合う、改行を含まない、長すぎない、重ならない行に絞り、上限で切る。 */
export function capFiles(list: readonly unknown[]): FileHit[] {
  const seen = new Set<string>();
  const out: FileHit[] = [];
  for (const f of list) {
    if (out.length >= MOBILE_ASK_FILES_MAX) break;
    const x = f as Partial<FileHit> | null;
    if (!x || typeof x !== 'object' || typeof x.path !== 'string' || typeof x.changed !== 'boolean') continue;
    const path = x.path;
    if (!path || path.length > MOBILE_ASK_NAME_MAX || LINE_BREAK.test(path) || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, changed: x.changed });
  }
  return out;
}

/** commands を、形の合う、空白を含まない、長すぎない、重ならない行に絞り、説明を切り、上限で切る。 */
export function capCommands(list: readonly unknown[]): CommandHit[] {
  const seen = new Set<string>();
  const out: CommandHit[] = [];
  for (const c of list) {
    if (out.length >= MOBILE_ASK_COMMANDS_MAX) break;
    const x = c as Partial<CommandHit> | null;
    if (!x || typeof x !== 'object' || typeof x.name !== 'string' || typeof x.description !== 'string' || (x.kind !== 'skill' && x.kind !== 'command')) continue;
    const name = x.name;
    // 「/名前」は空白で切れるので、空白や改行を含む名前は入れられない。
    if (!name || name.length > MOBILE_ASK_NAME_MAX || /\s/.test(name)) continue;
    const k = `${x.kind}:${name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, description: [...x.description].slice(0, MOBILE_ASK_DESCRIPTION_MAX).join(''), kind: x.kind });
  }
  return out;
}

/** opencode のモデルとモードの件数、名前と説明の字数の上限（PC の答えの上限と同じ）。 */
const AGENT_MODELS_MAX = 100;
const AGENT_MODES_MAX = 20;
const AGENT_LABEL_MAX = 60;
const COSTS: ReadonlySet<string> = new Set(['local', 'free', 'metered', 'plan']);
const DATA_USES: ReadonlySet<string> = new Set(['on-device', 'no-training', 'retain-30d', 'may-train', 'provider-logs']);
const cut = (s: string, n: number): string => [...s].slice(0, n).join('');

/**
 * opencode の選択肢を、送れる形の行だけに絞る。
 * モードとモデルは、PC が起動の依頼で受ける形（isMobileMode、isModelName）のものだけを残す。知らない費用の型のモデルは落とし、知らないデータの扱いは null（分からない）にする。
 * 形の違う答えは null。
 */
export function capAgentOptions(v: unknown): MobileAgentOptions | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<Record<keyof MobileAgentOptions, unknown>>;
  if (!Array.isArray(o.modes) || !Array.isArray(o.models) || typeof o.stale !== 'boolean') return null;
  const modes: MobileAgentOptions['modes'] = [];
  for (const m of o.modes as unknown[]) {
    if (modes.length >= AGENT_MODES_MAX) break;
    const x = m as { id?: unknown; description?: unknown } | null;
    if (!x || typeof x !== 'object' || !isMobileMode(x.id) || modes.some((y) => y.id === x.id)) continue;
    modes.push({ id: x.id, description: typeof x.description === 'string' ? cut(x.description, MOBILE_ASK_DESCRIPTION_MAX) : null });
  }
  const models: MobileModelOption[] = [];
  for (const m of o.models as unknown[]) {
    if (models.length >= AGENT_MODELS_MAX) break;
    const x = m as Partial<Record<keyof MobileModelOption, unknown>> | null;
    if (!x || typeof x !== 'object' || !isModelName(x.id) || typeof x.cost !== 'string' || !COSTS.has(x.cost) || models.some((y) => y.id === x.id)) continue;
    const label = typeof x.label === 'string' && x.label.trim() ? cut(x.label, AGENT_LABEL_MAX) : x.id;
    const group = typeof x.group === 'string' ? cut(x.group, AGENT_LABEL_MAX) : '';
    const data = typeof x.data === 'string' && DATA_USES.has(x.data) ? (x.data as MobileModelOption['data']) : null;
    models.push({ id: x.id, label, group, cost: x.cost as MobileModelOption['cost'], data });
  }
  return {
    version: typeof o.version === 'string' ? cut(o.version, 40) : null,
    verified: o.verified === true,
    modes,
    models,
    defaultModel: isModelName(o.defaultModel) ? o.defaultModel : null,
    stale: o.stale,
    fetchedAt: typeof o.fetchedAt === 'number' && Number.isFinite(o.fetchedAt) ? o.fetchedAt : 0,
  };
}

/** Codex のモデルと推論の段階の件数の上限（PC の答えの上限と同じ）。 */
const CODEX_MODELS_MAX = 40;
const CODEX_EFFORTS_MAX = 8;
/** PC が起動の依頼で受ける推論の段階の形（server の mobile/launchInbox.ts と同じ）。 */
const isEffortWord = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,23}$/.test(v);

/**
 * Codex の選択肢を、送れる形の行だけに絞る。モデルは isModelName、推論の段階は isEffortWord の形のものだけを残し、defaultEffort が段階の中に無ければ null にする。
 * 形の違う答えは null。
 */
export function capCodexOptions(v: unknown): MobileCodexOptions | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Partial<Record<keyof MobileCodexOptions, unknown>>;
  if (!Array.isArray(o.models) || typeof o.stale !== 'boolean') return null;
  const models: MobileCodexOptions['models'] = [];
  for (const m of o.models as unknown[]) {
    if (models.length >= CODEX_MODELS_MAX) break;
    const x = m as Partial<Record<'id' | 'label' | 'efforts' | 'defaultEffort', unknown>> | null;
    if (!x || typeof x !== 'object' || !isModelName(x.id) || models.some((y) => y.id === x.id)) continue;
    const efforts = (Array.isArray(x.efforts) ? (x.efforts as unknown[]) : []).filter(isEffortWord).slice(0, CODEX_EFFORTS_MAX);
    models.push({
      id: x.id,
      label: typeof x.label === 'string' && x.label.trim() ? cut(x.label, AGENT_LABEL_MAX) : x.id,
      efforts,
      defaultEffort: typeof x.defaultEffort === 'string' && efforts.includes(x.defaultEffort) ? x.defaultEffort : null,
    });
  }
  return {
    version: typeof o.version === 'string' ? cut(o.version, 40) : null,
    verified: o.verified === true,
    models,
    stale: o.stale,
    fetchedAt: typeof o.fetchedAt === 'number' && Number.isFinite(o.fetchedAt) ? o.fetchedAt : 0,
  };
}

/** 開いた答えから、形の合う行だけを残す。形の違う答えは null。 */
function readReply(v: unknown): AskReply | { error: AskFailure } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.error === 'string') return PC_REFUSALS.has(o.error as AskFailure) ? { error: o.error as AskFailure } : null;
  if (Array.isArray(o.files)) return { files: capFiles(o.files as unknown[]) };
  if (Array.isArray(o.commands)) return { commands: capCommands(o.commands as unknown[]) };
  if ('agentOptions' in o) {
    if (o.agentOptions === null) return { agentOptions: null };
    const a = capAgentOptions(o.agentOptions);
    return a ? { agentOptions: a } : null;
  }
  if ('codexOptions' in o) {
    if (o.codexOptions === null) return { codexOptions: null };
    const c = capCodexOptions(o.codexOptions);
    return c ? { codexOptions: c } : null;
  }
  return null;
}

function failureOf(res: Response): AskError {
  const s = res.status;
  if (s === 401) return new AskError('unpaired', s);
  if (s === 404) return new AskError('not-found', s);
  if (s === 503) return new AskError('pc-offline', s);
  if (s === 504) return new AskError('pc-timeout', s);
  if (s === 429) return new AskError('rate-limited', s);
  if (s === 413) return new AskError('too-large', s);
  return new AskError('server', s);
}

/**
 * 宛先の PC に問い合わせる（POST /m/ask）。
 * 中身は aadAsk(id, 宛先) で封じ、答えは aadReply(id) で開く。Worker も Durable Object も中身を読めない。
 */
export async function askPc(p: Pairing, key: PhoneKey, targetDevice: string, body: AskBody): Promise<AskReply> {
  const id = globalThis.crypto.randomUUID();
  const ask = { v: 1, ...body } as MobileAsk;
  let origin: string;
  try {
    origin = originOf(p.url);
  } catch (e) {
    if (e instanceof MobilePairingError) throw new AskError('unpaired');
    throw e;
  }
  const sealed = await seal(key.key, aadAsk(id, targetDevice), ask);
  // epoch は封じたスマホ用の鍵の世代。PC は同じ世代の鍵で開き、答えも同じ世代で封じる。
  const req: MobileAskIn = { id, targetDevice, sealed, epoch: key.epoch };
  let res: Response;
  try {
    res = await fetch(`${origin}/m/ask`, {
      method: 'POST',
      headers: { ...mobileHeaders(p), 'content-type': 'application/json' },
      body: JSON.stringify(req),
      cache: 'no-store',
    });
  } catch {
    throw new AskError('network');
  }
  // /m/ask を知らない古い Worker（rc.1 も JSON の 404 を返す）は、応答の版の見出しで見分ける。
  if (workerTooOld(workerCompatOf(res))) throw new AskError('unsupported', res.status);
  if (res.status === 401) throw new AskError('unpaired', 401, (await unpairedOf(res)).reason);
  if (!res.ok) throw failureOf(res);
  let out: unknown;
  try {
    out = await res.json();
  } catch {
    throw new AskError('unreadable', res.status);
  }
  const s = out && typeof out === 'object' ? (out as { sealed?: unknown }).sealed : undefined;
  if (typeof s !== 'string') throw new AskError('unreadable', res.status);
  let reply: MobileReply;
  try {
    reply = await open<MobileReply>(key.key, aadReply(id), s);
  } catch {
    throw new AskError('unreadable', res.status);
  }
  const r = readReply(reply);
  if (!r) throw new AskError('unreadable', res.status);
  if ('error' in r) throw new AskError(r.error, res.status);
  return r;
}

/** 画面の間だけ答えを覚える問い合わせ口。 */
export type Asker = {
  /**
   * `/` の候補。同じ PC、プロジェクト、アカウント、エージェントは画面の間 1 回だけ問い合わせる。
   * agent が opencode なら、アカウントは空で、PC は opencode のコマンドとスキルを返す。
   */
  commands: (pc: string, projectId: string | null, accountId: string, agent?: MobileAgent) => Promise<CommandHit[]>;
  /** `@` の候補。同じ PC、プロジェクト、q は 30 秒覚える。 */
  files: (pc: string, projectId: string, q: string) => Promise<FileHit[]>;
  /** opencode のモードとモデル。同じ PC とプロジェクトは画面の間 1 回だけ問い合わせる。PC がまだ一覧を持っていなければ null。 */
  agentOptions: (pc: string, projectId: string | null) => Promise<MobileAgentOptions | null>;
  /** Codex のモデルと推論の段階。場所に依らないので PC ごとに画面の間 1 回だけ問い合わせる。PC がまだ一覧を持っていなければ null。 */
  codexOptions: (pc: string) => Promise<MobileCodexOptions | null>;
};

/** 問い合わせ口を作る。失敗した問い合わせは覚えない（次で問い合わせ直す）。 */
export function createAsker(p: Pairing, key: PhoneKey, o: { now?: () => number; ask?: typeof askPc } = {}): Asker {
  const now = o.now ?? Date.now;
  const ask = o.ask ?? askPc;
  const cmds = new Map<string, Promise<CommandHit[]>>();
  const files = new Map<string, { at: number; p: Promise<FileHit[]> }>();
  const options = new Map<string, Promise<MobileAgentOptions | null>>();
  const codexOpts = new Map<string, Promise<MobileCodexOptions | null>>();
  /** 画面の間覚え、失敗したものは忘れる（次で問い合わせ直す）。 */
  const remember = <T>(m: Map<string, Promise<T>>, k: string, make: () => Promise<T>): Promise<T> => {
    const hit = m.get(k);
    if (hit) return hit;
    const pr = make();
    m.set(k, pr);
    pr.catch(() => {
      if (m.get(k) === pr) m.delete(k);
    });
    return pr;
  };
  return {
    commands: (pc, projectId, accountId, agent) =>
      remember(cmds, JSON.stringify([pc, projectId, accountId, agent ?? null]), () =>
        ask(p, key, pc, agent ? { kind: 'commands', projectId, accountId, agent } : { kind: 'commands', projectId, accountId }).then((r) => ('commands' in r ? r.commands : [])),
      ),
    agentOptions: (pc, projectId) =>
      remember(options, JSON.stringify([pc, projectId]), () =>
        ask(p, key, pc, { kind: 'agent-options', agent: 'opencode', projectId }).then((r) => ('agentOptions' in r ? r.agentOptions : null)),
      ),
    codexOptions: (pc) =>
      remember(codexOpts, pc, () => ask(p, key, pc, { kind: 'agent-options', agent: 'codex', projectId: null }).then((r) => ('codexOptions' in r ? r.codexOptions : null))),
    files: (pc, projectId, q) => {
      const k = JSON.stringify([pc, projectId, q]);
      const t = now();
      const hit = files.get(k);
      if (hit && t - hit.at < FILES_CACHE_MS) return hit.p;
      const pr = ask(p, key, pc, { kind: 'files', projectId, q }).then((r) => ('files' in r ? r.files : []));
      files.set(k, { at: t, p: pr });
      pr.catch(() => {
        if (files.get(k)?.p === pr) files.delete(k);
      });
      return pr;
    },
  };
}

/** 最後に渡したものだけを ms 待ってから走らせる。 */
export function debounce(ms: number = ASK_DEBOUNCE_MS): { run: (fn: () => void) => void; cancel: () => void } {
  let t: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (t) clearTimeout(t);
    t = null;
  };
  return {
    run: (fn) => {
      cancel();
      t = setTimeout(() => {
        t = null;
        fn();
      }, ms);
    },
    cancel,
  };
}
