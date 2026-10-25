import type { AgentDriver, LiveSource, TranscriptSource } from '../../agent/types.ts';
import { OpencodeClient } from './client.ts';
import { materializeOpencode, planOpencode, putInstructions, type MaterializeDeps, type OpencodeServes } from './launch.ts';

/**
 * opencode の driver に呼び手が渡すもの。
 * serves は会話ごとの serve の管理（boot/opencode.ts の ServeManager）。driver は配る層と一緒に組むが、serve の管理はその後で組むので、呼ばれた時点で引く。まだ無ければ null。
 * droppedEnv は TUI へ持ち込まない変数（launch/env.ts の RUN_DROPPED_ENV と hangar の変数）。この置き場から hangar の層を読まないよう、呼び手が渡す。
 * report は、指示を差し込めなかったときと、hangar の MCP がつながらなかったときに呼ぶ（どちらも起動は止めない）。
 */
export type OpencodeDriverDeps = {
  serves: () => OpencodeServes | null;
  droppedEnv: readonly string[];
  report?: (what: 'instructions' | 'mcp' | 'stop', e: unknown) => void;
} & Pick<MaterializeDeps, 'mcpWaitMs' | 'mcpPollMs' | 'requestTimeoutMs' | 'sleep'>;

/** serve の管理がまだ組まれていない。 */
export class OpencodeNotReadyError extends Error {
  constructor() {
    super('opencode serve manager is not ready yet');
    this.name = 'OpencodeNotReadyError';
  }
}

/** 状態の面。SSE で写しを持つのは段 B4 で、それまでは何も載せない。 */
const idleLive: LiveSource = {
  start: () => {},
  stop: () => {},
  current: () => [],
  onChange: () => () => {},
  kick: () => {},
  isRunning: () => false,
};

/** トランスクリプトの面。本文を DB に写すのは段 B5 で、それまでは空のページを返す。 */
const emptyTranscript: TranscriptSource = {
  start: () => {},
  stop: () => {},
  readPage: (_db, sessionId) => ({ sessionId, events: [], total: 0, nextSeq: null }),
};

/**
 * opencode の driver。起動の面を持ち、状態とトランスクリプトと許可・質問の面は、段 B4・B5 まで型を満たすだけの空にしておく。
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

  return {
    kind: 'opencode',
    caps: { accounts: false, effort: false, permissionMode: false, remoteControl: false, fork: false, attachExternal: false },
    launch: {
      // ID は opencode に振らせる（materialize が返す）。
      async materialize(mode, spec) {
        const r = await materializeOpencode({ serves: serves(), report, mcpWaitMs: deps.mcpWaitMs, mcpPollMs: deps.mcpPollMs, requestTimeoutMs: deps.requestTimeoutMs, sleep: deps.sleep }, mode, spec);
        hangarIdOf.set(r.providerSessionId, spec.hangarSessionId);
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
       * TUI が閉じたとき（tui-gone）の止め方と、hangar の再起動のあとの扱いは段 B6 で決める。
       */
      async release(target) {
        const s = deps.serves();
        const id = target.sessionId ?? hangarIdOf.get(target.providerSessionId);
        if (!s || !id || !s.get(id)) return false;
        hangarIdOf.delete(target.providerSessionId);
        await s.stop(id).catch((e: unknown) => report('stop', e));
        return true;
      },
    },
    live: idleLive,
    transcript: emptyTranscript,
    // 許可と質問は SSE で流す（段 B4 の subscribe）。hook は使わないので parseHook を持たない（hook の受け口は何も読まずに 204 を返す）。
    asks: {},
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
