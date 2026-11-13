/**
 * 統括が自分で許可してよい範囲（docs/design.md「統括」の許可の方針）。この PC だけの設定で、同期しない。
 * text は利用者の言葉そのまま、autoTools は統括が言葉から直した道具の名前、updatedAt は保存した時刻（ミリ秒）。
 * 設定に無い（null）ときは、読み取りと検索の道具だけを許すものとして読む（permissionAutoToolsOf）。
 * 今は道具の名前だけを見る。Bash を入れることは受けるが、命令の中身の線引きは統括の読み（text）に任せる。
 */
export type PermissionPolicy = { text: string; autoTools: string[]; updatedAt: number };

/** 方針が空のときに統括が自分で許してよい道具。ファイルの読み取りと検索だけ。 */
export const DEFAULT_AUTO_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'LS'];

/** 方針の言葉の長さの上限（文字）。 */
export const PERMISSION_POLICY_TEXT_MAX = 2000;
/** 道具の名前の数の上限。 */
export const PERMISSION_POLICY_TOOLS_MAX = 64;

/**
 * 道具の名前として受ける形。Claude Code の道具（Read、Bash）と MCP の道具（mcp__server__tool）。
 * 括弧つきの指定（Bash(git status:*)）や * は受けない。命令の前置きの型は後の PR で足す。
 */
export function isAutoToolName(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 128) return false;
  return v.startsWith('mcp__') ? /^mcp__[A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*(?:__[A-Za-z0-9_-]+)?$/.test(v) : /^[A-Za-z][A-Za-z0-9_]*$/.test(v);
}

/** 保存した方針を形で検査して読む。形の違う値は null（既定）として読む。 */
export function permissionPolicyOf(raw: unknown): PermissionPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.text !== 'string' || o.text.trim() === '' || o.text.length > PERMISSION_POLICY_TEXT_MAX) return null;
  if (!Array.isArray(o.autoTools) || o.autoTools.length > PERMISSION_POLICY_TOOLS_MAX || !o.autoTools.every(isAutoToolName)) return null;
  const updatedAt = typeof o.updatedAt === 'number' && Number.isFinite(o.updatedAt) ? o.updatedAt : 0;
  return { text: o.text, autoTools: [...new Set(o.autoTools as string[])], updatedAt };
}

/** 統括がいま自分で許してよい道具。方針が無ければ既定（読み取りと検索の 4 つ）。 */
export function permissionAutoToolsOf(policy: PermissionPolicy | null | undefined): string[] {
  return policy ? [...policy.autoTools] : [...DEFAULT_AUTO_TOOLS];
}

/**
 * 統括が方針に沿って自分で出した許可の記録の 1 行（手元だけの表 auto_approvals）。
 * title はその時点の会話の題名、input は道具の主な引数（2000 字まで）、label は押した行、reason は統括が書いた 1 行、policyText はその時点の方針の言葉（既定なら null）。
 */
export type AutoApprovalDto = { id: string; at: number; sessionId: string; title: string; tool: string; input: string; label: string; reason: string; policyText: string | null };
