import { resumeHereOf } from './resumeHere.ts';
import { agentOfSession } from './agentIcon.ts';
import { asideOf } from '../lib/aside.ts';
import { gitDetailRows, gitUnsafeFix, presentGitChip, presentGitFiles, type GitChipProps, type GitFilesView } from './git.ts';
import { openForLabel, openLabel } from './editor.ts';
import { baseName, splitLast } from '../lib/paths.ts';
import { AGENT_LABEL, stopReasonOf, type LiveStatus, type RunDto, type RunKind, type SessionDto, type SessionFilesDto, type SettingsDto, type StepCell, type StopReason, type TranscriptEvent, type Translate, type UiAction } from '@agent-hangar/shared';
import { defaultSessionView } from '../mediator/sessionView.ts';
import type { State } from '../mediator/types.ts';
import { accountOfSession, aliveRunOf, artifactsOf, currentRunOf, eventsKey, hasMultipleAccounts, hasRunOf, outsideOpenOf, tabsOf, type Store } from '../store/store.ts';
import { DEFAULT_DAYS, EXTEND_TO, transcriptMark } from './retention.ts';
import { periodLabel } from './retentionDialog.ts';
import { absoluteTime, costLabel, durationLabel, percentLabel, relativeTime, shortModel, STATUS_LABEL, SUMMARIZER_LABEL, tokensLabel } from './format.ts';
import type { ParentLink } from './heading.ts';
import { presentArtifactCard, type ArtifactCardProps } from './project.ts';
import { presentTool, relPath, type ToolView } from './tools.ts';
import { turnsText } from './stats.ts';
import { translatorOf } from './i18n.ts';
import { interruptMark } from './interrupted.ts';
import { presentOverlap, type OverlapProps } from './overlap.ts';
import { projectDisplayName } from './projectName.ts';
import { statusMark } from './row.ts';
import { phoneLabelOf } from './phoneLabel.ts';
import { permissionLabel } from '../views/primitives/permissionModel.ts';
import { bandsOf, presentNowCard, resultsOf, type NowCardProps } from './live.ts';
import { buildTurns } from './turns.ts';
import { tocFolds } from './tocFold.ts';
import type { JumpState, TurnJumpStatus } from '../mediator/types.ts';

export type TranscriptItem =
  | { kind: 'user' | 'assistant' | 'thinking' | 'system'; seq: number; text: string; when: string }
  // view は種類ごとの見せ方。raw は生の記録を出すときだけ持つ、生の入力の JSON と結果の文である。
  | { kind: 'tool'; seq: number; summary: string; name: string; view: ToolView; raw: { input: string; result: string | null } | null; result: { text: string; isError: boolean } | null; when: string; subagent: { agentId: string; label: string } | null }
  | { kind: 'meta'; seq: number; name: string; json: string };
/** agent は opencode の会話のエージェントのタブにだけ付け、公式ロゴと「opencode」を出す。Claude のタブはいまのまま（ロボットの印と「Claude」）。 */
export type TabItemProps = { id: string; title: string; kind: 'agent' | 'shell'; agent?: 'opencode'; selected: boolean; closable: boolean };
/** 目次の見出しの数。plus は、数えきれていない古い行が残ること。 */
export type TurnCount = { n: number; plus: boolean };
/** 目次の 1 行。head は左のターミナルの指示の行と突き合わせる書き出しで、跳ぶ要求にそのまま載る。 */
export type TurnRowProps = { seq: number; when: string; text: string; head: string; tools: number; open: boolean; band: StepCell[] };

/**
 * 要約に使った要約器とモデルの表示。
 * 種類は `sourceId`（要約器の id）が決める。モデル名から推し量らない。
 * `sourceId` を持たない古い行は、どの要約器が書いたか分からないので「不明」と出す。
 * 要約器を通していない要約（土台とセッション内）は、どちらも持たないので札を出さない。
 */
export function summarizerLabel(sourceId: string | null, sourceModel: string | null, t: Translate): string | null {
  if (!sourceId) return sourceModel ? t('session.lead.summarizerUnknown', { model: sourceModel }) : null;
  // lmstudio は LM Studio だけだった頃の id のまま残した OpenAI 互換の要約器なので、画面の言語で「OpenAI 互換」と言う（0.6.0）。
  const kind = sourceId === 'lmstudio' ? t('session.lead.summarizerOpenai') : SUMMARIZER_LABEL[sourceId] ?? sourceId;
  return sourceModel && sourceModel !== kind ? `${kind} / ${sourceModel}` : kind;
}

