import {
  aadAnswer,
  aadLaunch,
  clampText,
  isModelName,
  LAUNCH_TTL_MS,
  open,
  PERMISSION_MODE_VALUES,
  seal,
  type LaunchParams,
  type MobileLaunchAnswer,
  type MobileLaunchOut,
  type MobileLaunchPayload,
} from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { displayName } from '../db/queries.ts';
import type { LaunchResult } from '../runs/manager.ts';
import type { CloudClient } from '../sync/client.ts';
import { mobileKeyFor } from './publisher.ts';

/** スマホと PC の時計のずれを見込んで、TTL に足す余裕。Worker は TTL を過ぎた依頼を claim させないので、これは時計の狂った依頼への備えである。 */
export const LAUNCH_CLOCK_SLACK_MS = 5 * 60_000;

type FailReason = Extract<MobileLaunchAnswer, { ok: false }>['reason'];

export type MobileLaunchInboxDeps = {
  db: Db;
  client: CloudClient;
  joinSecret: string;
  deviceId: string;
  /** 会話を起こす（RunManager.start）。tmux と psmux の違いは RunManager が持つ。 */
  start: (p: LaunchParams) => LaunchResult;
  /** この PC に場所のある（未解決でない）プロジェクトか。 */
  hasProjectHere: (projectId: string) => boolean;
  /** この PC に登録したアカウントか。 */
  hasAccount: (id: string) => boolean;
  now: () => number;
};

const PERMISSION_MODES: ReadonlySet<string> = new Set(PERMISSION_MODE_VALUES);

/** 開けた中身が依頼の形か。権限モードとモデルは、PC の新規セッションのダイアログと同じ値だけを通す（--model へそのまま渡すので、引数に読まれる形を断る）。 */
function isPayload(v: unknown): v is MobileLaunchPayload {
  const o = v as Partial<MobileLaunchPayload> | null;
  return (
    !!o && typeof o === 'object' &&
    o.v === 1 &&
    typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) &&
    (o.projectId === null || typeof o.projectId === 'string') &&
    typeof o.scratch === 'boolean' &&
    typeof o.accountId === 'string' &&
    typeof o.permissionMode === 'string' && PERMISSION_MODES.has(o.permissionMode) &&
    typeof o.model === 'string' && (o.model === '' || isModelName(o.model)) &&
    typeof o.prompt === 'string'
  );
}

/** 依頼から起動の params を組む。scratch ならプロジェクトを渡さない。空（既定）の権限モードとモデルは含めない。 */
function paramsOf(p: MobileLaunchPayload): LaunchParams {
  const params: LaunchParams = p.scratch ? { scratch: true } : { projectId: p.projectId! };
  params.account = p.accountId;
  if (p.permissionMode) params.permissionMode = p.permissionMode;
  if (p.model) params.model = p.model;
  if (p.prompt) params.prompt = p.prompt;
  return params;
}

/** ログに出すのは種類だけにする。依頼の中身や秘密を含む文をそのまま出さない。 */
const kindOf = (e: unknown): string => {
  const status = (e as { status?: unknown } | null)?.status;
  return `${e instanceof Error ? e.constructor.name : typeof e}${typeof status === 'number' ? ` ${status}` : ''}`;
};

/**
 * スマホからの起動の依頼（pull の応答の launches）を受け取って、この PC で会話を起こす。
 *
 * 1 件の扱いの順は、手元の記録（mobile_launches）にあれば何もしない、Worker で claim できなければ何もしない、
 * 開封する（開けなければ bad-payload）、時間切れを見る（expired）、プロジェクトとアカウントを確かめる、起こす、記録する、答える、である。
 * 記録は答えより先に書く。答えを送れなくても、同じ依頼を二度起こさない（スマホは時間切れと言う）。
 * claim が通信で倒れたときは記録しないので、次の pull でもう一度試す（Worker で受け取れていれば 409 で止まる）。
 * receive は 1 本ずつ順に走らせる。並行に 2 回呼んでも、同じ依頼を 2 度扱わない。
 */
