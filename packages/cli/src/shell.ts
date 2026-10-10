import path from 'node:path';
import {
  ensureHome,
  ensureShellScript,
  hangarHome,
  installShellHook,
  shellHookInstalled,
  shellHookLine,
  shellHookUpToDate,
  shellWrapOsSupported,
  shellWrapSupported,
  uninstallShellHook,
  zshrcPath,
} from '@agent-hangar/server/src/cliEntry.ts';
import { promptYesNo, type Ask } from './statusline.ts';

type ShellOpts = {
  /** hangar 自身の置き場。テストは一時ディレクトリを渡す。 */
  home?: string;
  /** 書き換える ~/.zshrc。テストは一時ファイルを渡す。 */
  zshrc?: string;
  /** hangar が使う tmux。無ければ入れない。 */
  tmuxPath: string | null;
  /** hangar のポート。本体に埋め込み、サーバは起動のたびに実際のポートで書き直す。 */
  port?: number;
  /** 利用者のログインシェル。zsh でなければ入れない。 */
  loginShell?: string;
  /** 動いている OS。試験が差し替える。Windows では入れない。 */
  platform?: NodeJS.Platform;
  yes?: boolean;
  ask?: Ask;
  log?: (s: string) => void;
};

/** Windows で install を頼まれたときの案内。包みは zsh のもので、Windows では作らない（2026-10-10 の決定）。 */
const WINDOWS_NOTE = 'Windows ではシェル連携を使えません。claude は Hangar から起動してください。外のターミナルで動いている claude は、Hangar の「hangar に移動」で開けます。';

/**
 * 外のターミナルで起動した claude を hangar で開けるようにする。
 * 包み方の本体を ~/.agent-hangar/shell/claude.zsh に置き、~/.zshrc の末尾に読み込む 1 行を足す。
 * 足す前に行を見せて承諾を得て、~/.zshrc の控えを取る。
 * tmux が無い PC では入れない。包み方は hangar の tmux の中で claude を起こすので、入れても素の claude に戻るだけで、効き目が無い。
 */
export async function runShellInstall(o: ShellOpts): Promise<{ installed: boolean }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const ask = o.ask ?? promptYesNo;
  const home = o.home ?? hangarHome();
  const zshrc = o.zshrc ?? zshrcPath();
  const platform = o.platform ?? process.platform;
  if (!shellWrapOsSupported(platform)) {
    log(WINDOWS_NOTE);
    return { installed: false };
  }
  const loginShell = o.loginShell ?? process.env.SHELL ?? '';
  if (!/(^|\/)zsh$/.test(loginShell)) {
    log(`ログインシェルが zsh ではありません（${loginShell || '不明'}）。いまは zsh だけに対応しています。`);
    return { installed: false };
  }
  if (!shellWrapSupported(o.tmuxPath, platform)) {
    log('この PC では tmux が見つかりません。包み方は hangar の tmux の中で claude を起こすので、tmux が要ります。');
    log('brew install tmux で入れるか、hangar の設定の「tmux のパス」を入れてください。');
    return { installed: false };
  }
  ensureHome(home);
  ensureShellScript(home, { url: `http://127.0.0.1:${o.port ?? 4177}`, tokenFile: path.join(home, 'token'), tmuxPath: o.tmuxPath });
  const line = shellHookLine(home);
  if (shellHookUpToDate(zshrc, line)) {
    log('既に入っています');
    return { installed: true };
  }
  log(`${zshrc} の末尾に次の 1 行を足します。`);
  log('');
  log(`  ${line}`);
  log('');
  log('足すと、ターミナルで起動した claude は hangar の tmux の中で動き、hangar からも同じセッションを開けるようになります。');
  log('hangar が動いていないときは、素の claude を起動します。');
  log('1 回だけ包まずに起動するときは command claude と打ってください。');
  if (!o.yes && !(await ask('足しますか？足す前に控えを取ります。'))) {
    log('足しませんでした');
    return { installed: false };
  }
  const r = installShellHook(zshrc, line);
  if (r.backup) log(`控え: ${r.backup}`);
  log('足しました。新しく開いたターミナルから効きます。開いているターミナルでは exec zsh で読み直せます。');
  return { installed: true };
}

/** ~/.zshrc から目印の付いた行だけを消す。控えを取ってから書く。 */
export function runShellUninstall(o: { zshrc?: string; log?: (s: string) => void } = {}): { removed: boolean } {
  const log = o.log ?? ((s: string) => console.log(s));
  const zshrc = o.zshrc ?? zshrcPath();
  const r = uninstallShellHook(zshrc);
  if (!r.changed) {
    log('入っていません');
    return { removed: false };
  }
  if (r.backup) log(`控え: ${r.backup}`);
  log('外しました。新しく開いたターミナルから効きます。');
  return { removed: true };
}

/** この PC の状態を 1 行で。 */
export function shellStatusLine(o: { zshrc?: string; tmuxPath: string | null; platform?: NodeJS.Platform }): string {
  const platform = o.platform ?? process.platform;
  if (!shellWrapOsSupported(platform)) return '外のターミナル: Windows では使えません。claude は Hangar から起動してください';
  if (!shellWrapSupported(o.tmuxPath, platform)) return '外のターミナル: この PC では tmux が見つからないので使えません';
  return shellHookInstalled(o.zshrc ?? zshrcPath()) ? '外のターミナル: 入っています' : '外のターミナル: まだです（hangar shell install で入れられます）';
}
