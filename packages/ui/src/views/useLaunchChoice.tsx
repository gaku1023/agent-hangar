import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { AGENT_UI_CAPS, DEFAULT_AGENT_KIND, defaultOpencodeMode, DEFAULT_CODEX_PERMISSION, isAgentKind, type AgentValue, type CodexPermission, type LaunchParams, type NewSessionSeed, type ProjectPlace, type ScheduleTarget } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { LaunchPrefs } from '../mediator/types.ts';
import { codexAgentNote, codexEffortChoice, codexEffortsOf, codexModelChoice } from '../presenters/codexLaunch.ts';
import { accountChoice, accountOptions, opencodeAgentNote, opencodeModelChoice, SCRATCH_CHOICE, type LaunchChoiceData } from '../presenters/newSession.ts';
import { STATUS_LABEL } from '../presenters/format.ts';
import { agentOnlyAttr, enterAgent, leaveAgent, type AgentSwapSnapshot } from './agentSwap.ts';
import { LaunchChips, type LaunchChipValues } from './LaunchChips.tsx';
import { CodexFullAccessNote } from './CodexFullAccessNote.tsx';
import { OpencodeModelResetNote } from './OpencodeModelResetNote.tsx';
import { boldFirst, inspectOf } from './folderNote.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { isMacClient } from '../keys.ts';
import { baseName, joinPath } from '../lib/paths.ts';
import { Listbox } from './primitives/Listbox.tsx';
import type { ListboxAction, ListboxOption } from './primitives/listboxModel.ts';
import { CheckCard } from './primitives/OptionCard.tsx';
import { PERMISSION_BYPASS } from './primitives/permissionModel.ts';
import { ParentField, parentReady } from './ParentField.tsx';

/** プロジェクトの一覧の先頭に置くクイックセッションの行。値はプロジェクトの id と重ならず、クイックセッションの前回値の鍵と同じ綴りである。 */
const SCRATCH = SCRATCH_CHOICE;
/** 新しいフォルダの行の値。プロジェクトの id ともクイックセッションとも重ならない。行は顔にだけ使い、一覧には並べない。 */
const NEW_DIR = ':new';
/** 既存のフォルダ（未登録と Finder）の行の値の頭。後ろにパスを付ける。 */
const DIR = ':dir:';
const isDir = (v: string) => v.startsWith(DIR);

/** 札で決める値（名前を除く）。追加ディレクトリは欄のまま 1 行 1 つの文字で持つ。 */
type Options = { model: string; effort: string; permissionMode: string; worktree: string; addDirs: string };
/** 既定の札の値。モデルは設定の既定のモデル（空は Claude Code の既定）。 */
const defaultOptions = (model: string): Options => ({ model, effort: '', permissionMode: '', worktree: '', addDirs: '' });
/** 前回値から札の値を作る。前回値にモデルが無ければ、設定の既定のモデルを入れる（前回値が先）。 */
const optionsOf = (p: LaunchPrefs | undefined, defaultModel: string): Options => ({ model: p?.model ?? defaultModel, effort: p?.effort ?? '', permissionMode: p?.permissionMode ?? '', worktree: p?.worktree ?? '', addDirs: p?.addDirs?.join('\n') ?? '' });
const dirsOf = (text: string): string[] => text.split('\n').map((d) => d.trim()).filter(Boolean);
const sameOptions = (a: Options, b: Options): boolean => a.model.trim() === b.model.trim() && a.effort === b.effort && a.permissionMode === b.permissionMode && a.worktree.trim() === b.worktree.trim() && dirsOf(a.addDirs).join('\n') === dirsOf(b.addDirs).join('\n');
/** 同じファイルの編集の警告から開いたときの worktree の名前。時刻から作り、開くたびに替える。 */
const freshWorktreeName = (): string => `parallel-${Date.now().toString(36).slice(-6)}`;
/** 既定でない値が 1 つでもあるか。「前回と同じ」は、既定だけの前回値には出さない。 */
const hasNonDefault = (o: Options): boolean => !!(o.model.trim() || o.effort || o.permissionMode || o.worktree.trim() || dirsOf(o.addDirs).length);

/** 予定の「新しい会話」の送り先。 */
export type ScheduleNewTarget = Extract<ScheduleTarget, { kind: 'new' }>;

/**
 * 予定の保存のための値の取り方。
 * target を渡すと、その値を札の初めの値にする（作るときは null）。
 * 札は、利用者が決めた値だけを target に載せる（モードと Codex の推論と権限、opencode の自動承認は、決めていなければ載せない）。
 * 古い形の予定を開いて何も触らずに保存しても、値が増えない。
 */
export type LaunchScheduleOpts = { target: ScheduleNewTarget | null };

