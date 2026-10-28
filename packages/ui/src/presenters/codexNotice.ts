import { CODEX_VERIFIED_RANGE, codexEnabledOf, settingsSectionOf } from '@agent-hangar/shared';
import type { State } from '../mediator/types.ts';
import type { Store } from '../store/store.ts';
import { translatorOf } from './i18n.ts';
import { codexVersionKind } from './settings.ts';

/** 未検証の Codex の版の右下の札（C4）。形は opencode の札と同じ。version は札が言う版で、操作はこの版を知らせ終えたことにする。 */
export type CodexVersionCardProps = { version: string; head: string; who: string; title: string; body: string; settings: string; proceed: string };

/**
 * 札を出すか。設定で Codex を有効にしていて、検出の答えが範囲の外（unverified）のときだけ出す（opencode の札と同じ決まり）。
 * 同じ版では一度だけにする（閉じた版は State の codexVersionSeen）。版が変われば、また出す。
 * 版を読めないとき、見つからないときは出さない（版の行と、起動したときのエラーが言う）。
 * 設定の連携の節を開いている間は、そこの版の行が同じ注意を言っているので出さない。
 */
export function presentCodexVersionCard(state: State, store: Store): CodexVersionCardProps | null {
  if (!codexEnabledOf(store.settings ?? {})) return null;
  const status = store.codexStatus;
  if (!status || status.version === null) return null;
  if (codexVersionKind(status) !== 'unverified') return null;
  if (state.codexVersionSeen === status.version) return null;
  if (state.screen.name === 'settings' && settingsSectionOf(state.screen.at) === 'agentCodex') return null;
  const t = translatorOf(store);
  const version = status.version;
  return {
    version,
    head: t('toasts.codexVersion.head'),
    who: t('toasts.codexVersion.who', { version }),
    title: t('toasts.codexVersion.title', { version }),
    body: t('toasts.codexVersion.body', { range: CODEX_VERIFIED_RANGE }),
    settings: t('toasts.codexVersion.settings'),
    proceed: t('toasts.codexVersion.continue'),
  };
}
