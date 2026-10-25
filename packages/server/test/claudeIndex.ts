import type { Db } from '../src/db/open.ts';
import type { TranscriptFile } from '../src/agent/types.ts';
import { indexFile as indexWith, type IndexFileOptions, type IndexFileResult } from '../src/indexer/indexFile.ts';
import type { TranscriptCompat } from '../src/provider/claude-code/compat/transcript.ts';
import { readClaudeBatch } from '../src/provider/claude-code/transcript/batch.ts';

/**
 * Claude の本文のファイル 1 つを索引化する。索引（indexer/service.ts）と同じく、Claude の読み手（transcript/batch.ts）で束にして DB に書く。
 * compat は手元の本文にだけ渡す（remote の写しは見張らない）。試験が本文を 1 つずつ索引化するのに使う。
 */
export function indexFile(db: Db, file: TranscriptFile, opts: Omit<IndexFileOptions, 'reader'> & { compat?: TranscriptCompat }): IndexFileResult {
  const compat = opts.remote === true ? undefined : opts.compat;
  return indexWith(db, file, { ...opts, reader: { agent: 'claude-code', read: (f, from) => readClaudeBatch(f, from, { compat }) } });
}
