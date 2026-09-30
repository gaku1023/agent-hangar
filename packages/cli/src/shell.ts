import {
  claudeSupportsBackground,
  ensureHome,
  ensureShellScript,
  hangarHome,
  installShellHook,
  shellHookInstalled,
  shellHookLine,
  shellHookUpToDate,
  uninstallShellHook,
  zshrcPath,
} from '@agent-hangar/server';
import { promptYesNo, type Ask } from './statusline.ts';

type ShellOpts = {
  /** hangar 自身の置き場。テストは一時ディレクトリを渡す。 */
  home?: string;
  /** 書き換える ~/.zshrc。テストは一時ファイルを渡す。 */
  zshrc?: string;
  claudeBin: string | null;
  /** 利用者のログインシェル。zsh でなければ入れない。 */
  loginShell?: string;
  yes?: boolean;
  ask?: Ask;
  log?: (s: string) => void;
};

/**
 * 外のターミナルで起動した claude を hangar で開けるようにする。
 * 包み方の本体を ~/.agent-hangar/shell/claude.zsh に置き、~/.zshrc の末尾に読み込む 1 行を足す。
 * 足す前に行を見せて承諾を得て、~/.zshrc の控えを取る。
 * Claude Code がバックグラウンドを使えない PC では入れない。入れても包み方は素の claude に戻るだけで、効き目が無い。
 */
export async function runShellInstall(o: ShellOpts): Promise<{ installed: boolean }> {
  const log = o.log ?? ((s: string) => console.log(s));
  const ask = o.ask ?? promptYesNo;
  const home = o.home ?? hangarHome();
  const zshrc = o.zshrc ?? zshrcPath();
  const loginShell = o.loginShell ?? process.env.SHELL ?? '';
  if (!/(^|\/)zsh$/.test(loginShell)) {
    log(`ログインシェルが zsh ではありません（${loginShell || '不明'}）。いまは zsh だけに対応しています。`);
    return { installed: false };
  }
  if (!claudeSupportsBackground(o.claudeBin)) {
    log('この PC の Claude Code ではバックグラウンドを使えません（claude agents --json が通りません）。');
    log('claude update で新しくするか、管理設定でバックグラウンドが切られていないかを確かめてください。');
    return { installed: false };
  }
  ensureHome(home);
  ensureShellScript(home);
  const line = shellHookLine(home);
  if (shellHookUpToDate(zshrc, line)) {
    log('既に入っています');
    return { installed: true };
  }
  log(`${zshrc} の末尾に次の 1 行を足します。`);
  log('');
  log(`  ${line}`);
  log('');
  log('足すと、ターミナルで起動した claude は Claude のバックグラウンドで動き、hangar からも同じセッションを開けるようになります。');
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
export function shellStatusLine(o: { zshrc?: string; claudeBin: string | null }): string {
  if (!claudeSupportsBackground(o.claudeBin)) return '外のターミナル: この PC の Claude Code ではバックグラウンドを使えません';
  return shellHookInstalled(o.zshrc ?? zshrcPath()) ? '外のターミナル: 入っています' : '外のターミナル: まだです（hangar shell install で入れられます）';
}
