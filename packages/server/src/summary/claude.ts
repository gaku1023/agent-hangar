import { spawn } from 'node:child_process';
import type { UsageDto } from '@agent-hangar/shared';
import { parseSummaryOutput, SUMMARY_SCHEMA, SUMMARY_SYSTEM_PROMPT, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from './types.ts';

export type SpawnText = (cmd: string, args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * 標準入力に本文を流し、標準出力と標準エラーを集めて返す。
 * 時間切れは SIGKILL である。
 */
export const spawnText: SpawnText = (cmd, args, stdin, timeoutMs) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`${timeoutMs} ミリ秒で応答がありませんでした`)); }, timeoutMs);
  p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  p.on('error', (e) => { clearTimeout(timer); reject(e); });
  p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  p.stdin.end(stdin);
});

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

  constructor(private readonly o: { claudeBin: string | null; hourlyCap: number; usage: () => UsageDto; spawn?: SpawnText; now?: () => number }) {
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
    if (!this.o.claudeBin) throw new SummarizerError(this.id, 'claude が見つかりません');
    this.calls.push(this.now());
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--append-system-prompt', SUMMARY_SYSTEM_PROMPT, '--no-session-persistence', '--tools', ''];
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await this.spawnFn(this.o.claudeBin, args, input.text, 120_000);
    } catch (e) {
      throw new SummarizerError(this.id, e instanceof Error ? e.message : String(e));
    }
    if (r.code !== 0) throw new SummarizerError(this.id, `claude が ${r.code} で終了しました: ${r.stderr.trim().split('\n').at(-1) ?? ''}`);
    let j: unknown;
    try {
      j = JSON.parse(r.stdout);
    } catch {
      throw new SummarizerError(this.id, '出力が JSON ではありません');
    }
    const so = typeof j === 'object' && j !== null ? (j as Record<string, unknown>).structured_output : undefined;
    if (so === undefined) throw new SummarizerError(this.id, '出力に structured_output がありません');
    const out = parseSummaryOutput(so);
    if (!out) throw new SummarizerError(this.id, 'structured_output がスキーマの形ではありません');
    return out;
  }
}
