import type { UsageDto } from '@agent-hangar/shared';
import { captureOutput } from '../../../platform/capture.ts';
import { printJsonDrifts } from '../compat/cli.ts';
import { NO_COMPAT, type CompatSink } from '../compat/types.ts';
import { parseSummaryOutput, SUMMARY_SCHEMA, summarySystemPrompt, SummarizerError, type Summarizer, type SummaryInput, type SummaryOutput } from '../../../summary/types.ts';
import { msg } from '../../../i18n/message.ts';
import { PRIMARY_ACCOUNT_ID } from '../../../config/accounts.ts';

/** env を渡さなければサーバの環境を継ぐ。 */
export type SpawnText = (cmd: string, args: string[], stdin: string, timeoutMs: number, env?: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * 要約するセッションのアカウント。configDir はその置き場で、最初のアカウントは null（CLAUDE_CONFIG_DIR を付けない）。
 * 呼び手（boot/summary.ts）が、そのセッションを最後に動かした run のアカウントから組む。
 */
export type SummaryAccount = { id: string; configDir: string | null };
const PRIMARY: SummaryAccount = { id: PRIMARY_ACCOUNT_ID, configDir: null };

/**
 * そのアカウントの置き場で claude を起こす環境。run の起動（RunManager.launch）と同じく、最初のアカウントは CLAUDE_CONFIG_DIR を外す。
 * サーバを別のアカウントのシェルから起こしていると、外さないだけではその置き場の枠を使ってしまう。
 */
export function summaryEnv(account: SummaryAccount, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.CLAUDE_CONFIG_DIR;
  if (account.configDir) env.CLAUDE_CONFIG_DIR = account.configDir;
  return env;
}

/**
 * 標準入力に本文を流し、標準出力と標準エラーを集めて返す。
 * 時間切れは SIGKILL である。
 * 標準出力はファイルへ書かせて読む（platform/capture.ts）。-p の JSON は要約の本文を含んでパイプの容量を越えうるうえ、
 * claude はパイプへ書き切る前に終わることがあるためである。
 */
export const spawnText: SpawnText = async (cmd, args, stdin, timeoutMs, env) => {
  const r = await captureOutput(cmd, args, { timeoutMs, stdin, stderr: true, env });
  return { code: r.code ?? -1, stdout: r.stdout, stderr: r.stderr };
};

const HOUR_MS = 3_600_000;
const SEVEN_DAY_STOP = 80;

/**
 * claude -p --model haiku のフォールバック。
 * サブスクリプションのレート制限を消費するので、1 時間の件数と 7 日の使用率で止める。
 * 走らせるのは、要約するセッションのアカウントの置き場である（accountOf）。枠を使うのは会話のアカウントで、既定のアカウントではない。
 * 7 日の使用率も、そのアカウントのもので見る。accountOf を渡さなければ、最初のアカウントで走らせる。
 */
export class ClaudeHeadlessSummarizer implements Summarizer {
  readonly id = 'claude-headless' as const;
  private calls: number[] = [];
  private readonly spawnFn: SpawnText;
  private readonly now: () => number;

  constructor(private readonly o: { claudeBin: string | null; hourlyCap: number; usage: (accountId: string) => UsageDto; accountOf?: (sessionId: string) => SummaryAccount; spawn?: SpawnText; now?: () => number; compat?: CompatSink }) {
    this.spawnFn = o.spawn ?? spawnText;
    this.now = o.now ?? (() => Date.now());
  }

  /** 直近 1 時間の呼び出し回数。古い記録はここで落とす。 */
  callsInLastHour(): number {
    const since = this.now() - HOUR_MS;
    this.calls = this.calls.filter((t) => t > since);
    return this.calls.length;
  }

  private accountOf(sessionId: string | undefined): SummaryAccount {
    return sessionId !== undefined && this.o.accountOf ? this.o.accountOf(sessionId) : PRIMARY;
  }

  /** input を渡さない問いは、最初のアカウントの使用率で見る。 */
  async available(input?: SummaryInput): Promise<boolean> {
    if (!this.o.claudeBin) return false;
    if (this.callsInLastHour() >= this.o.hourlyCap) return false;
    const seven = this.o.usage(this.accountOf(input?.sessionId).id).sevenDay;
    return seven === null || seven.usedPercent < SEVEN_DAY_STOP;
  }

  async summarize(input: SummaryInput): Promise<SummaryOutput> {
    if (!this.o.claudeBin) throw new SummarizerError(this.id, msg('summary.claude.missing'));
    this.calls.push(this.now());
    const args = ['-p', '--model', 'haiku', '--output-format', 'json', '--json-schema', JSON.stringify(SUMMARY_SCHEMA), '--append-system-prompt', summarySystemPrompt(input.language), '--no-session-persistence', '--tools', ''];
    let r: { code: number; stdout: string; stderr: string };
    try {
      r = await this.spawnFn(this.o.claudeBin, args, input.text, 120_000, summaryEnv(this.accountOf(input.sessionId)));
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
