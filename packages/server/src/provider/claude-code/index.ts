import { buildClaudeArgs } from '../../launch/args.ts';
import type { LaunchInput, Provider } from '../types.ts';

/**
 * claude の起動コマンドだけを受け持つ provider。
 * 走査や本文の読み出しはサーバが各モジュールを直接呼ぶので、ここには持たせない。
 */
export const claudeCodeProvider: Pick<Provider, 'id' | 'launchCommand' | 'resumeCommand'> = {
  id: 'claude-code',
  launchCommand(input: LaunchInput): string[] {
    return ['claude', ...buildClaudeArgs(input)];
  },
  resumeCommand(input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[] {
    const mode = fork
      ? { kind: 'fork' as const, sessionUuid: session.providerSessionId, newSessionUuid: newSessionUuid ?? '' }
      : { kind: 'resume' as const, sessionUuid: session.providerSessionId };
    return ['claude', ...buildClaudeArgs({ ...input, mode })];
  },
};
