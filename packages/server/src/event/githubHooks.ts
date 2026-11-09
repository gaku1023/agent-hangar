import { randomBytes } from 'node:crypto';
import { generateInboxKeyPair } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { captureOutput, type CaptureOptions, type Captured } from '../platform/capture.ts';
import { needsShell } from '../platform/exec.ts';
import { findTool } from '../report/real.ts';
import type { InboxApi } from './inboxClient.ts';
import { REPO_RE } from './puller.ts';
import { addHookOrphan, bindingsForInbox, bindingsForRepo, dropHookOrphan, getBindingRow, listHookOrphans, setBindingInbox, type BindingInput, type HookOrphan } from './store.ts';

/**
 * GitHub の webhook と、Worker の受け箱の登録と解除（#563）。
 *
 * 受け箱と webhook は「repo × PC」ごとに 1 組で、その PC のその repo の結び付けが分け合う。
 * 外の webhook の結び付けは、結び付けごとに自分の受け箱を持つ。
 *
 * 登録（ensureRepoHook）：
 * - その repo の結び付けがすでに webhook を持っていれば、その組をそのまま返す。
 * 何も呼ばない。
 * - まだなら、受け箱を作り、gh api で webhook を付ける。
 * 秘密の値は 32 バイトの乱数で、gh へは標準入力の JSON で渡す（引数には載せない）。
 * - 404 と 403 は no_admin（その repo の管理者の権限が無い）。
 * そのとき作った受け箱は消す。
 * - 返す組（share）は、呼び手が createBinding にそのまま渡す。
 * 結び付けを作れなかったときは、呼び手が removeRepoHookIfUnused を呼ぶ。
 *   結び付けを作るまでの組はメモリに持ち、removeRepoHookIfUnused が外す。
 *
 * 解除：
 * 受け箱を使う最後の結び付けが消えると、store が後片付けの預かり（event_hook_orphans）に 1 行を残す。
 * 結び付けの行はもう無いので、webhook の ID と受け箱の ID はこの預かりから引く。
 * removeRepoHookIfUnused（repo ごと）と sweep（全部）が、webhook を外し、受け箱を消し、預かりを消す。
 * 404 は成功とみなす。
 * 403（もう管理者でない）は webhook を外せないので諦め、受け箱だけ消す。
 * それ以外の失敗（gh が無い、ネットワーク、クラウド未設定）では預かりを残し、次の sweep が続きをする。
 * どちらも投げない。
 *
 * 秘密の値、受け箱の ID、URL は、ログにも失敗の文にも出さない。
 */

const GH_TIMEOUT_MS = 20_000;
const EVENTS = ['check_suite', 'pull_request', 'pull_request_review', 'pull_request_review_comment', 'issue_comment', 'issues'] as const;

type Capture = (file: string, args: string[], o: CaptureOptions) => Promise<Captured>;

/**
 * 結び付けが分け合う組。
 * BindingInput へそのまま渡せる形である。
 */
export type RepoShare = Required<Pick<BindingInput, 'inboxId' | 'inboxPublicKey' | 'inboxPrivateKey' | 'webhookId' | 'hookSecret'>>;

export type EnsureRepoHookResult =
  | { status: 'registered'; hookId: number; share: RepoShare }
  | { status: 'no_admin' }
  | { status: 'failed'; message: string };

export type HookInboxResult = { status: 'ready' } | { status: 'failed'; message: string };

export type EventHooksDeps = {
  db: Db;
  /**
   * 今の受け箱の口。
   * 同期が組み直されると別のものになるので、毎回引く。
   * 使えないとき（クラウド未設定、口の無い client）は null。
   */
  api: () => Pick<InboxApi, 'createInbox' | 'deleteInbox'> | null;
  /**
   * Worker の URL。
   * 無ければ null。
   */
  baseUrl: () => string | null;
  /**
   * 受け箱を作ったか消した。
   * スマホの呼び鈴を、受け箱だけを使う利用者にも開けるために知らせる。
   */
  onInboxChanged?: () => void;
  env?: NodeJS.ProcessEnv;
  /**
   * gh を探す口。
   * 試験が差し替える（既定は findTool で、PATH のほかに既知の置き場も見るので、環境に gh があると見つかる）。
   */
  findGh?: (env: NodeJS.ProcessEnv) => string | null;
  capture?: Capture;
  now?: () => number;
};

