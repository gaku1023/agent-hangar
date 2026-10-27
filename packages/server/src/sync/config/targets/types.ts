import type { ConfigApproval, ConfigInboxOp, ConfigItemKind } from '@agent-hangar/shared';
import type { Db } from '../../../db/open.ts';
import type { ApplyOptions, ApplyPlan, ApplyResult, PlannedOp, PlanPaths, PlanReader, WritePaths } from '../apply.ts';
import type { Collected } from '../collect.ts';
import type { ItemRef } from '../ids.ts';

/**
 * 設定の同期の「対象」。Claude、Codex、opencode のように、設定の入れ物ごとに 1 つ持つ。
 * 対象は、自分の id（`owns`）、集め方、書き戻しの見立てと書き方、承認の要否、PC に依る項目の判定を持つ。
 * 3 方向の判定（threeWay.ts）は、id の持ち主の対象を `owns` で決め、その対象を扱う相手の束だけを数える。
 */

/** 集めるときに渡す、この PC の事情。 */
export type TargetContext = {
  db: Db;
  deviceId: string;
  home: string;
  claudeDir: string;
  allowedUnsent: ReadonlyMap<string, string>;
  /** Codex の入れ物（`$CODEX_HOME`、既定 `~/.codex`）。 */
  codexHome: string;
  /** その PC で Codex が有効か（設定の codexEnabled）。切なら Codex の対象は集めない。 */
  codexEnabled: boolean;
  /** opencode の入れ物（`$XDG_CONFIG_HOME/opencode`、既定 `~/.config/opencode`）。 */
  opencodeDir: string;
  /** その PC で opencode が有効か（設定の opencodeEnabled）。 */
  opencodeEnabled: boolean;
  /** 共通の skills の入れ物（`~/.agents/skills`）。 */
  agentsSkillsDir: string;
  /** Claude の `~/.claude.json`。 */
  claudeJsonPath: string;
  /** hangar の settings.json。 */
  hangarSettingsPath: string;
  /** 項目の数の上限。試験が小さくするために使う。 */
  maxItems?: number;
  /** 対象ごとの入切（設定の configTargets）。無い対象は切。 */
  switches?: Readonly<Record<string, boolean>>;
};

/**
 * 書き戻しの入れ物と、控えの世代の置き場。
 * 同じ入れ物に書く対象（claude と claude-hooks など）は、同じ name と backups を持つ。
 */
export type TargetStore = {
  /** 控えを数えるときの名前（hangar config restore --target に渡す名前）。 */
  name: string;
  /** 控えの世代の置き場の名前。`<hangar の置き場>/backups/<backups>/<時刻>/`。 */
  backups: string;
  /** 書く入れ物。 */
  root(o: WritePaths): string;
};

/** id を解いた結果。`ref` は、その対象の項目の指す先。 */
export type ParsedId = { kind: ConfigItemKind; ref: ItemRef };

export interface ConfigTarget {
  /** 対象名。束の目録の `targets` に載る名前で、一度出したら変えない。 */
  readonly name: string;
  /** 枠だけで、まだ何も運ばない対象（placeholder.ts）。束の `targets` に載せない。本物にするときは外す。 */
  readonly placeholder?: true;
  /**
   * その id がこの対象のものか。id の頭だけでなく中身でも決めてよい。
   * 古い版が運ばない項目は、古い版が運ぶ項目と別の対象にする（でないと、古い版の束で消去に見える）。
   * 形の検査はしない（それは parseId）。
   */
  owns(id: string): boolean;
  /** id を解く。形が悪い、運ばない場所を指す、のどれかなら null。 */
  parseId(id: string): ParsedId | null;
  /** この PC がこの対象を集めて送るか。切なら束の `targets` に入れず、この対象の項目は create もしない。 */
  enabled(ctx: TargetContext): boolean;
  /** 手元の項目を集める。読むだけで、何も書かない。 */
  collect(ctx: TargetContext): Collected;
  /** 書き戻しの見立て。何も書かない。 */
  planWrite(o: PlanPaths): ApplyPlan;
  /**
   * 書く先ごとの、書いた後の中身。何も書かない。承認の窓に見せる差分と、書く直前の指紋の元になる。
   * read は、同じファイルを先に書く対象があるときの読み手（そのファイルを読むときは、ディスクでなく read を使う）。
   * 持たない対象の項目は、適用で断る（見せずに書かないため）。
   */
  planOps?(o: WritePaths, read: PlanReader): PlannedOp[];
  /** write が、別の対象の write と同じ項目をまとめて書くときの、その対象名。適用は同じ write を 1 回だけ呼ぶ。 */
  readonly writesWith?: string;
  /** 書き戻しの入れ物と控えの置き場。持たない対象は控えを取らない（hangar の好み）。 */
  readonly store?: TargetStore;
  /** 指示書のとおりに書く。 */
  write(o: ApplyOptions): ApplyResult;
  /** 他の PC から届いた項目の適用に、承認が要るか。 */
  needsApproval(item: { id: string; kind: ConfigItemKind; op: ConfigInboxOp }, approval: ConfigApproval): boolean;
  /** その PC でしか意味を持たない項目か（絶対パスなど）。そうなら送らず、受けても適用しない。 */
  isMachineBound(item: { id: string; kind: ConfigItemKind; content: Buffer }): boolean;
}
