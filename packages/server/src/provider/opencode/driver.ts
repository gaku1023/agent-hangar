import type { LiveSessionDto } from '@agent-hangar/shared';
import type { AgentDriver } from '../../agent/types.ts';
import { opencodeAsks } from './asks.ts';
import { OpencodeClient } from './client.ts';
import { materializeOpencode, planOpencode, putInstructions, type MaterializeDeps, type OpencodeServes } from './launch.ts';
import { OpencodeLive } from './live.ts';
import { OpencodeTranscript } from './transcript/source.ts';

/**
 * opencode の driver に呼び手が渡すもの。
 * serves は会話ごとの serve の管理（boot/opencode.ts の ServeManager）。driver は配る層と一緒に組むが、serve の管理はその後で組むので、呼ばれた時点で引く。まだ無ければ null。
 * droppedEnv は TUI へ持ち込まない変数（launch/env.ts の RUN_DROPPED_ENV と hangar の変数）。この置き場から hangar の層を読まないよう、呼び手が渡す。
 * report は、指示を差し込めなかったときと、hangar の MCP がつながらなかったときに呼ぶ（どちらも起動は止めない）。
 * enrich は実行中の一覧の足し付けの鎖（agent/liveHub.ts の LiveHub.enrich）で、状態の面が組み直すたびに通す。
 */
export type OpencodeDriverDeps = {
  serves: () => OpencodeServes | null;
  droppedEnv: readonly string[];
  enrich?: (live: LiveSessionDto[]) => LiveSessionDto[];
  report?: (what: 'instructions' | 'mcp' | 'stop', e: unknown) => void;
} & Pick<MaterializeDeps, 'mcpWaitMs' | 'mcpPollMs' | 'requestTimeoutMs' | 'sleep'>;

/** serve の管理がまだ組まれていない。 */
export class OpencodeNotReadyError extends Error {
  constructor() {
    super('opencode serve manager is not ready yet');
    this.name = 'OpencodeNotReadyError';
  }
}

/**
 * opencode の driver。起動、状態、トランスクリプト、許可・質問、追記の面を持つ。
 * Claude にしか無いもの（アカウント、effort、権限モード、Remote Control、フォーク、外の会話の引き取り）は caps で持たないと言い、RunManager が入口で断る。
 */
export function createOpencodeDriver(deps: OpencodeDriverDeps): AgentDriver {
  const report = deps.report ?? ((what: string, e: unknown) => { console.warn(`[opencode] ${what}: ${e instanceof Error ? e.message : String(e)}`); });
  const serves = (): OpencodeServes => {
    const s = deps.serves();
    if (!s) throw new OpencodeNotReadyError();
    return s;
  };
  /** opencode の会話の ID から hangar の会話の ID を引く。serve は hangar の ID で持つので、追記の差し替えに使う。 */
  const hangarIdOf = new Map<string, string>();
  /** 状態の面。作った会話を載せ、serve の出来事の流れで写しを持つ（live.ts）。許可と質問もここから流す。 */
  const live = new OpencodeLive({ enrich: deps.enrich, log: (line) => { console.log(line); } });
  /**
   * トランスクリプトの面。作った会話の本文を serve の API から読み、索引へ束で渡す（transcript/source.ts）。
   * 読む契機は、状態の面が読んでいる serve の出来事の流れから受ける（流れを serve 1 本に 1 本にするため）。
   */
  const transcript = new OpencodeTranscript({ events: (cb) => live.onEvent(cb), requestTimeoutMs: deps.requestTimeoutMs });

  return {
    kind: 'opencode',
    caps: { accounts: false, effort: false, permissionMode: false, remoteControl: false, fork: false, attachExternal: false },
    launch: {
      // ID は opencode に振らせる（materialize が返す）。
      async materialize(mode, spec) {
        const r = await materializeOpencode({ serves: serves(), report, mcpWaitMs: deps.mcpWaitMs, mcpPollMs: deps.mcpPollMs, requestTimeoutMs: deps.requestTimeoutMs, sleep: deps.sleep }, mode, spec);
        hangarIdOf.set(r.providerSessionId, spec.hangarSessionId);
        live.track({ providerSessionId: r.providerSessionId, cwd: spec.cwd, serve: r.serve });
        transcript.track({ providerSessionId: r.providerSessionId, cwd: spec.cwd, serve: r.serve });
        return { providerSessionId: r.providerSessionId };
      },
      plan(bin, mode, spec) {
        if (mode.kind !== 'start') throw new Error(`opencode cannot ${mode.kind} a session yet`);
        const serve = serves().get(spec.hangarSessionId);
        if (!serve) throw new Error('the opencode serve for this session is not running');
        return planOpencode(bin, mode.id, spec, serve, deps.droppedEnv);
      },
      /**
       * その会話の serve を止める（interrupt、SIGTERM、SIGKILL の順は serve の管理が持つ）。止めにいったら true を返す。
       * 止める前に本文をもう一度読む。serve が止まると本文を読めなくなるためである（読めなくても止める）。
       * TUI が閉じたとき（tui-gone）の止め方と、hangar の再起動のあとの扱いは段 B6 で決める。
       */
      async release(target) {
        live.untrack(target.providerSessionId);
        await transcript.sync(target.providerSessionId).catch(() => undefined);
        transcript.untrack(target.providerSessionId);
        const s = deps.serves();
        const id = target.sessionId ?? hangarIdOf.get(target.providerSessionId);
        if (!s || !id || !s.get(id)) return false;
        hangarIdOf.delete(target.providerSessionId);
        await s.stop(id).catch((e: unknown) => report('stop', e));
        return true;
      },
    },
    live,
    transcript,
    // 許可と質問は serve の出来事の流れから流す（subscribe）。hook は使わないので parseHook を持たない（hook の受け口は何も読まずに 204 を返す）。
    asks: opencodeAsks(live),
    instructions: {
      // 動いている会話の追記も API で差し替えられる。
      when: 'live',
      async update(providerSessionId, entries) {
        const id = hangarIdOf.get(providerSessionId);
        const serve = id ? deps.serves()?.get(id) : null;
        if (!serve) throw new Error('the opencode serve for this session is not running');
        await putInstructions(new OpencodeClient(serve, { timeoutMs: deps.requestTimeoutMs }), providerSessionId, entries, report);
      },
    },
  };
}