type GhResult = { ok: true; stdout: string } | { ok: false; status: number | null; code: number | null; limited: boolean };

/**
 * 取り直しの間隔。
 * 1 分から倍にし、1 時間で止める。
 */
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

/**
 * gh の失敗の文。
 * 標準エラーは載せない（URL や秘密を含み得る）。
 */
const ghMessage = (r: Extract<GhResult, { ok: false }>): string => (r.limited ? 'rate limited' : r.status !== null ? `gh failed (HTTP ${r.status})` : r.code === null ? 'gh could not run' : `gh exited with ${r.code}`);

export class EventHooks {
  /**
   * 結び付けをまだ作っていない webhook の組。
   * repo は小文字で引く。
   */
  private readonly pending = new Map<string, RepoShare>();
  private chain: Promise<unknown> = Promise.resolve();
  /**
   * 順番待ちで、まだ始まっていない sweep。
   * あれば新しく積まずに、これを返す。
   */
  private sweepWaiting: Promise<void> | null = null;
  /**
   * 外しきれなかった預かりの、次に試してよい時刻と、今の間隔。
   * メモリだけで持ち、再起動で忘れる。
   */
  private readonly retry = new Map<string, { at: number; wait: number }>();

  constructor(private readonly d: EventHooksDeps) {}

  private get env(): NodeJS.ProcessEnv { return this.d.env ?? process.env; }
  private ghPath(): string | null { return (this.d.findGh ?? ((e) => findTool('gh', e)))(this.env); }
  private now(): number { return (this.d.now ?? Date.now)(); }

  /**
   * 登録と解除を 1 本ずつ流す。
   * 同じ repo の登録が二重にならず、解除と登録が行き違わない。
   */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async gh(bin: string, args: string[], stdin?: string): Promise<GhResult> {
    const capture = this.d.capture ?? captureOutput;
    let r: Captured;
    try {
      r = await capture(bin, args, { timeoutMs: GH_TIMEOUT_MS, env: this.env, shell: needsShell(bin), stderr: true, ...(stdin !== undefined ? { stdin } : {}) });
    } catch {
      return { ok: false, status: null, code: null, limited: false };
    }
    if (r.code === 0) return { ok: true, stdout: r.stdout };
    // 403 は権限が無いときと、呼びすぎのときの両方で返る。
    // 見分けて、呼びすぎは取り直せる失敗にする。
    return { ok: false, status: statusOf(r), code: r.code, limited: /rate limit/i.test(r.stderr) || /rate limit/i.test(r.stdout) };
  }

  /**
   * その repo の webhook を付ける。
   * すでにあれば同じ組を返す。
   */
  ensureRepoHook(repo: string): Promise<EnsureRepoHookResult> {
    return this.locked(() => this.register(repo)).catch(() => ({ status: 'failed', message: 'unexpected failure' }) as const);
  }