export class MobileLaunchInbox {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: MobileLaunchInboxDeps) {}

  receive(l: MobileLaunchOut[]): Promise<void> {
    const p = this.tail.then(() => this.receiveOnce(l));
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async receiveOnce(list: MobileLaunchOut[]): Promise<void> {
    const seen = new Set<string>();
    for (const l of list) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      try {
        await this.handle(l);
      } catch (e) {
        console.error('[mobile] could not handle a launch request; will retry on the next pull', kindOf(e));
      }
    }
  }

  private handled(id: string): boolean {
    return !!this.deps.db.prepare('select 1 from mobile_launches where id = ?').get(id);
  }

  private async handle(l: MobileLaunchOut): Promise<void> {
    const { client, deviceId, now } = this.deps;
    if (this.handled(l.id)) return;
    const claim = client.claimLaunch?.bind(client);
    if (!claim || !client.answerLaunch) return;
    if (!(await claim(l.id))) return;
    // 受け取った後は、どの結果でも記録して答える。
    const key = await mobileKeyFor(this.deps.joinSecret);
    // 確かめの途中で思わぬ失敗をしても、受け取った依頼は答えずに残さない（claim はもう通らない）。
    const answer = await this.decide(key, l).catch((): MobileLaunchAnswer => ({ ok: false, reason: 'launch-failed' }));
    this.deps.db.prepare('insert or ignore into mobile_launches (id, handled_at, result) values (?, ?, ?)').run(l.id, now(), answer.ok ? 'started' : answer.reason);
    try {
      await client.answerLaunch(l.id, answer.ok, await seal(key, aadAnswer(l.id), answer));
    } catch (e) {
      console.error('[mobile] could not send the launch answer', kindOf(e));
    }
  }

  private async decide(key: CryptoKey, l: MobileLaunchOut): Promise<MobileLaunchAnswer> {
    const fail = (reason: FailReason, detail?: string): MobileLaunchAnswer => (detail ? { ok: false, reason, detail } : { ok: false, reason });
    let p: unknown;
    try {
      // 宛先（この PC）を AAD で縛る。ほかの PC 宛ての封じを付け替えた依頼は開けない。
      p = await open<unknown>(key, aadLaunch(l.id, this.deps.deviceId), l.sealed);
    } catch {
      return fail('bad-payload');
    }
    if (!isPayload(p)) return fail('bad-payload');
    if (p.createdAt < this.deps.now() - LAUNCH_TTL_MS - LAUNCH_CLOCK_SLACK_MS) return fail('expired');
    if (!p.scratch && (p.projectId === null || !this.deps.hasProjectHere(p.projectId))) return fail('project-missing');
    if (!this.deps.hasAccount(p.accountId)) return fail('account-missing');
    let r: LaunchResult;
    try {
      r = this.deps.start(paramsOf(p));
    } catch (e) {
      // 理由の文は封じてスマホにだけ渡す。
      return fail('launch-failed', clampText(e instanceof Error ? e.message : String(e)) ?? undefined);
    }
    return { ok: true, sessionId: r.sessionId, title: this.titleOf(r.sessionId, p.prompt) };
  }

  /** 起こした会話の表示名。行がまだ無ければ、最初の指示の先頭 40 字（表示名の決め方と同じ）。 */
  private titleOf(sessionId: string, prompt: string): string {
    const s = this.deps.db
      .prepare('select s.custom_title, n.name, s.ai_title, s.first_prompt from sessions s left join session_notes n on n.session_id = s.id and n.deleted_at is null where s.id = ?')
      .get(sessionId) as { custom_title: string | null; name: string | null; ai_title: string | null; first_prompt: string | null } | undefined;
    return (s ? displayName(s, undefined) : null) ?? displayName({ custom_title: null, name: null, ai_title: null, first_prompt: prompt || null }, undefined) ?? '';
  }
}
