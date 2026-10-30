/**
 * 起動前の準備（docs/design.md「起動前の準備」）。opencode の会話を起こす前に hangar が走らせる段の進みである。
 * 段は 2 種類。local-model は LM Studio のモデルを足りる長さで載せる段、command は接続先の準備のコマンドを走らせる段。
 * 画面は起動のたびに作る鍵（key）で進みを受け取る。鍵は起動の要求（LaunchParams.prepKey）に添えて送る。
 */
export type LaunchPrepPhase = 'running' | 'ready' | 'failed' | 'asking' | 'cancelled';
export type LaunchPrepStepKind = 'local-model' | 'local-server' | 'command';
export type LaunchPrepStepState = 'running' | 'done' | 'skipped' | 'failed';
/** local-model の段で行うこと。check は確かめるだけ、load は載せる、reload は外して載せ直す、unload は外す。command は run。 */
export type LaunchPrepAction = 'check' | 'load' | 'reload' | 'unload' | 'run' | 'server-start';

export type LaunchPrepStepDto = {
  id: string;
  kind: LaunchPrepStepKind;
  /** モデルの名前（local-model）か、接続先の名前（command）。 */
  target: string;
  action: LaunchPrepAction;
  state: LaunchPrepStepState;
  /** 載っていた長さと、載せる長さ。local-model の load と reload だけが持つ。 */
  fromContext: number | null;
  toContext: number | null;
  startedAt: number;
  endedAt: number | null;
  /** 失敗の理由。長さを切ってある。 */
  reason: string | null;
};

/** 手で載せたモデル（hangar が載せていないもの）の 1 つ。 */
export type LaunchPrepInstance = { instanceId: string; model: string; sizeBytes: number | null; context: number | null };

/**
 * 準備が止まって、利用者に 1 問だけ聞くこと。
 * unload-manual：手で載せたモデル（同じモデルが短い長さで載っているものを含む）を外さないと載らない。外すかを聞く。
 * memory：会話と agent が別々のモデルを使う設定で、合わせるとメモリに収まらない。1 モデルに寄せるかを聞く（既定の案内）。
 * suggest は勧めるモデル（LM Studio の名前）、suggestRef はその opencode の指定（`provider/model`、答えの singleModel に入れる）。
 * uses は、そのモデルを使う agent の名前。会話の既定のモデルは '$session'、opencode の small_model は '$small' と書く。
 */
export type LaunchPrepAsk =
  | { kind: 'unload-manual'; model: string; want: number; blocking: LaunchPrepInstance[] }
  | { kind: 'memory'; models: { model: string; uses: string[]; sizeBytes: number }[]; totalBytes: number; limitBytes: number; suggest: string; suggestRef: string };

/**
 * 問いへの答え。起動の要求（LaunchParams.prepChoice）に添えて送り直す。
 * skip は準備をせずに始める。unload は外してよい手で載せたもの（instanceId）。singleModel は、会話と全部の agent をこのモデルに寄せる。
 */
export type LaunchPrepChoice = { skip?: boolean; unload?: string[]; singleModel?: string };

export type LaunchPrepDto = {
  key: string;
  phase: LaunchPrepPhase;
  startedAt: number;
  endedAt: number | null;
  steps: LaunchPrepStepDto[];
  ask: LaunchPrepAsk | null;
  /** 失敗の理由（phase が failed のとき）。 */
  reason: string | null;
};

/** 準備で問いが出て起動を止めたときの 409 の本文の code。画面は届いている進み（ask）を読んで問いを出す。 */
export const LAUNCH_PREP_ASK_CODE = 'prep-ask';
/** 利用者が準備をやめたときの code。 */
export const LAUNCH_PREP_CANCELLED_CODE = 'prep-cancelled';

/** 届いた答えを読む。形の違う項目は捨てる。 */
export function prepChoiceOf(v: unknown): LaunchPrepChoice {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const r = v as Record<string, unknown>;
  const unload = Array.isArray(r.unload) ? r.unload.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 300).slice(0, 20) : [];
  return {
    ...(r.skip === true ? { skip: true } : {}),
    ...(unload.length ? { unload } : {}),
    ...(typeof r.singleModel === 'string' && r.singleModel.indexOf('/') > 0 && r.singleModel.length <= 300 ? { singleModel: r.singleModel } : {}),
  };
}

/** 起動の鍵の形。画面が作る。長すぎるものと、使えない字を含むものは受けない。 */
export const isLaunchPrepKey = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(v);

/** ローカルのモデルを載せる長さの既定（設定の opencodeLocalContext）。 */
export const DEFAULT_LOCAL_CONTEXT = 65_536;
/** 設定で選べる長さ。 */
export const LOCAL_CONTEXT_CHOICES = [32_768, 65_536, 131_072] as const;
export const isLocalContext = (v: unknown): v is number => typeof v === 'number' && (LOCAL_CONTEXT_CHOICES as readonly number[]).includes(v);
/** 設定の長さ。項目が無いか形が違えば既定。 */
export const localContextOf = (s: { opencodeLocalContext?: number }): number => (isLocalContext(s.opencodeLocalContext) ? s.opencodeLocalContext : DEFAULT_LOCAL_CONTEXT);

/** 使っていないローカルのモデルを外すまでの分の既定（設定の opencodeIdleUnload）。 */
export const DEFAULT_IDLE_UNLOAD = 5;
/** 設定で選べる分。0 は外さない（しない）で、スライダーの右端に置く。 */
export const IDLE_UNLOAD_CHOICES = [1, 3, 5, 10, 15, 30, 60, 0] as const;
export const isIdleUnload = (v: unknown): v is number => typeof v === 'number' && (IDLE_UNLOAD_CHOICES as readonly number[]).includes(v);
/** 設定の分。項目が無いか形が違えば既定。 */
export const idleUnloadOf = (s: { opencodeIdleUnload?: number }): number => (isIdleUnload(s.opencodeIdleUnload) ? s.opencodeIdleUnload : DEFAULT_IDLE_UNLOAD);
