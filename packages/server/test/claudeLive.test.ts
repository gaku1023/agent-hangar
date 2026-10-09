import { describe, expect, it } from 'vitest';
import { captureOutputSync } from '../src/platform/capture.ts';
import { claudeVersionOf, parseHelp } from '../src/provider/claude-code/compat/cli.ts';
import { newestClaudeFixture, readFixtureText } from './claudeFixtures.ts';

/**
 * 週に 1 度の照合（.github/workflows/claude-compat.yml）だけが HANGAR_LIVE_CLAUDE=1 を立てる。ふだんの npm test では飛ぶ。
 * サブコマンドか引数が最も新しい見本と違えば落ちる。見本を採り直す合図である。
 * 版が新しいだけなら落とさない（版はほぼ毎日上がる）。
 * --help は 22KB ほどあり、Node のパイプで読むと macOS で途中で切れる。captureOutputSync は一時ファイル越しに読む。
 */
const LIVE = process.env.HANGAR_LIVE_CLAUDE === '1';
const TIMEOUT_MS = 60_000;

describe.skipIf(!LIVE)('いまの claude と最も新しい見本', () => {
  it('サブコマンドと引数が、最も新しい見本の --help と同じ', () => {
    const f = newestClaudeFixture();
    expect(f, '見本がありません。npm run capture-claude-fixtures で採ってください').not.toBeNull();
    const bin = process.env.HANGAR_CLAUDE_BIN ?? 'claude';
    const version = claudeVersionOf(captureOutputSync(bin, ['--version'], { timeoutMs: TIMEOUT_MS }).stdout);
    const now = parseHelp(captureOutputSync(bin, ['--help'], { timeoutMs: TIMEOUT_MS }).stdout);
    const want = parseHelp(readFixtureText(f!, 'help.txt'))!;
    console.log(`claude ${version ?? '(版を読めない)'}、最も新しい見本 ${f!.version}`);
    expect(now).not.toBeNull();
    expect(now!.subcommands).toEqual(want.subcommands);
    expect(now!.options).toEqual(want.options);
  });
});
