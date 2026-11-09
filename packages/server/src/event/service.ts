import { EVENT_BINDINGS_MAX, t, type EventAction, type EventBindingDto, type EventSource, type WakeOn } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import type { GetLanguage } from '../i18n/language.ts';
import { MessageError, msg } from '../i18n/message.ts';
import type { EventHooks } from './githubHooks.ts';
import { deviceOfSession } from '../runs/handover.ts';
import { bindingsForRepo, countBindings, createBinding, deleteBinding, getBinding, getBindingRow, listBindings, refreshWakeBinding, setBindingInbox, updateBinding, type BindingRow } from './store.ts';

/**
 * 結び付けを作る、承認する、消す流れ（#563）。画面の道（http/routes/events.ts）と、Paused の確定（http/routes/sessions.ts）が使う。
 * GitHub の結び付けは、webhook と受け箱を付けてから行を作る。付けられなかったら、何も作らずに理由を返す。
 * 外の webhook の結び付けは、受け箱の無い行を先に作り、受け箱を作れたときだけ有効にする。
 * webhook の組（share）には秘密が入っている。createBinding と setBindingInbox にだけ渡し、返さず、ログにも出さない。
 */

export type HookState = { status: 'registered' | 'no_admin' | 'failed' | 'none'; message?: string };
/** 付けられなかったときの理由。結び付けは作っていない。 */
export type HookFailure = { status: 'no_admin' | 'failed'; message?: string };
export type CreateResult = { binding: EventBindingDto; hook?: { status: 'registered' } } | { hook: HookFailure };
export type NewBinding = {
  source: EventSource; action: EventAction; prompt: string; passBody: boolean; allowAuthors: string[]; fromSessionId?: string | null;
};
/** state が active のとき、受け箱を作れなかったら hook に理由を載せ、binding は下書きのまま返す。 */
export type UpdateResult = { binding: EventBindingDto; hook?: HookFailure };
export type BindingPatchInput = { prompt?: string; passBody?: boolean; allowAuthors?: string[]; state?: 'active' };

export type EventServiceDeps = {
  db: Db;
  /** この PC の ID。起こす結び付けは、会話を最後に動かした PC でだけ作る。 */
  deviceId: string;
  hooks: Pick<EventHooks, 'ensureRepoHook' | 'removeRepoHookIfUnused' | 'sweep' | 'ensureHookInbox' | 'rotateHookInbox' | 'hookUrlOf'>;
  /** 結び付けが増えた、減った。スマホの呼び鈴を組み直させる（呼び鈴は結び付けがあるときだけ張る）。 */
  changed: () => void;
  language: GetLanguage;
  now?: () => number;
};

const notFound = (): MessageError => new MessageError(msg('schedules.event.error.notFound'));
const overCap = (): MessageError => new MessageError(msg('schedules.event.error.max', { max: EVENT_BINDINGS_MAX }));

export class EventBindingService {
  /** 最後に付けられなかった理由を repo ごとに覚える（画面の札の元）。付けられたら忘れる。メモリだけ。 */
  private readonly lastFailure = new Map<string, HookFailure>();

  constructor(private readonly d: EventServiceDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }
  private changed(): void { try { this.d.changed(); } catch { /* 呼び鈴の組み直しの失敗で、作った結び付けを無かったことにしない */ } }

  list(): EventBindingDto[] { return listBindings(this.d.db); }

  private assertRoom(): void {
    if (countBindings(this.d.db) >= EVENT_BINDINGS_MAX) throw overCap();
  }

  /** repo の webhook の登録の状態。gh は呼ばない。結び付けが組を持っていれば registered、無ければ最後の失敗、それも無ければ none。 */
  repoHookState(repo: string): HookState {
    if (bindingsForRepo(this.d.db, repo).some((b) => b.webhookId !== null && b.inboxId && b.hookSecret)) return { status: 'registered' };
    const f = this.lastFailure.get(repo.toLowerCase());
    return f ? { status: f.status, ...(f.message ? { message: f.message } : {}) } : { status: 'none' };
  }