export type SessionProps = { id: string; name: string; parent: ParentLink | null; live: LiveStatus | null; aside: boolean;
  /** 止まっている理由（shared の stopReasonOf）。見出しの点と端末の縁を替える。無ければ null。 */
  reason?: StopReason | null;
  /** 見出しの名前の横に出す、要約の 1 文。無ければ null。 */
  oneLiner: string | null;
  hasTranscript: boolean; items: TranscriptItem[]; total: number; loaded: number; loading: boolean; hasMore: boolean; showThinking: boolean; showRaw: boolean; follow: boolean; agentId: string | null; subagents: string[]; notFound: boolean; loadingSession: boolean; run: { id: string; kind: RunKind; alive: boolean; started: string } | null; tabs: TabItemProps[]; selectedTab: string | null; transcriptOpen: boolean; trustHint: boolean; canResume: boolean; canFork: boolean; summaryPending: boolean; summaryError: string | null; fromScratch: boolean; canPromote: boolean; split: { left: string; right: string } | null; canSplit: boolean; lock: SessionLockProps | null; remoteOnly: boolean; canResumeHere: boolean; outsideOpen: 'attach' | 'adopt' | null;
  /** この PC にプロジェクトのフォルダが無いほかの PC の会話の、押せない理由と場所を指定する先（presenters/resumeHere.ts）。省けば null として読む。 */
  noRoot?: { reason: string; projectId: string } | null;
  /** ほかの PC に引き継がれたことを伝える見出しの下の 1 行（SessionDto.takenOver）。引き継がれていなければ null、省けば出さない。 */
  takenOver?: string | null;
  /** ほかの PC の続きの方が新しい（SessionDto.newerElsewhere）。「この PC で再開」を主にし、素の再開は名前を替えて「…」に残す。省けば偽として読む。 */
  newerElsewhere?: boolean;
  /** 保持期間で本文が消えたとみられる会話の注記。そうでなければ null。 */
  gone: { note: string; canExtend: boolean; extendTo: number } | null;
  /** ターンの目次。古い順。turnsComplete は会話の最初の指示まで読み込んでいるか。 */
  turnRows: TurnRowProps[]; turnsComplete: boolean; turnsPending: boolean; turnCount: TurnCount | null; loadingOlder: boolean; openTurnItems: TranscriptItem[]; turnJump: { seq: number; status: TurnJumpStatus } | null;
  /**
   * 目次のターンを押したとき、左のエージェントの画面をその指示へ跳ばせるか（サーバの driver の caps.promptJump と同じ）。
   * 跳び方は Claude Code の画面の操作なので、Claude Code の会話だけ真。偽なら目次は run を持たず、終わった会話と同じくターンを開くだけにする。
   */
  promptJump: boolean;
  /** 検索の結果から開いたときの跳び先。 */
  jump: JumpState | null;
  /** 読んだ頁より新しい行がまだあるか（検索の結果から真ん中の頁だけを読んで開いたとき）。 */
  hasNewer: boolean;
  /**
   * そのセッションを最後に動かしたアカウントの札（名前と色）。
   * アカウントが 2 件以上あるときだけ出し、1 件以下なら null で、(i) のポップオーバーに行を足さない。
   */
  account: { name: string; color: string } | null;
  /**
   * 見出しの行の操作（A1）。
   * 主の操作 1 つと「…」のメニュー。
   */
  actions: SessionActions;
  /**
   * 目次から跳ばした Claude が transcript を表示している間の帯（F1）。
   * when は跳ばしたターンの時刻。
   */
  transcriptBand: { when: string } | null;
  /** 現在の札（右の欄の上）。生きた run があるときだけ。 */
  strip: NowCardProps | null;
  /** 現在の札の「同じファイルを編集中」の 1 節（presenters/overlap.ts）。重なりが無ければ null。 */
  overlap?: OverlapProps | null;
  /** 終わったセッションの、トランスクリプトの冒頭の 1 枚。run が無いときだけ。 */
  lead: LeadCardProps | null;
  /**
   * 終わった画面の本文の面の最後に置く 1 行（C7、試作の E1）。opencode の会話で、run が無く、再開できるときだけ 'opencode'。
   * 1 行は「再開」から続けられることを言うので、再開を押せない会話（ほかの PC の会話、本文が無い）には付けない。Claude の会話にも付けない。
   */
  endedLine?: 'opencode' | null;
  /** 見出しの名前の横の札（ロック、トランスクリプトの在りか）。 */
  badges: BadgeProps[];
  /**
   * 見出しの状態の札（4A）。主の操作の左に置き、選ぶとセッションの状態を変える。
   * 状態の無い会話は Active。auto と title は、hangar が自動で付けた状態の印と理由（row.ts の statusMark）。
   * 本文が消えた会話では null で、札を出さない。省けば null として読む。
   */
  statusPick?: StatusPick | null;
  /** 見出しの (i) のポップオーバーの行。 */
  details: DetailRow[];
  /** 持ち主の違いで git が断ったときの、許すコマンド。(i) の行の下に、訳と一緒に写せる形で出す。断っていなければ null か無し。 */
  gitFix?: string | null;
  /**
   * git の表示（0.5.0）。chip は現在の札と冒頭の 1 枚に置く札（まだ届いていないものと git でないものは null）、files は「変更したファイル」の差分の一覧。
   * まだ git を読んでいないセッションは null。
   */
  git?: SessionGitView | null };
/** セッション画面の git。 */
export type SessionGitView = { chip: GitChipProps | null; files: GitFilesView };

export type SessionActionId = 'openEditor' | 'resume' | 'resumeHere' | 'fork' | 'openTerminal' | 'attach' | 'adopt' | 'regenerate' | 'promote' | 'copyAddress' | 'copyId' | 'stop';
/**
 * 操作の 1 つ。
 * disabled は押せない理由（押せるなら null）、note は下に添える 1 行。
 * danger は取り消せない操作。
 */
/** note は項目の下に出す補足（副作用を言うものだけ）。title は画面に出さず、項目の title に入れる補足。 */
export type SessionAction = { id: SessionActionId; label: string; disabled: string | null; note: string | null; title?: string | null; danger?: boolean };
export type SessionActions = { primary: SessionAction; menu: SessionAction[] };
/**
 * 変更したファイルの 1 行。
 * path は本文に出てきた綴りのまま（開くときにサーバへ送る）。
 * dir と base は作業ディレクトリからの相対で分けた見せ方。
 */
export type ChangedFileProps = { path: string; dir: string; base: string; added: number; removed: number; created: boolean };

/**
 * 他端末がそのセッションを握っている間の表示。
 * heartbeat が途絶えていても（stale）ロックは外さず、文言だけを「応答がありません」に変える。
 * 消えた端末を理由に同じ run を横取りさせないための形である。
 * ただし行き止まりにはせず、stale のときは「この PC で再開」だけを開けて新しい run に逃がす（Ruling 14）。
 */
export type SessionLockProps = { deviceName: string; stale: boolean; heartbeat: string; label: string };

