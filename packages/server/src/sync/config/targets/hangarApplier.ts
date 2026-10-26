import { loadSettings, saveSettings } from '../../../config/paths.ts';

/**
 * hangar の好みの書き込みの口。既定は settings.json を読んで鍵を差し替えて保存する（loadSettings と saveSettings、サーバと同じ書き方）。
 * 走っているサーバは設定を自分の入れ物（boot の box.current）に持ち、ファイルを読み直さない。
 * ファイルだけ書くと、次の設定の変更が古い入れ物で上書きするので、サーバは起動のとき（boot/http.ts）に applySettingsPatch を通す口をここに登録する。
 * 対象の登録（targets/index.ts）を読まない葉の部品にしてある。起動の側から先に読まれても、対象の登録の循環に入らないため。
 */
export type HangarPrefsApplier = (home: string, patch: Record<string, unknown>) => void;
const fileApplier: HangarPrefsApplier = (home, patch) => saveSettings(home, { ...loadSettings(home), ...patch });
let applier: HangarPrefsApplier = fileApplier;
export function setHangarPrefsApplier(fn: HangarPrefsApplier | null): void { applier = fn ?? fileApplier; }
export const applyHangarPrefs: HangarPrefsApplier = (home, patch) => applier(home, patch);
