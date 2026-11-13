import { isAutoToolName, orchestratorOf, PERMISSION_POLICY_TEXT_MAX, PERMISSION_POLICY_TOOLS_MAX, type PermissionPolicy, type ServerEvent, type SettingsDto } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import { msg } from '../i18n/message.ts';
import { listAutoApprovals, AUTO_APPROVAL_LIST_MAX } from '../orchestrator/autoApprovals.ts';
import { ToolError, type ToolContext, type ToolDeps } from './tools.ts';

/**
 * 統括（docs/design.md「統括」）だけが使う許可の道具。
 * 統括のセッション別 URL（ctx.sessionId が設定の orchestrator.sessionId で、統括が入り）からだけ通す。
 * ほかの URL では道具の一覧に出さず（mcp/app.ts）、呼ばれても「知らない道具」と同じ断りを返す（ここ）。
 */
export const ORCHESTRATOR_TOOL_NAMES = ['list_pending_asks', 'answer_ask', 'set_permission_policy', 'list_auto_approvals'] as const;
export type OrchestratorToolName = (typeof ORCHESTRATOR_TOOL_NAMES)[number];

export const isOrchestratorToolName = (name: string): name is OrchestratorToolName => (ORCHESTRATOR_TOOL_NAMES as readonly string[]).includes(name);

/**
 * この呼び出しが統括のセッション別 URL からか。共通 URL（sessionId が null）は統括とみなさない。
 * 統括の会話の秘密で開けたときだけ通す。本体のトークン（hangar mcp install が user スコープに配る）を持つほかのエージェントが、統括の URL を名乗って道具を使えないようにする。
 */
export function isOrchestratorCtx(deps: Pick<ToolDeps, 'settings'>, ctx: ToolContext): boolean {
  if (ctx.sessionId === null || ctx.sessionSecret !== true) return false;
  const o = orchestratorOf(deps.settings?.().orchestrator);
  return o.enabled && o.sessionId === ctx.sessionId;
}

/** by: 'policy' の理由の 1 行の上限（文字）。 */
const REASON_MAX = 300;

const unknown = (name: string): ToolError => new ToolError(msg('mcp.error.unknownTool', { name }));
const bad = (field: string): ToolError => new ToolError(msg('mcp.orchestrator.badField', { field }));

export function callOrchestratorTool(deps: ToolDeps, ctx: ToolContext, name: OrchestratorToolName, args: Record<string, unknown>): unknown {
  if (!isOrchestratorCtx(deps, ctx) || !deps.orchestratorAsks) throw unknown(name);
  const self = ctx.sessionId!;
  const asks = deps.orchestratorAsks;
  switch (name) {
    case 'list_pending_asks':
      return asks.list(self);
    case 'answer_ask': {
      const askId = typeof args.ask_id === 'string' ? args.ask_id.trim() : '';
      if (askId === '') throw bad('ask_id');
      const option = args.option;
      const okOption = (typeof option === 'string' && option !== '') || (Array.isArray(option) && option.length > 0 && option.every((o) => typeof o === 'string' && o !== ''));
      if (!okOption) throw bad('option');
      if (args.by !== 'policy' && args.by !== 'user') throw bad('by');
      if (args.text !== undefined && typeof args.text !== 'string') throw bad('text');
      if (args.by === 'policy') {
        const reason = typeof args.reason === 'string' ? args.reason.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX) : '';
        if (reason === '') throw bad('reason');
        return asks.answer(self, { askId, option: option as string | string[], by: 'policy', reason, ...(args.text !== undefined ? { text: args.text as string } : {}) });
      }
      return asks.answer(self, { askId, option: option as string | string[], by: 'user', ...(args.text !== undefined ? { text: args.text as string } : {}) });
    }
    case 'set_permission_policy': {
      if (!deps.savePermissionPolicy) throw unknown(name);
      const text = typeof args.text === 'string' ? args.text.trim() : '';
      if (text === '' || text.length > PERMISSION_POLICY_TEXT_MAX) throw bad('text');
      const tools = args.auto_tools;
      if (!Array.isArray(tools) || tools.length > PERMISSION_POLICY_TOOLS_MAX || !tools.every(isAutoToolName)) throw bad('auto_tools');
      // 方針を変えられるのは利用者の言葉だけ。出来事で始まったターンでは断る。
      if (!asks.userTurn(self)) throw new ToolError(msg('mcp.orchestrator.userOnly'));
      const saved: PermissionPolicy = { text, autoTools: [...new Set(tools as string[])], updatedAt: Date.now() };
      deps.savePermissionPolicy(saved);
      return { text: saved.text, auto_tools: saved.autoTools, updated_at: saved.updatedAt };
    }
    case 'list_auto_approvals': {
      for (const f of ['limit', 'since'] as const) if (args[f] !== undefined && (typeof args[f] !== 'number' || !Number.isFinite(args[f]))) throw bad(f);
      const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), AUTO_APPROVAL_LIST_MAX) : undefined;
      const since = typeof args.since === 'number' ? args.since : undefined;
      return { approvals: listAutoApprovals(deps.db, { ...(limit !== undefined ? { limit } : {}), ...(since !== undefined ? { since } : {}) }) };
    }
  }
}

/** 方針の保存の道。設定に書き、変えた欄を全部の画面へ配る（set_notify_preference と同じ形）。 */
export function permissionPolicySaver(o: {
  updateSettings(patch: Partial<SettingsDto>): Settings;
  broadcast(ev: Extract<ServerEvent, { type: 'settings.changed' }>): void;
  toDto(s: Settings): SettingsDto;
}): (p: PermissionPolicy) => void {
  return (p) => {
    const s = o.updateSettings({ permissionPolicy: p });
    o.broadcast({ type: 'settings.changed', settings: o.toDto(s), keys: ['permissionPolicy'] });
  };
}
