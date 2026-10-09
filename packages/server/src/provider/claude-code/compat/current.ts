import type { CompatContract } from '@agent-hangar/shared';
import { isClaudeDirDrift } from './claudeDir.ts';
import { isCliDrift } from './cli.ts';
import { isRegistryDrift } from './registry.ts';
import { isTranscriptDrift } from './transcript.ts';

/**
 * 記録に残ったずれが、今の hangar の契約でもずれかを、契約と値だけで答える。
 * 記録は手元の claude の版が変わるまで残るので、そのあいだに hangar が知っている集合を広げると、
 * 前の hangar が記録した値が、今の hangar から見ればずれでないのに残り続ける。ずれの記録（log.ts）はこれで落とす。
 *
 * 値だけで決められるのは、知っている集合と比べて記録した値である（トランスクリプトの種類、レジストリの status、
 * ~/.claude の項目、CLI のサブコマンドの増減と agents --json の行の種類）。
 * statusline と画面の文字は、欠けた項目と見つからない目印の記録で、値だけでは今もそうかを決められないので残す。
 * ほかの契約の欠けと、知らない形の値も残す。
 */
export function isCurrentDrift(contract: CompatContract, value: string): boolean {
  switch (contract) {
    case 'transcript': return isTranscriptDrift(value);
    case 'registry': return isRegistryDrift(value);
    case 'claude-dir': return isClaudeDirDrift(value);
    case 'cli': return isCliDrift(value);
    case 'statusline':
    case 'screen':
      return true;
  }
}
