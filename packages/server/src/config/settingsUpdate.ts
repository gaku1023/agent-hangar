import type { SettingsDto } from '@agent-hangar/shared';
import { saveSettings, type Settings } from './paths.ts';

export type SettingsUpdateDeps = {
  home: string;
  /** いまの設定の置き場。書き替えた値をここへ戻す。 */
  box: { current: Settings };
  /** tmux のパスを、これから起こす run と新しい attach へ行き渡らせる。変わっていなくても毎回呼ぶ。 */
  applyTmux: (s: Settings) => void;
  /** tmuxPath の欄が来たとき。包みの本体を書き直す。 */
  onTmuxPath: () => void;
  /** claudePath の欄が来たとき。これから起こす run と要約が新しい場所を使い、包みのサブコマンドと手元の版も読み直す。 */
  onClaudePath: (s: Settings) => void;
  /** summaryHourlyCap の欄が来たとき。上限だけは要約器が内側に持つので、作り直す。 */
  onSummaryCap: () => void;
  /** 設定の同期の入り切りを、ヘッダと Settings の表示に載せ直す。 */
  publishConfigSync: (s: Settings) => void;
};

/**
 * 設定の書き替えを 1 か所で受け、保存して、動いている部品へ行き渡らせる。
 * 部品への渡し方は呼び手（boot/http.ts）が口として渡す。ここは、どの欄でどの口を呼ぶかだけを決める。
 */
export function applySettingsPatch(deps: SettingsUpdateDeps, patch: Partial<SettingsDto>): Settings {
  const settings: Settings = { ...deps.box.current, ...patch };
  deps.box.current = settings;
  saveSettings(deps.home, settings);
  // tmuxPath が変われば、これから起こす run も新しい attach も新しいパスを使う。
  deps.applyTmux(settings);
  if (patch.tmuxPath !== undefined) deps.onTmuxPath();
  if (patch.claudePath !== undefined) deps.onClaudePath(settings);
  if (patch.summaryHourlyCap !== undefined) deps.onSummaryCap();
  deps.publishConfigSync(settings);
  return settings;
}