export type LaunchChoiceOpts = {
  /** 札の中身。起動のダイアログは自分の props をそのまま渡す。予定は prefs を空にして、前回値を持ち込まない。 */
  data: LaunchChoiceData;
  /** 起動のダイアログが開いたときの選択。 */
  projectId?: string | null;
  scratch?: boolean;
  dir?: string | null;
  /** worktree の札に新しい名前を入れて開く。 */
  freshWorktree?: boolean;
  /** 開く経路が決めたエージェント。 */
  agent?: 'opencode';
  /** opencode のモデルの小窓を開いた状態で出す。 */
  pickModel?: boolean;
  /** 埋めて開いたときの種。アカウントと元の会話の設定だけを使う。 */
  seed?: Pick<NewSessionSeed, 'accounts' | 'settings'> | null;
  /** 名前の初めの値（下書きから）。 */
  name?: string;
  /** 予定のフォームで使うとき。 */
  schedule?: LaunchScheduleOpts;
  /** 利用者がプロジェクトを選び直したとき。 */
  onChoose?: () => void;
};

export type LaunchBuilt = { params: LaunchParams; place?: ProjectPlace };

/** 札の値から予定の target を作る。登録が要るフォルダ（place）のときは、projectId は登録の後に差し替えるので空にする。 */
export function scheduleTargetOf(params: LaunchParams): ScheduleNewTarget {
  const { prompt: _prompt, prepKey: _prepKey, prepChoice: _prepChoice, projectId, scratch, agent, ...rest } = params;
  return {
    kind: 'new', projectId: scratch ? null : projectId ?? '',
    ...(scratch ? { scratch: true as const } : {}),
    ...(agent && agent !== DEFAULT_AGENT_KIND ? { agent } : {}),
    ...rest,
  };
}

/**
 * 起動の札の組み立て。新しいセッションのダイアログと予定のフォームが同じものを使う。
 * プロジェクトの札（検索、まとまり、クイックセッション、未登録のフォルダ、新しいフォルダ、Finder）、エージェント、アカウント（2 件以上のときだけ）、
 * Claude Code、Codex、opencode の各札と、選んだフォルダの 1 行の説明までを持つ。
 * 値はすべてここの状態で、build が選んだ値から起動の params と、登録が要るフォルダの place を作る。
 * 初期プロンプト、添付、下書き、起動前の準備は呼び手のものである。
 */
