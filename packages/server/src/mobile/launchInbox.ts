import fs from 'node:fs';
import {
  aadAnswer,
  aadImage,
  aadLaunch,
  appendPaths,
  clampText,
  isEffort,
  isModelName,
  LAUNCH_TTL_MS,
  MOBILE_IMAGE_MAX_BYTES,
  MOBILE_IMAGES_PER_LAUNCH,
  MOBILE_LAUNCH_ID_MAX,
  MOBILE_PROMPT_MAX,
  open,
  openBytes,
  PERMISSION_MODE_VALUES,
  seal,
  type LaunchParams,
  type MobileImageRef,
  type MobileLaunchAnswer,
  type MobileLaunchOut,
  type MobileLaunchPayload,
} from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { displayName } from '../db/queries.ts';
import { pruneDrops, saveDrop } from '../prompt/drops.ts';
import type { LaunchResult } from '../runs/manager.ts';
import { CloudError, type CloudClient } from '../sync/client.ts';
import type { PhoneKeySource } from '../sync/phoneKeys.ts';

/** スマホと PC の時計のずれを見込んで、TTL に足す余裕。Worker は TTL を過ぎた依頼を claim させないので、これは時計の狂った依頼への備えである。 */
export const LAUNCH_CLOCK_SLACK_MS = 5 * 60_000;

/** 答えを送れなかった依頼を送り直す長さ（扱った時刻から）。スマホは 80 秒で待つのをやめるが、受信箱の確かめのために少し長く送る。 */
export const ANSWER_RESEND_WINDOW_MS = 10 * 60_000;

/** 手元の記録（mobile_launches）を残す長さ。同じ依頼の再送は Worker の TTL（数分）で止まるので、これは重複を防ぐ控えの掃除である。 */
export const MOBILE_LAUNCH_KEEP_MS = 7 * 24 * 60 * 60_000;

type FailReason = Extract<MobileLaunchAnswer, { ok: false }>['reason'];

export type MobileLaunchInboxDeps = {
  db: Db;
  client: CloudClient;
  /** スマホ用の鍵 M。依頼は、依頼が名乗る世代（epoch）の M で開き、答えと画像も同じ世代で封じて開く。 */
  phoneKeys: Pick<PhoneKeySource, 'at'>;
  deviceId: string;
  /** 画像を置く場所（PC の指示欄の添付と同じ drops）。 */
  dropsDir: string;
  /** 会話を起こす（RunManager.start）。tmux と psmux の違いは RunManager が持つ。 */
  start: (p: LaunchParams) => LaunchResult;
  /** この PC に場所のある（未解決でない）プロジェクトか。 */
  hasProjectHere: (projectId: string) => boolean;
  /** この PC に登録したアカウントか。 */
  hasAccount: (id: string) => boolean;
  /** いま依頼を扱ってよいか（boot/sync.ts の canCarryMobile）。偽なら claim せずに残す（Worker の行は pending のまま）。 */
  canProcess: () => boolean;
  now: () => number;
  /** 依頼で会話を起こせたときの受け手（右下の通知、試作 F1）。記録の後、答えの前に 1 回だけ呼ぶ。投げても答えは送る。 */
  onStarted?: (e: PhoneLaunchStarted) => void;
};

/**
 * 依頼で起こした会話。from は依頼を置いたスマホの ID（Worker の launches の from、返さない Worker では null）。
 * permissionMode は依頼の権限モード（空は既定）、title は答えに入れた会話の名前。
 */
export type PhoneLaunchStarted = { sessionId: string; from: string | null; projectId: string | null; scratch: boolean; permissionMode: string; title: string };

const PERMISSION_MODES: ReadonlySet<string> = new Set(PERMISSION_MODE_VALUES);

/** 封（IV 12 バイトと認証タグ 16 バイト）の分。Worker の置ける大きさ（packages/cloud の SEAL_OVERHEAD_BYTES）と同じ。 */
const SEAL_OVERHEAD_BYTES = 28;

