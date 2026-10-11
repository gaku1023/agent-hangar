/**
 * 連携の書き込みの対象（MCP の登録と解除、シェル連携のインストールとアンインストール、ステータスラインの設定と解除）。
 * 画面のボタン（setup.run）、CLI の見立て（packages/cli/src/setupPlan.ts）、殻の命令（apps/desktop の approve.rs の SETUP_TARGETS）が同じ並びを使う。
 * 書くのは殻の承諾の窓を経た CLI だけで、サーバは書かない（全体計画の D9）。
 */
export const SETUP_TARGETS = ['mcp-install', 'mcp-uninstall', 'shell-install', 'shell-uninstall', 'statusline-install', 'statusline-uninstall'] as const;
export type SetupTarget = (typeof SETUP_TARGETS)[number];

export function isSetupTarget(v: string): v is SetupTarget {
  return (SETUP_TARGETS as readonly string[]).includes(v);
}