export function useLaunchChoice(o: LaunchChoiceOpts) {
  const emit = useEmit();
  const t = useT();
  const data = o.data;
  const initial = o.schedule?.target ?? null;
  const scheduling = o.schedule !== undefined;
  const [choice, setChoice] = useState(() => {
    // 予定は、保存した場所をそのまま選んでおく。プロジェクトが一覧に無くても、黙って別の場所に替えない。
    if (initial) return initial.cwd ? DIR + initial.cwd : initial.scratch || initial.projectId === null ? SCRATCH : initial.projectId;
    // 作成のダイアログから、登録済みのプロジェクトの下のフォルダで始めるときは、そのフォルダを選んでおく（0.6.1）。
    if (o.dir) return DIR + o.dir;
    // サーバも scratch を projectId より優先する。選んでいない（一覧に無い id を含む）ときはクイックセッションである。
    if (o.scratch) return SCRATCH;
    return o.projectId && data.projects.some((p) => p.id === o.projectId) ? o.projectId : SCRATCH;
  });
  const scratch = choice === SCRATCH;
  const newDir = choice === NEW_DIR;
  const dirPath = isDir(choice) ? choice.slice(DIR.length) : null;
  // 未登録の一覧に載っているのはプロジェクトの親フォルダ直下のフォルダだけなので、載っていなければ外か深い階層である。
  const outside = dirPath !== null && !data.dirs.some((d) => d.path === dirPath);
  // 作成場所（設定）が空のときに選ぶ、新しいフォルダを作る場所（2026-10-13）。
  const [parent, setParent] = useState('');
  const rootless = data.workspaceRoot === '';
  // 作る場所。作成場所が空なら選んだ場所で、設定が届く前は仮の場所にする。区切りは画面の OS に合わせる。
  const root = rootless ? parent.trim() : data.workspaceRoot ?? joinPath('~', 'workspace');
  // 選んだフォルダの事前の問い合わせ（0.6.1、試作の 6 と 7 の A）。
  // 登録済みのプロジェクトの下なら、既定は包むプロジェクトのセッションとしてそのフォルダで起こす（利用者の答え）。「別のプロジェクトにする」で分けて登録する。
  // ほかの PC から届いた同じプロジェクトがあれば、既定はそれに結び付けて始める。「新しく作る」で新しいプロジェクトにする。
  // 切り替えは選んだフォルダごとで、フォルダを選び直したら既定に戻る。
  const { data: inspected, loading: inspecting } = inspectOf(data.inspect, dirPath);
  const [splitAt, setSplitAt] = useState<string | null>(null);
  const [linkNewAt, setLinkNewAt] = useState<string | null>(null);
  const enclosing = inspected && !inspected.registered ? inspected.enclosing : null;
  const nested = enclosing !== null && splitAt !== dirPath ? enclosing : null;
  const link = !enclosing && inspected && !inspected.registered ? inspected.link : null;
  const linking = link !== null && linkNewAt !== dirPath ? link : null;
  const linkWho = link ? (link.deviceName ? t('newSession.dir.linkWho', { device: link.deviceName, name: link.name }) : link.name) : '';
  // 札の値の前回値を引く鍵。包むプロジェクトで始めるときは、そのプロジェクトの前回値を使う。
  const prefKey = nested ? nested.projectId : choice;
  // 作成場所が空で、新しいフォルダを作る場所をまだ選んでいなければ起動できない。
  // 選んだフォルダの事前の問い合わせを待つ間も起動できない（包むプロジェクトで起こすか、登録するかが決まらないため）。
  const blocked = (newDir && !parentReady(data.workspaceRoot, parent)) || inspecting;
  const titleKey = newDir ? 'newSession.title.newDir' as const : dirPath && !nested && !linking ? 'newSession.title.dir' as const : 'newSession.title.default' as const;
  // 新しいフォルダの名前と git init。名前は「『語』を新しいフォルダとして作る」で選んだときの語を入れる。
  const [newName, setNewName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  // Finder で選んだ、未登録の一覧に無いフォルダ（親フォルダの外か深い階層）。行を持たないので、ここで覚えて行を足す。
  const startDir = initial?.cwd ?? o.dir ?? null;
  const [extraDir, setExtraDir] = useState<string | null>(() => (startDir && !data.dirs.some((d) => d.path === startDir) ? startDir : null));
  // 開いた時点の Finder の回数。これより新しい結果だけを使う。別のダイアログで選んだ結果が当たらないようにするためである。
  const pickedAtOpen = useRef(data.picked?.n ?? 0);
  // @ の候補はプロジェクトのフォルダを探すので、クイックセッションとパスの無いプロジェクトでは渡さない。/ の候補は自分のスキルだけになる。
  const assistProject = scratch || !choice ? null : data.projects.find((p) => p.id === prefKey)?.path ? prefKey : null;
  const [name, setName] = useState(initial?.name ?? o.name ?? '');
  // 札の値の初期値は、選んだプロジェクトの前回値にする（D1）。
  // 利用者が札に触れる前にプロジェクトを選び直したら、そのプロジェクトの前回値に入れ替える。触れた後は、自分で選んだ値を残す。
  // 同じファイルの編集の警告から開いたときは、worktree の札に新しい名前を入れておく。前の worktree の中で起動しないよう、開くたびに名前を替える。
  // 前回値が無いときのモデルは、設定の既定のモデル（1d）。予定は既定のモデルを予定に固めず、空（既定）から始める。
  const defaultModel = scheduling ? '' : data.defaultModel ?? '';
  // 「同じ設定で新しいセッション…」で開いたときは、前回値でなく元の会話の値を入れ、触れた後と同じに扱う（プロジェクトを選び直しても残す）。worktree は名前が重なるので引き継がない。
  const seed = o.seed ?? null;
  const seeded = seed?.settings ?? null;
  const [detail, setDetail] = useState((): Options => {
    if (initial) {
      const claude = (initial.agent ?? DEFAULT_AGENT_KIND) === DEFAULT_AGENT_KIND;
      return claude ? { model: initial.model ?? '', effort: initial.effort ?? '', permissionMode: initial.permissionMode ?? '', worktree: initial.worktree ?? '', addDirs: initial.addDirs?.join('\n') ?? '' } : defaultOptions('');
    }
    if (seeded) return { ...defaultOptions(seeded.agent === DEFAULT_AGENT_KIND ? seeded.model ?? defaultModel : defaultModel), ...(seeded.agent === DEFAULT_AGENT_KIND ? { effort: seeded.effort ?? '', permissionMode: seeded.permissionMode ?? '', addDirs: seeded.addDirs.join('\n') } : {}) };
    return o.freshWorktree ? { ...optionsOf(data.prefs[choice], defaultModel), worktree: freshWorktreeName() } : optionsOf(data.prefs[choice], defaultModel);
  });
  const [touched, setTouched] = useState(o.freshWorktree === true || seeded !== null || initial !== null);
  const choose = (value: string) => {
    setChoice(value);
    lastPrefKey.current = value;
    o.onChoose?.();
    if (touched) return;
    setDetail(optionsOf(data.prefs[value], defaultModel));
  };
  useEffect(() => {
    const p = data.picked;
    if (!p || p.n <= pickedAtOpen.current) return;
    pickedAtOpen.current = p.n;
    // 作成場所が空で新しいフォルダを作っているときの Finder は、作る場所を選ぶもの（ParentField が受ける）。
    if (rootless && newDir) return;
    const known = data.projects.find((x) => x.path === p.path);
    if (known) { choose(known.id); return; }
    if (!data.dirs.some((d) => d.path === p.path)) setExtraDir(p.path);
    choose(DIR + p.path);
  }, [data.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 既存のフォルダを選んだら、事前の問い合わせを頼む（答えは data.inspect に届く）。
  useEffect(() => {
    if (dirPath) emit({ type: 'folder.inspect', path: dirPath });
  }, [dirPath]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 登録済みのプロジェクトのフォルダだった（綴りの違いで一覧と当たらなかった）なら、そのプロジェクトを選ぶ。
  const registeredId = inspected?.registered?.projectId ?? null;
  useEffect(() => {
    if (registeredId && data.projects.some((p) => p.id === registeredId)) choose(registeredId);
  }, [registeredId]);   // eslint-disable-line react-hooks/exhaustive-deps
  // 前回値を引く鍵が変わったら（包むプロジェクトの答えが届いた、「別のプロジェクトにする」を押した）、札に触れる前ならその前回値に入れ替える。
  const lastPrefKey = useRef(choice);
  useEffect(() => {
    if (lastPrefKey.current === prefKey) return;
    lastPrefKey.current = prefKey;
    if (!touched) setDetail(optionsOf(data.prefs[prefKey], defaultModel));
  }, [prefKey]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 作れた後に起動だけが失敗した。押し直しで二重に作らないよう、作ったプロジェクトを選び直す。
    if (data.createdProjectId) setChoice(data.createdProjectId);
  }, [data.createdProjectId]);
  const resetDetail = () => { setTouched(true); setDetail(defaultOptions(defaultModel)); };
  const { model, effort, permissionMode, worktree, addDirs } = detail;
  // アカウントは、利用者が選んだ id だけを覚える。選んでいなければ、いまのアカウント（選べなければ選べる最初の 1 件）。
  // 選んだ id が一覧から消えたとき、選べなくなったときも、同じ規則でいまのアカウントへ戻る。
  // Claude Code と Codex は別のアカウントの組なので、選んだ id もエージェントごとに覚える（Claude で選んだものを Codex に持ち込まない）。
  // 埋めて開いたときは、種のアカウント（エラーに絡まず壊れていないもの）を選んでおく。予定は保存した id を選んでおく。
  const [pickedAccount, setPickedAccount] = useState<string | null>((initial && (initial.agent ?? DEFAULT_AGENT_KIND) === DEFAULT_AGENT_KIND ? initial.account : undefined) ?? seed?.accounts?.['claude-code'] ?? null);
  const [pickedCxAccount, setPickedCxAccount] = useState<string | null>((initial?.agent === 'codex' ? initial.account : undefined) ?? seed?.accounts?.codex ?? null);
  // エージェント。利用者が選んだものだけを覚え、選んでいなければプロジェクトの前回値（無ければ Claude Code）。設定で無効なら、いつも Claude Code。
  const oc = data.opencode ?? null;
  const cx = data.codex ?? null;
  // 一覧に並べるエージェントは、設定で有効にしたものだけ（Claude Code は常に）。前回のエージェントが無効になっていたら Claude Code で開く。
  const offered: AgentValue[] = [DEFAULT_AGENT_KIND, ...(cx ? (['codex'] as const) : []), ...(oc ? (['opencode'] as const) : [])];
  // 開く経路が決めたエージェント（起動後の札の「別のモデルでやり直す」は opencode）。一覧に無ければ前回の値に任せる。
  const openAgent = initial?.agent ?? o.agent ?? seeded?.agent;
  const [pickedAgent, setPickedAgent] = useState<AgentValue | null>(openAgent && offered.includes(openAgent) ? openAgent : null);
  const remembered = data.prefs[prefKey]?.agent;
  const chosenAgent = pickedAgent ?? remembered;
  const agent: AgentValue = isAgentKind(chosenAgent) && offered.includes(chosenAgent) ? chosenAgent : DEFAULT_AGENT_KIND;
  const opencode = agent === 'opencode';
  const codex = agent === 'codex';
  const caps = AGENT_UI_CAPS[agent];
  // いまのエージェントのアカウントの組（opencode は無し）。2 件未満なら null で、札も params.account も出さない。
  const accountSet = !caps.accounts ? null : codex ? data.codexAccounts ?? null : data.accounts;
  const account = accountSet ? accountChoice(accountSet, codex ? pickedCxAccount : pickedAccount) : null;
  // 既存の予定の編集では、アカウントの札に触れない限り、元の target の account をそのまま保つ（無ければ無いまま、一覧から消えた id も黙って替えない）。エージェントを替えたら、組が違うので札の値に従う。
  const [accountTouched, setAccountTouched] = useState(false);
  const keepAccount = initial !== null && !accountTouched && caps.accounts && (initial.agent ?? DEFAULT_AGENT_KIND) === agent;
  const pickAccount = (v: string) => { setAccountTouched(true); (codex ? setPickedCxAccount : setPickedAccount)(v); };
  // opencode の一覧を聞く場所。opencode.json の重なりが場所で変わるので、起こす場所で聞く。新しいフォルダとクイックセッションはホームで聞く。
  const ocDir = dirPath ?? (scratch || newDir ? null : data.projects.find((p) => p.id === choice)?.path ?? null);
  const ocState = oc?.options && oc.options.dir === ocDir ? oc.options : null;
  const ocData = ocState?.data ?? null;
  useEffect(() => { if (opencode) emit({ type: 'opencode.options', dir: ocDir }); }, [opencode, ocDir]);   // eslint-disable-line react-hooks/exhaustive-deps
  // モードは選んだものが一覧にあればそれ、無ければ一覧の既定（build）。一覧が届く前は空（params に載せず、opencode の既定に任せる）。
  const seededOc = seeded?.agent === 'opencode' ? seeded : null;
  const seededCx = seeded?.agent === 'codex' ? seeded : null;
  const [pickedMode, setPickedMode] = useState<string | null>((initial?.agent === 'opencode' ? initial.mode : undefined) ?? seededOc?.mode ?? null);
  const ocMode = pickedMode !== null && (!ocData || ocData.modes.some((m) => m.id === pickedMode)) ? pickedMode : ocData ? defaultOpencodeMode(ocData.modes) : '';
  // モデルは選んだもの、選んでいなければ前回値。一覧から消えていたらデフォルトに戻す。
  const [pickedModel, setPickedModel] = useState<string | null>((initial?.agent === 'opencode' ? initial.model : undefined) ?? seededOc?.model ?? null);
  const ocRemembered = pickedModel ?? data.prefs[prefKey]?.opencodeModel ?? '';
  const ocModel = opencodeModelChoice(ocRemembered, ocData);
  // Codex。モデルと推論は選んだもの、選んでいなければ前回値。一覧から消えたモデルはデフォルトに戻し、そのモデルで選べない推論は medium に戻す。権限は毎回自動から始める（前回値に残さない）。
  const cxState = cx?.options ?? null;
  const cxData = cxState?.data ?? null;
  useEffect(() => { if (codex) emit({ type: 'codex.options' }); }, [codex]);   // eslint-disable-line react-hooks/exhaustive-deps
  const initialCx = initial?.agent === 'codex' ? initial : null;
  const [pickedCxModel, setPickedCxModel] = useState<string | null>(initialCx?.model ?? seededCx?.model ?? null);
  const cxModel = codexModelChoice(pickedCxModel ?? data.prefs[prefKey]?.codexModel ?? '', cxData);
  const [pickedCxEffort, setPickedCxEffort] = useState<string | null>(initialCx?.effort ?? seededCx?.effort ?? null);
  const cxEffort = codexEffortChoice(pickedCxEffort ?? data.prefs[prefKey]?.codexEffort ?? '', cxData, cxModel);
  // 複製でも、フルアクセスは黙って引き継がない（権限は毎回自動から始める決まりの、広い側だけを守る）。予定は保存した値をそのまま戻す。
  const initialCxPermission = initialCx?.permissionMode === 'read-only' || initialCx?.permissionMode === 'auto' || initialCx?.permissionMode === 'full-access' ? initialCx.permissionMode : null;
  const [cxPermission, setCxPermissionNow] = useState<CodexPermission>(initialCxPermission ?? (seededCx?.permissionMode === 'read-only' ? 'read-only' : DEFAULT_CODEX_PERMISSION));
  // 予定では、権限を決めたか。決めていなければ target に載せない。
  const [cxPermissionSet, setCxPermissionSet] = useState(initialCxPermission !== null);
  const setCxPermission = (v: CodexPermission) => { setCxPermissionNow(v); setCxPermissionSet(true); };
  // モデルを替えて、選んでいる推論がそのモデルで選べなくなったら、その場で medium（無ければそのモデルの既定）に戻す。
  const pickCxModel = (v: string) => {
    setPickedCxModel(v);
    setPickedCxEffort(codexEffortChoice(cxEffort, cxData, v));
  };
  // 戻したことの注記（M1）は ✕ で閉じられる。閉じたら、このダイアログの間は出さない。
  const [resetNoteClosed, setResetNoteClosed] = useState(false);
  // 自動承認は毎回オフから始める（前回値に残さない）。予定は保存した値から始める。
  const [autoApprove, setAutoApprove] = useState(initial?.autoApprove === true);
  // 切り替えの動き（M1）。消える札を薄れさせてから入れ替え、入れ替えた後の描画で残る札を滑らせ、新しい札を入れる。
  const chipsRef = useRef<HTMLDivElement>(null);
  const swap = useRef<{ snap: AgentSwapSnapshot; to: AgentValue } | null>(null);
  const switchAgent = async (to: AgentValue) => {
    if (to === agent) return;
    const box = chipsRef.current?.closest<HTMLElement>('.dialog, .sch-form');
    if (box) swap.current = { snap: await leaveAgent(box, agent), to };
    setPickedAgent(to);
  };
  useLayoutEffect(() => {
    const s = swap.current;
    if (!s || s.to !== agent) return;
    swap.current = null;
    enterAgent(s.snap, agent);
  }, [agent]);
  // 開いたときに 1 回、認証と使用量を読み直させる。
  const hasAccounts = data.accounts !== null || (data.codexAccounts ?? null) !== null;
  useEffect(() => { if (hasAccounts) emit({ type: 'accounts.load' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** 選んだ値から、起動の params（初期プロンプトと準備の鍵を除く）と、登録が要るフォルダの place を作る。 */
  const build = (): LaunchBuilt => {
    const params: LaunchParams = {};
    let place: ProjectPlace | undefined;
    // クイックセッションはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (scratch) params.scratch = true;
    // 新しいフォルダと未登録のフォルダは、Mediator がプロジェクトを作ってから起動する。
    else if (newDir) place = { kind: 'newDir', name: newName.trim(), gitInit, ...(rootless ? { parent: parent.trim() } : {}) };
    // 登録済みのプロジェクトの下のフォルダは、包むプロジェクトのセッションとして、そのフォルダで起こす（cwd は前回値に残さない）。
    else if (nested && dirPath) { params.projectId = nested.projectId; params.cwd = dirPath; }
    // 分けると決めたら allowNested、ほかの PC のプロジェクトに結び付けるなら linkTo を添えて登録してから起動する。
    else if (dirPath) place = { kind: 'dir', path: dirPath, ...(enclosing ? { allowNested: true } : {}), ...(linking ? { linkTo: linking.projectId } : {}) };
    else if (choice) params.projectId = choice;
    // 開いてから送るまでにいまのアカウントが変わっても、選んだとおりに起こすため、いまのアカウントと同じでも入れる。
    // opencode にはアカウントを効かせない（サーバも断る）。
    if (keepAccount) { if (initial.account !== undefined) params.account = initial.account; }
    else if (account !== null) params.account = account;
    if (name.trim()) params.name = name.trim();
    // Codex は、エージェント、モデル、推論、権限の 3 段だけを渡す。Claude Code だけの値は載せない（サーバが断る）。モデルが空（デフォルト）なら載せない。
    if (codex) {
      params.agent = agent;
      if (cxModel) params.model = cxModel;
      if (!scheduling || pickedCxEffort !== null) params.effort = cxEffort;
      if (!scheduling || cxPermissionSet) params.permissionMode = cxPermission;
      return { params, ...(place ? { place } : {}) };
    }
    // opencode は、エージェント、モード（POST の agent）、モデル（provider/model）、自動承認（--auto）だけを渡す。Claude Code だけの値は載せない（サーバが断る）。
    if (opencode) {
      params.agent = agent;
      if (scheduling ? pickedMode !== null && ocMode : ocMode) params.mode = ocMode;
      if (ocModel.model) params.model = ocModel.model;
      if (!scheduling || autoApprove) params.autoApprove = autoApprove;
      return { params, ...(place ? { place } : {}) };
    }
    if (model.trim()) params.model = model.trim();
    if (effort) params.effort = effort;
    if (permissionMode) params.permissionMode = permissionMode;
    if (worktree.trim()) params.worktree = worktree.trim();
    const dirs = dirsOf(addDirs);
    if (dirs.length) params.addDirs = dirs;
    return { params, ...(place ? { place } : {}) };
  };

  const recent = new Set(data.recentIds);
  const options: ListboxOption[] = [
    { value: SCRATCH, label: t('newSession.project.quick'), sub: t('newSession.project.quickSub'), subKind: 'prose', icon: 'scratch' },
    // アーカイブは語に一致したときだけ、札付きで出す。presenter が後ろに並べてあるので、検索の結果でもほかのプロジェクトの後に来る。
    ...data.projects.map((p) => ({ value: p.id, label: p.name, sub: p.path ?? undefined, meta: p.lastActivity || undefined, status: p.status, ...(p.status === 'archived' ? { tag: STATUS_LABEL.archived, searchOnly: true } : {}) })),
    ...data.dirs.map((d) => ({ value: DIR + d.path, label: d.name, sub: d.path, icon: 'folder' as const, tag: t('newSession.project.unregistered'), searchOnly: true })),
    ...(extraDir ? [{ value: DIR + extraDir, label: baseName(extraDir), sub: extraDir, icon: 'folder' as const, hidden: true }] : []),
    { value: NEW_DIR, label: newName.trim() || t('newSession.project.newFolderChip'), faceSub: t('newSession.project.newFolderPath', { path: joinPath(root, newName.trim()) }), icon: 'folderPlus', hidden: true },
  ];
  // 作れない名前。APFS は大文字小文字を区別しないので、小文字で比べる。
  const names = new Set([...data.takenNames, ...data.projects.map((p) => p.name), ...data.dirs.map((d) => d.name)].map((n) => n.toLowerCase()));
  const taken = (q: string) => names.has(q.toLowerCase());
  const actions = (q: string): ListboxAction[] => {
    const word = q.trim();
    const first: ListboxAction = word && !taken(word)
      ? { value: 'new', label: t('newSession.project.newFolderNamed', { name: word }), ...(root !== '' ? { sub: joinPath(root, word) } : {}), icon: 'folderPlus' }
      : { value: 'new', label: t('newSession.project.newFolder'), icon: 'folderPlus' };
    return data.desktop ? [first, { value: 'finder', label: t('newSession.project.other'), sub: t(isMacClient() ? 'newSession.project.otherPickerMac' : 'newSession.project.otherPickerWindows'), icon: 'folderOpen' }] : [first];
  };
  const onAction = (value: string, q: string) => {
    if (value === 'finder') { emit({ type: 'folder.pick' }); return; }
    const word = q.trim();
    if (word && !taken(word)) setNewName(word);
    choose(NEW_DIR);
  };
  const groups = [{ title: t('newSession.project.groupQuick'), values: [SCRATCH] }, { title: t('newSession.project.groupRecent'), values: data.recentIds }, { title: t('newSession.project.groupAll'), values: data.projects.filter((p) => !recent.has(p.id) && p.status !== 'archived').map((p) => p.id) }];
  const chosen = options.find((o2) => o2.value === choice);

  // 前回値のままなら、札の下に「前回と同じ」と出どころを言い、「既定に戻す」を添える（D1）。
  const prev = data.prefs[prefKey];
  const sameAsPrev = caps.recallLine && !!prev && hasNonDefault(detail) && sameOptions(detail, optionsOf(prev, defaultModel));
  const bypass = caps.permissionMode && permissionMode === PERMISSION_BYPASS;

  const onChips = (patch: Partial<LaunchChipValues>) => {
    const { name: nextName, ...rest } = patch;
    if (nextName !== undefined) setName(nextName);
    if (Object.keys(rest).length) { setTouched(true); setDetail((cur) => ({ ...cur, ...rest })); }
  };
  const projectChip = (
    <Listbox id="new-session-project" label={t('newSession.project.label')} value={choice || null} options={options} groups={groups} onChange={choose} actions={actions} onAction={onAction}
      searchPlaceholder={t('newSession.project.search')} minWidth={360} align="start" faceClassName="set-chip" faceProps={{ 'data-tone': nested || linking ? 'linked' : 'default' }}
      renderFace={(sel) => (
        // 包むプロジェクトで始めるときは、札をそのプロジェクトにして下のフォルダを添える。結び付けるときは、結び付く先の名前にして「ほかの PC」を添える。
        nested ? <><Icon name="folder" /><span className="set-chip-value">{nested.name}</span><small className="set-chip-sub">{nested.relative}</small><Icon name="chevronDown" /></>
          : linking ? <><Icon name="folder" /><span className="set-chip-value">{linking.name}</span>{linking.deviceName && <span className="listbox-tag">{t('newSession.project.otherPc')}</span>}<Icon name="chevronDown" /></>
            : <><Icon name={sel?.icon ?? 'folder'} /><span className="set-chip-value">{sel?.label ?? ''}</span><Icon name="chevronDown" /></>
      )} />
  );

  const chips = (
    <LaunchChips
      rootRef={chipsRef}
      agent={oc || cx ? { value: agent, onChange: (v) => { void switchAgent(v); }, opencodeNote: opencodeAgentNote(t, ocData), codexNote: codexAgentNote(t, cxData), offered } : undefined}
      codex={codex ? {
        model: cxModel, models: cxData?.models ?? [], onModel: pickCxModel,
        effort: cxEffort, efforts: codexEffortsOf(cxData, cxModel), onEffort: setPickedCxEffort,
        permission: cxPermission, onPermission: setCxPermission,
      } : undefined}
      opencode={opencode ? {
        mode: ocMode, modes: ocData?.modes ?? [], onMode: setPickedMode,
        model: ocModel.model, models: ocData?.models ?? [], defaultModel: ocData?.defaultModel ?? null, modelReset: ocModel.reset, onModel: setPickedModel,
        providers: ocData?.providers ?? [], pricesAt: ocData?.pricesAt ?? null, fetchedAt: ocData?.fetchedAt ?? 0, reloading: ocState?.status === 'loading',
        onReload: () => emit({ type: 'opencode.options', dir: ocDir, refresh: true }),
        // 設定の opencode の面へ移る（プロバイダーの面は C6）。書きかけは閉じるときに下書きとして残る。
        onManage: () => { emit({ type: 'opencode.providers.manage' }); },
        autoApprove, onAutoApprove: setAutoApprove, pickModel: o.pickModel === true,
      } : undefined}
      lead={projectChip}
      account={accountSet && account !== null ? { value: account, options: accountOptions(t, accountSet), onChange: pickAccount } : undefined}
      values={{ model, effort, permissionMode, worktree, addDirs, name }}
      onChange={onChips}
      previousPermission={prev ? prev.permissionMode ?? '' : undefined}
      worktreeSuffix={scheduling ? t('schedules.worktree.suffix') : undefined}
    />
  );

  /** 札の下の注意と、選んだフォルダの 1 行の説明。 */
  const notes = (
    <>
      <CodexFullAccessNote open={codex && cxPermission === 'full-access'} />
      {codex && cxData === null && (cxState?.status === 'loading' || cxState?.status === 'failed') && (
        <div className="faint" {...agentOnlyAttr('modelList')}>{t(cxState.status === 'loading' ? 'launch.codex.loading' : 'launch.codex.failed')}</div>
      )}
      <OpencodeModelResetNote open={opencode && ocModel.reset && !resetNoteClosed} model={ocRemembered} onClose={() => setResetNoteClosed(true)} />
      {opencode && ocState?.data === null && (ocState.status === 'loading' || ocState.status === 'failed') && (
        <div className="faint" {...agentOnlyAttr('modes')}>{t(ocState.status === 'loading' ? 'launch.opencode.loading' : 'launch.opencode.failed')}</div>
      )}
      {sameAsPrev && (
        <div className="prev-line" {...agentOnlyAttr('recallLine')}>
          <span className="prev-tag">{t('newSession.prev.tag')}</span>
          <span className="faint">{t('newSession.prev.note', { name: nested?.name ?? chosen?.label ?? '' })}</span>
          <button type="button" className="linkish prev-reset" onClick={resetDetail}><Icon name="reset" />{t('newSession.prev.reset')}</button>
        </div>
      )}
      {newDir && (
        <>
          <label className="field" htmlFor="new-session-dir-name">{t('newSession.newDir.nameLabel')}
            <input id="new-session-dir-name" className="input mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('newSession.newDir.namePlaceholder')} />
          </label>
          {rootless && <ParentField value={parent} onChange={setParent} desktop={data.desktop} picked={data.picked} />}
          {root !== '' && <div className="faint">{t(scheduling ? 'schedules.dir.newNote' : 'newSession.newDir.note', { path: joinPath(root, newName.trim()) })}</div>}
          <CheckCard label={t('newSession.newDir.gitInit')} icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      )}
      {dirPath && enclosing && (
        <div className="faint dir-note">
          {nested
            ? <><span>{boldFirst(t('newSession.dir.nested', { name: enclosing.name, relative: enclosing.relative }), enclosing.name)}</span><button type="button" className="linkish" onClick={() => setSplitAt(dirPath)}>{t('newSession.dir.split')}</button></>
            : <><span>{boldFirst(t('newSession.dir.splitNote', { name: enclosing.name }), enclosing.name)}</span><button type="button" className="linkish" onClick={() => setSplitAt(null)}>{t('newSession.dir.keep', { name: enclosing.name })}</button></>}
        </div>
      )}
      {dirPath && link && (
        <div className="faint dir-note">
          {linking
            ? <><span>{boldFirst(t(link.match === 'remote' ? 'newSession.dir.linkRemote' : 'newSession.dir.linkName', { who: linkWho, path: dirPath }), linkWho)}</span><button type="button" className="linkish" onClick={() => setLinkNewAt(dirPath)}>{t('newSession.dir.linkNew')}</button></>
            : <><span>{boldFirst(t('newSession.dir.newNote', { who: linkWho }), linkWho)}</span><button type="button" className="linkish" onClick={() => setLinkNewAt(null)}>{t('newSession.dir.linkBack', { name: link.name })}</button></>}
        </div>
      )}
      {dirPath && !enclosing && !link && <div className="faint">{outside ? t('newSession.dir.outside') : t(scheduling ? 'schedules.dir.unregistered' : 'newSession.dir.unregistered', { path: dirPath })}</div>}
      {!scratch && caps.trustNote && <div className="faint" {...agentOnlyAttr('trustNote')}>{t('newSession.note.trust')}</div>}
    </>
  );

  return { name, setName, chips, notes, build, blocked, titleKey, assistProject, agent, account, bypass };
}
