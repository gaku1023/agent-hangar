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
  /** フォークには新しい UUID が要る。空のまま組み立てると --session-id '' という壊れたコマンドになるので、ここで弾く。 */
  resumeCommand(input: Omit<LaunchInput, 'mode'>, session: { providerSessionId: string }, fork: boolean, newSessionUuid?: string): string[] {
    if (fork && !newSessionUuid?.trim()) throw new Error('フォークには新しいセッションの UUID が必要です');
    const mode = fork
      ? { kind: 'fork' as const, sessionUuid: session.providerSessionId, newSessionUuid: newSessionUuid!.trim() }
      : { kind: 'resume' as const, sessionUuid: session.providerSessionId };
    return ['claude', ...buildClaudeArgs({ ...input, mode })];
  },
};
