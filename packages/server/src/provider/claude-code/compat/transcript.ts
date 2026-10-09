import { compareClaudeVersions } from '@agent-hangar/shared';
import { isRec, versionOfRecord, type CompatSink, type Drift } from './types.ts';

// 知っている値の集合。正規化（normalize.ts）が名前で読む値と、2.1.284 から 2.1.295 の実物の記録で見た値である。
// 集合に足すのは、その値を正規化でどう扱うか（読むか、meta として残すか、捨てるか）を決めたときだけにする。
// isolation-latch は 2.1.295 で現れた。atis-latch と同じ仲間で、side と sessionId だけを持つ行なので、meta として残す。

/** 正規化が中身を読む行の種類。 */
export const KNOWN_LINE_TYPES: ReadonlySet<string> = new Set(['user', 'assistant', 'system', 'attachment']);
/** 中身を読まずに meta として残すと決めた行の種類（「Claude Code Provider」の節）。summary は古い版の要約の行である。 */
export const KNOWN_META_TYPES: ReadonlySet<string> = new Set([
  'last-prompt', 'atis-latch', 'mode', 'permission-mode', 'ai-title', 'custom-title', 'agent-name', 'pr-link',
  'queue-operation', 'file-history-snapshot', 'file-history-delta', 'relocated', 'worktree-state', 'bridge-session',
  'cost-state', 'frame-link', 'started', 'history-suppression', 'failed', 'result', 'artifact-autoreact-ledger',
  'artifact-comment-monitor', 'fork-context-ref', 'continued-in', 'summary', 'isolation-latch',
]);
/** system の行の種類。turn_duration はターンの終わりの印として読む（live/aside.ts）。 */
export const KNOWN_SYSTEM_SUBTYPES: ReadonlySet<string> = new Set([
  'turn_duration', 'stop_hook_summary', 'away_summary', 'local_command', 'informational', 'compact_boundary',
  'scheduled_task_fire', 'bridge_status', 'model_refusal_fallback', 'agents_killed',
]);
/** user の本文の塊の種類。 */
export const KNOWN_USER_BLOCKS: ReadonlySet<string> = new Set(['text', 'image', 'document', 'tool_result']);
/** assistant の本文の塊の種類。redacted_thinking は捨てると決めた塊である。 */
export const KNOWN_ASSISTANT_BLOCKS: ReadonlySet<string> = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use']);
/**
 * 添付で中身を読むのは queued_command だけである。
 * 添付の種類は版ごとに増え（2.1.284 から 2.1.292 の記録で 50 種）、hangar はほかの種類を読まないので、知らない種類を全部ずれにすると、止めた機能の無いずれで記録が埋まる。
 * そこで、知らない種類は、queued_command と同じく文字の prompt を持つときだけずれにする。queued_command の改名を捕まえるためである。
 */
export const READ_ATTACHMENT_TYPE = 'queued_command';

const d = (value: string): Drift => ({ contract: 'transcript', value, version: null });

/**
 * 1 行の記録が、正規化の知っている形かを見て、知らないものを 1 つずつずれとして返す。
 * 振る舞いは変えない（知らない行は meta として残し、知らない塊は捨てる）。
 * 版は入れない。呼び手（transcriptWatcher）が、行の版か同じファイルの直前の行の版を入れる。
 */
export function transcriptDrifts(raw: unknown): Drift[] {
  if (!isRec(raw)) return [];
  const type = typeof raw.type === 'string' ? raw.type : null;
  if (type === null) return [d('type=(missing)')];
  if (!KNOWN_LINE_TYPES.has(type)) return KNOWN_META_TYPES.has(type) ? [] : [d(`type=${type}`)];
  if (type === 'system') {
    const s = typeof raw.subtype === 'string' ? raw.subtype : null;
    if (s === null) return [d('system.subtype=(missing)')];
    return KNOWN_SYSTEM_SUBTYPES.has(s) ? [] : [d(`system.subtype=${s}`)];
  }
  if (type === 'attachment') {
    const a = isRec(raw.attachment) ? raw.attachment : null;
    if (a === null || typeof a.type !== 'string') return [d('attachment.type=(missing)')];
    if (a.type === READ_ATTACHMENT_TYPE) return [];
    return typeof a.prompt === 'string' ? [d(`attachment.type=${a.type}`)] : [];
  }
  const content = isRec(raw.message) ? raw.message.content : undefined;
  if (!Array.isArray(content)) return [];
  const known = type === 'user' ? KNOWN_USER_BLOCKS : KNOWN_ASSISTANT_BLOCKS;
  const out: Drift[] = [];
  const seen = new Set<string>();
  for (const b of content) {
    const bt = isRec(b) && typeof b.type === 'string' ? b.type : '(missing)';
    if (known.has(bt) || seen.has(bt)) continue;
    seen.add(bt);
    out.push(d(`${type}.content=${bt}`));
  }
  return out;
}

/** 索引に渡す見張りの口。since() より古い版の行は昔の形として見ない。 */
export type TranscriptCompat = { sink: CompatSink; since: () => string };

/**
 * 1 つのファイルの行を順に見張る関数を返す。
 * 版の無い行（メタ行の多く）は、同じファイルの直前の行の版を使う。
 * 版が分からない行と since() より古い版の行は見ない。長い履歴を初めて索引にするときに、昔の形の行でずれが溢れないようにするためである。
 */
export function transcriptWatcher(c: TranscriptCompat): (raw: unknown) => void {
  let last: string | null = null;
  const since = c.since();
  return (raw) => {
    const v = versionOfRecord(raw) ?? last;
    last = v;
    if (v === null || compareClaudeVersions(v, since) < 0) return;
    for (const x of transcriptDrifts(raw)) c.sink.note({ ...x, version: v });
  };
}
