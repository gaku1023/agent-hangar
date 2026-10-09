import type { UsageDto } from '@agent-hangar/shared';
import type { Settings } from '../config/paths.ts';
import type { CompatSink } from '../provider/claude-code/compat/types.ts';
import { ClaudeHeadlessSummarizer } from './claude.ts';
import { LmStudioSummarizer } from './lmstudio.ts';
import type { Summarizer } from './types.ts';

/**
 * run が終わったときの要約の受け付け方。
 * RunManager.kill は tmux kill-session の直後に同期で runEnded を出すが、
 * レジストリは ~/.claude/sessions を 500 ミリ秒周期で読んだキャッシュなので、
 * その瞬間は必ず「生きている」と出て受理を断ってしまう。
 * run の終了はこちらが知っているので、生存判定だけを飛ばす。
 * 土台かどうかと 5 ターンの判定は残す。
 */
export const RUN_ENDED_SUMMARY_OPTS = { ignoreLive: true } as const;

export type SummarizerSetDeps = {
  settings: () => Pick<Settings, 'lmStudioUrl' | 'lmStudioModel' | 'summaryFallback' | 'summaryHourlyCap'>;
  claudeBin: () => string | null;
  usage: () => UsageDto;
  compat: CompatSink;
};

/**
 * 要約器の列を持つ。
 * Claude への切り替えの件数はプロセスの寿命で数えるので、Claude の要約器は 1 度だけ作り、
 * 設定の変更は列の組み立てで反映する。毎回作り直すと 1 時間の窓が空になる。
 * claude の場所と上限だけは要約器が内側に持つので、変わったときに rebuildClaude で作り直す。
 */
export class SummarizerSet {
  private claude: ClaudeHeadlessSummarizer;

  constructor(private readonly deps: SummarizerSetDeps) {
    this.claude = this.build();
  }

  private build(): ClaudeHeadlessSummarizer {
    return new ClaudeHeadlessSummarizer({ claudeBin: this.deps.claudeBin(), hourlyCap: this.deps.settings().summaryHourlyCap, usage: this.deps.usage, compat: this.deps.compat });
  }

  rebuildClaude(): void {
    this.claude = this.build();
  }

  list = (): Summarizer[] => {
    const s = this.deps.settings();
    const list: Summarizer[] = [new LmStudioSummarizer({ baseUrl: s.lmStudioUrl, model: s.lmStudioModel })];
    if (s.summaryFallback) list.push(this.claude);
    return list;
  };

  /** LM Studio のモデルの一覧。設定のモデルに依らないので、その場限りの問い合わせ用に作る。 */
  listModels = (): Promise<string[]> => new LmStudioSummarizer({ baseUrl: this.deps.settings().lmStudioUrl, model: null }).listModels();
}
