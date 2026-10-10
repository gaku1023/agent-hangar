import desktop from '../../../../apps/desktop/package.json' with { type: 'json' };

/**
 * サーバの版。WebSocket の ready と GET /health と MCP が名乗る。
 * アプリの版（apps/desktop の package.json）をそのまま使い、決め打ちしない。
 * 配布物では bundle-server の esbuild が束ねるときに中身を取り込むので、build のときの版が入る。
 * 版を上げるのは release-plan.ts の set-version で、release の plan もこのファイルの版をタグと照らす。
 */
export const VERSION: string = desktop.version;

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
