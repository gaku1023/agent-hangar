import { opencodeProbeEnv } from '../compat/version.ts';

/**
 * `opencode serve` に渡す空の環境（docs/design.md「opencode の serve の管理」）。
 *
 * 裏のサービスは、起こしたプロセスの環境をそのまま持ち続ける。
 * hangar を Claude Code のセッションから起こすと、サーバの環境に呼び手の印（`CLAUDE` で始まる鍵）と hangar の印（`HANGAR_*`）が入っているので、
 * それを継いだ serve が、そこから動く道具とモデルの全部に印を配ってしまう。
 * opencode は環境から設定（`OPENCODE_*`）とプロバイダーの API キーも読むので、決まった鍵のほかは何も渡さない。
 */

/**
 * Windows で serve に写す鍵の許可リストの型。
 * 中身は段 G（G1）で実機を見て決める。それまで Windows では serve を起こさない。
 */
export type WindowsServeAllowlist = readonly string[];

/** この OS では serve をまだ起こせない。 */
export class ServeUnsupportedError extends Error {
  constructor(platform: NodeJS.Platform) {
    super(`opencode serve is not supported on ${platform} yet`);
    this.name = 'ServeUnsupportedError';
  }
}

/**
 * serve の環境を組む。
 * macOS と Linux は `HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG` と、opencode の置き場を先頭に足した固定の最小の `PATH` だけである。
 * 版を読むとき（compat/version.ts の `opencodeProbeEnv`）と同じ作りにそろえる。
 * パスワード（`OPENCODE_SERVER_PASSWORD`）は起こす側（spawn.ts）が足す。
 */
export function serveEnv(bin: string, src: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  if (platform === 'win32') throw new ServeUnsupportedError(platform);
  return opencodeProbeEnv(bin, src, platform);
}
