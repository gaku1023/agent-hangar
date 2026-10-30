import { NOTIFY_KINDS, notifyPreferenceOf, notifyRulesOf, type NewSessionSeed, type NotifyKind, type SettingsDto, type Translate } from '@agent-hangar/shared';

export type NotifyRuleRow = { key: 'unread' | 'os' | 'phone'; name: string; level: string; off: boolean };
/**
 * 設定の「知らせ方」の欄（読むだけ）。
 * quote は利用者の言葉で、未設定なら null にして defaultText（薄く出す既定の文）を出す。
 * seed は「エージェントで変える…」で開く新しいセッションのダイアログの種。
 */
export type NotifyRulesProps = { quote: string | null; defaultText: string | null; rows: NotifyRuleRow[]; seed: NewSessionSeed };

const osKey = (platform: string): 'mac' | 'win' | 'other' => (platform === 'darwin' ? 'mac' : platform === 'win32' ? 'win' : 'other');

/** 段階の言葉。全部ならすべて、空ならオフ、ほかは場面を done・ask・progress の順に並べる。 */
function levelOf(t: Translate, kinds: readonly NotifyKind[]): { text: string; off: boolean } {
  if (kinds.length === 0) return { text: t('settings.notifyRules.level.off'), off: true };
  const has = NOTIFY_KINDS.filter((k) => kinds.includes(k));
  if (has.length === NOTIFY_KINDS.length) return { text: t('settings.notifyRules.level.all'), off: false };
  return { text: has.map((k) => t(`settings.notifyRules.kind.${k}`)).join(t('settings.notifyRules.separator')), off: false };
}

export function presentNotifyRules(t: Translate, s: SettingsDto | null, platform: string): NotifyRulesProps {
  const rules = notifyRulesOf(s ?? {});
  const set = notifyPreferenceOf(s?.notifyPreference) !== null;
  const os = osKey(platform);
  const row = (key: NotifyRuleRow['key'], name: string): NotifyRuleRow => { const l = levelOf(t, rules[key]); return { key, name, level: l.text, off: l.off }; };
  return {
    quote: set ? rules.text : null,
    defaultText: set ? null : t('settings.notifyRules.default', { os: t(`settings.notifyRules.os.${os}`) }),
    rows: [row('unread', t('settings.notifyRules.dest.unread')), row('os', t(`settings.notifyRules.dest.os.${os}`)), row('phone', t('settings.notifyRules.dest.phone'))],
    seed: { request: set ? t('settings.notifyRules.request', { text: rules.text.replace(/[。.]+$/, '') }) : t('settings.notifyRules.requestUnset'), quote: '' },
  };
}