const IMAGE_EXT: Readonly<Record<MobileImageRef['mime'], string>> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** 画像の控えの並びが正しいか。枚数は 1 依頼の上限まで、番号は 0 から上限の手前で重ならず、mime は許しの内、大きさは 1 枚の上限まで。 */
function isImageRefs(v: unknown): v is MobileImageRef[] {
  if (!Array.isArray(v) || v.length > MOBILE_IMAGES_PER_LAUNCH) return false;
  const seen = new Set<number>();
  for (const r of v as unknown[]) {
    const o = r as Partial<MobileImageRef> | null;
    if (!o || typeof o !== 'object') return false;
    if (typeof o.n !== 'number' || !Number.isInteger(o.n) || o.n < 0 || o.n >= MOBILE_IMAGES_PER_LAUNCH || seen.has(o.n)) return false;
    seen.add(o.n);
    if (typeof o.mime !== 'string' || !Object.hasOwn(IMAGE_EXT, o.mime)) return false;
    if (typeof o.bytes !== 'number' || !Number.isInteger(o.bytes) || o.bytes < 1 || o.bytes > MOBILE_IMAGE_MAX_BYTES) return false;
  }
  return true;
}

/** 開けた中身が依頼の形か。権限モードとモデルは、PC の新規セッションのダイアログと同じ値だけを通す（--model へそのまま渡すので、引数に読まれる形を断る）。 */
function isPayload(v: unknown): v is MobileLaunchPayload {
  const o = v as Partial<MobileLaunchPayload> | null;
  return (
    !!o && typeof o === 'object' &&
    o.v === 1 &&
    typeof o.createdAt === 'number' && Number.isFinite(o.createdAt) &&
    (o.projectId === null || (typeof o.projectId === 'string' && o.projectId.length <= MOBILE_LAUNCH_ID_MAX)) &&
    typeof o.scratch === 'boolean' &&
    typeof o.accountId === 'string' && o.accountId.length <= MOBILE_LAUNCH_ID_MAX &&
    typeof o.permissionMode === 'string' && PERMISSION_MODES.has(o.permissionMode) &&
    typeof o.model === 'string' && (o.model === '' || isModelName(o.model)) &&
    typeof o.prompt === 'string' && o.prompt.length <= MOBILE_PROMPT_MAX &&
    (o.effort === undefined || isEffort(o.effort)) &&
    (o.images === undefined || isImageRefs(o.images))
  );
}

/** 依頼から起動の params を組む。scratch ならプロジェクトを渡さない。空（既定）の権限モードとモデルと effort は含めない。prompt は画像のパスを足したものを渡せる。 */
function paramsOf(p: MobileLaunchPayload, prompt = p.prompt): LaunchParams {
  const params: LaunchParams = p.scratch ? { scratch: true } : { projectId: p.projectId! };
  params.account = p.accountId;
  if (p.permissionMode) params.permissionMode = p.permissionMode;
  if (p.model) params.model = p.model;
  if (p.effort) params.effort = p.effort;
  if (prompt) params.prompt = prompt;
  return params;
}

/** 最初の指示の、空でない最初の行の先頭 40 字（表示名の決め方と同じ長さ）。 */
const firstLine = (prompt: string): string => [...(prompt.split(/\r?\n/).find((x) => x.trim()) ?? '').trim()].slice(0, 40).join('');

/** ログに出すのは種類だけにする。依頼の中身や秘密を含む文をそのまま出さない。 */
const kindOf = (e: unknown): string => {
  const status = (e as { status?: unknown } | null)?.status;
  return `${e instanceof Error ? e.constructor.name : typeof e}${typeof status === 'number' ? ` ${status}` : ''}`;
};

