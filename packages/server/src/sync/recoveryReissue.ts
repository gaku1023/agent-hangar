import { randomUUID } from 'node:crypto';
import { encodeEpochList, formatRecoveryKey, generateKeyPair, RECOVERY_RECIPIENT, recoverySecretTail, sealKeybox, toBase64Url, type MessageKey, type RecoveryKeyDraftDto } from '@agent-hangar/shared';
import { MessageError, msg } from '../i18n/message.ts';
import type { HttpCloudClient } from './client.ts';
import type { Keyring } from './keyring.ts';
import type { RosterStore } from './roster.ts';

/** 再発行の下書き（新しいリカバリーキー）を確認できる長さ。パスワードマネージャーに保存する間を見込む。 */
export const RECOVERY_DRAFT_TTL_MS = 30 * 60_000;

export type RecoveryDraftReason = 'no-draft' | 'tail-mismatch' | 'no-roster';

const REASON_KEY: Record<RecoveryDraftReason, Extract<MessageKey, `sync.recovery.${string}`>> = {
  'no-draft': 'sync.recovery.noDraft',
  'tail-mismatch': 'sync.recovery.tailMismatch',
  'no-roster': 'sync.recovery.noRoster',
};

/**
 * 再発行の確認ができない。
 * no-draft は下書きが無いか期限を過ぎた（経路は 409）、tail-mismatch は末尾 4 文字が違う（400）、no-roster は名簿がまだ無い（409）。
 */
export class RecoveryDraftError extends MessageError {
  constructor(readonly reason: RecoveryDraftReason) {
    super(msg(REASON_KEY[reason]));
    this.name = 'RecoveryDraftError';
  }
}

export type RecoveryReissueDeps = {
  roster: Pick<RosterStore, 'read' | 'update' | 'refreshKeyboxes'>;
  keyring: Keyring | Promise<Keyring>;
  wire: Pick<HttpCloudClient, 'putKeyboxes'>;
  /** リカバリーキーに書く Worker の URL（cloud.json の url）。 */
  url: () => string;
  now?: () => number;
};

type Draft = { id: string; pub: string; text: string; createdAt: number };

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
 * keybox の中身は手元の世代 1 から n までの全部である（GET /keyboxes は受け手ごとにいちばん新しい箱 1 つしか返さない）。
 * 下書きは 1 つだけで、新しく再発行すると前のものは使えなくなる。確認が途中で失敗したら、同じ下書きでもう一度確認できる。
 */
export class RecoveryKeyReissuer {
  private draft: Draft | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: RecoveryReissueDeps) {
    this.now = deps.now ?? Date.now;
    Promise.resolve(deps.keyring).catch(() => {});
  }

  async reissue(): Promise<RecoveryKeyDraftDto> {
    const pair = await generateKeyPair();
    const createdAt = this.now();
    const text = formatRecoveryKey({ priv: pair.priv, url: this.deps.url(), createdAt });
    this.draft = { id: randomUUID(), pub: pair.pub, text, createdAt };
    return { text, draftId: this.draft.id };
  }

  async confirm(draftId: string, tail: string): Promise<void> {
    const d = this.draft;
    if (!d || d.id !== draftId || this.now() - d.createdAt > RECOVERY_DRAFT_TTL_MS) {
      if (d && this.now() - d.createdAt > RECOVERY_DRAFT_TTL_MS) this.draft = null;
      throw new RecoveryDraftError('no-draft');
    }
    if (String(tail).normalize('NFKC').trim().toUpperCase() !== recoverySecretTail(d.text)) throw new RecoveryDraftError('tail-mismatch');
    // 他の PC が回した世代があれば、先に受け取る（古い世代に置くと、いちばん新しい箱が古い公開鍵宛てのまま残る）。
    await this.deps.roster.refreshKeyboxes();
    if ((await this.deps.roster.read()).version === 0) throw new RecoveryDraftError('no-roster');
    await this.deps.roster.update((r) => ({ ...r, recoveryPub: d.pub }));
    const ring = await this.deps.keyring;
    const epoch = ring.current().epoch;
    const content = encodeEpochList({ epochs: ring.toConfigPatch().epochs });
    const box = await sealKeybox(d.pub, { epoch, recipient: RECOVERY_RECIPIENT }, content);
    await this.deps.wire.putKeyboxes([{ epoch, recipient: RECOVERY_RECIPIENT, sealed: toBase64Url(box) }]);
    if (this.draft === d) this.draft = null;
  }
}
