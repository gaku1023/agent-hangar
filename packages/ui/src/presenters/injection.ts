import type { OpencodeInjection, Translate } from '@agent-hangar/shared';

/** 全文の 1 つの切れ。token は差し込む値の印（プロジェクト名など）で、画面は破線の枠で描く。 */
export type InjectionPiece = { kind: 'text' | 'token'; text: string };
/**
 * 足す指示の 1 段。label はどのスイッチのものか、off は切っていて足さない段（打ち消し線で残す）。
 * mark は段の名前に添える印で、PC をまたぐ段の「同期を使っているときだけ」に使う。無ければ null。
 */
export type InjectionPart = { label: string; off: boolean; mark: string | null; pieces: InjectionPiece[] };

/** 差し込む値の印を本文から切り出すための区切り。辞書の文には出てこない文字にする。 */
const MARK = '\u0001';

/** 区切りで挟んだ印を切れに分ける。区切りの間（奇数番目）が印である。 */
function split(text: string): InjectionPiece[] {
  return text.split(MARK).map((s, i): InjectionPiece => ({ kind: i % 2 === 1 ? 'token' : 'text', text: s })).filter((p) => p.text !== '');
}

/**
 * 設定の「足す指示の全文を見る」の中身（試作 1 節の推す案）。
 * サーバが起動のときに足す文（launch/injection.ts の renderInjection）と同じ辞書の鍵を、同じ順に、画面の言語で埋める。
 * PC をまたぐ 2 段（引き継ぎと、複数の PC で使うプロジェクトの 1 文）はスイッチを持たず、条件に当たるときだけ足すので、印で添える。
 * 設定の画面はプロジェクトに属さないので、プロジェクト名、パス、TODO の一覧は値の代わりに印にする。
 * 切った段も消さずに返し、何が足されなくなったかを見せる。
 */
export function presentInjection(t: Translate, parts: { askStatusAtEnd: boolean; liveHints: boolean }): InjectionPart[] {
  const token = (s: string) => `${MARK}${s}${MARK}`;
  const body = t('launch.injection.body', {
    projectName: token(t('settings.integrations.inject.token.projectName')),
    projectPath: token(t('settings.integrations.inject.token.projectPath')),
    todos: token(t('settings.integrations.inject.token.todos')),
  });
  const handover = t('launch.injection.handover', {
    prevDevice: token(t('settings.integrations.inject.token.prevDevice')), prevOs: token(t('settings.integrations.inject.token.prevOs')),
    lastAt: token(t('settings.integrations.inject.token.lastAt')), prevPath: token(t('settings.integrations.inject.token.prevPath')),
    device: token(t('settings.integrations.inject.token.device')), os: token(t('settings.integrations.inject.token.os')),
    path: token(t('settings.integrations.inject.token.path')), branch: token(t('settings.integrations.inject.token.branch')),
    editedCount: token(t('settings.integrations.inject.token.editedCount')), missing: token(t('settings.integrations.inject.token.missing')),
  });
  const multi = t('launch.injection.multiDevice', { deviceCount: token(t('settings.integrations.inject.token.deviceCount')) });
  const syncOnly = t('settings.integrations.inject.part.syncOnly');
  const named = (name: string, on: boolean) => t(on ? 'settings.integrations.inject.part.on' : 'settings.integrations.inject.part.off', { name });
  return [
    { label: t('settings.integrations.inject.part.body'), off: false, mark: null, pieces: split(body) },
    { label: t('settings.integrations.inject.part.handover'), off: false, mark: syncOnly, pieces: split(handover) },
    { label: t('settings.integrations.inject.part.multiDevice'), off: false, mark: syncOnly, pieces: split(multi) },
    { label: named(t('settings.label.askStatusAtEnd'), parts.askStatusAtEnd), off: !parts.askStatusAtEnd, mark: null, pieces: split(t('launch.injection.status')) },
    { label: named(t('settings.label.liveHints'), parts.liveHints), off: !parts.liveHints, mark: null, pieces: split(t('launch.injection.live')) },
  ];
}

/**
 * 設定の opencode の「システムプロンプトへの追記」の全文の畳みの中身。
 * サーバの renderOpencodeInjectionEntries（launch/injection.ts）と同じ組み方を、同じ辞書の鍵で画面の言語に埋める。
 * 最小限は辞書の 1 段だけで、段の名前は選択肢の名前にする。
 * Claude Code と同じは presentInjection の 5 段で、意図の段の文だけ opencode 向けの文に替える。スイッチの入り切りも Claude と同じく効く。
 * 追記しないは段が無い（画面は畳みごと出さない）。
 */
export function presentOpencodeInjection(t: Translate, parts: { askStatusAtEnd: boolean; liveHints: boolean }, choice: OpencodeInjection): InjectionPart[] {
  if (choice === 'none') return [];
  if (choice === 'minimal') return [{ label: t('settings.opencode.injection.minimal'), off: false, mark: null, pieces: split(t('launch.injection.opencode.minimal')) }];
  const claude = presentInjection(t, parts);
  const live = claude.length - 1;
  return claude.map((p, i) => (i === live ? { ...p, pieces: split(t('launch.injection.opencode.live')) } : p));
}
