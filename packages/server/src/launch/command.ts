// tmux のセッションの中で起こすコマンドの組み立て。OS で変わるのは、包みの起こし方と、シェルのタブの中身である。

/**
 * claude を包みで起こすコマンドと、セッションに足す環境変数。
 * macOS と Linux は bash の包み。プロセス置換を使うので sh ではなく bash で起こし、HANGAR_RUN_ID は env コマンドで渡す。
 * Windows は Node の包み。ペインの中の PATH に頼らないよう、サーバを動かしている Node の絶対パスで起こし、HANGAR_RUN_ID はセッションの環境で渡す。
 * unset は claude に渡さない変数の名前（Claude Code の印など。launch/env.ts の RUN_DROPPED_ENV）。
 * tmux の新しいセッションは、tmux サーバを起こしたシェルの環境を継ぐので、足さないだけでは外れない。
 * macOS と Linux は env -u で外し、Windows は名前を HANGAR_UNSET_ENV で包みに渡して、包みが起こす前に消す（hangar-run.mjs）。
 */
export function runCommand(o: { runId: string; wrapper: string; log: string; command: string[]; platform?: NodeJS.Platform; node?: string; unset?: readonly string[] }): { command: string[]; env: Record<string, string> } {
  const unset = o.unset ?? [];
  if ((o.platform ?? process.platform) === 'win32') {
    return { command: [o.node ?? process.execPath, o.wrapper, o.log, ...o.command], env: { HANGAR_RUN_ID: o.runId, ...(unset.length > 0 ? { HANGAR_UNSET_ENV: unset.join(';') } : {}) } };
  }
  return { command: ['env', ...unset.flatMap((n) => ['-u', n]), `HANGAR_RUN_ID=${o.runId}`, 'bash', o.wrapper, o.log, ...o.command], env: {} };
}

/**
 * シェルのタブで起こすコマンド。
 * macOS と Linux は利用者のログインシェル。Windows は PowerShell で、Git Bash が立てる SHELL は見ない。
 * unset はシェルに渡さない変数の名前。タブも tmux サーバの環境を継ぐので、macOS と Linux は env -u で外してからシェルを起こす。
 * Windows は PowerShell の前に置ける env コマンドが無いので外さない（claude の run は包みが外す）。
 */
export function shellTabCommand(o: { shell?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; unset?: readonly string[] } = {}): string[] {
  const env = o.env ?? process.env;
  if ((o.platform ?? process.platform) === 'win32') return [o.shell ?? 'powershell.exe', '-NoLogo'];
  const unset = o.unset ?? [];
  return [...(unset.length > 0 ? ['env', ...unset.flatMap((n) => ['-u', n])] : []), o.shell ?? env.SHELL ?? '/bin/zsh', '-l'];
}
