import { OPENCODE_VERIFIED_RANGE, opencodeEnabledOf, settingsSectionOf } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';
import { opencodeVersionKind } from './settings.ts';

/**
 * 未検証の opencode の版の右下の札（C7、試作の N1）。いまの更新の札と同じ形で、見出し、題、本文、操作の 2 つを持つ。
 * version は札が言う版で、操作はこの版を知らせ終えたことにする。
 */
export type OpencodeVersionCardProps = { version: string; head: string; who: string; title: string; body: string; settings: string; proceed: string };

/**
 * 札を出すか。設定で opencode を有効にしていて、検出の答えが範囲の外（unverified）か 1.x（legacy）のときだけ出す。
 * 同じ版では一度だけにする（閉じた版は State の opencodeVersionSeen）。版が変われば、また出す。
 * 版を読めない（unknown）ときは、言う版も覚える版も無いので出さない。設定の版の行が「読み取れませんでした」と言う。
 * 見つからないときも出さない。起動したときのエラー（run.agent.notFound）が言う。
 * 設定の連携の節を開いている間は、そこの版の行が同じ注意を言っているので出さない（参加リクエストの通知と同じ扱い）。
 */
export function presentOpencodeVersionCard(state: State, store: Store): OpencodeVersionCardProps | null {
  if (!opencodeEnabledOf(store.settings ?? {})) return null;
  const status = store.opencodeStatus;
  if (!status || status.version === null) return null;
  const kind = opencodeVersionKind(status);
  if (kind !== 'unverified' && kind !== 'legacy') return null;
  if (state.opencodeVersionSeen === status.version) return null;
  if (state.screen.name === 'settings' && settingsSectionOf(state.screen.at) === 'agentOpencode') return null;
  const t = translatorOf(store);
  const version = status.version;
  return {
    version,
    head: t('toasts.opencodeVersion.head'),
    who: t('toasts.opencodeVersion.who', { version }),
    title: t('toasts.opencodeVersion.title', { version }),
    // 1.x は API の形が違う古い系統なので、範囲の外とは分けて、設定の版の行と同じ文で言う。
    body: kind === 'legacy' ? t('settings.opencode.version.legacyNote') : t('toasts.opencodeVersion.body', { range: OPENCODE_VERIFIED_RANGE }),
    settings: t('toasts.opencodeVersion.settings'),
    proceed: t('toasts.opencodeVersion.continue'),
  };
}