  private async register(repo: string): Promise<EnsureRepoHookResult> {
    if (!REPO_RE.test(repo)) return { status: 'failed', message: 'invalid repo' };
    const key = repo.toLowerCase();
    const bound = bindingsForRepo(this.d.db, repo).find((b) => b.webhookId !== null && b.inboxId && b.hookSecret);
    if (bound) {
      this.pending.delete(key);
      return { status: 'registered', hookId: bound.webhookId!, share: { inboxId: bound.inboxId, inboxPublicKey: bound.inboxPublicKey, inboxPrivateKey: bound.inboxPrivateKey, webhookId: bound.webhookId!, hookSecret: bound.hookSecret! } };
    }
    const kept = this.pending.get(key);
    if (kept && !listHookOrphans(this.d.db).some((o) => o.inboxId === kept.inboxId)) return { status: 'registered', hookId: kept.webhookId, share: kept };
    this.pending.delete(key);

    const bin = this.ghPath();
    if (!bin) return { status: 'failed', message: 'gh not found' };
    const api = this.d.api();
    const base = this.d.baseUrl();
    if (!api || !base) return { status: 'failed', message: 'cloud not set up' };
    const keys = await generateInboxKeyPair();
    let inboxId: string;
    try {
      inboxId = (await api.createInbox(keys.publicKey)).inboxId;
    } catch {
      return { status: 'failed', message: 'inbox unavailable' };
    }
    this.d.onInboxChanged?.();

    const secret = randomBytes(32).toString('hex');
    const spec = { name: 'web', active: true, events: [...EVENTS], config: { url: hookUrl(base, inboxId), content_type: 'json', secret, insecure_ssl: '0' } };
    const r = await this.gh(bin, ['api', '--method', 'POST', `repos/${repo}/hooks`, '--input', '-'], JSON.stringify(spec));
    const hookId = r.ok ? idOf(r.stdout) : null;
    if (!r.ok || hookId === null) {
      // 付けられなかった。
      // 作った受け箱は要らないので消す。
      // 消せなければ預かりに残し、次の sweep で消す。
      addHookOrphan(this.d.db, { inboxId, repo, webhookId: null }, this.now());
      await this.drain([{ inboxId, repo, webhookId: null }]);
      if (r.ok) return { status: 'failed', message: 'gh printed no hook id' };
      return !r.limited && (r.status === 404 || r.status === 403) ? { status: 'no_admin' } : { status: 'failed', message: ghMessage(r) };
    }
    const share: RepoShare = { inboxId, inboxPublicKey: keys.publicKey, inboxPrivateKey: keys.privateKey, webhookId: hookId, hookSecret: secret };
    this.pending.set(key, share);
    return { status: 'registered', hookId, share };
  }

