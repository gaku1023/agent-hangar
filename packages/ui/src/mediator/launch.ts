import { DEFAULT_AGENT_KIND, isAgentKind, type InvestigateContext, type LaunchParams, type NonDefaultAgentKind, type SessionLaunchSettingsDto, type UiAction } from '@agent-hangar/shared';
import { translatorOf } from '../presenters/i18n.ts';
import { investigateSeed, setupGuideSeed } from '../presenters/investigate.ts';
import type { Store } from '../store/store.ts';
import { overlayReplaceable } from './overlay.ts';
import type { Effect, Input, LaunchPrefs, LaunchPrepMark, NewSessionDraft, State, Step } from './types.ts';

/** 閉じた後に済んだ起動の知らせを出しておく長さ（ミリ秒）。既定の info（4 秒）より長く、「開く」を押す間を取る。 */
const NOTICE_MS = 8000;

/** 起動の要求に準備の鍵があれば、見張りの印にする。鍵が無い起動（Claude Code）は準備を持たない。 */
const prepMarkOf = (p: LaunchParams): LaunchPrepMark | null => (p.prepKey ? { key: p.prepKey, model: p.model ?? null, name: p.name ?? null } : null);

/** 新しいセッションのダイアログの書きかけを残す localStorage の鍵。値は NewSessionDraft か null。 */
export const NEW_SESSION_DRAFT_KEY = 'newSession.draft';
/** 詳細のプロジェクトごとの前回値を残す localStorage の鍵。値は launchPrefs そのもの。 */
export const LAUNCH_PREFS_KEY = 'newSession.prefs';
/** クイックセッションの前回値の鍵。プロジェクトの id と重ならない綴りにする。 */
export const SCRATCH_PREFS = ':scratch';

// worktree は残さない。同じ名前が毎回初期値に入ると、前の worktree の中で起動してしまうからである。
const PREF_TEXT = ['model', 'effort', 'permissionMode'] as const;

/**
 * 起動の params から、前回値として残す詳細だけを取り出す。空欄と既定は params に入らないので、入っているものだけが残る。
 * 設定の既定のモデル（defaultModel）と同じモデルは残さない。残すと、既定のモデルを変えてもそのプロジェクトだけ古い既定に留まる。
 * before はそのプロジェクトの前の前回値である。opencode で起こしたときは、Claude Code の札の値を前のまま残し、エージェントと opencode のモデルだけを書き換える。
 * Claude Code で起こしたときは、opencode のモデルを前のまま残す。opencode のモードと自動承認は残さない（自動承認は毎回オフから始める）。
 * Codex で起こしたときは、エージェントとモデルと推論の段階だけを書き換える（Claude の札と opencode のモデルは前のまま。権限は毎回自動から始めるので残さない）。
 * Codex のモデルと推論は、どのエージェントで起こしても前のまま残す。
 */
export function launchPrefsOf(params: LaunchParams, defaultModel: string | null = null, before: LaunchPrefs = {}): LaunchPrefs {
  if (params.agent === 'opencode') {
    const { agent: _agent, opencodeModel: _model, worktree: _worktree, ...claude } = before;
    return { ...claude, agent: 'opencode', ...(params.model ? { opencodeModel: params.model } : {}) };
  }
  if (params.agent === 'codex') {
    const { agent: _agent, codexModel: _model, codexEffort: _effort, worktree: _worktree, ...claude } = before;
    return { ...claude, agent: 'codex', ...(params.model ? { codexModel: params.model } : {}), ...(params.effort ? { codexEffort: params.effort } : {}) };
  }
  const out: LaunchPrefs = {};
  for (const k of PREF_TEXT) if (params[k] && !(k === 'model' && params[k] === defaultModel)) out[k] = params[k];
  if (params.addDirs?.length) out.addDirs = [...params.addDirs];
  if (before.opencodeModel) out.opencodeModel = before.opencodeModel;
  if (before.codexModel) out.codexModel = before.codexModel;
  if (before.codexEffort) out.codexEffort = before.codexEffort;
  return out;
}

