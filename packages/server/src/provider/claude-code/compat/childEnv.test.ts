import { describe, expect, it } from 'vitest';
import { CLAUDE_CHILD_ENV } from './childEnv.ts';

describe('CLAUDE_CHILD_ENV', () => {
  it('名前として読める形で、重なりが無い', () => {
    for (const n of CLAUDE_CHILD_ENV) expect(n, n).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(new Set(CLAUDE_CHILD_ENV).size).toBe(CLAUDE_CHILD_ENV.length);
  });

  // 2026-10-08 に、Claude Code のセッションの Bash から .app を起こしたとき、殻とサーバに入っていた印。
  it('Claude Code の Bash の子に立つ印を持つ', () => {
    for (const n of [
      'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED',
      'CLAUDE_CODE_SESSION_ID', 'CLAUDE_EFFORT', 'CLAUDE_PID', 'AI_AGENT',
    ]) expect(CLAUDE_CHILD_ENV, n).toContain(n);
  });

  it('裏のセッション（claude --bg）の起こし方で立つ印を持つ', () => {
    for (const n of ['CLAUDE_CODE_SESSION_KIND', 'CLAUDE_JOB_DIR', 'CLAUDE_CODE_SESSION_NAME', 'CLAUDE_BG_BACKEND', 'CLAUDE_BG_SOURCE']) {
      expect(CLAUDE_CHILD_ENV, n).toContain(n);
    }
  });

  // 利用者が自分で立てる設定として公開の文書に載っているものは、外すと利用者の設定が効かなくなる。
  it('利用者が立てる設定の変数は入れない', () => {
    for (const n of [
      'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_EFFORT_LEVEL',
      'CLAUDE_CODE_SHELL', 'CLAUDE_CODE_TMPDIR', 'CLAUDE_ENV_FILE', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
      'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'DISABLE_TELEMETRY',
    ]) expect(CLAUDE_CHILD_ENV, n).not.toContain(n);
  });

  // Claude Code が子に立てることはあるが、名前だけでは利用者やほかの道具が立てたものと見分けられない。
  it('ほかの道具と共有する名前は入れない', () => {
    for (const n of ['GIT_EDITOR', 'COREPACK_ENABLE_AUTO_PIN', 'NoDefaultCurrentDirectoryInExePath', 'TRACEPARENT', 'FORCE_COLOR', 'COLORTERM', 'BROWSER', 'SHELL', 'TMPDIR', 'TMUX', 'PATH']) {
      expect(CLAUDE_CHILD_ENV, n).not.toContain(n);
    }
  });
});