  /** 利用者が作る。作ったら有効になる。 */
  async create(input: NewBinding): Promise<CreateResult> {
    this.assertRoom();
    if (input.source.kind === 'hook') return this.createHook(input);
    const repo = input.source.repo;
    const hook = await this.d.hooks.ensureRepoHook(repo);
    if (hook.status !== 'registered') return this.failed(repo, hook);
    this.lastFailure.delete(repo.toLowerCase());
    let binding: EventBindingDto;
    try {
      binding = createBinding(this.d.db, { ...hook.share, source: input.source, action: input.action, prompt: input.prompt, passBody: input.passBody, allowAuthors: input.allowAuthors, state: 'active', fromSessionId: input.fromSessionId ?? null }, this.now());
    } catch (e) {
      await this.d.hooks.removeRepoHookIfUnused(repo);
      throw e;
    }
    this.changed();
    return { binding, hook: { status: 'registered' } };
  }

  private failed(repo: string, hook: { status: 'no_admin' } | { status: 'failed'; message: string }): { hook: HookFailure } {
    const f: HookFailure = hook.status === 'failed' ? { status: 'failed', message: hook.message } : { status: 'no_admin' };
    this.lastFailure.set(repo.toLowerCase(), f);
    return { hook: f };
  }

  /** 外の webhook。受け箱の無い行を先に作り、受け箱ができたら有効にする。作れなければ行も消す。 */
  private async createHook(input: NewBinding): Promise<CreateResult> {
    const draft = createBinding(this.d.db, { inboxId: '', inboxPublicKey: '', inboxPrivateKey: '', source: input.source, action: input.action, prompt: input.prompt, passBody: input.passBody, allowAuthors: input.allowAuthors, state: 'draft', fromSessionId: input.fromSessionId ?? null }, this.now());
    const inbox = await this.d.hooks.ensureHookInbox(draft.id);
    if (inbox.status !== 'ready') {
      deleteBinding(this.d.db, draft.id, this.now());
      return { hook: { status: 'failed', message: inbox.message } };
    }
    const binding = updateBinding(this.d.db, draft.id, { state: 'active' }, this.now());
    this.changed();
    return { binding };
  }