function lockProps(lock: SessionDto['lock'], now: number, t: Translate): SessionLockProps | null {
  if (!lock) return null;
  return { deviceName: lock.deviceName, stale: lock.stale, heartbeat: relativeTime(t, lock.heartbeatAt, now), label: t(lock.stale ? 'session.lock.stale' : 'session.lock.running', { device: lock.deviceName }) };
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** 時刻の時と分（`HH:MM`）。表示の言語に依らない。 */
const when = (ts: number | undefined) => {
  if (ts === undefined) return '';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** タグの中身。無ければ null。 */
const tagText = (text: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? m[1]!.trim() : null;
};

/**
 * ローカルコマンド（/exit、/model など）の記録を読める形にする。null なら出さない。
 * Claude Code はこれを user の発言として、タグで包んで書く。そのまま出すとタグと決まり文句が本文に並ぶ。
 * 決まり文句（local-command-caveat）と空の出力は落とし、コマンドは「/model opus」の 1 行に、出力は中身だけにする。
 * どのタグでもない system の記録はそのまま返す。
 */
export function localCommandText(text: string, t: Translate): string | null {
  const head = text.trimStart();
  if (head.startsWith('<local-command-caveat>')) return null;
  // スキルを読み込むと、その本文がまるごと記録に入る。ターミナルは 1 行しか出さないので、ここも名前だけにする。
  const skill = /^Base directory for this skill: (\S+)/.exec(head);
  if (skill) return t('session.transcript.skillLoaded', { name: baseName(skill[1]!) });
  const name = tagText(head, 'command-name');
  if (name !== null) {
    const args = tagText(head, 'command-args') ?? '';
    return args ? `${name} ${args}` : name;
  }
  const out = tagText(head, 'local-command-stdout');
  if (out !== null) return out === '' || out === '(no content)' ? null : out;
  // ! で打ったシェルは、ターミナルと同じく「! コマンド」の 1 行に、出力は中身だけにする。どちらも空なら出さない。
  const bash = tagText(head, 'bash-input');
  if (bash !== null) return `! ${bash}`;
  if (head.startsWith('<bash-stdout>') || head.startsWith('<bash-stderr>')) {
    const shown = [tagText(head, 'bash-stdout'), tagText(head, 'bash-stderr')].filter((s) => s).join('\n');
    return shown || null;
  }
  // バックグラウンドのタスクの知らせは、要旨の 1 行だけにする。内部の注意書きは出さない。
  if (head.startsWith('<task-notification>')) return tagText(head, 'summary') ?? null;
  if (head.startsWith('<system-reminder>')) return null;
  return text;
}

type ToolCall = Extract<TranscriptEvent, { kind: 'tool_call' }>;
type ToolResult = { text: string; isError: boolean };
/**
 * ツールの見せ方の控え。差分を取るので安くはなく、描くたびに作り直すと重い。
 * ストアの本文は同じ呼び出しを同じ物のまま持つので、呼び出しの物を鍵にし、結果か作業ディレクトリが変わったときだけ作り直す。
 */
const toolViews = new WeakMap<ToolCall, { result: ToolResult | null; cwd: string; t: Translate; view: ToolView }>();
function toolView(call: ToolCall, result: ToolResult | null, cwd: string, t: Translate): ToolView {
  const hit = toolViews.get(call);
  // 辞書の関数は言語ごとに同じ物が返るので、言語を替えたときだけ作り直す。
  if (hit && hit.cwd === cwd && hit.t === t && (hit.result === result || (hit.result?.text === result?.text && hit.result?.isError === result?.isError))) return hit.view;
  const view = presentTool(call, result, cwd, t);
  toolViews.set(call, { result, cwd, t, view });
  return view;
}

export function buildItems(events: TranscriptEvent[], opts: { showThinking: boolean; showRaw: boolean; subagents: string[]; cwd?: string }, t: Translate): TranscriptItem[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const e of events) if (e.kind === 'tool_result') results.set(e.toolId, { text: e.text, isError: e.isError });
  const items: TranscriptItem[] = [];
  let nextSub = 0;
  for (const e of events) {
    switch (e.kind) {
      case 'user': case 'assistant': items.push({ kind: e.kind, seq: e.seq, text: e.text, when: when(e.ts) }); break;
      case 'system': {
        // 生の記録を出すときは、手を加えずにそのまま見せる。
        // 種類の名前しか持たない行（turn_duration と stop_hook_summary は毎ターン 1 つずつ出る）は、読む中身が無いので落とす。
        if (!opts.showRaw && e.subtype !== undefined && e.text === e.subtype) break;
        const text = opts.showRaw ? e.text : localCommandText(e.text, t);
        if (text !== null) items.push({ kind: 'system', seq: e.seq, text, when: when(e.ts) });
        break;
      }
      case 'thinking': if (opts.showThinking) items.push({ kind: 'thinking', seq: e.seq, text: e.text, when: when(e.ts) }); break;
      case 'tool_call': {
        const sub = SUBAGENT_TOOLS.has(e.name) && opts.subagents[nextSub] ? { agentId: opts.subagents[nextSub++]!, label: e.summary } : null;
        const result = results.get(e.toolId) ?? null;
        const raw = opts.showRaw ? { input: JSON.stringify(e.input, null, 2) ?? '', result: result?.text ?? null } : null;
        items.push({ kind: 'tool', seq: e.seq, summary: e.summary, name: e.name, view: toolView(e, result, opts.cwd ?? '', t), raw, result, when: when(e.ts), subagent: sub });
        break;
      }
      case 'tool_result': break;
      case 'subagent': break;
      case 'meta': if (opts.showRaw) items.push({ kind: 'meta', seq: e.seq, name: e.name, json: JSON.stringify(e.value, null, 2) }); break;
    }
  }
  return items;
}

/** 「<名前> で開く」。名前は設定のエディタ（presenters/editor.ts）。 */
const openEditor = (label: string): SessionAction => ({ id: 'openEditor', label, disabled: null, note: null });

/** 見出しの行の操作を決めるのに要る事実。 */
export type ActionFacts = Pick<SessionProps, 'run' | 'live' | 'lock' | 'remoteOnly' | 'hasTranscript' | 'canResume' | 'canFork' | 'canResumeHere' | 'outsideOpen' | 'canPromote' | 'gone' | 'summaryPending' | 'summaryError' | 'fromScratch' | 'noRoot' | 'newerElsewhere'> & {
  /** 要約エンジンが「使わない」。作り直しをサーバが受け付けないので、項目を出さない（冒頭の 1 枚の canRegenerate と同じ）。省けば使うものとして扱う。 */
  summaryOff?: boolean;
};

/**
 * 見出しの行の操作（試作 session-layout-v2.html の A1 と、状態ごとの操作の表）。
 * 状態に合う操作を 1 つだけ主にし、残りは「…」のメニューに入れる。
 * 停止は危険色でメニューの最後に置く。
 * 押せない項目は消さずに残し、押せない理由を 1 行添える。
 * 理由は再開とフォークを閉じている事実（実行中、ロック、本文の在りか）から言う。
 * 生きているロックの「この PC で再開」は Ruling 14 のとおり閉じたままにし、主の操作のまま理由を添える。
 */
export function sessionActions(f: ActionFacts, t: Translate, editorLabel: string = t('editor.open.named', { name: 'VS Code' })): SessionActions {
  const running = f.run?.alive === true || (f.live !== null && f.lock === null && !f.remoteOnly);
  const dev = f.lock?.deviceName ?? null;
  const why = (kind: 'resume' | 'fork'): string => {
    if (running) return t('session.action.runningReason');
    if (f.lock) return f.lock.stale && kind === 'resume' ? t('session.action.reason.staleResume', { device: dev ?? '' }) : t('session.action.reason.running', { device: dev ?? '' });
    if (f.remoteOnly) return kind === 'resume' ? t('session.action.reason.remoteResume') : t('session.action.reason.remote');
    if (!f.hasTranscript) return t('session.action.reason.noTranscript');
    return t('session.action.reason.starting');
  };
  // ほかの PC の続きの方が新しいときの素の再開は、手元の古いトランスクリプトで起きる。そう分かる名前と注記にする。
  const stale = f.newerElsewhere === true && f.canResume;
  const resume: SessionAction = { id: 'resume', label: t(stale ? 'session.action.resumeLocal' : 'session.action.resume'), disabled: f.canResume ? null : why('resume'), note: stale ? t('session.action.resumeLocalNote') : null, title: !stale && f.fromScratch ? t('session.action.resumeQuickNote') : null };
  const fork: SessionAction = { id: 'fork', label: t('session.action.fork'), disabled: f.canFork ? null : why('fork'), note: null, title: f.canFork ? t('session.action.forkNote') : null };
  const regenerate: SessionAction[] = f.gone || f.summaryOff ? [] : [{ id: 'regenerate', label: t('session.action.regenerate'), disabled: null, note: f.summaryPending ? t('session.action.regenerateBusy') : f.summaryError ? t('session.action.regenerateFailed') : null }];
  const promote: SessionAction[] = f.canPromote ? [{ id: 'promote', label: t('session.action.promote'), disabled: null, note: null }] : [];
  const editor = openEditor(editorLabel);
  // 別の Claude に渡す宛先の 1 行。動いていても終わっていても写せる（終わったら session_id だけ）。
  const copyAddress: SessionAction = { id: 'copyAddress', label: t('session.action.copyAddress'), disabled: null, note: null };
  // claude -r に渡す Claude Code のセッション ID（providerSessionId）だけ。宛先の 1 行の session_id は hangar の ID で、claude -r では開けない。
  const copyId: SessionAction = { id: 'copyId', label: t('session.action.copyId'), disabled: null, note: null };
  if (running) {
    const alive = f.run?.alive === true;
    const outside: SessionAction[] = f.outsideOpen === 'attach' ? [{ id: 'attach', label: t('session.action.attach'), disabled: null, note: null, title: t('session.action.attachNote') }]
      : f.outsideOpen === 'adopt' ? [{ id: 'adopt', label: t('session.action.adopt'), disabled: null, note: t('session.action.adoptNote') }] : [];
    return { primary: editor, menu: [
      ...(alive ? [{ id: 'openTerminal', label: t('session.action.openTerminal'), disabled: null, note: null, title: t('session.action.openTerminalNote') } satisfies SessionAction] : []),
      ...outside, fork, ...regenerate, ...promote, copyAddress, copyId,
      ...(alive ? [{ id: 'stop', label: t('session.action.stop'), disabled: null, note: null, danger: true } satisfies SessionAction] : []),
    ] };
  }
  if (f.lock || f.remoteOnly || f.newerElsewhere) {
    // 押せても、この PC にプロジェクトのフォルダが無ければ閉じる（理由は見出しの下にも出す、resumeHere.ts）。
    // ほかの PC で実行中でも押せる。押すと、停止して引き継ぐ確認の 1 枚が出る。
    const blocked = f.noRoot?.reason ?? null;
    const here: SessionAction = { id: 'resumeHere', label: t('session.action.resumeHere'), disabled: blocked, note: null };
    return { primary: here, menu: [resume, fork, editor, ...regenerate, ...promote, copyAddress, copyId] };
  }
  return { primary: resume, menu: [fork, editor, ...regenerate, ...promote, copyAddress, copyId] };
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * 変更したファイル。
 * 編集系のツールの呼び出しを、最初に触った順にパスで束ねる。
 * 足した行と消した行は、本文の欄と同じ差分（ツールの見せ方の控え）から数える。
 * Write は中身の行を足した数にする。
 */
function changedFilesOf(events: TranscriptEvent[], results: Map<string, ToolResult>, cwd: string, t: Translate): ChangedFileProps[] {
  const files = new Map<string, ChangedFileProps>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || !FILE_TOOLS.has(e.name)) continue;
    const input = (typeof e.input === 'object' && e.input !== null ? e.input : {}) as Record<string, unknown>;
    const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : '';
    if (!path) continue;
    let f = files.get(path);
    if (!f) {
      f = { path, ...splitLast(relPath(path, cwd)), added: 0, removed: 0, created: false };
      files.set(path, f);
    }
    const view = toolView(e, results.get(e.toolId) ?? null, cwd, t);
    if (view.body.kind === 'diff') for (const h of view.body.hunks) for (const l of h.lines) { if (l.t === 'add') f.added++; else if (l.t === 'del') f.removed++; }
    if (view.body.kind === 'code') { f.added += view.body.text === '' ? 0 : view.body.text.split('\n').length; if (view.body.created) f.created = true; }
  }
  return [...files.values()];
}

