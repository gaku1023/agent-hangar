import {
  clampText,
  E2eOpenError,
  isEffort,
  isMobileMode,
  isPeerLaunchPermission,
  isModelName,
  MOBILE_LAUNCH_ID_MAX,
  MOBILE_PROMPT_MAX,
  openPeerLaunch,
  PEER_LAUNCH_TTL_MS,
  PeerUnknownEpochError,
  peerSealEpoch,
  sealPeerAnswer,
  type LaunchParams,
  type PeerKeyring,
  type PeerLaunchAnswer,
  type PeerLaunchApi,
  type PeerLaunchIncoming,
  type PeerLaunchRefusal,
  type PeerLaunchRequest,
  type PeerRoute,
} from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { displayName } from '../db/queries.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { getSpawn, isSpawnedFromOtherDevice, recordSpawn } from '../sessions/spawns.ts';
import { CloudError } from '../sync/client.ts';

/** 頼んだ PC と頼まれた PC の時計のずれを見込んで、期限に足す余裕（スマホの依頼と同じ）。 */
export const PEER_CLOCK_SLACK_MS = 5 * 60_000;
/** 答えを送れなかった頼みを送り直す長さ（扱った時刻から）。 */
export const PEER_ANSWER_RESEND_WINDOW_MS = 10 * 60_000;
/** 手元の記録（peer_launches）を残す長さ。同じ頼みの再送は Worker の期限で止まるので、重複を防ぐ控えの掃除である。 */
export const PEER_LAUNCH_KEEP_MS = 7 * 24 * 60 * 60_000;
/** 知らない世代の鍵を探して keybox を読み直す間隔。 */
export const PEER_EPOCH_REREAD_MS = 60_000;

/** この PC のアカウント 1 件。loggedIn が null なのは、まだ読めていない（未確認）こと。 */
export type PeerAccount = { id: string; loggedIn: boolean | null };

export type PeerLaunchInboxDeps = {
  db: Db;
  api: PeerLaunchApi;
  /** PC どうしの封の鍵（サーバの Keyring）。 */
  ring: () => Promise<PeerKeyring>;
  /** keybox を読み直して、新しい世代の鍵を手元に入れる。投げてよい（呼び手が受ける）。 */
  reread: () => Promise<void>;
  deviceId: string;
  /** 会話を起こす（RunManager.start と同じ道）。 */
  start: (p: LaunchParams) => LaunchResult | Promise<LaunchResult>;
  /** この PC に場所のある（未解決でない）プロジェクトか。 */
  hasProjectHere: (projectId: string) => boolean;
  /** この PC のそのエージェントのアカウントを名前で引く。無ければ null。 */
  accountByName: (agent: 'claude-code' | 'codex', name: string) => PeerAccount | null;
  /** この PC でそのエージェントを起こせるか（入っていて、設定で有効）。 */
  hasAgent: (agent: PeerLaunchRequest['agent']) => boolean;
  /** いま頼みを扱ってよいか（同期が動き、Worker の版が PEER_LAUNCH_MIN_WORKER_COMPAT に届いている）。偽なら claim せずに残す。 */
  canProcess: () => boolean;
  now: () => number;
  /** 頼みで会話を起こせたときの受け手。記録の後、答えの前に 1 回だけ呼ぶ。投げても答えは送る。 */
  onStarted?: (e: PeerLaunchStarted) => void;
  /**
   * send と stop の頼み（D16）の実行。対象が頼んだ側の起こした会話であることは、呼ぶ前に確かめてある。
   * send は入力を入れる前に結果の印を付け、入れられなければ印を戻す。投げれば launch-failed で断る。省けば send と stop は断る。
   */
  control?: {
    send(sessionId: string, text: string): Promise<void>;
    stop(sessionId: string): Promise<void> | void;
  };
};

/** 頼みで起こした会話。from は頼んだ PC の ID、parentSessionId は頼んだ PC の会話。 */
export type PeerLaunchStarted = { requestId: string; from: string; parentSessionId: string; sessionId: string; title: string; hasPrompt: boolean };

const isCodexEffort = (v: unknown): v is string => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]{0,23}$/.test(v);

const firstLine = (prompt: string): string => [...(prompt.split(/\r?\n/).find((x) => x.trim()) ?? '').trim()].slice(0, 40).join('');
const kindOf = (e: unknown): string => {
  const status = (e as { status?: unknown } | null)?.status;
  return `${e instanceof Error ? e.constructor.name : typeof e}${typeof status === 'number' ? ` ${status}` : ''}`;
};

