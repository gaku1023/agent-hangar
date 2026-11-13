import type { AutoApprovalDto, EventsPageDto } from '@agent-hangar/shared';
import type { OrchestratorSlice } from '../store/orchestrator.ts';
import type { EventsQuery } from './api.ts';

/** 画面からの操作。Mediator が orchestrator の効果にして渡す（mediator/orchestrator.ts）。 */
export type OrchestratorCommand = { op: 'load' } | { op: 'send'; text: string };

export type OrchestratorRunnerDeps = {
  /** 統括の会話の id（設定の orchestrator.sessionId）。無ければ読まない。 */
  sessionId: () => string | null;
  events: (sessionId: string, q: EventsQuery) => Promise<EventsPageDto>;
  approvals: () => Promise<{ approvals: AutoApprovalDto[] }>;
  send: (text: string) => Promise<unknown>;
  get: () => OrchestratorSlice;
  set: (next: OrchestratorSlice) => void;
  fail: (e: unknown) => void;
};

/**
 * 統括の柱の読み込みと送信。
 * 会話は最新の頁を読み直して置き換える（柱は末尾だけを見せる）。本文が伸びたことは Runtime が WebSocket の transcript.appended で知り、load を呼ぶ。
 * 読みが重なったときは、最後に始めた読みの答えだけを入れる。
 */
export function createOrchestratorRunner(deps: OrchestratorRunnerDeps) {
  let generation = 0;
  async function load(): Promise<void> {
    const id = deps.sessionId();
    if (!id) return;
    const mine = ++generation;
    try {
      const [page, rec] = await Promise.all([deps.events(id, { agentId: null, latest: true }), deps.approvals()]);
      if (mine !== generation) return;
      deps.set({ ...deps.get(), events: page.events, approvals: rec.approvals, loaded: true });
    } catch (e) {
      if (mine === generation) deps.fail(e);
    }
  }
  async function send(text: string): Promise<void> {
    deps.set({ ...deps.get(), sending: true });
    try {
      await deps.send(text);
    } catch (e) {
      deps.fail(e);
    } finally {
      deps.set({ ...deps.get(), sending: false });
    }
  }
  return {
    run(cmd: OrchestratorCommand): Promise<void> { return cmd.op === 'load' ? load() : send(cmd.text); },
  };
}
export type OrchestratorRunner = ReturnType<typeof createOrchestratorRunner>;
