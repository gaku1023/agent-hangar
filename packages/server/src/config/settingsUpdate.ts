import type { SettingsDto } from '@agent-hangar/shared';
import { agentSettingsKeys } from '../agent/entry.ts';
import { saveSettings, type Settings } from './paths.ts';

const SHELL_KEYS = agentSettingsKeys('shell');
const ENABLED_KEYS = agentSettingsKeys('enabled');

export type SettingsUpdateDeps = {
  home: string;
  /** いまの設定の置き場。書き替えた値をここへ戻す。 */
  box: { current: Settings };
  /** tmux のパスを、これから起こす run と新しい attach へ行き渡らせる。変わっていなくても毎回呼ぶ。 */
  applyTmux: (s: Settings) => void;
  /** tmuxPath、opencodeEnabled、opencodeIntercept の欄が来たとき。包みの本体を書き直す（tmux のパスと、opencode() を書くか）。 */
  onTmuxPath: () => void;
  /** claudePath の欄が来たとき。これから起こす run と要約が新しい場所を使い、包みのサブコマンドと手元の版も読み直す。 */
  onClaudePath: (s: Settings) => void;
  /** summaryHourlyCap の欄が来たとき。上限だけは要約器が内側に持つので、作り直す。 */
  onSummaryCap: () => void;
  /** 設定の同期の入り切りを、ヘッダと Settings の表示に載せ直す。 */
  publishConfigSync: (s: Settings) => void;
  /** opencodeEnabled の欄が来たとき。スマホの一覧（受信箱の素）は opencode の入り切りで中身が変わるので、組み直させる。 */
  onOpencodeEnabled?: () => void;
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
  if (patch.tmuxPath !== undefined || SHELL_KEYS.some((k) => patch[k] !== undefined)) deps.onTmuxPath();
  if (patch.claudePath !== undefined) deps.onClaudePath(settings);
  if (patch.summaryHourlyCap !== undefined) deps.onSummaryCap();
  if (ENABLED_KEYS.some((k) => patch[k] !== undefined)) deps.onOpencodeEnabled?.();
  deps.publishConfigSync(settings);
  return settings;
}
