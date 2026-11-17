import type { AutoApprovalDto, EventsPageDto, OrchestratorOrigin, OrchestratorStateDto } from '@agent-hangar/shared';
import type { OrchestratorSlice } from '../store/orchestrator.ts';
import type { EventsQuery } from './api.ts';

/** 柱のメニューの操作。fresh は会話を新しくする、stop は停止、wake は再開。 */
export type OrchestratorControlOp = 'fresh' | 'stop' | 'wake';

/** 画面からの操作。Mediator が orchestrator の効果にして渡す（mediator/orchestrator.ts）。 */
export type OrchestratorCommand = { op: 'load' } | { op: 'send'; text: string; origin?: OrchestratorOrigin } | { op: OrchestratorControlOp };

export type OrchestratorRunnerDeps = {
  /** 統括の会話の id（設定の orchestrator.sessionId）。無ければ読まない。 */
  sessionId: () => string | null;
  events: (sessionId: string, q: EventsQuery) => Promise<EventsPageDto>;
  approvals: () => Promise<{ approvals: AutoApprovalDto[] }>;
  send: (text: string, origin?: OrchestratorOrigin) => Promise<unknown>;
  /** 見張りの状態（GET /api/orchestrator/state）。 */
  state: () => Promise<OrchestratorStateDto>;
  /** 柱のメニューの操作（POST /api/orchestrator/fresh・stop・wake）。 */
  control: (op: OrchestratorControlOp) => Promise<unknown>;
  get: () => OrchestratorSlice;
  set: (next: OrchestratorSlice) => void;
  fail: (e: unknown) => void;
};

/**
 * 統括の柱の読み込みと送信と、メニューの操作。
 * 会話は最新の頁を読み直して置き換える（柱は末尾だけを見せる）。本文が伸びたことは Runtime が WebSocket の transcript.appended で知り、load を呼ぶ。
 * 見張りの状態は load のたびに読み（文脈の量は本文が伸びるたびに変わる）、止まった・切り替え中の変化は WebSocket の orchestrator.state でも届く。
 * 読みが重なったときは、最後に始めた読みの答えだけを入れる。
 */
export function createOrchestratorRunner(deps: OrchestratorRunnerDeps) {
  let generation = 0;
  let stateGeneration = 0;
  /** 見張りの状態を読み直す。読めなくても柱の会話は出せるので、失敗は知らせない。 */
  async function readState(): Promise<void> {
    const mine = ++stateGeneration;
    try {
      const keeper = await deps.state();
      if (mine === stateGeneration) deps.set({ ...deps.get(), keeper });
    } catch { /* 状態が読めなくても会話は出す */ }
  }
  async function load(): Promise<void> {
    const id = deps.sessionId();
    if (!id) return;
    const mine = ++generation;
    void readState();
    try {
      const [page, rec] = await Promise.all([deps.events(id, { agentId: null, latest: true }), deps.approvals()]);
      if (mine !== generation) return;
      deps.set({ ...deps.get(), events: page.events, approvals: rec.approvals, loaded: true });
    } catch (e) {
      if (mine === generation) deps.fail(e);
    }
  }
  async function send(text: string, origin?: OrchestratorOrigin): Promise<void> {
    deps.set({ ...deps.get(), sending: true });
    try {
      await deps.send(text, origin);
    } catch (e) {
      deps.fail(e);
    } finally {
      deps.set({ ...deps.get(), sending: false });
    }
  }
  /** 断られたら（切、切り替え中）サーバの文を知らせる。どちらでも状態は読み直す（画面の見立てが古かったかもしれない）。 */
  async function control(op: OrchestratorControlOp): Promise<void> {
    try {
      await deps.control(op);
    } catch (e) {
      deps.fail(e);
    }
    await readState();
  }
  return {
    run(cmd: OrchestratorCommand): Promise<void> {
      switch (cmd.op) {
        case 'load': return load();
        case 'send': return send(cmd.text, cmd.origin);
        default: return control(cmd.op);
      }
    },
  };
}
export type OrchestratorRunner = ReturnType<typeof createOrchestratorRunner>;
