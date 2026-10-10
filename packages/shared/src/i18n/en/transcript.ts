import type { transcriptKeys } from '../keys/transcript.ts';
import type { AreaDictionary } from '../messageSpec.ts';

export const transcriptEn: AreaDictionary<typeof transcriptKeys> = {
  'transcript.diff.gap': '⋯ {n} {n|line|lines} ⋯',
  'transcript.bash.exitCode': 'Exit code {code}',
  'transcript.bash.failed': 'Failed',
  'transcript.bash.noResult': 'No result',
  'transcript.bash.noOutput': 'No output',
  'transcript.bash.lines': '{n} {n|line|lines}',
  'transcript.fetch.prompt': 'Prompt',
  'transcript.search.results': '{n} {n|result|results}',
  'transcript.tool.hits': '{n} {n|match|matches}',
  'transcript.tool.result': 'Result',
  'transcript.tool.raw': 'Raw',
  'transcript.tool.viewSubagent': 'View subagent {id}',
  'transcript.find.noMatch': '0 matches',
  'transcript.find.label': 'Find in transcript',
  'transcript.find.matchCase': 'Match case',
  'transcript.find.prev': 'Previous match (⇧⏎)',
  'transcript.find.next': 'Next match (⏎)',
  'transcript.find.close': 'Close (esc)',
  'transcript.empty.none': 'No transcript',
  'transcript.more.older': 'Load older lines ({n} left)',
  'transcript.more.newer': 'Load newer lines',
  'transcript.more.unseen': '{n} new {n|line|lines}',
};
