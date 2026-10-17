import { randomUUID } from 'node:crypto';
import { encodeEpochList, formatRecoveryKey, generateKeyPair, MAX_KEYBOXES_PER_PUT, RECOVERY_RECIPIENT, recoverySecretTail, sealKeybox, toBase64Url, type KeyboxIn, type MessageKey, type RecoveryKeyDraftDto } from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';
import type { HttpCloudClient } from './client.ts';
import type { Keyring } from './keyring.ts';
import { normalizeRecoveryTail } from './recoveryTail.ts';
import type { RosterStore } from './roster.ts';
import type { SyncStateStore } from './state.ts';

/** 再発行の下書き（新しいリカバリーキー）を確認できる長さ。パスワードマネージャーに保存する間を見込む。 */
export const RECOVERY_DRAFT_TTL_MS = 30 * 60_000;
/** 同じ下書きで末尾 4 文字が外れてよい回数。この回数目で下書きを無効にする。 */
export const RECOVERY_TAIL_MAX_MISSES = 5;
/** recovery 宛ての箱の PUT を、その場で試す回数（最初の 1 回を含む）。 */
export const RECOVERY_BOX_PUT_TRIES = 3;
/** 箱を置いた後に、名簿の公開鍵か世代が変わっていたら置き直す回数の上限。 */
const RECOVERY_BOX_ROUNDS = 3;
/** 試し直しの間の待ち（ミリ秒）。 */
const RECOVERY_BOX_RETRY_MS = 1_000;

/** recovery 宛ての箱を置き終えていない印（sync_state）。同期の巡で resumePending が置き直して消す。 */
const PENDING_KEY = 'recoveryBoxPending';

export type RecoveryDraftReason = 'no-draft' | 'tail-mismatch' | 'too-many-tries' | 'no-roster';

const REASON_KEY: Record<RecoveryDraftReason, Extract<MessageKey, `sync.recovery.${string}`>> = {
  'no-draft': 'sync.recovery.noDraft',
  'tail-mismatch': 'sync.recovery.tailMismatch',
  'too-many-tries': 'sync.recovery.tooManyTries',
  'no-roster': 'sync.recovery.noRoster',
};

/**
 * 再発行の確認ができない。
 * no-draft は下書きが無いか期限を過ぎた（経路は 409）、tail-mismatch は末尾 4 文字が違う（400）、
 * too-many-tries は同じ下書きで外れ続けて下書きを無効にした（409）、no-roster は名簿がまだ無い（409）。
 */
export class RecoveryDraftError extends MessageError {
  constructor(readonly reason: RecoveryDraftReason) {
    super(msg(REASON_KEY[reason]));
    this.name = 'RecoveryDraftError';
  }
}