/* ---- 終わった画面の見出しの下の 1 行と要約の札、見出しの札 ---- */

/** 冒頭の 1 枚の「変更したファイル」の 1 行。added と removed は、読み込んだ本文の窓にある分だけ持つ（無ければ null）。 */
export type LeadFileRow = { path: string; dir: string; base: string; created: boolean; added: number | null; removed: number | null; edits: string; byAgent: string | null; openLabel: string };
export type LeadCardProps = {
  label: string;
  /** title は札のツールチップ（日本語の説明、自動の Done はその理由）、auto は hangar が自動で付けた Done（札に ✦ と点線の枠）。 */
  status: { value: 'active' | 'paused' | 'done' | 'archived'; label: string; since: string | null; title: string; auto: boolean };
  /** 終了の文。区切りを付けたので止めたときは stopped を、中断したときは interrupted を出すので null。 */
  ended: string | null;
  /** 中断の文（「PC の再起動で中断 · 10/12 03:12」）。ステータスの無いセッションで、最後の run が中断で終わったときだけ。 */
  interrupted?: string | null;
  stopped: string | null;
  turns: string; tokens: string; cost: string | null;
  /** 「要約のみ」「トランスクリプトがありません」。 */
  flags: string[];
  /**
   * 要約の札（S5）の中身。sourceLine（作成元）は札に行として出さず、進捗の title に置く。
   * 土台の要約（索引が組んだ事実）は要約ではないので null にする。本文が消えた会話だけは、残った手がかりとして出す。
   */
  summary: { body: string; nextSteps: string[]; nextStepsLabel: string; progress: string; sourceLine: string } | null;
  /** 要約の札の注記（作成中、作成できなかった）。要約が無くても札を出して言う。失敗の理由は title で読める。 */
  notice: { kind: 'pending' | 'failed'; text: string; title: string | null } | null;
  canRegenerate: boolean; regenerate: string;
  files: { label: string; count: number; rows: LeadFileRow[]; note: string | null };
  artifacts: { label: string; count: number; items: ArtifactCardProps[] };
  pr: { label: string; url: string } | null;
};
export type LeadInput = {
  session: SessionDto;
  now: number;
  /** 保持期間で本文が消えたとみられる会話。 */
  gone: boolean;
  /** 選んでいるエディタ（変更したファイルの「<名前> で開く」）。省くと VS Code として言う。 */
  editor?: Pick<SettingsDto, 'editor'> | null;
  summaryPending: boolean;
  summaryError: string | null;
  /** 設定の要約エンジンが「使わない」か。事後の要約を作らないので、空の文で設定へ誘い、作り直しを出さない。省けば偽。 */
  summaryOff?: boolean;
  artifacts: ArtifactCardProps[];
  /** サーバの変更したファイルの一覧（`GET /api/sessions/:id/files`）。届く前は null。 */
  files: SessionFilesDto['files'] | null;
  /** 読み込んだ本文の窓から数えた分（足した行と消した行を持つ）。 */
  windowFiles: ChangedFileProps[];
};

