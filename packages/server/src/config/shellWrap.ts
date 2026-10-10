import fs from 'node:fs';
import path from 'node:path';
import type { ShellHookDto } from '@agent-hangar/shared';
import { ensureShellScript, shellHookLine, shellHookState, shellInstallCommand, shellWrapOsSupported, shellWrapSupported, zshrcPath } from './shellHook.ts';
import { which } from './tools.ts';

/**
 * 同梱の hangar。アプリの中では server.mjs の隣の bin/hangar にある。リポジトリから動かすときは無い。
 * serverDir はサーバの入口のファイルがある場所である。
 */
export function bundledHangarIn(serverDir: string): string | null {
  const p = path.join(serverDir, 'bin', 'hangar');
  return fs.existsSync(p) ? p : null;
}

export type ShellWrapDeps = {
  home: string;
  /** 待ち受けているホストとポート。包みの本体に埋め込む。 */
  host: string; port: number;
  /** いまの tmux のパス。設定は書き替わるので、呼ばれた時点の値を読む。 */
  tmuxPath: () => string | null;
  /** 包みがそのまま渡すサブコマンド。 */
  subcommands: () => readonly string[];
  bundledHangar: string | null;
  /** 試験が ~/.zshrc の場所を差し替える口。 */
  zshrc?: () => string;
  /** 動いている OS。試験が差し替える。Windows では包みを作らない。 */
  platform?: NodeJS.Platform;
  errorLog?: (...a: unknown[]) => void;
};

/**
 * 外のターミナルで起動した claude を hangar で開けるようにする包みの、サーバの側の持ち場。
 * 包み方の本体は hangar の版と揃える。~/.zshrc の 1 行はこのファイルを読むだけなので、更新はここで行き渡る。
 * 本体には実際に待ち受けているポートと tmux のパスを埋め込むので、listen の後に書き、tmux のパスが変われば書き直す。
 * ~/.zshrc は読むだけで、書き換えない。
 */
export function createShellWrap(deps: ShellWrapDeps): { write(): void; installCommand(): string; hook(): ShellHookDto } {
  const installCommand = (): string => shellInstallCommand({ hangarOnPath: which('hangar'), bundledHangar: deps.bundledHangar });
  const platform = deps.platform ?? process.platform;
  const osSupported = shellWrapOsSupported(platform);
  return {
    write() {
      // Windows では包みを作らないので、zsh の本体も置かない。
      if (!osSupported) return;
      try {
        const host = deps.host === '0.0.0.0' || deps.host === '::' ? '127.0.0.1' : deps.host;
        ensureShellScript(deps.home, { url: `http://${host}:${deps.port}`, tokenFile: path.join(deps.home, 'token'), tmuxPath: deps.tmuxPath(), subcommands: deps.subcommands() });
      } catch (e) {
        (deps.errorLog ?? console.error)('[shell] 包み方の本体を書けませんでした', e instanceof Error ? e.message : e);
      }
    },
    installCommand,
    // 包めるかは tmux を実行できるかで見る。ファイルを見るだけなので、毎回測る。
    // osSupported が偽（Windows）なら、画面はシェル連携の節ごと出さない。
    hook() {
      const shellSupported = shellWrapSupported(deps.tmuxPath(), platform);
      const zshrc = (deps.zshrc ?? zshrcPath)();
      return { state: shellHookState(zshrc, shellSupported), zshrc, line: shellHookLine(deps.home), command: installCommand(), osSupported };
    },
  };
}