export type RecoveryReissueDeps = {
  roster: Pick<RosterStore, 'read' | 'update' | 'refreshKeyboxes' | 'invalidate'>;
  keyring: Keyring | Promise<Keyring>;
  wire: Pick<HttpCloudClient, 'putKeyboxes'>;
  /** リカバリーキーに書く Worker の URL（cloud.json の url）。 */
  url: () => string;
  /** 置き終えていない印を残す先（sync_state）。無ければ印を残さない（試験と、同期を組まない口）。 */
  state?: Pick<SyncStateStore, 'get' | 'set'>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Draft = { id: string; pub: string; text: string; createdAt: number; misses: number };

/**
 * 設定の「リカバリーキーを再発行」（設計書「リカバリーキー」）。
 *
 * PC はリカバリーキーの秘密鍵を持たないので、表示し直すことはできず、新しい鍵ペアを作って差し替える。
 * reissue は新しい鍵ペアを作り、4 行の文を返すだけで、鍵ペアはこのメモリにだけ置く（秘密鍵は文の中にしか残さない）。
 * confirm で末尾 4 文字が合ってから、名簿の recoveryPub を新しい公開鍵にし、recovery 宛ての keybox を置き直す。
 * 保存し損ねた人が、古いリカバリーキーまで失わないための順である。
 *
 * 名簿を先に書き、keybox を後に置く。
 * 間に別の PC が世代を回しても、回した PC は書き換えた後の名簿の公開鍵に封じるので、いちばん新しい keybox は新しい公開鍵宛てになる。
 * keybox は世代 1 から n の全部に置き直し、世代 k の箱の中身は世代 1 から k までの世代鍵である（setup と世代を回す PC が置く形）。
 * 過去の世代の箱を古い公開鍵宛てのまま残さない。
 *
 * 名簿を書いた後で箱を置けないと、古いキーは名簿の照合で断られ、新しいキーは箱を開けない。
 * その窓を閉じるため、名簿を書く前に sync_state に印を残し、箱を置き終えたら消す。
 * 箱の PUT はその場で RECOVERY_BOX_PUT_TRIES 回まで試し、それでも通らなければ印を残したまま投げる。
 * 印は同期の巡（resumePending）が見て、名簿の recoveryPub 宛てに置き直す。箱は公開鍵だけで封じるので、下書きが無くても置ける。
 *
 * 下書きは 1 つだけで、新しく再発行すると前のものは使えなくなる。
 * 同じ下書きで RECOVERY_TAIL_MAX_MISSES 回外れたら下書きを無効にする。
 * 確認が途中で失敗したら、同じ下書きでもう一度確認できる。同時に 2 回呼ばれたら、進行中の確認を共有する。
 */
export class RecoveryKeyReissuer {
  private draft: Draft | null = null;
  private confirming: { draftId: string; promise: Promise<void> } | null = null;
  private placing: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RecoveryReissueDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    Promise.resolve(deps.keyring).catch(() => {});
  }

  async reissue(): Promise<RecoveryKeyDraftDto> {
    const pair = await generateKeyPair();
    const createdAt = this.now();
    const text = formatRecoveryKey({ priv: pair.priv, url: this.deps.url(), createdAt });
    this.draft = { id: randomUUID(), pub: pair.pub, text, createdAt, misses: 0 };
    return { text, draftId: this.draft.id };
  }

  /**
   * 末尾 4 文字を照合し、合えば名簿と keybox を差し替える。
   * 照合までは await を挟まずに進めるので、同時の 2 回目は進行中の確認を受け取る。
   */
  confirm(draftId: string, tail: string): Promise<void> {
    const running = this.confirming;
    if (running && running.draftId === draftId) return running.promise;
    let d: Draft;
    try {
      d = this.check(draftId, tail);
    } catch (e) {
      return Promise.reject(e);
    }
    const promise = this.apply(d).finally(() => {
      if (this.confirming?.promise === promise) this.confirming = null;
    });
    this.confirming = { draftId, promise };
    return promise;
  }

  /**
   * 同期の巡から呼ぶ。置き終えていない印があれば、名簿の recoveryPub 宛てに箱を置き直して印を消す。
   * 印が無ければ Worker に何も送らない。確認か置き直しが走っていれば、重ねずに戻る。
   * 失敗は投げない（次の巡でもう一度試す）。
   */
  async resumePending(): Promise<void> {
    if (this.deps.state?.get(PENDING_KEY) !== '1') return;
    if (this.confirming || this.placing) return;
    try {
      await this.place();
    } catch (e) {
      console.warn('[recovery] could not place the recovery keyboxes yet; will try again on the next sync', e instanceof Error ? e.constructor.name : typeof e);
    }
  }

  private check(draftId: string, tail: string): Draft {
    const d = this.draft;
    if (d && this.now() - d.createdAt > RECOVERY_DRAFT_TTL_MS) this.draft = null;
    if (!this.draft || this.draft.id !== draftId) throw new RecoveryDraftError('no-draft');
    const cur = this.draft;
    if (normalizeRecoveryTail(tail) !== recoverySecretTail(cur.text)) {
      cur.misses++;
      if (cur.misses >= RECOVERY_TAIL_MAX_MISSES) {
        this.draft = null;
        throw new RecoveryDraftError('too-many-tries');
      }
      throw new RecoveryDraftError('tail-mismatch');
    }
    return cur;
  }

  private async apply(d: Draft): Promise<void> {
    // 他の PC が回した世代があれば、先に受け取る（新しい世代で封じた名簿は、その世代の鍵が無いと開けない）。
    await this.deps.roster.refreshKeyboxes();
    if ((await this.deps.roster.read()).version === 0) throw new RecoveryDraftError('no-roster');
    // 名簿を書く前に印を残す。名簿だけ書けて落ちても、次の巡で箱を置き直す。
    this.deps.state?.set(PENDING_KEY, '1');
    await this.deps.roster.update((r) => ({ ...r, recoveryPub: d.pub }));
    if (this.placing) await this.placing.catch(() => {});
    await this.place();
    if (this.draft === d) this.draft = null;
  }

  private place(): Promise<void> {
    const p = this.placeBoxes().finally(() => {
      if (this.placing === p) this.placing = null;
    });
    this.placing = p;
    return p;
  }

  /**
   * 名簿の recoveryPub 宛てに、世代 1 から n の全部の recovery の箱を置く。
   * 置く直前に keybox と名簿を読み直し、いちばん新しい世代と公開鍵に置く。
   * 置いた後にもう一度読み、公開鍵か世代が変わっていれば（他の PC の再発行か世代の回し）置き直す。
   * 置き終えたら印を消す。PUT が RECOVERY_BOX_PUT_TRIES 回とも通らなければ、印を残して投げる。
   */
  private async placeBoxes(): Promise<void> {
    const { roster } = this.deps;
    const ring = await this.deps.keyring;
    await roster.refreshKeyboxes();
    roster.invalidate();
    let cur = await roster.read();
    for (let round = 1; ; round++) {
      const pub = cur.roster.recoveryPub;
      if (cur.version === 0 || !pub) break;
      const { epochs } = ring.toConfigPatch();
      const numbers = Object.keys(epochs).map(Number).sort((a, b) => a - b);
      const boxes: KeyboxIn[] = [];
      for (const epoch of numbers) {
        const upTo = Object.fromEntries(numbers.filter((n) => n <= epoch).map((n) => [String(n), epochs[String(n)]!]));
        boxes.push({ epoch, recipient: RECOVERY_RECIPIENT, sealed: toBase64Url(await sealKeybox(pub, { epoch, recipient: RECOVERY_RECIPIENT }, encodeEpochList({ epochs: upTo }))) });
      }
      for (let i = 0; i < boxes.length; i += MAX_KEYBOXES_PER_PUT) await this.putWithRetry(boxes.slice(i, i + MAX_KEYBOXES_PER_PUT));
      const gained = await roster.refreshKeyboxes();
      roster.invalidate();
      const after = await roster.read();
      if (!gained && after.roster.recoveryPub === pub) break;
      // 置くたびに変わり続ける。印を残し、次の巡でもう一度置く。
      if (round >= RECOVERY_BOX_ROUNDS) {
        this.deps.state?.set(PENDING_KEY, '1');
        return;
      }
      cur = after;
    }
    this.deps.state?.set(PENDING_KEY, null);
  }

  private async putWithRetry(boxes: KeyboxIn[]): Promise<void> {
    for (let tries = 1; ; tries++) {
      try {
        await this.deps.wire.putKeyboxes(boxes);
        return;
      } catch (e) {
        if (tries >= RECOVERY_BOX_PUT_TRIES) {
          this.deps.state?.set(PENDING_KEY, '1');
          throw e;
        }
        await this.sleep(RECOVERY_BOX_RETRY_MS * tries);
      }
    }
  }
}