/** localStorage から読んだ下書き。形が違えば（手で書き換えられたなど）捨てる。添付の配列が無いもの（添付を足す前の形）も、形が違うものとして捨てる。 */
export function readDraft(v: unknown): NewSessionDraft | null {
  if (!v || typeof v !== 'object') return null;
  const { name, prompt, attachments } = v as Record<string, unknown>;
  if (typeof name !== 'string' || typeof prompt !== 'string' || !Array.isArray(attachments)) return null;
  const ok = (a: unknown): a is NewSessionDraft['attachments'][number] => {
    if (!a || typeof a !== 'object') return false;
    const r = a as Record<string, unknown>;
    return typeof r.path === 'string' && typeof r.name === 'string' && (r.size === null || typeof r.size === 'number');
  };
  // 空のパスと同じパスの重複は捨てる（手で書き換えられた保存値が、札の key の重複にならないように）。
  const seen = new Set<string>();
  const kept = attachments.filter(ok).filter((a) => a.path !== '' && !seen.has(a.path) && !!seen.add(a.path));
  return { name, prompt, attachments: kept.map((a) => ({ path: a.path, name: a.name, size: a.size })) };
}

/** localStorage から読んだ前回値。形の違う項目は捨て、残りが空になったプロジェクトは外す。 */
export function readLaunchPrefs(v: unknown): Record<string, LaunchPrefs> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const out: Record<string, LaunchPrefs> = {};
  for (const [key, raw] of Object.entries(v as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const p: LaunchPrefs = {};
    for (const k of PREF_TEXT) { const x = r[k]; if (typeof x === 'string' && x) p[k] = x; }
    if (Array.isArray(r.addDirs) && r.addDirs.length && r.addDirs.every((d) => typeof d === 'string')) p.addDirs = r.addDirs as string[];
    if (isAgentKind(r.agent) && r.agent !== DEFAULT_AGENT_KIND) p.agent = r.agent as NonDefaultAgentKind;
    if (typeof r.opencodeModel === 'string' && r.opencodeModel) p.opencodeModel = r.opencodeModel;
    if (typeof r.codexModel === 'string' && r.codexModel) p.codexModel = r.codexModel;
    if (typeof r.codexEffort === 'string' && r.codexEffort) p.codexEffort = r.codexEffort;
    if (Object.keys(p).length) out[key] = p;
  }
  return out;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 起動を送ったときに、そのプロジェクトの前回値を書き換える。変わらなければ何もしない。 */
function rememberPrefs(state: State, params: LaunchParams, defaultModel: string | null): Step {
  const key = params.scratch ? SCRATCH_PREFS : params.projectId;
  if (!key) return { state, effects: [] };
  const { [key]: before, ...rest } = state.launchPrefs;
  const prefs = launchPrefsOf(params, defaultModel, before);
  const next = Object.keys(prefs).length ? { ...rest, [key]: prefs } : rest;
  if (sameJson(before ?? null, Object.keys(prefs).length ? prefs : null)) return { state, effects: [] };
  return { state: { ...state, launchPrefs: next }, effects: [{ kind: 'storage.save', key: LAUNCH_PREFS_KEY, value: next }] };
}

/** 下書きを書き換える。名前も初期プロンプトも空白だけで、添付も無ければ消す。変わらなければ何もしない。 */
function setDraft(state: State, draft: NewSessionDraft | null): Step {
  const next = draft && (draft.name.trim() || draft.prompt.trim() || draft.attachments.length) ? draft : null;
  if (sameJson(next, state.newSessionDraft)) return { state, effects: [] };
  return { state: { ...state, newSessionDraft: next }, effects: [{ kind: 'storage.save', key: NEW_SESSION_DRAFT_KEY, value: next }] };
}

/**
 * 再開を、終わった扱いの run の claude が動き続けていることで断られた（issue #258）。止めて再開するかを聞く確認を開く。
 * 1 本の再開は送信中を解き、確認を出せない（決めるまで閉じないダイアログが開いている）ときは、起動の失敗と同じくトーストで理由を出す。
 * まとめて再開の 1 本は、理由を行に残してある（resumeQueue.failed）ので、確認を出せなければ何もしない。
 */
function strayConflict(state: State, ev: Extract<Input, { kind: 'runtime' }>['event'] & { type: 'api.conflict'; kind: 'strayProcess' }): Step {
  const launch = ev.queued ? state.launch : { kind: 'idle' as const };
  if (overlayReplaceable(state.overlay)) {
    const confirm = { kind: 'strayProcess' as const, sessionId: ev.sessionId, pid: ev.pid, ...(ev.queued ? { queued: true as const } : {}) };
    return { state: { ...state, launch, overlay: { kind: 'confirm', confirm } }, effects: [] };
  }
  if (ev.queued) return { state, effects: [] };
  return { state: { ...state, launch: { kind: 'failed', message: ev.message } }, effects: [{ kind: 'toast', level: 'error', message: ev.message }] };
}

/** 送った起動の、失敗したときに「エージェントで調査…」へ渡す事情。エージェントを選ばなければ Claude Code である。 */
const sentOf = (params: LaunchParams): State['launchSent'] => ({ op: 'launch', agent: params.agent ?? 'claude-code', ...(params.account ? { accountId: params.account } : {}) });
/**
 * 「同じ設定で新しいセッション…」で開くダイアログ。元の会話のプロジェクトと設定を種に入れ、本文は空にする。起動は利用者が押してから。
 * クイックセッションと未分類はクイックセッションで開く。アカウントは元のエージェントの札へ入れる。
 */
export function duplicateOpenAction(store: Store, id: string, s: SessionLaunchSettingsDto): Extract<UiAction, { type: 'session.new.open' }> {
  const projectId = store.sessions[id]?.projectId ?? null;
  const { account, ...settings } = s;
  const accounts = account === null || s.agent === 'opencode' ? {} : { [s.agent]: account };
  const seed = { request: '', quote: '', accounts, settings };
  return projectId && !store.projects[projectId]?.isScratch ? { type: 'session.new.open', projectId, seed } : { type: 'session.new.open', scratch: true, seed };
}

/** 送った印。埋めて開いたダイアログから送ったときは、下書きを消さないよう seeded にする。 */
const sentMark = (state: State): State['newSessionSent'] => (state.overlay.kind === 'newSession' && state.overlay.seed ? 'seeded' : true);

/** 失敗のトーストに「エージェントで調査…」を付けて積む。 */
export function pushInvestigateToast(state: State, store: Store, ctx: InvestigateContext): State {
  const t = translatorOf(store);
  const toast = { id: String(state.nextToastId), level: 'error' as const, message: ctx.message, action: { label: t('newSession.investigate.button'), title: t('newSession.investigate.title'), send: { type: 'investigate.open' as const, ...ctx } } };
  return { ...state, toasts: [...state.toasts, toast], nextToastId: state.nextToastId + 1 };
}

/** launch 領域：起動ダイアログ、送信中、失敗。再開とフォークも同じ送信中の状態を使う。 */
export function launchStep(state: State, store: Store, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const ev = input.event;
    if (ev.type === 'api.conflict' && ev.kind === 'strayProcess') return strayConflict(state, ev);
    if (ev.type === 'project.created') {
      // 作ってから起動する送信の途中で、プロジェクトができた。起動だけが失敗しても押し直しで二重に作らないよう印を持ち、
      // 送った詳細をそのプロジェクトの前回値にする（送った時点ではプロジェクトの id が無かったため）。
      if (state.launch.kind !== 'submitting') return { state, effects: [] };
      const r = rememberPrefs(state, ev.params, store.settings?.defaultModel ?? null);
      return { state: { ...r.state, launch: { kind: 'submitting', createdProjectId: ev.projectId } }, effects: r.effects };
    }
    if (ev.type === 'launch.done') {
      // ダイアログから起動し終えたら、書きかけの下書きは役目を終えたので消す。再開やフォークの完了では触れない。
      // 送った後に Esc でダイアログを閉じても起動は止まらないので、送った印（newSessionSent）でも消す。
      // 埋めて開いたダイアログ（「エージェントで調査…」）は下書きを使っていないので、消さない。
      const seeded = (state.overlay.kind === 'newSession' && !!state.overlay.seed) || state.newSessionSent === 'seeded';
      const fromDialog = !seeded && (state.overlay.kind === 'newSession' || state.newSessionSent);
      const overlay = state.overlay.kind === 'newSession' ? { kind: 'none' as const } : state.overlay;
      const cleared = fromDialog ? setDraft(state, null) : { state, effects: [] as Effect[] };
      const done: State = { ...cleared.state, launch: { kind: 'idle' }, overlay, newSessionSent: false, launchSent: null, launchPrep: null };
      // 段のあった準備（ローカルのモデルを載せた）の進みを見ていて、閉じた後に済んだときは、勝手に会話の画面へ移さず、右下の知らせで知らせる。
      // 段の無い準備は何も届かず、今までと見た目が同じなので、今までどおり移る。
      const prep = state.launchPrep ? store.launchPreps[state.launchPrep.key] : undefined;
      if (state.newSessionSent && state.overlay.kind !== 'newSession' && prep && prep.steps.length > 0) {
        const t = translatorOf(store);
        const name = store.sessions[ev.sessionId]?.name ?? state.launchPrep?.name ?? t('common.label.noName');
        const toast = { id: String(done.nextToastId), level: 'info' as const, message: t('launchPrep.notice.started', { name }), holdMs: NOTICE_MS, action: { label: t('launchPrep.notice.open'), send: { type: 'session.open' as const, id: ev.sessionId } } };
        return { state: { ...done, toasts: [...done.toasts, toast], nextToastId: done.nextToastId + 1 }, effects: cleared.effects };
      }
      return { state: done, effects: [{ kind: 'navigate', route: { name: 'session', id: ev.sessionId } }, ...cleared.effects] };
    }
    if (ev.type === 'launch.halted') {
      // 準備が問いで止まったか、利用者がやめた。失敗ではない。ダイアログが開いていれば進みと問いの札がそこに出るので、何も重ねない。
      // 閉じた後に問いで止まったときだけ、続けるには確認が要ることを知らせる（やめたのは利用者自身なので、知らせない）。
      const created = state.launch.kind === 'submitting' || state.launch.kind === 'halted' ? state.launch.createdProjectId : undefined;
      const shown = state.overlay.kind === 'newSession';
      return { state: { ...state, launch: { kind: 'halted', ...(created ? { createdProjectId: created } : {}) }, newSessionSent: false }, effects: shown || ev.why === 'cancel' ? [] : [{ kind: 'toast', level: 'error', message: ev.message }] };
    }
    if (ev.type === 'launch.failed') {
      // 起動ダイアログが開いていれば、その中に同じ文言が出るのでトーストは重ねない。
      // 再開とフォークはダイアログを持たないので、そのときだけトーストで知らせる。
      const shown = state.overlay.kind === 'newSession';
      // 失敗した起動の下書きは、やり直せるよう残す。送った印だけ外す。
      const created = state.launch.kind === 'submitting' ? state.launch.createdProjectId : undefined;
      const next = { ...state, launch: { kind: 'failed' as const, message: ev.message, ...(created ? { createdProjectId: created } : {}), ...(ev.linkConflict ? { linkConflict: ev.linkConflict } : {}) }, newSessionSent: false, launchSent: null };
      if (shown) return { state: next, effects: [] };
      // リンクの場所のファイルの衝突は、トーストから修復のダイアログへ進める（#513）。
      if (ev.linkConflict) {
        const label = translatorOf(store)('account.repair.button');
        const toast = { id: String(next.nextToastId), level: 'error' as const, message: ev.message, action: { label, send: { type: 'linkRepair.open' as const, ...ev.linkConflict } } };
        return { state: { ...next, toasts: [...next.toasts, toast], nextToastId: next.nextToastId + 1 }, effects: [] };
      }
      // 何を送ったか分かる失敗（起動、再開、フォーク）は、トーストから「エージェントで調査…」へ進める。
      const sent = state.launchSent;
      if (sent) return { state: pushInvestigateToast(next, store, { ...sent, message: ev.message }), effects: [] };
      return { state: next, effects: [{ kind: 'toast', level: 'error', message: ev.message }] };
    }
    return null;
  }
  if (input.kind !== 'action') return null;
  const i = input.action;
  switch (i.type) {
    case 'session.new.open':
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      // クイックセッションはプロジェクトを選ばずに開く。ダイアログ側でプロジェクトの選択欄を隠す。
      // 前の起動の準備は、まだ走っているときだけ残す（開き直した画面に進みと「準備を中止」を出す）。止まった問いと失敗は、新しい画面に持ち越さない。
      return { state: { ...state, overlay: { kind: 'newSession', projectId: i.projectId ?? null, scratch: i.scratch === true, ...(i.dir ? { dir: i.dir } : {}), ...(i.seed ? { seed: i.seed } : {}) }, launch: { kind: 'idle' }, launchPrep: state.launchPrep && store.launchPreps[state.launchPrep.key]?.phase === 'running' ? state.launchPrep : null }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    case 'investigate.open': {
      // エラーの札から。修復のダイアログと、起動に失敗した新しいセッションのダイアログからは、それを閉じて差し替える。
      // ほかの確認や入力のダイアログが出ていれば、差し替えない（session.new.open と同じ）。
      const o = state.overlay;
      // アカウントを足すダイアログの失敗の行からも、それを閉じて差し替える。
      if (o.kind !== 'linkRepair' && o.kind !== 'newSession' && o.kind !== 'addAccount' && !overlayReplaceable(o)) return { state, effects: [] };
      const { type: _type, ...ctx } = i;
      const cleared: State = {
        ...state, overlay: { kind: 'none' },
        ...(o.kind === 'linkRepair' ? { linkRepair: { detail: null, working: false, error: null } } : {}),
        ...(o.kind === 'addAccount' ? { accountAdd: { kind: 'idle' as const } } : {}),
      };
      return launchStep(cleared, store, { kind: 'action', action: { type: 'session.new.open', scratch: true, seed: investigateSeed(store, ctx) } });
    }
    case 'setupGuide.launch': {
      // 設定の札とホームの「仕上げ」の行から。すゝめの一言と準備の状況を入れたクイックセッションのダイアログを開く（すぐには起動しない）。
      const seed = setupGuideSeed(store);
      if (!seed) return { state, effects: [] };
      return launchStep(state, store, { kind: 'action', action: { type: 'session.new.open', scratch: true, seed } });
    }
    case 'opencode.providers.manage': {
      // ダイアログから来たときだけ、戻る先を覚える。ダイアログを閉じて、設定の opencode の面へ移る。
      const o = state.overlay;
      const back = o.kind === 'newSession' ? { projectId: o.projectId, scratch: o.scratch, ...(o.dir ? { dir: o.dir } : {}) } : null;
      return { state: { ...state, overlay: o.kind === 'newSession' ? { kind: 'none' } : o, launch: { kind: 'idle' }, opencodeReturn: back }, effects: [{ kind: 'navigate', route: { name: 'settings', at: 'opencode' } }] };
    }
    case 'opencode.providers.back': {
      const back = state.opencodeReturn;
      if (!back) return { state, effects: [] };
      return launchStep({ ...state, opencodeReturn: null }, store, { kind: 'action', action: { type: 'session.new.open', scratch: back.scratch, ...(back.projectId ? { projectId: back.projectId } : {}), ...(back.dir ? { dir: back.dir } : {}) } });
    }
    case 'session.new.submit':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      // 新しいフォルダと未登録のフォルダは、プロジェクトを作ってから起動する（runtime が 2 つを順に行う）。
      if (i.place) return { state: { ...state, launch: { kind: 'submitting' }, launchSent: sentOf(i.params), newSessionSent: sentMark(state), launchPrep: prepMarkOf(i.params) }, effects: [{ kind: 'api.createProjectThenLaunch', place: i.place, params: i.params }] };
      if (!i.params.projectId && !i.params.scratch) return { state: { ...state, launch: { kind: 'failed', message: translatorOf(store)('mediator.launch.pickProject') } }, effects: [] };
      {
        // 詳細は、送った時点でそのプロジェクトの前回値にする。起動に失敗しても、選んだ詳細は利用者の意図なので残す。
        const r = rememberPrefs(state, i.params, store.settings?.defaultModel ?? null);
        return { state: { ...r.state, launch: { kind: 'submitting' }, launchSent: sentOf(i.params), newSessionSent: sentMark(state), launchPrep: prepMarkOf(i.params) }, effects: [{ kind: 'api.launch', params: i.params }, ...r.effects] };
      }
    case 'session.new.draft': return setDraft(state, { name: i.name, prompt: i.prompt, attachments: i.attachments ?? [] });
    case 'session.new.draft.attach': {
      // 名前と本文は、いまの下書きのまま残す。同じパスは足さない（setDraft は変わらなければ何もしない）。
      const cur = state.newSessionDraft ?? { name: '', prompt: '', attachments: [] };
      const have = new Set(cur.attachments.map((x) => x.path));
      const fresh = i.attachments.filter((x) => !have.has(x.path) && !!have.add(x.path));
      return setDraft(state, { ...cur, attachments: [...cur.attachments, ...fresh] });
    }
    case 'overlay.close':
      // newSession のときだけ横取りする。
      // overlayStep の overlay.close はキューを進めるだけで、launch を idle に戻せない。
      if (state.overlay.kind !== 'newSession') return null;
      return { state: { ...state, overlay: { kind: 'none' }, launch: { kind: 'idle' } }, effects: [] };
    case 'session.resume': {
      // 残った claude の確認から選んだときは、確認を閉じてから送る。
      const overlay = i.stray && state.overlay.kind === 'confirm' && state.overlay.confirm.kind === 'strayProcess' ? { kind: 'none' as const } : state.overlay;
      // 鍵があれば、準備の進み（opencode の接続先の準備）を右下の札で見せるために覚える。準備の無い再開は何も届かないので、札は出ない。
      const launchPrep = i.prepKey ? { key: i.prepKey, model: null, name: null, resume: true as const } : state.launchPrep;
      return { state: { ...state, overlay, launch: { kind: 'submitting' }, launchSent: { op: 'resume', sessionId: i.id }, launchPrep }, effects: [{ kind: 'api.resume', sessionId: i.id, ...(i.stray ? { stray: i.stray } : {}), ...(i.prepKey ? { prepKey: i.prepKey } : {}) }] };
    }
    case 'session.fork': return { state: { ...state, launch: { kind: 'submitting' }, launchSent: { op: 'fork', sessionId: i.id } }, effects: [{ kind: 'api.fork', sessionId: i.id }] };
    case 'session.attach':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.attach', sessionId: i.id }] };
    case 'session.adopt': {
      // 外のターミナルの claude を終わらせるので、押しただけでは動かさず、先に確認を出す。
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'adoptSession', sessionId: i.id } } }, effects: [] };
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      // 元の claude が終わるのを待つので、開くまで数秒かかる。押したことが伝わるよう先に一言出す。
      return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'toast', level: 'info', message: translatorOf(store)('mediator.launch.adopting') }, { kind: 'api.adopt', sessionId: i.id }] };
    }
    case 'session.kill': {
      // サーバの停止はシェルタブを全部閉じてから tmux を落とす。
      // 作業中の Claude かシェルタブを巻き込むときだけ先に確認を出し、休みで巻き込むものが無ければすぐ止める。
      if (!i.confirmed && (i.working || i.shellTabs > 0)) {
        return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'killRun', runId: i.runId, working: i.working, aside: i.aside, shellTabs: i.shellTabs } } }, effects: [] };
      }
      const overlay = i.confirmed && state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay }, effects: [{ kind: 'api.killRun', runId: i.runId }] };
    }
    default: return null;
  }
}