/**
 * 開けた頼みの意味を検査する（開く関数は型の形しか見ない）。
 * 文字数、権限モード（送る側と同じ isPeerLaunchPermission。新規ダイアログの値と default）とモデルと effort の値、エージェントごとの欄の組み合わせを見る。
 * Codex の権限は mode か permissionMode のどちらかに入っていればよい。opencode にはアカウントと権限モードと effort が無く、Claude には mode と autoApprove が無い。
 */
function isMeaningful(r: PeerLaunchRequest): boolean {
  if (r.op === 'send' || r.op === 'stop') {
    // 起動の欄は使わない。対象と、send の本文だけを見る。
    if (r.parentSessionId.length === 0 || r.parentSessionId.length > MOBILE_LAUNCH_ID_MAX) return false;
    if (!r.targetSessionId || r.targetSessionId.length > MOBILE_LAUNCH_ID_MAX) return false;
    return r.op === 'send' ? r.prompt.trim().length > 0 && r.prompt.length <= MOBILE_PROMPT_MAX : r.prompt === '';
  }
  // 親の会話が空なのは、人が画面から頼んだ起動（結び付きも結果の返却も無い）。
  if (r.prompt.length > MOBILE_PROMPT_MAX || r.parentSessionId.length > MOBILE_LAUNCH_ID_MAX) return false;
  if (r.account.length > MOBILE_LAUNCH_ID_MAX || (r.callerAccount?.length ?? 0) > MOBILE_LAUNCH_ID_MAX) return false;
  if (r.projectId !== null && (r.projectId.length === 0 || r.projectId.length > MOBILE_LAUNCH_ID_MAX)) return false;
  if (r.scratch ? r.projectId !== null : r.projectId === null) return false;
  if (r.model !== '' && !isModelName(r.model)) return false;
  if ((r.name?.length ?? 0) > 200) return false;
  // 権限の値の検査は送る側（peerTools）と同じ関数を使う。
  if (!isPeerLaunchPermission(r)) return false;
  if (r.agent === 'codex') return (r.effort === undefined || isCodexEffort(r.effort)) && r.autoApprove === undefined;
  if (!(r.effort === undefined || isEffort(r.effort))) return false;
  if (r.agent === 'opencode') {
    return r.account === '' && r.effort === undefined && (r.mode === undefined || isMobileMode(r.mode));
  }
  return r.mode === undefined && r.autoApprove === undefined;
}

/**
 * 別の PC からの起動の頼み（pull の応答の peerLaunches、呼び鈴の peer launch）を受け取って、この PC で会話を起こす。
 * スマホの MobileLaunchInbox（mobile/launchInbox.ts）と同じ順で、1 件の扱いは次のとおりである。
 * 手元の記録（peer_launches）にあれば何もしない、扱ってよくなければ何もしない、頼みが名乗る世代の鍵が無ければ（keybox を読み直しても）claim せずに残す、
 * Worker で claim できなければ何もしない、開く（開けなければ bad-payload）、意味を検査する（bad-payload）、期限を見る（expired）、
 * 深さ（depth-exceeded）、プロジェクトの場所（project-missing）、エージェント（agent-missing）、アカウントとログイン（account-missing、account-logged-out）、起こす（launch-failed）、
 * 結び付きを書く、記録する、答える、である。
 * 記録は答えより先に書く。答えを送れなくても、同じ頼みを二度起こさない（再起動をまたいでも）。送れなかった答えは resendAnswers が同じ封のまま送り直す。
 * 承認（D8）は頼んだ PC の仕事なので、projectId と scratch はそのまま受ける。auto_approve と permission_mode もそのまま通す（D10）。
 * receive と resendAnswers は 1 本ずつ順に走らせる。
 */
export class PeerLaunchInbox {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly keyless = new Set<string>();
  private lastReread = 0;

  constructor(private readonly deps: PeerLaunchInboxDeps) {}

  receive(l: PeerLaunchIncoming[]): Promise<void> {
    return this.queue(() => this.receiveOnce(l));
  }

