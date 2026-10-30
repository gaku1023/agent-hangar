import type { Translate } from './i18n/t.ts';
import type { NotifyKind, NotifyRules } from './notifyPreference.ts';

/**
 * 指示文に出す OS の名前（通知の出し先の呼び名）。Windows の PC では Windows、それ以外は Mac。
 * platform は Node の process.platform の値である。
 */
export const notifyOsLabel = (platform: string | null | undefined): 'Mac' | 'Windows' => (platform === 'win32' ? 'Windows' : 'Mac');

const kinds = (t: Translate, list: NotifyKind[]): string => (list.length ? list.join(t('launch.injection.notifyJoin')) : t('launch.injection.notifyOff'));

/** 指示文に差し込む「今の決まり」の 1 句。kind の名前は done、ask、progress のままで、出し先ごとに並べる。 */
export const notifyRulesLine = (t: Translate, r: Pick<NotifyRules, 'unread' | 'os' | 'phone'>): string =>
  t('launch.injection.notifyRules', { unread: kinds(t, r.unread), os: kinds(t, r.os), phone: kinds(t, r.phone) });
