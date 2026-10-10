import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type DeviceInfo, type Settings } from '../config/paths.ts';
import { ensureStatuslineHeaderFile } from '../config/statusline.ts';
import { resolveToolPaths } from '../config/tools.ts';
import { openDb, type Db } from '../db/open.ts';
import { ensureWrapperScript } from '../launch/wrapper.ts';
import { ensureSpawnHelper } from '../pty/helper.ts';
import type { StartOptions } from './options.ts';
import { languageReader, type GetLanguage } from '../i18n/language.ts';

/**
 * サーバの寿命の印。
 * started は、起動の手続き（最初の索引づけと紐づけ）が済んだかである。済むまで .app は起動画面に残る。
 * closed は、閉じ始めたかである。閉じた後に届いた裏の読み取りが、消えた置き場に書かないようにする。
 */
export type Life = { started: boolean; closed: boolean };

export type HomeParts = {
  home: string;
  token: string;
  device: DeviceInfo;
  /** いまの設定。書き替えるのは config/settingsUpdate.ts だけである。 */
  settings: { current: Settings };
  /**
   * いまの言語を返す関数。設定の language を読む。
   * サーバにこの関数は 1 つだけで、HTTP の経路、MCP の道具、起動の管理、要約、保持期間、知らせが同じものを受け取る。
   */
  language: GetLanguage;
  /** 索引の読み取り元。opts.claudeDir、設定、既定の順に決める。 */
  claudeDir: string;
  db: Db;
  life: Life;
  /** DB を閉じる。止める手続きの最後に呼ぶ。 */
  stop(): void;
};

/**
 * 置き場と、そこに置く物を用意する。
 * 置き場、トークン、statusline のヘッダ、端末の ID、設定、起動の包み、spawn-helper、DB の順である。
 * DB を開くときに、マイグレーションの前の控えを取る（db/open.ts）。控えが取れなければここで投げ、何も待ち受けない。
 */
export function bootHome(opts: Pick<StartOptions, 'home' | 'claudeDir'> = {}): HomeParts {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  const token = readOrCreateToken(home);
  // statusline が curl に読ませるヘッダのファイルは、トークンと同じところで用意する。
  // install のときにしか置かないと、置き場を消した利用者の使用量が何も言わずに止まる。
  ensureStatuslineHeaderFile(home, token);
  const device = readOrCreateDevice(home);
  // tmux、code、claude のパスが設定に無ければここで探して書き戻す。GUI 起動の貧弱な PATH でも見つけられる。
  const settings = { current: resolveToolPaths(loadSettings(home)) };
  saveSettings(home, settings.current);
  ensureWrapperScript(home);
  const fixed = ensureSpawnHelper();
  if (fixed.length) console.log('[pty] spawn-helper に実行権限を付けました:', fixed.join(', '));

  const claudeDir = opts.claudeDir ?? (settings.current.claudeDir || defaultClaudeDir());
  const db = openDb(dbPath(home));
  const language = languageReader(() => settings.current);
  return { home, token, device, settings, language, claudeDir, db, life: { started: false, closed: false }, stop: () => db.close() };
}
