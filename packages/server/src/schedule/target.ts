import { isAgentKind, type AgentKind, type ScheduleLaunch, type ScheduleTarget } from '@agent-hangar/shared';
import { MessageError, msg, type Message } from '../i18n/message.ts';
import { agentEnabledLabel } from '../runs/manager.ts';

/**
 * 予定の「新しい会話」の宛先の検査。HTTP（routes/schedules.ts）と MCP（mcp/scheduleTools.ts）が共有する。
 * 形の誤りと、エージェントに合わない項目、projectId と scratch の矛盾を断る。黙って捨てない。
 * モデルや effort が実在するかは調べない。起動のときの既存の検査（runs.start）に任せる。
 */
type NewTarget = Extract<ScheduleTarget, { kind: 'new' }>;

const STRING_KEYS = ['name', 'account', 'model', 'effort', 'permissionMode', 'worktree', 'mode', 'cwd'] as const;

/** エージェントに合わない項目を断る文。opencode と Codex は起動（runs/manager.ts）と同じ文で、Claude Code は予定だけの文である。 */
function unsupported(agent: AgentKind, option: string): Message {
  if (agent === 'codex') return msg('run.agent.codex.optionUnsupported', { option });
  if (agent === 'opencode') return msg('run.agent.optionUnsupported', { option });
  return msg('schedules.error.optionNotForClaude', { option });
}

/** そのエージェントに渡せない項目。 */
const REJECTED: Record<AgentKind, readonly (keyof ScheduleLaunch)[]> = {
  'claude-code': ['mode', 'autoApprove'],
  codex: ['worktree', 'addDirs', 'mode', 'autoApprove'],
  opencode: ['account', 'effort', 'permissionMode', 'worktree', 'addDirs'],
};

export function parseNewTarget(v: unknown, agentEnabled: (a: AgentKind) => boolean): NewTarget {
  const bad = () => new MessageError(msg('schedules.error.target'));
  if (typeof v !== 'object' || v === null) throw bad();
  const o = v as Record<string, unknown>;
  if (o.kind !== 'new') throw bad();

  const scratch = o.scratch === true;
  if (o.scratch !== undefined && typeof o.scratch !== 'boolean') throw bad();
  // クイックセッションは projectId が null で scratch が真。プロジェクトを持つ予定に scratch は付かない。
  if (scratch ? o.projectId !== null : typeof o.projectId !== 'string' || !o.projectId) throw bad();

  let agent: AgentKind | undefined;
  if (o.agent !== undefined) {
    if (!isAgentKind(o.agent)) throw new MessageError(msg('run.agent.unknown', { agent: String(o.agent).slice(0, 40) }));
    if (o.agent !== 'claude-code' && !agentEnabled(o.agent)) throw new MessageError(msg('run.agent.disabled', { label: agentEnabledLabel(o.agent) }));
    agent = o.agent;
  }

  const launch: ScheduleLaunch = {};
  for (const k of STRING_KEYS) {
    const x = o[k];
    if (x === undefined) continue;
    if (typeof x !== 'string') throw bad();
    if (x.trim()) launch[k] = x.trim();
  }
  if (o.addDirs !== undefined) {
    if (!Array.isArray(o.addDirs) || o.addDirs.some((d) => typeof d !== 'string')) throw bad();
    const dirs = (o.addDirs as string[]).map((d) => d.trim()).filter(Boolean);
    if (dirs.length) launch.addDirs = dirs;
  }
  if (o.autoApprove !== undefined) {
    if (typeof o.autoApprove !== 'boolean') throw bad();
    if (o.autoApprove) launch.autoApprove = true;
  }
  // クイックセッションには、プロジェクトの下のフォルダが無い。
  if (scratch && launch.cwd) throw bad();

  const effective = agent ?? 'claude-code';
  const reject = REJECTED[effective].find((k) => launch[k] !== undefined);
  if (reject) throw new MessageError(unsupported(effective, reject));

  return {
    kind: 'new', projectId: scratch ? null : (o.projectId as string), ...(scratch ? { scratch: true } : {}),
    ...(agent ? { agent } : {}), ...launch,
  };
}
