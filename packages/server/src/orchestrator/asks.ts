import { createHash } from 'node:crypto';
import { permissionAutoToolsOf, type LiveSessionDto, type PermissionPolicy } from '@agent-hangar/shared';
import type { Db } from '../db/open.ts';
import { displayName } from '../db/queries.ts';
import type { PeerChatLocal } from '../peer/chat/host.ts';
import { deleteAutoApproval, insertAutoApproval } from './autoApprovals.ts';

/**
 * 統括がほかの会話の許可待ちに答える芯（docs/design.md「統括」の許可、MCP の list_pending_asks と answer_ask）。
 *
 * 答えはペインへのキー入力で、peer chat の宿主の答え手（peer/chat/host.ts の local）を通す。
 * ほかの PC からの答えと同じ照合と記録を通るので、同じ札に 2 度は打たず、利用者が先に答えれば打たずに断る。
 *
 * 安全の境界は hangar が機械で守る（統括の読みに頼らない）。
 * - 統括自身の札は一覧に載せず、答えない。
 * - by: 'policy' は、方針の道具（無ければ読み取りと検索の 4 つ）の、許可の札の、「今回だけ許す」の行（Yes）だけを押せる。質問は押せない。
 *   押す前に記録を書き、書けなければ打たず、打てなければ記録を消す。1 分に ORCHESTRATOR_POLICY_RATE 回まで。
 * - by: 'user' は、統括の今のターンが利用者の入力で始まったときだけ通す（userTurn）。
 * - Claude Code の会話だけに答える。Codex と opencode は answerable: false で載せ、伝えるだけにする。
 */

/** by: 'policy' の答えの、1 分あたりの上限。超えたら断り、利用者へ知らせる（暴走の歯止め）。 */
export const ORCHESTRATOR_POLICY_RATE = 20;
const RATE_WINDOW_MS = 60_000;
/** 答えた ask_id を覚えておく長さ（答え手の ANSWERED_TTL_MS と同じ）。 */
const ANSWERED_KEEP_MS = 10 * 60_000;
/**
 * 「今回だけ許す」の行。Claude Code の許可の札の 1 行目（2.1.319 の実機で `1. Yes`）。
 * 「今後は聞かない」（Yes, and don't ask again …）、「この会話の間は許す」（Yes, allow reading from …）、モードを替える行、断る行は当たらない。
 * 文言が版で変わって当たらなくなれば、方針の答えが not-allowed になるだけで、広い方へは倒れない。
 */
const ONE_TIME_ALLOW = /^yes$/i;

export type PendingAsk = {
  ask_id: string;
  session_id: string;
  title: string;
  project: string | null;
  kind: 'permission' | 'question';
  tool: string | null;
  input: string | null;
  description: string | null;
  options: { key: string; label: string }[];
  answerable: boolean;
  since: number | null;
};

export type AnswerAskArgs = {
  askId: string;
  /** 押す行の key。複数選択の質問は配列（by: 'user' のときだけ）。 */
  option: string | string[];
  by: 'policy' | 'user';
  /** by: 'policy' の理由の 1 行。呼び手（MCP の層）が空でないことを確かめてから渡す。 */
  reason?: string;
  /** 質問の自由入力（by: 'user' のときだけ）。 */
  text?: string;
};

export type AnswerAskRefusal = 'ask-mismatch' | 'already-answered' | 'not-allowed' | 'not-answerable' | 'rate-limited';
export type AnswerAskResult = { ok: true; label: string } | { ok: false; reason: AnswerAskRefusal; sent?: true };

export type OrchestratorAsksDeps = {
  db: Db;
  /** この PC の実行中の一覧（agent/liveHub.ts）。 */
  live(): LiveSessionDto[];
  /** この PC の Claude Code の会話の札に答える口。無ければ全部を answerable: false にする。 */
  local: Pick<PeerChatLocal, 'currentAsk' | 'answer'> | null;
  /** 設定の permissionPolicy（無ければ null、既定として読む）。 */
  policy(): PermissionPolicy | null;
  /** 統括の今のターンが利用者の入力で始まったか（orchestrator/turnMark.ts の userTurnOf）。偽なら by: 'user' を断る。 */
  userTurn(orchestratorSessionId: string): boolean;
  /** 方針の答えが上限に当たったとき（1 分に 1 度まで）。 */
  onRateLimited?(): void;
  now?(): number;
};

export type OrchestratorAsks = {
  list(selfSessionId: string): { asks: PendingAsk[]; policy: { text: string | null; auto_tools: string[] } };
  answer(selfSessionId: string, args: AnswerAskArgs): Promise<AnswerAskResult>;
  /** 統括の今のターンが利用者の入力で始まったか（set_permission_policy も同じ条件で断る）。 */
  userTurn(selfSessionId: string): boolean;
};

type Located = PendingAsk & { peerAskId: string | null };

