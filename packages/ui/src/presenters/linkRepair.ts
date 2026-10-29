import type { RetentionPreviewLine } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { diffOps } from './diff.ts';
import { absoluteTime } from './format.ts';
import { translatorOf } from './i18n.ts';

/** 衝突した 1 項目の札。lines は共有設定から、このアカウントのファイルへの行の差分で、本文の無い側があれば null（差分を出せない）。 */
export type LinkRepairCardProps = { name: string; mineWhen: string; sharedWhen: string; lines: RetentionPreviewLine[] | null };
/**
 * リンクの修復のダイアログ（#513）。
 * account は直す対象のアカウントの名前、names は項目の名前を並べた文字列（リードに入れる）。
 * loading は両側の中身を読む前、error は読めなかった理由か、直すのを断られた理由である。
 */
export type LinkRepairProps = { account: string; names: string; loading: boolean; cards: LinkRepairCardProps[]; working: boolean; error: string | null };

export function presentLinkRepair(state: State, store: Store): LinkRepairProps | null {
  const o = state.overlay;
  if (o.kind !== 'linkRepair') return null;
  const t = translatorOf(store);
  const list = o.agent === 'codex' ? store.accounts?.codex?.accounts : store.accounts?.accounts;
  const account = list?.find((a) => a.id === o.accountId)?.name ?? o.accountId;
  const { detail, working, error } = state.linkRepair;
  const cards = (detail?.entries ?? []).map((e): LinkRepairCardProps => ({
    name: e.name,
    mineWhen: absoluteTime(t, e.mine.mtimeMs),
    sharedWhen: absoluteTime(t, e.shared.mtimeMs),
    lines: e.mine.text === null || e.shared.text === null ? null : diffOps(e.shared.text, e.mine.text).map((l) => ({ kind: l.t, text: l.text })),
  }));
  return { account, names: cards.map((c) => c.name).join(t('common.list.separator')), loading: detail === null && error === null, cards, working, error };
}
