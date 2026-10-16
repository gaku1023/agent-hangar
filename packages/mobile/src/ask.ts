// shared を入口（index.ts）から読むと PC 向けの表まで束に入るので、使うものだけを直に読む。
import type { MobileAsk, MobileReply } from '@agent-hangar/shared/src/mobile.ts';
import { aadAsk, aadReply, MobilePairingError, open, seal } from '@agent-hangar/shared/src/mobileCrypto.ts';
import { mobileHeaders, originOf } from './api.ts';
import type { Pairing } from './store.ts';

/**
 * 問い合わせが答えを返さなかった理由。
 * - pc-offline：宛先の PC が呼び鈴につないでいない（503）。眠っている PC、止まった hangar、呼び鈴を知らない古い hangar もここに入る。
 * - pc-timeout：PC が 5 秒のうちに答えなかった（504）。
 * - unsupported：口の無い古い Worker（JSON でない 404）。
 * - not-found：宛先の PC が無いか、解除された（JSON の 404）。
 * - unreadable：答えを開けないか、形が違う。
 * - project-missing、account-missing、bad-request：PC が断った（封の中の答え）。
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
  | 'bad-request';

export class AskError extends Error {
  constructor(
    readonly reason: AskFailure,
    readonly status: number | null = null,
  ) {
    super(`問い合わせが通りませんでした（${reason}）`);
    this.name = 'AskError';
  }
}

/** 問い合わせの中身（v は送るときに付ける）。 */
export type AskBody = MobileAsk extends infer A ? (A extends { v: 1 } ? Omit<A, 'v'> : never) : never;
export type CommandHit = { name: string; description: string; kind: 'skill' | 'command' };
export type FileHit = { path: string; changed: boolean };
export type AskReply = { files: FileHit[] } | { commands: CommandHit[] };

/** 打つたびの問い合わせを出すまでに待つ長さ。 */
export const ASK_DEBOUNCE_MS = 250;
/** 同じ q の files を覚えておく長さ。 */
export const FILES_CACHE_MS = 30_000;

const PC_REFUSALS = new Set<AskFailure>(['project-missing', 'account-missing', 'bad-request']);

/** 開いた答えから、形の合う行だけを残す。形の違う答えは null。 */
function readReply(v: unknown): AskReply | { error: AskFailure } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.error === 'string') return PC_REFUSALS.has(o.error as AskFailure) ? { error: o.error as AskFailure } : null;
  if (Array.isArray(o.files)) {
    const files = (o.files as unknown[]).flatMap((f) => {
      const x = f as Partial<FileHit> | null;
      return x && typeof x === 'object' && typeof x.path === 'string' && x.path && typeof x.changed === 'boolean' ? [{ path: x.path, changed: x.changed }] : [];
    });
    return { files };
  }
  if (Array.isArray(o.commands)) {
    const commands = (o.commands as unknown[]).flatMap((c) => {
      const x = c as Partial<CommandHit> | null;
      return x && typeof x === 'object' && typeof x.name === 'string' && x.name && typeof x.description === 'string' && (x.kind === 'skill' || x.kind === 'command')
        ? [{ name: x.name, description: x.description, kind: x.kind }]
        : [];
    });
    return { commands };
  }
  return null;
}

async function failureOf(res: Response): Promise<AskError> {
  const s = res.status;
  if (s === 401) return new AskError('unpaired', s);
  if (s === 503) return new AskError('pc-offline', s);
  if (s === 504) return new AskError('pc-timeout', s);
  if (s === 429) return new AskError('rate-limited', s);
  if (s === 413) return new AskError('too-large', s);
  if (s === 404) {
    // 口のある Worker は JSON で断る。JSON でない 404 は、/m/ask を知らない古い Worker である。
    const body = await res.json().catch(() => null);
    return new AskError(body && typeof body === 'object' && 'error' in body ? 'not-found' : 'unsupported', s);
  }
  return new AskError('server', s);
}

/**
 * 宛先の PC に問い合わせる（POST /m/ask）。
 * 中身は aadAsk(id, 宛先) で封じ、答えは aadReply(id) で開く。Worker も Durable Object も中身を読めない。
 */
export async function askPc(p: Pairing, key: CryptoKey, targetDevice: string, body: AskBody): Promise<AskReply> {
  const id = globalThis.crypto.randomUUID();
  const ask = { v: 1, ...body } as MobileAsk;
  let origin: string;
  try {
    origin = originOf(p.url);
  } catch (e) {
    if (e instanceof MobilePairingError) throw new AskError('unpaired');
    throw e;
  }
  const sealed = await seal(key, aadAsk(id, targetDevice), ask);
  let res: Response;
  try {
    res = await fetch(`${origin}/m/ask`, {
      method: 'POST',
      headers: { ...mobileHeaders(p), 'content-type': 'application/json' },
      body: JSON.stringify({ id, targetDevice, sealed }),
      cache: 'no-store',
    });
  } catch {
    throw new AskError('network');
  }
  if (!res.ok) throw await failureOf(res);
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
    reply = await open<MobileReply>(key, aadReply(id), s);
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
  /** `/` の候補。同じ PC、プロジェクト、アカウントは画面の間 1 回だけ問い合わせる。 */
  commands: (pc: string, projectId: string | null, accountId: string) => Promise<CommandHit[]>;
  /** `@` の候補。同じ PC、プロジェクト、q は 30 秒覚える。 */
  files: (pc: string, projectId: string, q: string) => Promise<FileHit[]>;
};

/** 問い合わせ口を作る。失敗した問い合わせは覚えない（次で問い合わせ直す）。 */
export function createAsker(p: Pairing, key: CryptoKey, o: { now?: () => number; ask?: typeof askPc } = {}): Asker {
  const now = o.now ?? Date.now;
  const ask = o.ask ?? askPc;
  const cmds = new Map<string, Promise<CommandHit[]>>();
  const files = new Map<string, { at: number; p: Promise<FileHit[]> }>();
  return {
    commands: (pc, projectId, accountId) => {
      const k = JSON.stringify([pc, projectId, accountId]);
      const hit = cmds.get(k);
      if (hit) return hit;
      const pr = ask(p, key, pc, { kind: 'commands', projectId, accountId }).then((r) => ('commands' in r ? r.commands : []));
      cmds.set(k, pr);
      pr.catch(() => {
        if (cmds.get(k) === pr) cmds.delete(k);
      });
      return pr;
    },
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