const hash = (parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

export function createOrchestratorAsks(deps: OrchestratorAsksDeps): OrchestratorAsks {
  const now = deps.now ?? Date.now;
  const answered = new Map<string, number>();
  const policyTimes: number[] = [];
  let limitedUntil = 0;

  const sessionRow = deps.db.prepare(`select s.id, s.custom_title, sn.name, s.ai_title, s.first_prompt, p.name project from sessions s
    left join session_notes sn on sn.session_id = s.id and sn.deleted_at is null
    left join projects p on p.id = s.project_id and p.deleted_at is null
    where s.provider = ? and s.provider_session_id = ? and s.deleted_at is null`);

  /** 実行中の一覧の、許可か質問を待っている会話の札を全部（統括自身も含む）。 */
  function locate(): Located[] {
    const out: Located[] = [];
    for (const l of deps.live()) {
      if (l.waitingFor !== 'permission' && l.waitingFor !== 'question') continue;
      const provider = l.agent ?? 'claude-code';
      const row = sessionRow.get(provider, l.sessionId) as { id: string; custom_title: string | null; name: string | null; ai_title: string | null; first_prompt: string | null; project: string | null } | undefined;
      if (!row) continue;
      const base = { session_id: row.id, title: displayName(row, l) ?? '', project: row.project, description: l.permission?.description ?? null, since: l.statusAt ?? null };
      const ask = provider === 'claude-code' ? deps.local?.currentAsk(row.id) ?? null : null;
      if (ask) {
        out.push({
          ...base, ask_id: hash(['claude-code', row.id, ask.askId]), peerAskId: ask.askId, kind: ask.kind,
          tool: ask.tool ?? l.permission?.tool ?? null, input: ask.input ?? null, options: ask.options.map((o) => ({ key: o.key, label: o.label })), answerable: ask.answerable !== false,
        });
        continue;
      }
      // 答え手の無い会話（Codex、opencode）と、画面に札がまだ読めない Claude Code の会話は、伝えるだけにする。
      const kind = l.waitingFor;
      const tool = l.permission?.tool ?? null;
      const input = l.permission?.input ?? null;
      out.push({ ...base, ask_id: hash([provider, row.id, kind, tool, input, l.statusAt ?? null]), peerAskId: null, kind, tool, input, options: [], answerable: false });
    }
    return out;
  }

  const strip = ({ peerAskId: _p, ...a }: Located): PendingAsk => a;

  const wasAnswered = (askId: string): boolean => {
    const t = now();
    for (const [id, until] of answered) if (until <= t) answered.delete(id);
    return answered.has(askId);
  };

  function rateOk(): boolean {
    const t = now();
    while (policyTimes.length > 0 && policyTimes[0]! <= t - RATE_WINDOW_MS) policyTimes.shift();
    if (policyTimes.length < ORCHESTRATOR_POLICY_RATE) return true;
    if (t >= limitedUntil) {
      limitedUntil = t + RATE_WINDOW_MS;
      deps.onRateLimited?.();
    }
    return false;
  }

  return {
    userTurn: (selfSessionId) => deps.userTurn(selfSessionId),
    list(selfSessionId) {
      const policy = deps.policy();
      return {
        asks: locate().filter((a) => a.session_id !== selfSessionId).map(strip),
        policy: { text: policy?.text ?? null, auto_tools: permissionAutoToolsOf(policy) },
      };
    },

    async answer(selfSessionId, args) {
      if (wasAnswered(args.askId)) return { ok: false, reason: 'already-answered' };
      const ask = locate().find((a) => a.ask_id === args.askId);
      if (!ask) return { ok: false, reason: 'ask-mismatch' };
      // 自分の許可は自分で出せない。
      if (ask.session_id === selfSessionId) return { ok: false, reason: 'not-allowed' };
      if (args.by === 'user' && !deps.userTurn(selfSessionId)) return { ok: false, reason: 'not-allowed' };
      if (!ask.answerable || ask.peerAskId === null || !deps.local) return { ok: false, reason: 'not-answerable' };
      const keys = Array.isArray(args.option) ? args.option : [args.option];
      const chosen = keys.map((k) => ask.options.find((o) => o.key === k));
      if (keys.length === 0 || chosen.some((o) => !o)) return { ok: false, reason: 'ask-mismatch' };

      let recordId: string | null = null;
      if (args.by === 'policy') {
        const policy = deps.policy();
        const allowed = ask.kind === 'permission' && ask.tool !== null && permissionAutoToolsOf(policy).includes(ask.tool)
          && keys.length === 1 && ONE_TIME_ALLOW.test(chosen[0]!.label.trim()) && (args.text === undefined || args.text === '');
        if (!allowed) return { ok: false, reason: 'not-allowed' };
        if (!rateOk()) return { ok: false, reason: 'rate-limited' };
        // 打つ前に書く。書けなければ投げて、打たない。
        recordId = insertAutoApproval(deps.db, {
          at: now(), sessionId: ask.session_id, title: ask.title, tool: ask.tool!, input: ask.input ?? '', label: chosen[0]!.label, reason: args.reason ?? '', policyText: policy?.text ?? null,
        });
        policyTimes.push(now());
      }

      const r = await deps.local.answer(ask.session_id, ask.peerAskId, keys, args.by === 'user' ? args.text : undefined);
      if (r.ok || r.sent || r.reason === 'already-answered') answered.set(args.askId, now() + ANSWERED_KEEP_MS);
      if (r.ok) return { ok: true, label: r.label };
      // キーが届いたかもしれない断り（sent）は、記録を残す。何も打っていない断りは消す。
      if (recordId !== null && !r.sent) deleteAutoApproval(deps.db, recordId);
      const reason: AnswerAskRefusal = r.reason === 'already-answered' ? 'already-answered' : 'ask-mismatch';
      return r.sent ? { ok: false, reason, sent: true } : { ok: false, reason };
    },
  };
}
