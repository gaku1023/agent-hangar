import type { LaunchPrepAsk, LaunchPrepChoice, LaunchPrepDto, LaunchPrepPhase, LaunchPrepStepDto, Translate } from '@agent-hangar/shared';

/**
 * 起動前の準備（docs/design.md「起動前の準備」）を画面の形にする。
 * 準備の進みは Store が鍵ごとに持つ launch.prep の全体で、ここはそれを 1 行の今の段、済んだ段の一覧、問い、失敗の理由に直す。
 * 経過時間は時計が要るので、ここでは持たず、画面が startedAt から数える（elapsedLabel）。
 */

/** 1 行の今の段。bar は load と reload の間だけ真で、帯の中身は不定である。 */
export type LaunchPrepLine = { text: string; bar: boolean };
/** 問いの答えのボタン。choice は起動の要求に添えて送り直す答えで、primary は主のボタンである。 */
export type LaunchPrepChoiceView = { id: string; label: string; choice: LaunchPrepChoice; primary: boolean };
export type LaunchPrepAskView = { title: string; body: string; hint: string | null; choices: LaunchPrepChoiceView[] };
export type LaunchPrepView = {
  key: string;
  phase: LaunchPrepPhase;
  startedAt: number;
  line: LaunchPrepLine;
  /** 済んだ段（確かめと飛ばした段と失敗した段は載せない）。 */
  done: { id: string; text: string }[];
  /** 利用者に聞くこと。phase が asking のときだけ持つ。 */
  ask: LaunchPrepAskView | null;
  /** 失敗の理由。phase が failed のときだけ持ち、理由が無ければ空の文字列である。 */
  failure: string | null;
};

const GB = 1024 ** 3;
const gb = (bytes: number): string => `${(bytes / GB).toFixed(1)} GB`;

/** コンテキスト長。65536 は 64K。分からなければ ?。 */
export const contextLabel = (n: number | null): string => (n === null ? '?' : `${Math.round(n / 1024)}K`);

/** 経過時間（m:ss）。 */
export function elapsedLabel(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** 段の進行中の文。run（接続先の準備のコマンド）は今回の画面に文が無いので、起動中の文で受ける。 */
function lineOf(s: LaunchPrepStepDto | undefined, t: Translate): LaunchPrepLine {
  if (!s) return { text: t('launchPrep.step.starting'), bar: false };
  const context = contextLabel(s.toContext);
  switch (s.action) {
    case 'check': return { text: t('launchPrep.step.check'), bar: false };
    case 'load': return { text: t('launchPrep.step.load', { model: s.target, context }), bar: true };
    case 'reload': return { text: t('launchPrep.step.reload', { model: s.target, context }), bar: true };
    case 'unload': return { text: t('launchPrep.step.unload', { model: s.target }), bar: false };
    default: return { text: t('launchPrep.step.starting'), bar: false };
  }
}

/** 済んだ段の文。確かめと run は、一覧に載せる文が無いので null。 */
function doneOf(s: LaunchPrepStepDto, t: Translate): string | null {
  const time = elapsedLabel((s.endedAt ?? s.startedAt) - s.startedAt);
  switch (s.action) {
    case 'load': return t('launchPrep.done.load', { model: s.target, context: contextLabel(s.toContext), time });
    case 'reload': return t('launchPrep.done.reload', { model: s.target, from: contextLabel(s.fromContext), to: contextLabel(s.toContext), time });
    case 'unload': return t('launchPrep.done.unload', { model: s.target });
    default: return null;
  }
}

const skipChoice = (t: Translate): LaunchPrepChoiceView => ({ id: 'skip', label: t('launchPrep.ask.skip'), choice: { skip: true }, primary: false });

/**
 * 問いを画面の形にする。model は起動の要求のモデル（provider/model）で、1 つに寄せる答えの provider を取る。無ければそのボタンは出さない。
 * 手で載せたモデルが求めたモデルと同じものだけなら再ロード、別のモデルがあればアンロードしてロードを聞く。外してよい instance は全部送る。
 */
function askOf(a: LaunchPrepAsk, t: Translate, model: string | null): LaunchPrepAskView {
  if (a.kind === 'unload-manual') {
    const reload = a.blocking.length > 0 && a.blocking.every((b) => b.model === a.model);
    const unload = a.blocking.map((b) => b.instanceId);
    const want = contextLabel(a.want);
    if (reload) {
      return {
        title: t('launchPrep.ask.reload.title', { model: a.model, want }),
        body: t('launchPrep.ask.reload.body', { context: contextLabel(a.blocking[0]!.context), want }),
        hint: null,
        choices: [{ id: 'unload', label: t('launchPrep.ask.reload.ok'), choice: { unload }, primary: true }, skipChoice(t)],
      };
    }
    const models = [...new Set(a.blocking.map((b) => b.model))].join(t('common.list.separator'));
    return {
      title: t('launchPrep.ask.unload.title', { models }),
      body: t('launchPrep.ask.unload.body', { models, model: a.model }),
      hint: null,
      choices: [{ id: 'unload', label: t('launchPrep.ask.unload.ok'), choice: { unload }, primary: true }, skipChoice(t)],
    };
  }
  const name = (u: string) => (u === '$session' ? t('launchPrep.ask.memory.session') : u === '$small' ? 'small_model' : u);
  const list = a.models.map((m) => t('launchPrep.ask.memory.item', { uses: m.uses.map(name).join(t('common.list.separator')), model: m.model, size: gb(m.sizeBytes) })).join(t('common.list.separator'));
  const single: LaunchPrepChoiceView[] = a.suggestRef.indexOf('/') > 0 ? [{ id: 'single', label: t('launchPrep.ask.memory.ok', { model: a.suggest }), choice: { singleModel: a.suggestRef }, primary: true }] : [];
  return {
    title: t('launchPrep.ask.memory.title'),
    body: t('launchPrep.ask.memory.body', { list, total: gb(a.totalBytes), limit: gb(a.limitBytes) }),
    hint: t('launchPrep.ask.memory.hint'),
    choices: [...single, skipChoice(t)],
  };
}

export function presentLaunchPrep(prep: LaunchPrepDto, t: Translate, model: string | null): LaunchPrepView {
  const running = prep.steps.find((s) => s.state === 'running');
  return {
    key: prep.key,
    phase: prep.phase,
    startedAt: prep.startedAt,
    line: lineOf(running, t),
    done: prep.steps.flatMap((s) => {
      if (s.state !== 'done') return [];
      const text = doneOf(s, t);
      return text === null ? [] : [{ id: s.id, text }];
    }),
    ask: prep.phase === 'asking' && prep.ask ? askOf(prep.ask, t, model) : null,
    failure: prep.phase === 'failed' ? prep.reason ?? '' : null,
  };
}
