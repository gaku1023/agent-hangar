/** サーバの版。WebSocket の ready と GET /health が名乗る。 */
export const VERSION = '0.3.0';

export type StartOptions = {
  /** 0 を渡すと空いているポートを使い、実際の番号を返り値の port に入れる。 */
  port?: number;
  host?: string;
  home?: string;
  /** 設定ファイルより優先する Claude Code のディレクトリ。テストがフィクスチャの複製を指すために使う。 */
  claudeDir?: string;
  uiDist?: string;
  /**
   * Claude の登録のうち、消えたプロセスの残りと見る pid。既定は OS で決める（provider/claude-code/registry.ts の goneOn）。
   * テストの見本の登録は実在しない pid を持つので、テストは「残りは無い」を渡す。
   */
  registryIsGone?: (pid: number) => boolean;
  /** Windows の殻の実行ファイル。外のアプリをジョブの外で起こす起こし役に使う（external/breakaway.ts）。 */
  launcher?: string;
};