/**
 * スマホからの起動の依頼（pull の応答の launches）を受け取って、この PC で会話を起こす。
 *
 * 1 件の扱いの順は、手元の記録（mobile_launches）にあれば何もしない、依頼の世代（epoch）のスマホ用の鍵が無ければ何もしない、Worker で claim できなければ何もしない、
 * 開封する（開けなければ bad-payload）、時間切れを見る（expired）、プロジェクトとアカウントを確かめる、画像を取って drops に置く（欠ければ images-missing）、起こす、記録する、答える、である。
 * 記録は答えより先に書く。答えを送れなくても、同じ依頼を二度起こさない。
 * 起こせた依頼は、記録に会話の ID と権限モードも控え（一覧のラベル「スマホから」）、onStarted で右下の通知に知らせる（試作 F1）。
 * 記録には封じた答えも控える。送れなかった答えは resendAnswers が、扱ってから ANSWER_RESEND_WINDOW_MS のあいだ同じ封のまま送り直す。
 * Worker が受け取るか、409（もう答えた、ほかの PC 宛て、無い ID）を返したら answered にして、それ以上送らない。
 * claim が通信で倒れたときは記録しないので、次の pull でもう一度試す（Worker で受け取れていれば 409 で止まる）。
 * 手元より新しい世代の依頼は、名簿を読み直してから鍵を探す（PhoneKeySource.at）。
 * 読み直しても鍵が無い世代（手元より古い世代を含む）は、claim せずに残す。答えを封じる鍵が無いので受け取らず、Worker の TTL でスマホに時間切れが出る。
 * 次の pull でもう一度試すので、鍵が後から届けば（名簿の読み直しで）扱える。
 * receive と resendAnswers は 1 本ずつ順に走らせる。並行に 2 回呼んでも、同じ依頼を 2 度扱わない。
 */
export class MobileLaunchInbox {
  private tail: Promise<unknown> = Promise.resolve();
  /** 鍵の無い世代で残した依頼の ID。ログを 1 件につき 1 回にする。 */
  private readonly keyless = new Set<string>();

  constructor(private readonly deps: MobileLaunchInboxDeps) {}

  receive(l: MobileLaunchOut[]): Promise<void> {
    return this.queue(() => this.receiveOnce(l));
  }

  /** 答えを送れなかった依頼に、控えた答えを送り直す。扱ってよくないあいだは何もしない。投げない。 */
  resendAnswers(): Promise<void> {
    return this.queue(() => this.resendOnce());
  }

