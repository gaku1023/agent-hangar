import type { Translate } from '@agent-hangar/shared';

/** 全文の 1 つの切れ。token は差し込む値の印（プロジェクト名など）で、画面は破線の枠で描く。 */
export type InjectionPiece = { kind: 'text' | 'token'; text: string };
/** 足す指示の 1 段。label はどのスイッチのものか、off は切っていて足さない段（打ち消し線で残す）。 */
export type InjectionPart = { label: string; off: boolean; pieces: InjectionPiece[] };

/** 差し込む値の印を本文から切り出すための区切り。辞書の文には出てこない文字にする。 */
const MARK = '\u0001';

/** 区切りで挟んだ印を切れに分ける。区切りの間（奇数番目）が印である。 */
function split(text: string): InjectionPiece[] {
  return text.split(MARK).map((s, i): InjectionPiece => ({ kind: i % 2 === 1 ? 'token' : 'text', text: s })).filter((p) => p.text !== '');
}

/**
 * 設定の「足す指示の全文を見る」の中身（試作 1 節の推す案）。
 * サーバが起動のときに足す文（launch/injection.ts の renderInjection）と同じ辞書の 3 つの鍵を、画面の言語で埋める。
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
  const named = (name: string, on: boolean) => t(on ? 'settings.integrations.inject.part.on' : 'settings.integrations.inject.part.off', { name });
  return [
    { label: t('settings.integrations.inject.part.body'), off: false, pieces: split(body) },
    { label: named(t('settings.label.askStatusAtEnd'), parts.askStatusAtEnd), off: !parts.askStatusAtEnd, pieces: split(t('launch.injection.status')) },
    { label: named(t('settings.label.liveHints'), parts.liveHints), off: !parts.liveHints, pieces: split(t('launch.injection.live')) },
  ];
}