  /**
   * 変える。指示、本文を渡すか、渡してよい人は、そのまま書く。
   * state: 'active' は承認（下書きを有効にする）か、止まった結び付けの再開である。
   */
  async update(id: string, patch: BindingPatchInput): Promise<UpdateResult> {
    if (!getBindingRow(this.d.db, id)) throw notFound();
    const fields = { ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}), ...(patch.passBody !== undefined ? { passBody: patch.passBody } : {}), ...(patch.allowAuthors !== undefined ? { allowAuthors: patch.allowAuthors } : {}) };
    if (Object.keys(fields).length > 0) updateBinding(this.d.db, id, fields, this.now());
    const hook = patch.state === 'active' ? await this.activate(id) : null;
    const binding = getBinding(this.d.db, id);
    if (!binding) throw notFound();
    return hook ? { binding, hook: hook.hook } : { binding };
  }

  /** 受け箱が要るのに無いときは、承認のこの時点で作る。作れなければ下書きのままにして理由を返す。 */
  private async activate(id: string): Promise<{ hook: HookFailure } | null> {
    const row = getBindingRow(this.d.db, id);
    if (!row) throw notFound();
    if (row.state === 'active') return null;
    // 下書きを有効にすると、上限に数えられる。
    if (row.state === 'draft') this.assertRoom();
    const failure = await this.ensureInbox(row);
    if (failure) return failure;
    updateBinding(this.d.db, id, { state: 'active' }, this.now());
    this.changed();
    return null;
  }

  private async ensureInbox(row: BindingRow): Promise<{ hook: HookFailure } | null> {
    if (row.source.kind === 'hook') {
      const r = await this.d.hooks.ensureHookInbox(row.id);
      return r.status === 'ready' ? null : { hook: { status: 'failed', message: r.message } };
    }
    if (row.inboxId && row.webhookId !== null && row.hookSecret) return null;
    const repo = row.source.repo;
    const hook = await this.d.hooks.ensureRepoHook(repo);
    if (hook.status !== 'registered') return this.failed(repo, hook);
    this.lastFailure.delete(repo.toLowerCase());
    try {
      const { share } = hook;
      this.d.db.transaction(() => {
        setBindingInbox(this.d.db, row.id, { inboxId: share.inboxId, inboxPublicKey: share.inboxPublicKey, inboxPrivateKey: share.inboxPrivateKey });
        updateBinding(this.d.db, row.id, { webhookId: share.webhookId, hookSecret: share.hookSecret }, this.now());
      })();
    } catch (e) {
      // 結び付けが先に消えた。付けた組を使う行が無ければ外す。
      await this.d.hooks.removeRepoHookIfUnused(repo);
      throw e;
    }
    return null;
  }

  /** 消す。webhook と受け箱の後片付けは、裏で進める。 */
  remove(id: string): boolean {
    const gone = deleteBinding(this.d.db, id, this.now());
    if (gone) {
      void this.d.hooks.sweep();
      this.changed();
    }
    return gone;
  }

  /**
   * 同じ Paused のまま状態を書き直した（理由や戻る日を変えた）ときに、起こす結び付けを残す。
   * Paused を付け直すと、結び付けは古い Paused のものに見えるので、作った時刻を付け直す。
   */
  keepWakes(sessionId: string): void {
    for (const b of this.list()) if (b.action.kind === 'wake' && b.action.sessionId === sessionId) refreshWakeBinding(this.d.db, b.id, this.now());
  }

  /** 外の webhook の URL を作り直す。新しい URL は hookUrlOf で読む。 */
  async rotate(id: string): Promise<{ ok: true } | { hook: HookFailure }> {
    const row = getBindingRow(this.d.db, id);
    if (!row) throw notFound();
    if (row.source.kind !== 'hook') throw new MessageError(msg('schedules.event.error.invalid'));
    const r = await this.d.hooks.rotateHookInbox(id);
    return r.status === 'ready' ? { ok: true } : { hook: { status: 'failed', message: r.message } };
  }

  /** 外の webhook の URL。画面の専用の道だけが呼ぶ。 */
  hookUrl(id: string): string | null {
    if (!getBindingRow(this.d.db, id)) throw notFound();
    return this.d.hooks.hookUrlOf(id);
  }

  /**
   * Paused の確定で、起こす結び付けを作る。
   * 会話を最後に動かした PC でだけ作る（結び付けは作った PC のローカルにだけ置き、動かすのもこの PC だけなので）。ほかの PC の会話には 'other_pc' を返す。
   * 同じ会話の前の起こす結び付けは、新しいものを作れてから消す。作れなかったときは前のものを残し、
   * 同じ repo の webhook も付け直さずに済む。同じ条件がすでにあれば足さず、ほかの起こす結び付けだけを消す。
   * GitHub の webhook を付けられなかったときは、その理由を返す（Paused は確定したまま）。
   */
  async createWake(sessionId: string, wakeOn: WakeOn): Promise<{ status: 'created' } | HookFailure> {
    if (deviceOfSession(this.d.db, sessionId)?.id !== this.d.deviceId) return { status: 'failed', message: 'other_pc' };
    const wakes = this.list().filter((b) => b.action.kind === 'wake' && b.action.sessionId === sessionId);
    const same = wakes.find((b) => b.source.kind === 'github' && b.source.repo.toLowerCase() === wakeOn.repo.toLowerCase() && b.source.pr === wakeOn.pr && b.source.when.length === 1 && b.source.when[0] === wakeOn.when);
    let keep = same?.id ?? null;
    // 使い回す結び付けは、いまの Paused のものとして作った時刻を付け直す（古い Paused のものとは見なさせない）。
    if (same) refreshWakeBinding(this.d.db, same.id, this.now());
    if (!same) {
      const r = await this.create({
        source: { kind: 'github', repo: wakeOn.repo, when: [wakeOn.when], pr: wakeOn.pr }, action: { kind: 'wake', sessionId },
        prompt: t(this.d.language(), 'schedules.event.wakePrompt'), passBody: false, allowAuthors: [], fromSessionId: sessionId,
      });
      if (!('binding' in r)) return r.hook;
      keep = r.binding.id;
    }
    for (const b of wakes) if (b.id !== keep) this.remove(b.id);
    return { status: 'created' };
  }
}
