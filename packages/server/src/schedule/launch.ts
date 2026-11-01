import type { ScheduleTarget } from '@agent-hangar/shared';
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

/** 予定を流す。新しい会話を起こすか、既存の会話へ送る。動いている会話には送らず 'busy' を返す。止まっている会話は再開してから送る。 */
export async function launchScheduled(deps: ToolDeps, s: { prompt: string; target: ScheduleTarget }, clock: WaitClock = REAL): Promise<{ sessionId: string } | 'busy'> {
  if (s.target.kind === 'new') {
    const r = await createSessionTool(deps, CTX, { project_id: s.target.projectId, prompt: s.prompt, name: nameOf(s.prompt), ...(s.target.agent ? { agent: s.target.agent } : {}) }) as { session_id: string };
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
