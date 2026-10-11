import type { Translate } from '@agent-hangar/shared';
import type { SetupShellOutcome } from '../runtime/desktop.ts';

/** 殻と CLI が返す理由の鍵（setupPlan.ts の reason.code と、書く直前の changed）から、辞書の鍵の末尾へ。 */
const REASONS = {
  already: 'runtime.setup.reason.already', absent: 'runtime.setup.reason.absent', windows: 'runtime.setup.reason.windows',
  'not-zsh': 'runtime.setup.reason.notZsh', 'no-tmux': 'runtime.setup.reason.noTmux', 'no-script': 'runtime.setup.reason.noScript',
  'no-claude': 'runtime.setup.reason.noClaude', 'broken-json': 'runtime.setup.reason.brokenJson', unreadable: 'runtime.setup.reason.unreadable',
  'ps-param': 'runtime.setup.reason.psParam', 'ps-input': 'runtime.setup.reason.psInput', changed: 'runtime.setup.reason.changed',
} as const;
const reasonKey = (code: string | null) => (code !== null && Object.hasOwn(REASONS, code) ? REASONS[code as keyof typeof REASONS] : null);

/**
 * 連携の書き込みの結果を、右下の知らせにする。null なら知らせない。
 * 書けたときは承諾の窓が完了の段を出しているので、知らせない。取り消したときも、利用者が自分で閉じたので知らせない。
 * 済んでいた、書けなかった、は理由の鍵から文を引き、知らない鍵は殻の文（CLI の文は日本語だけ）をそのまま出す。
 */
export function setupNotice(t: Translate, r: SetupShellOutcome): { level: 'info' | 'error'; message: string } | null {
  if (r.status === 'written' || r.status === 'cancelled') return null;
  if (r.status === 'busy') return { level: 'info', message: t('runtime.setup.busy') };
  const key = reasonKey(r.code);
  const message = key ? t(key) : (r.message ?? t('runtime.shell.unreadable'));
  return { level: r.status === 'failed' ? 'error' : 'info', message };
}