  private queue(fn: () => Promise<void>): Promise<void> {
    const p = this.tail.then(fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async resendOnce(): Promise<void> {
    const { client, db, now } = this.deps;
    if (!this.deps.canProcess() || !client.answerLaunch) return;
    const rows = db
      .prepare('select id, ok, sealed_answer from mobile_launches where answered = 0 and sealed_answer is not null and handled_at >= ? order by handled_at')
      .all(now() - ANSWER_RESEND_WINDOW_MS) as { id: string; ok: number; sealed_answer: string }[];
    for (const r of rows) await this.sendAnswer(r.id, r.ok === 1, r.sealed_answer);
  }

  /** 答えを 1 回送る。届いたか、409 でもう受け取れないなら answered にする。ほかの失敗は次の回に送り直す。 */
  private async sendAnswer(id: string, ok: boolean, sealed: string): Promise<void> {
    try {
      await this.deps.client.answerLaunch!(id, ok, sealed);
    } catch (e) {
      if (!(e instanceof CloudError && e.status === 409)) {
        console.error('[mobile] could not send the launch answer; will resend', kindOf(e));
        return;
      }
    }
    this.deps.db.prepare('update mobile_launches set answered = 1 where id = ?').run(id);
  }

  private async receiveOnce(list: MobileLaunchOut[]): Promise<void> {
    this.pruneRecords();
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

  /**
   * 手元の記録のうち、残す長さを過ぎたものを消す。失敗しても受け取りは続ける。
   * 起こした会話の行は、その会話が一覧にある間は残す（ラベル「スマホから」の元なので）。会話を消したら、次の掃除で消える。
   */
  private pruneRecords(): void {
    if (this.keyless.size > 500) this.keyless.clear();
    try {
      this.deps.db
        .prepare('delete from mobile_launches where handled_at < ? and (session_id is null or not exists (select 1 from sessions s where s.id = mobile_launches.session_id and s.deleted_at is null))')
        .run(this.deps.now() - MOBILE_LAUNCH_KEEP_MS);
    } catch (e) {
      console.error('[mobile] could not prune old launch records', kindOf(e));
    }
  }

  private handled(id: string): boolean {
    return !!this.deps.db.prepare('select 1 from mobile_launches where id = ?').get(id);
  }

  private async handle(l: MobileLaunchOut): Promise<void> {
    const { client, deviceId, now } = this.deps;
    if (this.handled(l.id)) return;
    // 受け取ってから止められた（一時停止、版 6 の Worker など）ときは、claim せずに残す。
    if (!this.deps.canProcess()) return;
    const claim = client.claimLaunch?.bind(client);
    if (!claim || !client.answerLaunch) return;
    // 答えも画像も依頼と同じ世代の鍵で封じて開く。鍵の無い世代は受け取らない。
    const phoneKey = await this.deps.phoneKeys.at(l.epoch);
    if (!phoneKey) {
      if (!this.keyless.has(l.id)) console.warn(`[mobile] no phone key for epoch ${l.epoch}; left the launch request unclaimed`);
      this.keyless.add(l.id);
      return;
    }
    if (!(await claim(l.id))) return;
    // 受け取った後は、どの結果でも記録して答える。
    const key = phoneKey.key;
    // 確かめの途中で思わぬ失敗をしても、受け取った依頼は答えずに残さない（claim はもう通らない）。
    const opened: { p: MobileLaunchPayload | null } = { p: null };
    const answer = await this.decide(key, l, opened).catch((): MobileLaunchAnswer => ({ ok: false, reason: 'launch-failed' }));
    // 封じられなくても記録は残す（同じ依頼を二度起こさない）。封の無い行は送り直さない。
    const sealed = await seal(key, aadAnswer(l.id), answer).catch(() => null);
    // 起こした会話と権限モードも控える（一覧のラベル「スマホから」、試作 F1）。起こせなかった依頼はどちらも null。
    const started = answer.ok && opened.p ? { ...answer, p: opened.p } : null;
    this.deps.db
      .prepare('insert or ignore into mobile_launches (id, handled_at, result, sealed_answer, ok, answered, session_id, permission_mode) values (?, ?, ?, ?, ?, 0, ?, ?)')
      .run(l.id, now(), answer.ok ? 'started' : answer.reason, sealed, answer.ok ? 1 : 0, started?.sessionId ?? null, started?.p.permissionMode ?? null);
    if (started) {
      try {
        this.deps.onStarted?.({ sessionId: started.sessionId, from: l.from ?? null, projectId: started.p.scratch ? null : started.p.projectId, scratch: started.p.scratch, permissionMode: started.p.permissionMode, title: started.title });
      } catch (e) {
        console.error('[mobile] could not announce the started session', kindOf(e));
      }
    }
    if (sealed !== null) await this.sendAnswer(l.id, answer.ok, sealed);
  }

  /** 依頼を確かめて起こす。開けた中身は opened に置く（起こした後の記録と知らせに使う）。 */
  private async decide(key: CryptoKey, l: MobileLaunchOut, opened: { p: MobileLaunchPayload | null }): Promise<MobileLaunchAnswer> {
    const fail = (reason: FailReason, detail?: string): MobileLaunchAnswer => (detail ? { ok: false, reason, detail } : { ok: false, reason });
    let p: unknown;
    try {
      // 宛先（この PC）を AAD で縛る。ほかの PC 宛ての封じを付け替えた依頼は開けない。
      p = await open<unknown>(key, aadLaunch(l.id, this.deps.deviceId), l.sealed);
    } catch {
      return fail('bad-payload');
    }
    if (!isPayload(p)) return fail('bad-payload');
    opened.p = p;
    if (p.createdAt < this.deps.now() - LAUNCH_TTL_MS - LAUNCH_CLOCK_SLACK_MS) return fail('expired');
    if (!p.scratch && (p.projectId === null || !this.deps.hasProjectHere(p.projectId))) return fail('project-missing');
    if (!this.deps.hasAccount(p.accountId)) return fail('account-missing');
    // 画像は、起こすと決まってから取る（プロジェクトの無い依頼で本体を運ばない）。1 枚でも欠ければ起こさない。
    // 置いた画像は、起こせたときだけ残す。それ以外の出口（欠け、起動の失敗、途中の例外）では、finally で必ず消す。
    const saved: string[] = [];
    let started = false;
    try {
      let prompt = p.prompt;
      if (p.images?.length) {
        if (!(await this.fetchImages(key, l.id, p.images, saved))) return fail('images-missing');
        prompt = appendPaths(p.prompt, saved);
      }
      let r: LaunchResult;
      try {
        r = this.deps.start(paramsOf(p, prompt));
      } catch (e) {
        // 理由の文は封じてスマホにだけ渡す。
        return fail('launch-failed', clampText(e instanceof Error ? e.message : String(e)) ?? undefined);
      }
      started = true;
      // 起こした後は、題が読めなくても started と答える（会話は動いている）。
      let title: string;
      try {
        title = this.titleOf(r.sessionId, p.prompt);
      } catch {
        title = firstLine(p.prompt);
      }
      return { ok: true, sessionId: r.sessionId, title };
    } finally {
      if (!started) this.discard(saved);
    }
  }

  /**
   * 画像を Worker から取り、スマホ用の鍵で開き、drops に置く。置いたパスを saved に積む（失敗の後で呼び手が消せるように）。
   * 取れない、開けない、上限を超える、書けないものが 1 枚でもあれば false。
   */
  private async fetchImages(key: CryptoKey, launchId: string, refs: MobileImageRef[], saved: string[]): Promise<boolean> {
    const get = this.deps.client.getMobileBlob?.bind(this.deps.client);
    if (!get) return false;
    try {
      pruneDrops(this.deps.dropsDir, this.deps.now());
      for (const r of refs) {
        const sealed = await get(launchId, r.n);
        // 封の大きさは、開く前に確かめる（上限に封の分を足した大きさまで）。
        if (sealed.byteLength > MOBILE_IMAGE_MAX_BYTES + SEAL_OVERHEAD_BYTES) return false;
        const bytes = await openBytes(key, aadImage(launchId, r.n), sealed);
        if (bytes.byteLength > MOBILE_IMAGE_MAX_BYTES) return false;
        saved.push(saveDrop(this.deps.dropsDir, `phone-${r.n + 1}.${IMAGE_EXT[r.mime]}`, bytes, this.deps.now()).path);
      }
      return true;
    } catch (e) {
      console.error('[mobile] could not fetch the launch images', kindOf(e));
      return false;
    }
  }

  /** 起こさなかった依頼の画像を drops から消す。消せなかったものは drops の掃除（7 日）に任せる。 */
  private discard(paths: string[]): void {
    for (const f of paths.splice(0)) {
      try { fs.unlinkSync(f); } catch { /* 無ければよい */ }
    }
  }

  /** 起こした会話の表示名。行がまだ無ければ、最初の指示の先頭 40 字（表示名の決め方と同じ）。 */
  private titleOf(sessionId: string, prompt: string): string {
    const s = this.deps.db
      .prepare('select s.custom_title, n.name, s.ai_title, s.first_prompt from sessions s left join session_notes n on n.session_id = s.id and n.deleted_at is null where s.id = ?')
      .get(sessionId) as { custom_title: string | null; name: string | null; ai_title: string | null; first_prompt: string | null } | undefined;
    return (s ? displayName(s, undefined) : null) ?? firstLine(prompt);
  }
}