const SUMMARY_STATE_KEY = { in_progress: 'session.lead.state.inProgress', done: 'session.lead.state.done', blocked: 'session.lead.state.blocked', abandoned: 'session.lead.state.abandoned' } as const;
const SUMMARY_SOURCE_KEY = { baseline: 'session.lead.source.baseline', in_session: 'session.lead.source.inSession', post_hoc: 'session.lead.source.postHoc' } as const;

/** 月と日（端末の時刻）。 */
const monthDay = (ts: number): string => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()}`; };

/** PR の URL の末尾の `/pull/<番号>` から番号を取る。取れなければ「PR」だけ。 */
function prLabel(url: string, t: Translate): string {
  const n = /\/pull\/(\d+)/.exec(url)?.[1];
  return n ? t('session.lead.prNumber', { n }) : t('session.lead.pr');
}

/**
 * 変更したファイルの行。
 * サーバの一覧（索引から。窓には依らない）を並びと件数の正とし、読み込んだ窓にあるファイルにだけ足した行と消した行を付ける。
 * サーバの一覧が届く前は、窓から数えた分だけを出す。
 */
function leadFiles(i: LeadInput, t: Translate): LeadCardProps['files'] {
  const cwd = i.session.cwd;
  const byPath = new Map(i.windowFiles.map((f) => [f.path, f]));
  const split = (path: string) => splitLast(relPath(path, cwd));
  const row = (path: string, edits: number | null, agentId: string | null): LeadFileRow => {
    const w = byPath.get(path);
    return { path, ...split(path), created: w?.created ?? false, added: w ? w.added : null, removed: w ? w.removed : null, edits: edits === null ? '' : t('session.files.edits', { n: edits }), byAgent: agentId === null ? null : t('session.files.byAgent', { id: agentId }), openLabel: openForLabel(t, i.editor ?? null, path) };
  };
  const rows = i.files ? i.files.map((f) => row(f.path, f.edits, f.agentId)) : i.windowFiles.map((f) => row(f.path, null, null));
  const count = i.files ? i.files.length : Math.max(i.session.stats.filesChanged, rows.length);
  return { label: t('session.lead.files'), count, rows, note: rows.some((r) => r.added === null) ? t('session.files.diffPartial') : null };
}

/**
 * 終わったセッションの、見出しの下の 1 行（H1）と、右の欄の要約の札（S5）の中身（2026-10-16 の試作）。
 * 1 行にはステータスの札と設定した日、終了、ターンとトークンとコスト、git と変更したファイルとアーティファクトと PR の札を並べる。
 * 要約の札には、要約の本文、次のステップ、進捗、作成中と失敗の知らせ、「要約を再生成」を入れる。
 * 土台の要約（索引が組んだ事実の羅列）と、「要約はありません」「要約は設定で有効にできます」は出さない（見出しと重なる事実の羅列になっていた）。
 */
export function presentLeadCard(i: LeadInput, t: Translate): LeadCardProps {
  const s = i.session;
  const status = s.state?.status ?? 'active';
  const stats = s.stats;
  // 土台の要約は要約として出さない。本文が消えた会話だけは、残った手がかりとして出す。
  const sum = s.summary && (i.gone || s.summary.source !== 'baseline') ? s.summary : null;
  const stopped = s.stoppedByStatus && s.state?.status && s.live === null ? t('session.lead.stopped', { status: STATUS_LABEL[s.state.status] }) : null;
  const interrupted = !stopped && s.interrupted && !s.state?.status ? interruptMark(t, s.interrupted, i.now).title : null;
  const flags = [...(i.gone ? [t('session.lead.summaryOnly')] : []), ...(!s.hasTranscript && !i.gone ? [t('session.lead.noTranscript')] : [])];
  const sourceParts = sum ? [t(SUMMARY_SOURCE_KEY[sum.source]), summarizerLabel(sum.sourceId, sum.sourceModel, t)].filter((x): x is string => !!x) : [];
  return {
    label: t('session.lead.label'),
    status: { value: status, label: STATUS_LABEL[status], since: s.state?.setAt != null && s.state.status ? t('session.lead.statusSince', { date: monthDay(s.state.setAt) }) : null, ...statusMark(t, s.state, s.stats, s.summary, s.lastActivityAt) },
    ended: stopped || interrupted ? null : t('session.lead.ended', { when: relativeTime(t, s.lastActivityAt, i.now) }),
    stopped,
    interrupted,
    turns: turnsText(stats.turns, t), tokens: t('session.stats.tokens', { n: tokensLabel(stats.inputTokens + stats.outputTokens) }), cost: stats.costUsd === null ? null : costLabel(stats.costUsd),
    flags,
    summary: sum ? {
      body: sum.body, nextSteps: sum.nextSteps, nextStepsLabel: t('session.lead.nextSteps'),
      progress: t('session.lead.progress', { state: t(SUMMARY_STATE_KEY[sum.state]), turns: sum.basedOnTurns }),
      sourceLine: t('session.lead.sourceLine', { parts: sourceParts.join(t('common.list.separator')), when: absoluteTime(t, sum.updatedAt) }),
    } : null,
    notice: i.summaryPending ? { kind: 'pending', text: t('session.lead.pending'), title: null } : i.summaryError !== null ? { kind: 'failed', text: t('session.lead.failed'), title: i.summaryError } : null,
    // 本文が無いと作り直しは必ず失敗するので、消えた会話では出さない。
    // 要約エンジンを使わないときも出さない（サーバが受け付けない）。
    canRegenerate: !i.gone && !i.summaryOff, regenerate: t('session.lead.regenerate'),
    files: leadFiles(i, t),
    artifacts: { label: t('session.lead.artifacts'), count: i.artifacts.length, items: i.artifacts },
    pr: stats.prUrl ? { label: prLabel(stats.prUrl, t), url: stats.prUrl } : null,
  };
}

/** 見出しの状態の札の中身。value は ProjectStatus と同じ 4 つで、状態の無い会話は active。 */
export type StatusPick = { value: 'active' | 'paused' | 'done' | 'archived'; auto: boolean; title: string };

/** 見出しの名前の横に出す札。ロックと、トランスクリプトが他の PC にあること。どちらも操作できない理由なので、ポップオーバーには隠さない。 */
export type BadgeProps = { kind: 'lock' | 'stale' | 'remote' | 'phone' | 'phoneBypass'; label: string; title: string | null };

/**
 * 見出しの名前の横の札。
 * ロックは、他の PC が握っている間の「<PC 名> で実行中」と、応答が途絶えた「<PC 名> から応答がありません」（kind を stale にして色を替える）。
 * 「トランスクリプトは他の PC にあります」は再開とフォークを押せない理由なので、ロックと同じ扱いにする。
 * スマホから起動した会話は、ラベル「スマホから」を先頭に置く（Bypass permissions は kind を phoneBypass にして赤い枠）。
 */
export function presentSessionBadges(s: SessionDto, now: number, t: Translate): BadgeProps[] {
  const badges: BadgeProps[] = [];
  const phone = phoneLabelOf(s, t);
  if (phone) badges.push({ kind: phone.bypass ? 'phoneBypass' : 'phone', label: phone.label, title: phone.title });
  if (s.lock) {
    badges.push({ kind: s.lock.stale ? 'stale' : 'lock', label: t(s.lock.stale ? 'session.lock.stale' : 'session.lock.running', { device: s.lock.deviceName }), title: t('session.lock.lastSeen', { when: relativeTime(t, s.lock.heartbeatAt, now) }) });
  }
  if (s.remoteOnly) badges.push({ kind: 'remote', label: t('session.lock.remoteTranscript'), title: null });
  return badges;
}

/** (i) のポップオーバーの 1 行。mono は値を等幅で描く（パス、時刻）、dot は値の前に置く色の点（アカウント）。 */
/** note は値の後ろに薄く添える語、link は値の後ろのボタン（git の「一覧」）。 */
export type DetailRow = { name: string; value: string; mono?: boolean; dot?: string; note?: string; link?: { label: string; send: UiAction } };

/** 起動の種類を、辞書の語に引く。 */
const LAUNCH_KEY = { start: 'session.launch.start', resume: 'session.launch.resume', fork: 'session.launch.fork' } as const;

/**
 * 見出しの (i) のポップオーバーの行（設計書 2.3 の表）。毎回は見ない属性と、現在の札や冒頭の 1 枚に置かない数（コンテキスト使用量、コストを含む）をここに集める。
 * 値の無い行は出さない（効果レベルを選んでいない、権限モードを選ばなかった起動、変更も PR も無い、など）。
 * 権限モードは、起動のときに選んだ値で、起動のあとに Claude の中で切り替えた値は分からない（`RunDto.permissionMode`）。
 */
export function presentDetails(s: SessionDto, run: RunDto | null, account: { name: string; color: string } | null, t: Translate, address: string | null = null): DetailRow[] {
  // 先頭は、別の Claude に渡す宛先。動いていれば SendMessage の宛先、無ければ hangar の session_id を出す。コピーは同じ 1 行（sessionAddressLine）。
  const copy = { label: t('session.details.copy'), send: { type: 'session.copyAddress', id: s.id } } satisfies DetailRow['link'];
  const rows: DetailRow[] = [address ? { name: t('session.details.address'), value: address, mono: true, link: copy } : { name: t('session.details.id'), value: s.id, mono: true, link: copy }];
  const model = shortModel(s.stats.model);
  if (model) rows.push({ name: t('session.details.model'), value: model });
  if (s.stats.effort) rows.push({ name: t('session.details.effort'), value: s.stats.effort });
  if (run?.permissionMode) rows.push({ name: t('session.details.permission'), value: permissionLabel(run.permissionMode, t) });
  if (s.startedAt !== null) rows.push({ name: t('session.details.started'), value: absoluteTime(t, s.startedAt), mono: true });
  rows.push({ name: t('session.details.cwd'), value: s.cwd, mono: true });
  if (account) rows.push({ name: t('session.details.account'), value: account.name, dot: account.color });
  if (run) rows.push({ name: t('session.details.launch'), value: t('session.details.launchValue', { kind: t(LAUNCH_KEY[run.kind]), when: when(run.startedAt) }) });
  rows.push({ name: t('session.details.usage'), value: t('session.details.usageValue', { turns: turnsText(s.stats.turns, t), tokens: t('session.stats.tokens', { n: tokensLabel(s.stats.inputTokens + s.stats.outputTokens) }) }) });
  // 実行中の札に置かなくなった数（2026-10-11）。届いているときだけ出す。
  if (s.stats.contextPercent !== null) rows.push({ name: t('session.stats.context'), value: percentLabel(t, s.stats.contextPercent) });
  if (s.stats.costUsd !== null) rows.push({ name: t('session.stats.cost'), value: costLabel(s.stats.costUsd) });
  if (s.stats.filesChanged > 0) rows.push({ name: t('session.details.files'), value: t('session.details.filesValue', { n: s.stats.filesChanged }) });
  if (s.stats.prUrl) rows.push({ name: t('session.details.pr'), value: prLabel(s.stats.prUrl, t) });
  if (s.fromScratch) rows.push({ name: t('session.details.quick'), value: t('session.details.quickValue') });
  return rows;
}

/** そのセッションの登録（Claude Code の ~/.claude/sessions）。動いていなければ undefined。 */
const liveOf = (store: Store, s: SessionDto) => (s.live === null ? undefined : store.live.find((l) => l.sessionId === s.providerSessionId));

/**
 * 別の Claude に渡す、そのセッションを指す 1 行（セッション画面の「宛先をコピー」）。
 * 動いていれば SendMessage の宛先（登録の名前。重なるときは [ref] 付き、LiveSessionDto.address）と hangar の session_id、
 * 終わっていれば session_id だけにして終了と添える（宛先はもう届かない）。session_id は get_transcript などの MCP で使う。
 * 知らないセッションは null。
 */
export function sessionAddressLine(store: Store, id: string): string | null {
  const s = store.sessions[id];
  if (!s) return null;
  const t = translatorOf(store);
  const name = s.name ?? t('common.label.noName');
  const address = liveOf(store, s)?.address;
  if (address) return t('session.address.lineLive', { name, address, id });
  return t(s.live === null ? 'session.address.lineEnded' : 'session.address.line', { name, id });
}

export function presentSession(state: State, store: Store, now: number, id: string): SessionProps {
  const s = store.sessions[id];
  const t = translatorOf(store);
  const view = state.sessionView[id] ?? defaultSessionView();
  // ターンの少ない終わった会話は、右の欄をはじめ畳み、その画面だけの開閉（tocPeek）に従う。
  const transcriptOpen = tocFolds(store, view, id) ? view.tocPeek : view.transcriptOpen;
  const base = { id, parent: null, live: null, aside: false, oneLiner: null, hasTranscript: false, items: [], total: 0, loaded: 0, loading: false, hasMore: false, showThinking: view.showThinking, showRaw: view.showRaw, follow: view.follow, agentId: view.agentId, subagents: store.subagents[id] ?? [], loadingSession: false, run: null, tabs: [], selectedTab: null, transcriptOpen, trustHint: false, canResume: false, canFork: false, summaryPending: false, summaryError: null, fromScratch: false, canPromote: false, split: null, canSplit: false, lock: null, remoteOnly: false, canResumeHere: false, outsideOpen: null, turnRows: [], turnsComplete: true, turnsPending: false, turnCount: null, loadingOlder: false, openTurnItems: [], turnJump: null, promptJump: false, strip: null, lead: null, badges: [], details: [], git: null, account: null, gone: null, jump: null, hasNewer: false, actions: { primary: openEditor(openLabel(t, store.settings)), menu: [] }, transcriptBand: null };
  // 起動の応答は HTTP で先に返り、session.upsert は WebSocket で遅れて届く。
  // run だけ知っている間は「見つかりません」ではなく読み込み中にする。
  if (!s) { const loading = hasRunOf(store, id); return { ...base, name: id, notFound: !loading, loadingSession: loading }; }
  const slice = store.events[eventsKey(id, view.agentId)];
  // 本文は最新の側から読み、遡ったページは store の後ろに足される。並びは表示の直前にここで戻す。
  // 走査して崩れているときだけ並べ直すので、遡っていない間は写しも取らない。
  const raw = slice?.items ?? [];
  let sorted = true;
  for (let i = 1; i < raw.length; i++) if (raw[i]!.seq < raw[i - 1]!.seq) { sorted = false; break; }
  const events = sorted ? raw : [...raw].sort((a, b) => a.seq - b.seq);
  const itemOpts = { showThinking: view.showThinking, showRaw: view.showRaw, subagents: store.subagents[id] ?? [], cwd: s.cwd };
  const items = buildItems(events, itemOpts, t);
  const turnList = buildTurns(events);
  const openTurn = turnList.find((x) => x.seq === view.openTurn) ?? null;
  // 結果の表は 1 回だけ作り、色帯と現在の帯で使い回す。
  const results = resultsOf(events);
  const bands = bandsOf(events, turnList, results);
  const turnRows: TurnRowProps[] = turnList.map((x, n) => ({ seq: x.seq, when: when(x.ts), text: x.text, head: x.head, tools: x.tools, open: x === openTurn, band: bands[n]! }));
  const openTurnItems = openTurn ? buildItems(events.filter((e) => e.seq >= openTurn.from && e.seq < openTurn.to), itemOpts, t) : [];
  const project = s.projectId ? store.projects[s.projectId] ?? null : null;
  const run = currentRunOf(store, id);
  const alive = aliveRunOf(store, id) !== null;
  // 最初の events が届く前。目次は仮の行を出し、見出しの数は出さない。追記の読み込み（loading だけ立つ）は含めない。
  const turnsPending = s.hasTranscript && (!slice || (slice.loading && slice.items.length === 0));
  // 見出しのターンの数。上の帯と同じ出所（統計の turns）を使い、窓に読んだ行の数は使わない。
  // サブエージェントには統計が無いので、その窓の行の数にする（古い行が残るなら + を添える）。
  const olderLeft = slice ? slice.total > slice.items.length && !slice.olderDone : false;
  const turnCount: TurnCount | null = turnsPending ? null : view.agentId !== null ? { n: turnList.length, plus: olderLeft } : { n: s.stats.turns, plus: false };
  // 現在の札は実行中だけ。サブエージェントの transcript を開いている間は、events が主線ではない。
  // events は最新の 500 件の窓かもしれないので、ターンの頭は digest（サーバが全体から決めた seq）を先に使う。
  const lastTurn = turnList[turnList.length - 1] ?? null;
  const complete = slice ? slice.total <= slice.items.length : true;
  const open = run ? tabsOf(store, run.id) : [];
  const selectedTab = run ? (view.selectedTab && open.some((x) => x.id === view.selectedTab) ? view.selectedTab : run.id) : null;
  // opencode の会話のエージェントのタブは、サーバが付ける題（Claude）ではなく「opencode」と公式ロゴにする。
  const opencodeTab = agentOfSession(store, s) === 'opencode';
  const tabs: TabItemProps[] = open.map((x) => (x.kind === 'agent' && opencodeTab
    ? { id: x.id, title: AGENT_LABEL.opencode, kind: x.kind, agent: 'opencode', selected: x.id === selectedTab, closable: false }
    : { id: x.id, title: x.title, kind: x.kind, selected: x.id === selectedTab, closable: x.kind === 'shell' }));
  const idle = !alive && s.live === null && state.launch.kind !== 'submitting';
  const canSplit = open.length >= 2;
  // 保持期間で本文が消えたとみられる会話。要約しか残っていないことを、要約の上の一行で伝える。
  const r = store.retention;
  const gone = transcriptMark(s, r?.days ?? DEFAULT_DAYS, now) === 'gone'
    ? { note: t('session.gone.note', { period: periodLabel(t, DEFAULT_DAYS) }), canExtend: !!r && r.source === 'default' && r.writable, extendTo: EXTEND_TO }
    : null;
  // 変更したファイルは主線から数える（冒頭の 1 枚が、サーバの一覧に足した行と消した行を付けるのに使う）。
  // サブエージェントを見ている間も、主線の分を出す。
  const mainSlice = store.events[eventsKey(id, null)];
  const mainEvents = view.agentId === null ? events : (mainSlice?.items ?? []);
  const toolResults = new Map<string, ToolResult>();
  for (const e of mainEvents) if (e.kind === 'tool_result') toolResults.set(e.toolId, { text: e.text, isError: e.isError });
  const changedFiles = changedFilesOf(mainEvents, toolResults, s.cwd, t);
  // transcript を表示中の帯は、今の生きた run を transcript に入れたと確かめられた間だけ出す。
  // サーバは着けなかった（notFound）ときも transcript を開いたままにするので、そのときも出す。
  // 答えを待つ間（pending）と、入れなかった（mode）ときと、API が失敗した（failed）ときは出さない。
  // 失敗は目次の開いたターンの中で言う。
  const tj = view.turnJump;
  const aliveRun = aliveRunOf(store, id);
  const transcriptBand = tj && aliveRun && tj.runId === aliveRun.id && (tj.status === 'found' || tj.status === 'notFound') ? { when: (turnRows.find((r) => r.seq === tj.seq)?.when ?? '').slice(0, 5) } : null;
  // splitTab が閉じたタブを指していることがあるので、左と違う最初のタブに落とす。
  const right = view.split && canSplit && selectedTab ? open.find((x) => x.id === view.splitTab && x.id !== selectedTab) ?? open.find((x) => x.id !== selectedTab) ?? null : null;
  const sessionAccount = hasMultipleAccounts(store) ? accountOfSession(store, id) : null;
  const artifactCards = artifactsOf(store, { sessionId: id }).map((a) => presentArtifactCard(t, a, now));
  const account = sessionAccount ? { name: sessionAccount.name, color: sessionAccount.color } : null;
  // 現在の帯は生きた run があるときだけ。右パネルの「いま」の段が持っていた中身がここへ移る。
  // 止まっている理由（許可待ち、使用制限、リセット済み）。現在の札の欄、見出しの点、端末の縁が使う。
  const reason = stopReasonOf(s);
  const strip = alive ? presentNowCard({
    digest: store.liveDigests[id] ?? null, events, turnFrom: store.liveDigests[id]?.turnStartSeq ?? lastTurn?.from ?? 0,
    live: s.live, aside: asideOf(s.live, s.liveAside), activity: s.activity, now, viewingAgent: view.agentId !== null, clock: (ts) => when(ts).slice(0, 5),
    idleFor: durationLabel(t, now - (s.lastActivityAt ?? now)), results,
    waited: durationLabel(t, now - (s.lastActivityAt ?? now)), artifacts: artifactCards,
    reason, permission: s.permission, limit: s.limit, waitingFor: s.waitingFor,
    liveHints: store.settings?.liveHints !== false,
    // opencode の会話は、見出しの語と、意図が無いときの依頼と、札の下の使用量の欄が変わる（計画の C5）。
    agent: opencodeTab ? 'opencode' : 'claude-code',
    usage: opencodeTab ? { contextPercent: s.stats.contextPercent, contextTokens: s.stats.contextTokens ?? null, costUsd: s.stats.costUsd, model: s.stats.model } : null,
    firstPrompt: s.firstPrompt, firstTurn: s.stats.turns <= 1,
  }, t) : null;
  // 終わったセッションの見出しの下の 1 行と要約の札。ターミナルが出る間（run がある間）は出さない。
  const summaryOff = (store.settings?.summaryEngine ?? 'off') === 'off';
  const lead = run === null ? presentLeadCard({ session: s, now, gone: gone !== null, summaryPending: store.summaryPending[id] === true, summaryError: store.summaryFailed[id] ?? null, summaryOff, artifacts: artifactCards, editor: store.settings, files: store.sessionFiles[id] ?? null, windowFiles: changedFiles }, t) : null;
  const props: SessionProps = {
    ...base, account, name: s.name ?? t('common.label.noName'), live: s.live, aside: asideOf(s.live, s.liveAside) !== null, reason,
    // 見出しの上には、属するプロジェクトへ戻るリンクを出す。プロジェクトに属さない（まだ知らない）セッションでは出さない。
    parent: project ? { label: projectDisplayName(project, t), route: { name: 'project', id: project.id } } : null,
    oneLiner: s.summary?.oneLiner ? s.summary.oneLiner : null, hasTranscript: s.hasTranscript,
    items, total: slice?.total ?? 0, loaded: slice?.items.length ?? 0, loading: slice?.loading ?? false, hasMore: olderLeft, hasNewer: slice ? slice.nextSeq !== null : false, notFound: false,
    strip, overlap: alive ? presentOverlap(store, id, now) : null, lead, badges: presentSessionBadges(s, now, t),
    statusPick: gone ? null : { value: s.state?.status ?? 'active', ...statusMark(t, s.state, s.stats, s.summary, s.lastActivityAt) },
    // git の行は (i) の終わりに足す（ブランチ、worktree、作業ツリーの未コミット、このセッションの変更）。
    details: [...presentDetails(s, run, account, t, liveOf(store, s)?.address ?? null), ...gitDetailRows(t, store.git, id, store.sessions, store.gitChanges[id])],
    gitFix: gitUnsafeFix(store.git, id),
    git: store.git.sessions[id] ? { chip: presentGitChip(t, store.git, id, store.sessions), files: presentGitFiles(t, store.gitChanges[id]) } : null,
    turnRows, turnsComplete: complete, turnsPending, turnCount, loadingOlder: slice?.loadingOlder === true, openTurnItems, turnJump: view.turnJump,
    promptJump: agentOfSession(store, s) === 'claude-code',
    jump: view.jump,
    run: run ? { id: run.id, kind: run.kind, alive: run.endedAt === null, started: relativeTime(t, run.startedAt, now) } : null,
    tabs, selectedTab, trustHint: alive && s.live === null,
    // 他端末が動かしている間は再開もフォークもさせない。手元に写ししか無いセッションも同じである。
    // 手元で続けたいときは「この PC で再開」に回して、本文を降ろしてから新しい run を立てる。
    canResume: s.hasTranscript && idle && s.lock === null && !s.remoteOnly, canFork: s.hasTranscript && idle && s.lock === null && !s.remoteOnly,
    // Ruling 14。heartbeat が途絶えたロック（stale）は行き止まりにせず、「この PC で再開」だけを開ける。
    // 相手の run は止めに行かないので、同じ run の続きである再開とフォークは閉じたままにする。
    lock: lockProps(s.lock, now, t), remoteOnly: s.remoteOnly, canResumeHere: s.lock !== null || s.remoteOnly || s.newerElsewhere === true, newerElsewhere: s.newerElsewhere === true,
    // この PC にプロジェクトのフォルダが無いほかの PC の会話。「この PC で再開」を閉じ、見出しの下に理由と場所の指定を出す（1a）。
    noRoot: resumeHereOf(store, s, t)?.noRoot ?? null,
    takenOver: s.takenOver ? t('session.takenOver.line', { device: s.takenOver.deviceName, at: absoluteTime(t, s.takenOver.at) }) : null,
    // hangar の run が無いまま外で動いているとき、本文しか見せられない。hangar の端末で開く手を出す（store の outsideOpenOf）。
    outsideOpen: outsideOpenOf(store, s),
    summaryPending: store.summaryPending[id] === true, summaryError: store.summaryFailed[id] ?? null,
    fromScratch: s.fromScratch, canPromote: !!(s.projectId && store.projects[s.projectId]?.isScratch),
    split: right && selectedTab ? { left: selectedTab, right: right.id } : null, canSplit,
    gone, transcriptBand,
  };
  props.endedLine = run === null && opencodeTab && props.canResume ? 'opencode' : null;
  return { ...props, actions: sessionActions({ ...props, summaryOff }, t, openLabel(t, store.settings)) };
}
