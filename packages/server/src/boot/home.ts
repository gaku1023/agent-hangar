import { dbPath, defaultClaudeDir, ensureHome, hangarHome, loadSettings, readOrCreateDevice, readOrCreateToken, saveSettings, type DeviceInfo, type Settings } from '../config/paths.ts';
import { ensureStatuslineHeaderFile } from '../provider/claude-code/config/statusline.ts';
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
  /**
   * 読み替えた設定（探した道具のパス、別の OS の外部ターミナル、古い鍵）を settings.json へ書き戻す。
   * bootHome は書かない。起動の確かめ（DB の版、待ち受け）が通ってから startServer が呼ぶ。
   * 起動を断るときに利用者のファイルを書き換えると、前の版のアプリへ戻したときに読み替え済みの設定を掴まされるからである。
   */
  persistSettings(): void;
  /** DB を閉じる。止める手続きの最後に呼ぶ。 */
  stop(): void;
};

/**
 * 置き場と、そこに置く物を用意する。
 * 置き場、DB、トークン、statusline のヘッダ、端末の ID、設定、起動の包み、spawn-helper の順である。
 * DB を先に開くのは、起動を断る確かめだからである。起点より古い DB（DbTooOldError）と控えの取れない DB（DbBackupError）はここで投げ、
 * 置き場の物を 1 つも書かずに終わる（置き場そのものを作ることと、緩い権限を締めることだけは先に行う）。
 * 設定は読み替えをメモリの上で済ませ、書き戻すのは起動が通ってから（persistSettings）である。
 */
export function bootHome(opts: Pick<StartOptions, 'home' | 'claudeDir'> = {}): HomeParts {
  const home = opts.home ?? hangarHome();
  ensureHome(home);
  // 断る確かめを、置き場の物を書くより先に済ませる。
  const db = openDb(dbPath(home));
  try {
    const token = readOrCreateToken(home);
    // statusline が curl に読ませるヘッダのファイルは、トークンと同じところで用意する。
    // install のときにしか置かないと、置き場を消した利用者の使用量が何も言わずに止まる。
    ensureStatuslineHeaderFile(home, token);
    const device = readOrCreateDevice(home);
    // tmux、code、claude のパスが設定に無ければここで探す。GUI 起動の貧弱な PATH でも見つけられる。
    // 書き戻すのは起動が通ってから（persistSettings）。
    const settings = { current: resolveToolPaths(loadSettings(home)) };
    ensureWrapperScript(home);
    const fixed = ensureSpawnHelper();
    if (fixed.length) console.log('[pty] spawn-helper に実行権限を付けました:', fixed.join(', '));

    const claudeDir = opts.claudeDir ?? (settings.current.claudeDir || defaultClaudeDir());
    const language = languageReader(() => settings.current);
    return {
      home, token, device, settings, language, claudeDir, db, life: { started: false, closed: false },
      persistSettings: () => saveSettings(home, settings.current),
      stop: () => db.close(),
    };
  } catch (e) {
    // ここで転んだら誰も stop を呼ばない。Windows で DB のファイルを握ったまま残さない。
    db.close();
    throw e;
  }
}
