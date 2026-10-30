/**
 * 知らせ方の決まり（設定の notifyPreference）。
 * 利用者の言葉をエージェントが場面ごとの決まりに直して保存する。サーバは notify_user の kind と決まりで出し先を振り分ける。
 */
export const NOTIFY_KINDS = ['done', 'ask', 'progress'] as const;
/** 場面。done は済んだ、ask は判断が必要、progress は途中。 */
export type NotifyKind = (typeof NOTIFY_KINDS)[number];

export type NotifyPreference = {
  /** 利用者の言葉（画面が引用して見せる）。 */
  text: string;
  /** 未読に数える場面。 */
  unread: NotifyKind[];
  /** 窓が裏のとき OS の通知を出す場面。 */
  os: NotifyKind[];
  /** つないだスマホへ知らせる場面。 */
  phone: NotifyKind[];
  /** 見ている間も Mac に出すか。省けば既定（出さない）。 */
  whileFocused?: boolean;
  /** 返答と入力待ちを 1 通にまとめるか。省けば既定（まとめる）。 */
  merge?: boolean;
};

/** 実際に効く決まり。省ける項目は埋めてある。 */
export type NotifyRules = Required<NotifyPreference>;

export const DEFAULT_NOTIFY_RULES: NotifyRules = { text: '', unread: ['done', 'ask', 'progress'], os: ['done', 'ask'], phone: ['done', 'ask'], whileFocused: false, merge: true };

export const isNotifyKind = (v: unknown): v is NotifyKind => typeof v === 'string' && (NOTIFY_KINDS as readonly string[]).includes(v);
const isKindList = (v: unknown): v is NotifyKind[] => Array.isArray(v) && v.every(isNotifyKind);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 形が全部合うか（PATCH と設定の同期の検査）。 */
export const isNotifyPreference = (v: unknown): v is NotifyPreference =>
  isRecord(v) && typeof v.text === 'string' && isKindList(v.unread) && isKindList(v.os) && isKindList(v.phone)
  && (v.whileFocused === undefined || typeof v.whileFocused === 'boolean') && (v.merge === undefined || typeof v.merge === 'boolean');

const kindsOf = (v: unknown[]): NotifyKind[] => [...new Set(v.filter(isNotifyKind))];

/** 読み込みの検査。kind でない要素と重なりは捨て、配列でない・text が文字列でないものは null、真偽でない whileFocused と merge は省く。 */
export const notifyPreferenceOf = (v: unknown): NotifyPreference | null => {
  if (!isRecord(v) || typeof v.text !== 'string' || !Array.isArray(v.unread) || !Array.isArray(v.os) || !Array.isArray(v.phone)) return null;
  const out: NotifyPreference = { text: v.text, unread: kindsOf(v.unread), os: kindsOf(v.os), phone: kindsOf(v.phone) };
  if (typeof v.whileFocused === 'boolean') out.whileFocused = v.whileFocused;
  if (typeof v.merge === 'boolean') out.merge = v.merge;
  return out;
};

/**
 * 設定から、実際に効く決まりを読む。
 * notifyPreference が（形の合うものとして）あればそれが勝つ。無ければ既定で、古いスイッチ（unreadBadge・unreadOs・unreadPhone）が false の出し先は空の配列にする。
 */
export const notifyRulesOf = (s: { notifyPreference?: NotifyPreference | null; unreadBadge?: boolean; unreadOs?: boolean; unreadPhone?: boolean }): NotifyRules => {
  const p = s.notifyPreference == null ? null : notifyPreferenceOf(s.notifyPreference);
  if (p) return { text: p.text, unread: p.unread, os: p.os, phone: p.phone, whileFocused: p.whileFocused ?? DEFAULT_NOTIFY_RULES.whileFocused, merge: p.merge ?? DEFAULT_NOTIFY_RULES.merge };
  const d = DEFAULT_NOTIFY_RULES;
  return { ...d, unread: s.unreadBadge === false ? [] : [...d.unread], os: s.unreadOs === false ? [] : [...d.os], phone: s.unreadPhone === false ? [] : [...d.phone] };
};
