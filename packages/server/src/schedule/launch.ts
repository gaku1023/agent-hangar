import type { AgentKind, ScheduleTarget } from '@agent-hangar/shared';
import { getSession } from '../db/queries.ts';
import { MessageError, msg } from '../i18n/message.ts';
import { sendToSessionTool } from '../mcp/screenTools.ts';
import { createSessionTool, resumeSessionTool, type ToolContext, type ToolDeps } from '../mcp/tools.ts';
import { MAX_WAIT_SECONDS, waitForSessionTool, type WaitClock } from '../mcp/waitTool.ts';
import type { ScheduleOutcome } from './runner.ts';

/** 再開してから入力を受けられるようになるまで待つ長さ。 */
const RESUME_READY_MS = 60_000;
const NAME_MAX = 40;
/** サーバから呼ぶ。起動元の会話は無い。 */
const CTX: ToolContext = { sessionId: null };
const REAL: WaitClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

const nameOf = (prompt: string): string => {
  const cs = [...prompt.replace(/\s+/g, ' ').trim()];
  return cs.length > NAME_MAX ? `${cs.slice(0, NAME_MAX - 1).join('')}…` : cs.join('');
};

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 回ごとの worktree の名前。予定の時刻を手元の時刻で MMDD-HHmm にして付ける。遅れて走った回も、走った時刻でなく予定の時刻で付く。 */
export function worktreeForRun(base: string, plannedAt: number): string {
  const d = new Date(plannedAt);
  return `${base}-${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/**
 * 予定の account（id）がいまの組にまだあるか。無ければ、別のアカウントで黙って起こさず、その回を失敗にする。
 * 組が渡されていない（アカウントを使わない構成）ときも、頼まれた枠で起こせないので同じ扱いにする。
 */
function checkAccount(deps: ToolDeps, agent: AgentKind, id: string): void {
  const store = agent === 'codex' ? deps.codexAccounts : agent === 'claude-code' ? deps.accounts?.store : undefined;
  if (!store?.get(id)) throw new MessageError(msg('schedules.error.accountGone'));
}

/** 予定を流す。新しい会話を起こすか、既存の会話へ送る。動いている会話には送らず 'busy' を返す。止まっている会話は再開してから送る。 */
export async function launchScheduled(deps: ToolDeps, s: { prompt: string; target: ScheduleTarget; plannedAt: number }, clock: WaitClock = REAL): Promise<{ sessionId: string } | 'busy'> {
  if (s.target.kind === 'new') {
    const t = s.target;
    if (t.account) checkAccount(deps, t.agent ?? 'claude-code', t.account);
    // 項目は create_session の引数の名前に写す。あるものだけを渡し、渡さなかったものは create_session の既定に任せる。
    const r = await createSessionTool(deps, CTX, {
      ...(t.projectId ? { project_id: t.projectId } : {}), ...(t.scratch ? { scratch: true } : {}),
      prompt: s.prompt, name: t.name ?? nameOf(s.prompt),
      ...(t.agent ? { agent: t.agent } : {}), ...(t.account ? { account: t.account } : {}), ...(t.model ? { model: t.model } : {}),
      ...(t.effort ? { effort: t.effort } : {}), ...(t.permissionMode ? { permission_mode: t.permissionMode } : {}),
      ...(t.worktree ? { worktree: worktreeForRun(t.worktree, s.plannedAt) } : {}), ...(t.addDirs?.length ? { add_dirs: t.addDirs } : {}),
      ...(t.mode ? { mode: t.mode } : {}), ...(t.autoApprove ? { auto_approve: true } : {}), ...(t.cwd ? { cwd: t.cwd } : {}),
    }) as { session_id: string };
    return { sessionId: r.session_id };
  }
  const id = s.target.sessionId;
  const read = () => getSession(deps.db, deps.live(), id, { deviceId: deps.deviceId });
  const cur = read();
  if (!cur) throw new MessageError(msg('mcp.error.sessionNotFound', { id }));
  if (deps.runs.aliveRun?.(id)) {
    // 考えている途中や、許可の問いで止まっている会話に入力を流し込まない。
    if (cur.live !== 'idle') return 'busy';
  } else {
    await resumeSessionTool(deps, CTX, { session_id: id });
    const until = clock.now() + RESUME_READY_MS;
    while (read()?.live !== 'idle') {
      if (clock.now() >= until) throw new MessageError(msg('schedules.error.notReady'));
      await clock.sleep(1000);
    }
  }
  await sendToSessionTool(deps, CTX, { session_id: id, text: s.prompt });
  return { sessionId: id };
}

/** ターンの終わりか入力待ちまで待つ。待つ本体の上限ごとに呼び直し、実行の時間に上限は掛けない。 */
export async function waitScheduled(deps: ToolDeps, sessionId: string, clock: WaitClock = REAL): Promise<ScheduleOutcome> {
  for (;;) {
    const r = await waitForSessionTool(deps, CTX, { session_id: sessionId, timeout_seconds: MAX_WAIT_SECONDS }, clock);
    if (r.state === 'finished') return { result: 'finished' };
    if (r.state === 'waiting') return { result: 'waiting' };
    if (r.state === 'failed') return { result: 'failed', ...(r.reason ? { error: r.reason } : {}) };
  }
}