  /** 答えを送れなかった頼みに、控えた答えを送り直す。投げない。 */
  resendAnswers(): Promise<void> {
    return this.queue(() => this.resendOnce());
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async resendOnce(): Promise<void> {
    const { db, now } = this.deps;
    if (!this.deps.canProcess()) return;
    const rows = db
      .prepare('select id, ok, sealed_answer from peer_launches where answered = 0 and sealed_answer is not null and handled_at >= ? order by handled_at')
      .all(now() - PEER_ANSWER_RESEND_WINDOW_MS) as { id: string; ok: number; sealed_answer: string }[];
    for (const r of rows) await this.sendAnswer(r.id, r.ok === 1, r.sealed_answer);
  }

  /** 答えを 1 回送る。届いたか、409 でもう受け取れないなら answered にする。ほかの失敗は次の回に送り直す。 */
  private async sendAnswer(id: string, ok: boolean, sealed: string): Promise<void> {
    try {
      await this.deps.api.answer(id, ok, sealed);
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 409)) {
        console.error('[peer] could not send the launch answer; will resend', kindOf(e));
        return;
      }
    }
    this.deps.db.prepare('update peer_launches set answered = 1 where id = ?').run(id);
  }

  private async receiveOnce(list: PeerLaunchIncoming[]): Promise<void> {
    this.pruneRecords();
    const seen = new Set<string>();
    for (const l of list) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      try {
        await this.handle(l);
      } catch (e) {
        console.error('[peer] could not handle a launch request; will retry on the next pull', kindOf(e));
      }
    }
  }

  private pruneRecords(): void {
    if (this.keyless.size > 500) this.keyless.clear();
    try {
      this.deps.db.prepare('delete from peer_launches where handled_at < ?').run(this.deps.now() - PEER_LAUNCH_KEEP_MS);
    } catch (e) {
      console.error('[peer] could not prune old launch records', kindOf(e));
    }
  }

  /** 封が名乗る世代の鍵があるか。無ければ keybox を間引いて読み直し、もう一度探す。 */
  private async haveKey(ring: PeerKeyring, sealed: string): Promise<boolean> {
    const epoch = peerSealEpoch(sealed);
    // 形の違う封は、鍵の探しようが無い。claim して bad-payload で答える。
    if (epoch === null || ring.at(epoch)) return true;
    const t = this.deps.now();
    if (t - this.lastReread >= PEER_EPOCH_REREAD_MS) {
      this.lastReread = t;
      try { await this.deps.reread(); } catch (e) { console.warn('[peer] could not re-read the keybox for an epoch', kindOf(e)); }
    }
    return !!ring.at(epoch);
  }

  private async handle(l: PeerLaunchIncoming): Promise<void> {
    const { db, deviceId, now } = this.deps;
    if (db.prepare('select 1 from peer_launches where id = ?').get(l.id)) return;
    if (!this.deps.canProcess()) return;
    const ring = await this.deps.ring();
    if (!(await this.haveKey(ring, l.sealed))) {
      if (!this.keyless.has(l.id)) console.warn('[peer] no key for the epoch of a launch request; left it unclaimed');
      this.keyless.add(l.id);
      return;
    }
    if (!(await this.deps.api.claim(l.id))) return;
    // 受け取った後は、どの結果でも記録して答える。確かめの途中の思わぬ失敗でも、答えずに残さない。
    const route: PeerRoute = { requestId: l.id, from: l.from, to: deviceId };
    const opened: { r: PeerLaunchRequest | null } = { r: null };
    const answer = await this.decide(ring, route, l, opened).catch((): PeerLaunchAnswer => ({ ok: false, reason: 'launch-failed' }));
    const sealed = await sealPeerAnswer(ring, route, answer).catch(() => null);
    const launched = opened.r && (opened.r.op ?? 'launch') === 'launch';
    const started = answer.ok && opened.r && launched ? { ...answer, r: opened.r } : null;
    const reported = started !== null && started.r.parentSessionId !== '';
    if (started && reported) this.link(l, started.r, started.sessionId);
    db
      .prepare('insert or ignore into peer_launches (id, from_device, handled_at, result, sealed_answer, ok, answered, session_id, parent_session_id) values (?, ?, ?, ?, ?, ?, 0, ?, ?)')
      .run(l.id, l.from, now(), answer.ok ? (launched ? 'started' : opened.r!.op!) : answer.reason, sealed, answer.ok ? 1 : 0, answer.ok ? answer.sessionId : null, opened.r?.parentSessionId ?? null);
    if (started && reported) {
      try {
        this.deps.onStarted?.({ requestId: l.id, from: l.from, parentSessionId: started.r.parentSessionId, sessionId: started.sessionId, title: started.title, hasPrompt: started.r.prompt !== '' });
      } catch (e) {
        console.error('[peer] could not announce the started session', kindOf(e));
      }
    }
    if (sealed !== null) await this.sendAnswer(l.id, answer.ok, sealed);
  }

  /** 起こした会話の親を、頼んだ PC の会話として残す（D17）。書けなくても起動は成功のまま。 */
  private link(l: PeerLaunchIncoming, r: PeerLaunchRequest, sessionId: string): void {
    try {
      recordSpawn(this.deps.db, this.deps.deviceId, sessionId, r.parentSessionId, this.deps.now(), { parentDeviceId: l.from });
    } catch (e) {
      console.error('[peer] could not record the spawn link', kindOf(e));
    }
  }

  private async decide(ring: PeerKeyring, route: PeerRoute, l: PeerLaunchIncoming, opened: { r: PeerLaunchRequest | null }): Promise<PeerLaunchAnswer> {
    const fail = (reason: PeerLaunchRefusal, detail?: string): PeerLaunchAnswer => (detail ? { ok: false, reason, detail } : { ok: false, reason });
    let r: PeerLaunchRequest;
    try {
      r = await openPeerLaunch(ring, route, l.sealed);
    } catch (e) {
      if (e instanceof E2eOpenError || e instanceof PeerUnknownEpochError) return fail('bad-payload');
      throw e;
    }
    opened.r = r;
    if (!isMeaningful(r)) return fail('bad-payload');
    if (r.createdAt < this.deps.now() - PEER_LAUNCH_TTL_MS - PEER_CLOCK_SLACK_MS) return fail('expired');
    if (r.op === 'send' || r.op === 'stop') return this.control(r, l.from, fail);
    // 深さは 1 まで（D11）。頼んだ会話が、さらに別の PC から起こされたものなら断る。頼みの申告と、同期で届いた結び付きのどちらでも見る。
    if (r.spawnedRemotely === true || isSpawnedFromOtherDevice(this.deps.db, l.from, r.parentSessionId)) return fail('depth-exceeded');
    if (!r.scratch && !this.deps.hasProjectHere(r.projectId!)) return fail('project-missing');
    if (!this.deps.hasAgent(r.agent)) return fail('agent-missing');
    const params: LaunchParams = r.scratch ? { scratch: true } : { projectId: r.projectId! };
    if (r.agent !== 'opencode') {
      // アカウントは名前で決める。省かれていれば頼みに入っている呼び出し元のアカウントの名前で、それも無ければこの PC の既定（D7）。
      const want = r.account || r.callerAccount || '';
      if (want) {
        const a = this.deps.accountByName(r.agent, want);
        if (!a) return fail('account-missing', want);
        if (a.loggedIn === false) return fail('account-logged-out', want);
        params.account = a.id;
      }
    }
    if (r.agent !== 'claude-code') params.agent = r.agent;
    if (r.agent === 'codex') {
      const perm = r.mode || r.permissionMode;
      if (perm) params.mode = perm;
    } else {
      if (r.permissionMode) params.permissionMode = r.permissionMode;
      if (r.mode) params.mode = r.mode;
      if (r.autoApprove) params.autoApprove = true;
    }
    if (r.model) params.model = r.model;
    if (r.effort) params.effort = r.effort;
    if (r.name) params.name = r.name;
    if (r.prompt) params.prompt = r.prompt;
    let res: LaunchResult;
    try {
      res = await this.deps.start(params);
    } catch (e) {
      return fail('launch-failed', clampText(e instanceof Error ? e.message : String(e)) ?? undefined);
    }
    // 起こした後は、題が読めなくても started と答える（会話は動いている）。
    let title: string;
    try { title = this.titleOf(res.sessionId, r.prompt); } catch { title = firstLine(r.prompt); }
    return { ok: true, sessionId: res.sessionId, title };
  }

  /**
   * send と stop（D16）。対象は、この PC にあり、結び付きの親が頼んだ PC と頼んだ会話である会話に限る。
   * 結び付きが閉じた後（終わりを返した後）でも、切り離されるまでは起こした相手のままである。
   */
  private async control(r: PeerLaunchRequest, from: string, fail: (reason: PeerLaunchRefusal, detail?: string) => PeerLaunchAnswer): Promise<PeerLaunchAnswer> {
    const target = r.targetSessionId!;
    const link = getSpawn(this.deps.db, this.deps.deviceId, target);
    if (!link || link.childDeviceId !== this.deps.deviceId || link.parentDeviceId !== from || link.parentId !== r.parentSessionId) return fail('not-spawned-by-caller');
    const c = this.deps.control;
    if (!c) return fail('launch-failed', 'unsupported');
    try {
      if (r.op === 'send') await c.send(target, r.prompt);
      else await c.stop(target);
    } catch (e) {
      return fail('launch-failed', clampText(e instanceof Error ? e.message : String(e)) ?? undefined);
    }
    let title: string;
    try { title = this.titleOf(target, ''); } catch { title = ''; }
    return { ok: true, sessionId: target, title };
  }

  private titleOf(sessionId: string, prompt: string): string {
    const s = this.deps.db
      .prepare('select s.custom_title, n.name, s.ai_title, s.first_prompt from sessions s left join session_notes n on n.session_id = s.id and n.deleted_at is null where s.id = ?')
      .get(sessionId) as { custom_title: string | null; name: string | null; ai_title: string | null; first_prompt: string | null } | undefined;
    return (s ? displayName(s, undefined) : null) ?? firstLine(prompt);
  }
}
