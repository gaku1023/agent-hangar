import type { CompatDto } from '@agent-hangar/shared';
import type { Settings } from '../../../config/paths.ts';
import { ToolVersions } from '../../../config/readiness.ts';
import { which } from '../../../config/tools.ts';
import { BUILTIN_SUBCOMMANDS, readClaudeHelp, subcommandsFromHelp } from './cli.ts';
import type { CompatLog } from './log.ts';
import type { Drift } from './types.ts';
import { VERIFIED_CLAUDE_VERSION } from './version.ts';

/**
 * claude の場所。run を起こす tmux のペインは hangar の PATH を継ぐので、
 * 裸の `claude` では .app から起こしたときに引けない（PATH は /usr/bin:/bin:/usr/sbin:/sbin だけになる）。
 * 起動と要約の両方が同じ絶対パスを使う。
 */
export function claudeBinOf(s: Pick<Settings, 'claudePath'>): string | null {
  return process.env.HANGAR_CLAUDE_BIN ?? s.claudePath ?? which('claude');
}

export type LocalClaudeDeps = {
  /** いまの claude の場所。設定は書き替わるので、呼ばれた時点の値を読む。 */
  bin: () => string | null;
  /** サーバを閉じたか。閉じた後に届いた裏の読み取りが、消えた置き場に書かないようにする。 */
  closed: () => boolean;
  /** 手元の claude の版の置き場。ずれの記録（CompatLog）が同じものを読む。 */
  version: { current: string | null };
  log: Pick<CompatLog, 'note' | 'setLocalVersion' | 'list'>;
  /**
   * 版の変化でずれの記録を空にしたあと、1 度しか数えない元（登録、アカウントの置き場）から数え直させる。
   * 置き場の項目はサーバの寿命で 1 度、登録は登録が変わったときに 1 度しか数えないので、
   * 数え直さないと、次に起動し直すか登録が変わるまで一覧から消えたままになる。
   * トランスクリプトは新しい行を読むたびに数えるので、何もしなくてよい。
   */
  renote: () => void;
  /** 包みがそのまま渡すサブコマンドを作り直したときに呼ぶ。包みの本体を書き直す。 */
  onSubcommands: (list: readonly string[]) => void;
  /** GET /api/compat の手前で呼ぶ。アカウントの置き場の項目を見直す。 */
  beforeList?: () => void;
  errorLog?: (...a: unknown[]) => void;
};

/**
 * 手元の claude を裏で読む係。版（--version）と、包みがそのまま渡すサブコマンド（--help）を読む。
 * どちらも起動を待たせないよう裏で走らせるので、決して拒否しない（捕まらない拒否は Node ごと落とす）。
 * 待つ間に閉じたか、claude のパスが変わったときは、遅れて届いた古い結果で上書きしない。
 */
export class LocalClaude {
  // 同じファイルなら起こし直さない。
  private readonly versions = new ToolVersions();
  // 最後に claude --help から作り直したときのずれ。読んだ claude のパスと組で持つ。
  private lastSubcommandDrifts: { bin: string | null; drifts: readonly Drift[] } | null = null;
  /** 包みがそのまま渡すサブコマンド。読めるまでは組み込みの一覧である。 */
  subcommands: readonly string[] = BUILTIN_SUBCOMMANDS;

  constructor(private readonly deps: LocalClaudeDeps) {}

  /**
   * 手元の claude の版を読む。ずれの記録の既定の版と、GET /api/compat の手元の版に使う。
   * パスが普通のファイルの下を指すと stat が ENOTDIR で投げるので、読めないもの（null）として扱う。
   * 読めた版はずれの記録にも知らせる。版が変わっていれば記録が空になるので、1 度しか数えない元から数え直す。
   */
  refreshVersion = async (): Promise<string | null> => {
    const bin = this.deps.bin();
    let v: string | null = null;
    try {
      v = bin ? await this.versions.get(bin, ['--version']) : null;
    } catch {
      v = null;
    }
    if (!this.deps.closed() && this.deps.bin() === bin) {
      this.deps.version.current = v;
      if (this.deps.log.setLocalVersion(v)) this.renote(bin);
    }
    return v;
  };

  /** サブコマンドは --help を読んだときに 1 度しか数えないので、同じ claude のぶんはここで数え直す。 */
  private renote(bin: string | null): void {
    const last = this.lastSubcommandDrifts;
    if (last && last.bin === bin) for (const d of last.drifts) this.deps.log.note(d);
    this.deps.renote();
  }

  /**
   * 包みがそのまま渡すサブコマンドを claude --help から作り直し、包みを書き直させる。
   * 読めなければ組み込みの一覧を使う。組み込みとの差は Claude Code との互換のずれとして記録する。
   * 閉じた後に届いたときと、待つ間に claude のパスが変わったときは何もしない（新しいパスの読み取りが書く）。
   */
  refreshSubcommands = async (): Promise<void> => {
    try {
      const bin = this.deps.bin();
      const text = bin ? await readClaudeHelp(bin) : null;
      if (this.deps.closed() || this.deps.bin() !== bin) return;
      const r = subcommandsFromHelp(text);
      for (const d of r.drifts) this.deps.log.note(d);
      this.lastSubcommandDrifts = { bin, drifts: r.drifts };
      this.subcommands = r.subcommands;
      this.deps.onSubcommands(r.subcommands);
    } catch (e) {
      (this.deps.errorLog ?? console.error)('[shell] claude --help からサブコマンドを作り直せませんでした', e instanceof Error ? e.message : e);
    }
  };

  /** Claude Code との互換の一覧。準備の確かめでずれがあるとき、画面が続けて読む。 */
  compat = async (): Promise<CompatDto> => {
    this.deps.beforeList?.();
    return { verifiedVersion: VERIFIED_CLAUDE_VERSION, localVersion: await this.refreshVersion(), drifts: this.deps.log.list() };
  };
}