  /**
   * その repo の結び付けが 1 つも無ければ、webhook と受け箱を外す。
   * 結び付けを消したあとと、結び付けを作れなかったときに呼ぶ。
   * まだ使っているなら何もしない。
   * 結び付けを消した分の預かりは store が残しているので、ここでは預かりを片付ける。
   */
  removeRepoHookIfUnused(repo: string): Promise<void> {
    return this.locked(async () => {
      if (!REPO_RE.test(repo)) return;
      const key = repo.toLowerCase();
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        if (!bindingsForRepo(this.d.db, repo).some((b) => b.inboxId === p.inboxId)) addHookOrphan(this.d.db, { inboxId: p.inboxId, repo, webhookId: p.webhookId }, this.now());
      }
      await this.drain(listHookOrphans(this.d.db, repo));
    }).catch(() => undefined);
  }

  /**
   * 預かっている後片付けを全部進める。
   * 結び付けを消したあとと、起動のときに呼ぶ。
   */
  sweep(): Promise<void> {
    if (this.sweepWaiting) return this.sweepWaiting;
    const p = this.locked(async () => {
      this.sweepWaiting = null;
      await this.drain(listHookOrphans(this.d.db));
    }).catch(() => undefined);
    this.sweepWaiting = p;
    return p;
  }

  /**
   * 預かりを 1 件ずつ片付ける。
   * 外しきれたものだけ預かりから消す。
   */
  private async drain(orphans: HookOrphan[]): Promise<void> {
    for (const o of orphans) {
      try {
        // 受け取った組で結び付けが作られていたら、使っているので外さない。
        if (bindingsForInbox(this.d.db, o.inboxId).length > 0) {
          dropHookOrphan(this.d.db, o.inboxId);
          this.retry.delete(o.inboxId);
          continue;
        }
        if ((this.retry.get(o.inboxId)?.at ?? 0) > this.now()) continue;
        if (o.webhookId !== null && o.repo !== null && REPO_RE.test(o.repo)) {
          const bin = this.ghPath();
          if (!bin) { this.later(o.inboxId); continue; }
          const r = await this.gh(bin, ['api', '--method', 'DELETE', `repos/${o.repo}/hooks/${o.webhookId}`]);
          // 404 はもう無い。
          // 403 は外す権限が無く、待っても変わらない。
          // 受け箱だけ消す。
          // 呼びすぎの 403 は、あとで取り直す。
          if (!r.ok && r.status !== 404 && !(r.status === 403 && !r.limited)) { this.later(o.inboxId); continue; }
        }
        const api = this.d.api();
        if (!api) { this.later(o.inboxId); continue; }
        await api.deleteInbox(o.inboxId);
        dropHookOrphan(this.d.db, o.inboxId);
        this.retry.delete(o.inboxId);
        this.d.onInboxChanged?.();
      } catch {
        // 続きは、間隔が過ぎてからの sweep。
        this.later(o.inboxId);
      }
    }
  }

  /** 外しきれなかった預かりの次の試しを、間隔を倍にして遅らせる。 */
  private later(inboxId: string): void {
    const wait = Math.min((this.retry.get(inboxId)?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    this.retry.set(inboxId, { at: this.now() + wait, wait });
  }

  /** 外の webhook の結び付けの受け箱を、まだ無ければ作る。 */
  ensureHookInbox(bindingId: string): Promise<HookInboxResult> {
    return this.locked(async () => {
      const row = getBindingRow(this.d.db, bindingId);
      if (!row || row.source.kind !== 'hook') return { status: 'failed', message: 'not a hook binding' } as const;
      if (row.inboxId) return { status: 'ready' } as const;
      return this.swapInbox(bindingId, null);
    }).catch(() => ({ status: 'failed', message: 'unexpected failure' }) as const);
  }

  /**
   * 外の webhook の URL を作り直す。
   * 新しい受け箱と鍵の対を作り、古い受け箱を消す。
   */
  rotateHookInbox(bindingId: string): Promise<HookInboxResult> {
    return this.locked(async () => {
      const row = getBindingRow(this.d.db, bindingId);
      if (!row || row.source.kind !== 'hook') return { status: 'failed', message: 'not a hook binding' } as const;
      return this.swapInbox(bindingId, row.inboxId);
    }).catch(() => ({ status: 'failed', message: 'unexpected failure' }) as const);
  }

  private async swapInbox(bindingId: string, oldInboxId: string | null): Promise<HookInboxResult> {
    const api = this.d.api();
    if (!api) return { status: 'failed', message: 'cloud not set up' };
    const keys = await generateInboxKeyPair();
    let inboxId: string;
    try {
      inboxId = (await api.createInbox(keys.publicKey)).inboxId;
    } catch {
      return { status: 'failed', message: 'inbox unavailable' };
    }
    try {
      setBindingInbox(this.d.db, bindingId, { inboxId, inboxPublicKey: keys.publicKey, inboxPrivateKey: keys.privateKey });
    } catch {
      // 結び付けが先に消えた。
      // 作った受け箱は預かりに回す。
      addHookOrphan(this.d.db, { inboxId, repo: null, webhookId: null }, this.now());
      await this.drain([{ inboxId, repo: null, webhookId: null }]);
      return { status: 'failed', message: 'binding is gone' };
    }
    this.d.onInboxChanged?.();
    if (oldInboxId) {
      addHookOrphan(this.d.db, { inboxId: oldInboxId, repo: null, webhookId: null }, this.now());
      await this.drain([{ inboxId: oldInboxId, repo: null, webhookId: null }]);
    }
    return { status: 'ready' };
  }

  /**
   * 外の webhook の URL。
   * 受け箱がまだ無い、Worker の URL が無い、外の webhook でないときは null。
   * 画面の専用の道だけが呼ぶ。
   */
  hookUrlOf(bindingId: string): string | null {
    const row = getBindingRow(this.d.db, bindingId);
    const base = this.d.baseUrl();
    if (!row || row.source.kind !== 'hook' || !row.inboxId || !base) return null;
    return hookUrl(base, row.inboxId);
  }
}

const hookUrl = (base: string, inboxId: string): string => `${base.replace(/\/+$/, '')}/hooks/${encodeURIComponent(inboxId)}`;

/**
 * gh api の失敗の HTTP の状態。
 * 標準エラーの `(HTTP 404)` を読み、無ければ標準出力の JSON の status を見る。
 */
function statusOf(r: Captured): number | null {
  const m = /HTTP (\d{3})/.exec(r.stderr);
  if (m) return Number(m[1]);
  try {
    const s = Number((JSON.parse(r.stdout) as { status?: unknown }).status);
    return Number.isInteger(s) && s >= 100 && s < 600 ? s : null;
  } catch {
    return null;
  }
}

function idOf(stdout: string): number | null {
  try {
    const id = (JSON.parse(stdout) as { id?: unknown }).id;
    return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}
