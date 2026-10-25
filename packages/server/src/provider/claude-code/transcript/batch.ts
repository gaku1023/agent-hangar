import type { FileBatch, IndexRecord, TranscriptFile } from '../../../agent/types.ts';
import { transcriptWatcher, type TranscriptCompat } from '../compat/transcript.ts';
import { foldActivity, type Activity } from './activity.ts';
import { foldLimit, type Limit } from './limit.ts';
import { readNewLines } from './lines.ts';
import { isTypedPrompt, normalizeRecord, recordFacts } from './normalize.ts';

/**
 * Claude の本文（jsonl）を from バイト目から読み、索引に入れる束（agent/types.ts の IndexBatch）にする。
 * 改行で終わった行だけを読み、JSON として読めない行は数えて飛ばす。
 * ファイルが from より短くなっていたら作り直されたと見て先頭から読み、reset を立てる。from が 0 のときも reset を立てる。
 * compat を渡すと、読んだ行を Claude Code との互換の契約で見張る。手元の本文にだけ渡す（他端末の写しは、その端末の claude の版で書かれている）。
 * DB は読み書きしない。束を DB に書くのは indexer/write.ts である。
 */
export function readClaudeBatch(file: TranscriptFile, from: number, o: { compat?: TranscriptCompat } = {}): FileBatch {
  const read = readNewLines(file.path, from);
  const watch = o.compat ? transcriptWatcher(o.compat) : null;
  const raws: unknown[] = [];
  const records: IndexRecord[] = [];
  let badLines = 0;
  let seq = 0;
  for (const l of read.lines) {
    let rec: unknown;
    try { rec = JSON.parse(l.text); } catch { badLines++; continue; }
    // 受け口が投げても、見張りのせいで索引を止めない。
    try { watch?.(rec); } catch { /* 見張りは振る舞いを変えない */ }
    const events = normalizeRecord(rec, seq, file.agentId);
    const facts = recordFacts(rec);
    seq += events.length;
    raws.push(rec);
    records.push({
      events, facts,
      locator: { kind: 'file', path: file.path, offset: l.offset, length: l.length },
      typedPrompt: isTypedPrompt(rec, facts),
      endsTurn: events.some((e) => e.kind === 'system' && e.subtype === 'turn_duration'),
    });
  }
  return {
    agent: 'claude-code',
    providerSessionId: file.sessionId,
    agentId: file.agentId,
    cwd: records.find((r) => r.facts.cwd)?.facts.cwd,
    reset: read.reset || from === 0,
    records,
    fold: {
      // 「いま」は最後のツール呼び出しで、AskUserQuestion の問いは答え（tool_result）が来たら消える（activity.ts）。
      activity(prev: Activity | null) {
        let cur = prev;
        let asked = false;
        for (const r of records) {
          const was = cur;
          cur = foldActivity(cur, r.events);
          if (cur?.question && cur.question !== was?.question) asked = true;
        }
        return { next: cur, asked };
      },
      // 使用制限は合成の assistant 行から読むので、正規化の前の行も渡す（limit.ts）。
      limit(prev: Limit | null) {
        let cur = prev;
        records.forEach((r, i) => { cur = foldLimit(cur, raws[i], r.events); });
        return cur;
      },
    },
    nextByte: read.nextByte,
    badLines,
  };
}
