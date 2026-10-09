import type { UsageDto } from '@agent-hangar/shared';
import { captureOutput } from '../platform/capture.ts';
import { printJsonDrifts } from '../provider/claude-code/compat/cli.ts';
import { NO_COMPAT, type CompatSink } from '../provider/claude-code/compat/types.ts';
import { parseSummaryOutput, SUMMARY_SCHEMA, summarySystemPrompt, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';
import { msg } from '../i18n/message.ts';

export type SpawnText = (cmd: string, args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * 標準入力に本文を流し、標準出力と標準エラーを集めて返す。
 * 時間切れは SIGKILL である。
 * 標準出力はファイルへ書かせて読む（platform/capture.ts）。-p の JSON は要約の本文を含んでパイプの容量を越えうるうえ、
 * claude はパイプへ書き切る前に終わることがあるためである。
 */
export const spawnText: SpawnText = async (cmd, args, stdin, timeoutMs) => {
  const r = await captureOutput(cmd, args, { timeoutMs, stdin, stderr: true });
  return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
};

const HOUR_MS = 3_600_000;
const SEVEN_DAY_STOP = 80;

/**
 * claude -p --model haiku のフォールバック。
 * サブスクリプションのレート制限を消費するので、1 時間の件数と 7 日の使用率で止める。
 */
export class ClaudeHeadlessSummarizer implements Summarizer {
  readonly id = 'claude-headless' as const;
  private calls: number[] = [];
  private readonly spawnFn: SpawnText;
  private readonly now: () => number;

  constructor(private readonly o: { claudeBin: string | null; hourlyCap: number; usage: () => UsageDto; spawn?: SpawnText; now?: () => number; compat?: CompatSink }) {
    this.spawnFn = o.spawn ?? spawnText;
    this.now = o.now ?? (() => Date.now());
  }

  /** 直近 1 時間の呼び出し回数。古い記録はここで落とす。 */
  callsInLastHour(): number {
    const since = this.now() - HOUR_MS;
    this.calls = this.calls.filter((t) => t > since);
    return this.calls.length;
  }

  async available(): Promise<boolean> {
    if (!this.o.claudeBin) return false;
    if (this.callsInLastHour() >= this.o.hourlyCap) return false;
    const seven = this.o.usage().sevenDay;
    return seven === null || seven.usedPercent < SEVEN_DAY_STOP;
  }

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    if (!this.o.claudeBin) throw new SummarizerError(this.id, msg('summary.claude.missing'));
    this.calls.push(this.now());
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--append-system-prompt', summarySystemPrompt(input.language), '--no-session-persistence', '--tools', ''];
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await this.spawnFn(this.o.claudeBin, args, input.text, 120_000);
    } catch (e) {
      throw new SummarizerError(this.id, e instanceof Error ? e.message : String(e));
    }
    if (r.code !== 0) throw new SummarizerError(this.id, msg('summary.claude.exited', { code: r.code, detail: r.stderr.trim().split('\n').at(-1) ?? '' }));
    // 形が違えば、Claude Code との互換のずれとして記録する。失敗の扱いはいまのまま。
    for (const d of printJsonDrifts(r.stdout)) (this.o.compat ?? NO_COMPAT).note(d);
    let j: unknown;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      throw new SummarizerError(this.id, msg('summary.claude.notJson'));
    }
    const so = typeof j === 'object' && j !== null ? (j as Record<string, unknown>).structured_output : undefined;
    if (so === undefined) throw new SummarizerError(this.id, msg('summary.claude.noStructuredOutput'));
    const out = parseSummaryOutput(so);
    if (!out) throw new SummarizerError(this.id, msg('summary.claude.badStructuredOutput'));
    return { ...out, model: 'haiku' };
  }
}
