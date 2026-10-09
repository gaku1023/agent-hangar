import { describe, expect, it } from 'vitest';
import { CLAUDE_CHILD_ENV } from '../provider/claude-code/compat/childEnv.ts';
import { RUN_DROPPED_ENV, SERVER_DROPPED_ENV, takeServerEnv } from './env.ts';

/** Claude Code のセッションの Bash から起こされたときの環境を模す。値は形だけで、意味を持たない。 */
const dirty = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(CLAUDE_CHILD_ENV.map((n) => [n, 'x'])),
  HANGAR_PORT: '4199', HANGAR_PARENT_PID: '4242', HANGAR_UI_DIST: '/app/ui',
  HANGAR_RUN_ID: 'r', HANGAR_UNSET_ENV: 'A;B', HANGAR_CLOUD_DIR: '/w/cloud',
  // 残すもの。利用者の設定と、サーバが動いている間ずっと読む hangar の変数。
  HANGAR_HOME: '/h', HANGAR_CLAUDE_DIR: '/c', HANGAR_CLAUDE_BIN: '/x/claude', HANGAR_DEV: '1',
  CLAUDE_CONFIG_DIR: '/u/.claude-work', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EFFORT_LEVEL: 'high', ANTHROPIC_BASE_URL: 'https://gw.example', PATH: '/usr/bin',
});

describe('takeServerEnv', () => {
  it('受け渡しの値を読んでから、印と受け渡しの変数を env から消す', () => {
    const env = dirty();
    expect(takeServerEnv(env)).toEqual({ port: 4199, parentPid: 4242, uiDist: '/app/ui' });
    for (const n of SERVER_DROPPED_ENV) expect(env, n).not.toHaveProperty(n);
    expect(env).toEqual({
      HANGAR_HOME: '/h', HANGAR_CLAUDE_DIR: '/c', HANGAR_CLAUDE_BIN: '/x/claude', HANGAR_DEV: '1',
      CLAUDE_CONFIG_DIR: '/u/.claude-work', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_EFFORT_LEVEL: 'high', ANTHROPIC_BASE_URL: 'https://gw.example', PATH: '/usr/bin',
    });
  });
  it('受け渡しの値が無い、または空なら undefined にする', () => {
    expect(takeServerEnv({ PATH: '/usr/bin' })).toEqual({ port: undefined, parentPid: undefined, uiDist: undefined });
    expect(takeServerEnv({ HANGAR_PORT: '', HANGAR_PARENT_PID: '', HANGAR_UI_DIST: '' })).toEqual({ port: undefined, parentPid: undefined, uiDist: undefined });
  });
});

describe('RUN_DROPPED_ENV', () => {
  it('Claude Code の印と、サーバが読み終えた受け渡しの変数を持つ', () => {
    for (const n of [...CLAUDE_CHILD_ENV, 'HANGAR_PORT', 'HANGAR_PARENT_PID', 'HANGAR_UI_DIST', 'HANGAR_CLOUD_DIR']) expect(RUN_DROPPED_ENV, n).toContain(n);
    expect(new Set(RUN_DROPPED_ENV).size).toBe(RUN_DROPPED_ENV.length);
  });
  // HANGAR_HOME は statusline の台本と hangar の CLI が claude の中で読む。
  // HANGAR_RUN_ID は run ごとに立て直し、HANGAR_UNSET_ENV は Windows の包みが自分で読んで消す。外すと包みに届かない。
  // CLAUDE_CONFIG_DIR はアカウントで決まるので、呼び手が足すかを決める。
  it('claude の中で読むもの、run ごとに立てるもの、利用者の設定は入れない', () => {
    for (const n of ['HANGAR_HOME', 'HANGAR_RUN_ID', 'HANGAR_UNSET_ENV', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL']) {
      expect(RUN_DROPPED_ENV, n).not.toContain(n);
    }
  });
});
