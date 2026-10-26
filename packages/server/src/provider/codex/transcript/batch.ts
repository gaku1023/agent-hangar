import type { FileBatch, IndexRecord, TranscriptFile } from '../../../agent/types.ts';
import { foldActivity, type Activity } from '../../claude-code/transcript/activity.ts';
import { readHeadLine, readLogicalLines } from './logical.ts';
import { codexRecordFacts, modeOfSessionMeta, normalizeCodexRecord, type CodexMode } from './normalize.ts';

/** パスごとの保存の形。session_meta は先頭の 1 行にあり、書き換わらないので覚えておく。 */
const modes = new Map<string, CodexMode>();
const MODES_MAX = 2000;

function rememberMode(path: string, mode: CodexMode): void {
  if (modes.size >= MODES_MAX) modes.clear();
  modes.set(path, mode);
}

/** 先頭の行から保存の形を知る。先頭が読めなければ legacy。 */
function modeOf(path: string, firstLine: string | null): CodexMode {
  const known = modes.get(path);
  if (known) return known;
  let head = firstLine;
  if (head === null) { try { head = readHeadLine(path); } catch { head = null; } }
  let mode: CodexMode = 'legacy';
  if (head) { try { mode = modeOfSessionMeta(JSON.parse(head)); } catch { /* 読めなければ legacy */ } }
  rememberMode(path, mode);
  return mode;
}

/**
 * Codex の rollout（論理パス）を from バイト目から読み、索引に入れる束にする。
 * 圧縮された .jsonl.zst も同じ論理パスで読み、展開後のバイト位置で数える（logical.ts）。
 * 改行で終わった行だけを読み、JSON として読めない行と type の無い行は数えて飛ばす。
 * from が 0 のときと、本文が from より短くなっていたとき（作り直し）は reset を立てる。
 * DB は読み書きしない。束を DB に書くのは indexer/write.ts である。
 */
export function readCodexBatch(file: TranscriptFile, from: number): FileBatch {
  const read = readLogicalLines(file.path, from);
  // 作り直しのときは、先頭から読み直すので記憶を捨てる。
  if (read.reset || from === 0) modes.delete(file.path);
  const first = read.lines[0];
  const mode = modeOf(file.path, first && first.offset === 0 ? first.text : null);
  const records: IndexRecord[] = [];
  let badLines = 0;
  let seq = 0;
  // 外の会話の cwd は、最後の thread_settings_applied を優先する（codex の見方と合う）。
  let settingsCwd: string | undefined;
  for (const l of read.lines) {
    let rec: unknown;
    try { rec = JSON.parse(l.text); } catch { badLines++; continue; }
    if (typeof rec !== 'object' || rec === null || typeof (rec as { type?: unknown }).type !== 'string') { badLines++; continue; }
    const events = normalizeCodexRecord(rec, seq);
    const facts = codexRecordFacts(rec, { mode });
    seq += events.length;
    const p = (rec as { payload?: { type?: unknown } }).payload;
    if (p?.type === 'thread_settings_applied' && facts.cwd) settingsCwd = facts.cwd;
    records.push({
      events, facts,
      locator: { kind: 'file', path: file.path, offset: l.offset, length: l.length },
      typedPrompt: facts.isUserTurn,
      endsTurn: events.some((e) => e.kind === 'system' && (e.subtype === 'turn_duration' || e.subtype === 'turn_aborted')),
    });
  }
  return {
    agent: 'codex',
    providerSessionId: file.sessionId,
    agentId: null,
    cwd: settingsCwd ?? records.find((r) => r.facts.cwd)?.facts.cwd,
    reset: read.reset || from === 0,
    records,
    fold: {
      // 「いま」は最後のツール呼び出し。Codex には質問の道具が rollout に出ないので、asked は常に偽になる。
      activity(prev: Activity | null) {
        let cur = prev;
        for (const r of records) cur = foldActivity(cur, r.events);
        return { next: cur, asked: false };
      },
      // 使用量の枠は rollout の meta（rate_limits）から読む（段 B7）ので、ここでは持たない。
      limit: (prev) => prev,
    },
    nextByte: read.nextByte,
    badLines,
  };
}
