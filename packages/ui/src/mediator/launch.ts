import type { LaunchParams } from '@agent-hangar/shared';
import { overlayReplaceable } from './overlay.ts';
import type { Effect, Input, LaunchPrefs, NewSessionDraft, State, Step } from './types.ts';

/** 新しいセッションのダイアログの書きかけを残す localStorage の鍵。値は NewSessionDraft か null。 */
export const NEW_SESSION_DRAFT_KEY = 'newSession.draft';
/** 詳細のプロジェクトごとの前回値を残す localStorage の鍵。値は launchPrefs そのもの。 */
export const LAUNCH_PREFS_KEY = 'newSession.prefs';
/** スクラッチの前回値の鍵。プロジェクトの id と重ならない綴りにする。 */
export const SCRATCH_PREFS = ':scratch';

// worktree は残さない。同じ名前が毎回初期値に入ると、前の worktree の中で起動してしまうからである。
const PREF_TEXT = ['model', 'effort', 'permissionMode'] as const;

/** 起動の params から、前回値として残す詳細だけを取り出す。空欄と既定は params に入らないので、入っているものだけが残る。 */
export function launchPrefsOf(params: LaunchParams): LaunchPrefs {
  const out: LaunchPrefs = {};
  for (const k of PREF_TEXT) if (params[k]) out[k] = params[k];
  if (params.addDirs?.length) out.addDirs = [...params.addDirs];
  return out;
}

/** localStorage から読んだ下書き。形が違えば（手で書き換えられたなど）捨てる。 */
export function readDraft(v: unknown): NewSessionDraft | null {
  if (!v || typeof v !== 'object') return null;
  const { name, prompt } = v as Record<string, unknown>;
  return typeof name === 'string' && typeof prompt === 'string' ? { name, prompt } : null;
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
    if (Object.keys(p).length) out[key] = p;
  }
  return out;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 起動を送ったときに、そのプロジェクトの前回値を書き換える。変わらなければ何もしない。 */
function rememberPrefs(state: State, params: LaunchParams): Step {
  const key = params.scratch ? SCRATCH_PREFS : params.projectId;
  if (!key) return { state, effects: [] };
  const prefs = launchPrefsOf(params);
  const { [key]: before, ...rest } = state.launchPrefs;
  const next = Object.keys(prefs).length ? { ...rest, [key]: prefs } : rest;
  if (sameJson(before ?? null, Object.keys(prefs).length ? prefs : null)) return { state, effects: [] };
  return { state: { ...state, launchPrefs: next }, effects: [{ kind: 'storage.save', key: LAUNCH_PREFS_KEY, value: next }] };
}

/** 下書きを書き換える。名前も初期プロンプトも空白だけなら消す。変わらなければ何もしない。 */
function setDraft(state: State, draft: NewSessionDraft | null): Step {
  const next = draft && (draft.name.trim() || draft.prompt.trim()) ? draft : null;
  if (sameJson(next, state.newSessionDraft)) return { state, effects: [] };
  return { state: { ...state, newSessionDraft: next }, effects: [{ kind: 'storage.save', key: NEW_SESSION_DRAFT_KEY, value: next }] };
}

/** launch 領域：起動ダイアログ、送信中、失敗。再開とフォークも同じ送信中の状態を使う。 */
export function launchStep(state: State, input: Input): Step | null {
  if (input.kind === 'runtime') {
    const ev = input.event;
    if (ev.type === 'launch.done') {
      // ダイアログから起動し終えたら、書きかけの下書きは役目を終えたので消す。再開やフォークの完了では触れない。
      // 送った後に Esc でダイアログを閉じても起動は止まらないので、送った印（newSessionSent）でも消す。
      const fromDialog = state.overlay.kind === 'newSession' || state.newSessionSent;
      const overlay = state.overlay.kind === 'newSession' ? { kind: 'none' as const } : state.overlay;
      const cleared = fromDialog ? setDraft(state, null) : { state, effects: [] as Effect[] };
      return { state: { ...cleared.state, launch: { kind: 'idle' }, overlay, newSessionSent: false }, effects: [{ kind: 'navigate', route: { name: 'session', id: ev.sessionId } }, ...cleared.effects] };
    }
    if (ev.type === 'launch.failed') {
      // 起動ダイアログが開いていれば、その中に同じ文言が出るのでトーストは重ねない。
      // 再開とフォークはダイアログを持たないので、そのときだけトーストで知らせる。
      const shown = state.overlay.kind === 'newSession';
      // 失敗した起動の下書きは、やり直せるよう残す。送った印だけ外す。
      const next = { ...state, launch: { kind: 'failed' as const, message: ev.message }, newSessionSent: false };
      return { state: next, effects: shown ? [] : [{ kind: 'toast', level: 'error', message: ev.message }] };
    }
    return null;
  }
  if (input.kind !== 'intent') return null;
  const i = input.intent;
  switch (i.type) {
    case 'session.new.open':
      // 確認や入力のあるダイアログが出ていれば、差し替えない（overlay.ts の overlayReplaceable）。
      if (!overlayReplaceable(state.overlay)) return { state, effects: [] };
      // スクラッチはプロジェクトを選ばずに開く。ダイアログ側でプロジェクトの選択欄を隠す。
      return { state: { ...state, overlay: { kind: 'newSession', projectId: i.projectId ?? null, scratch: i.scratch === true }, launch: { kind: 'idle' } }, effects: [{ kind: 'focus', target: 'newSessionName' }] };
    case 'session.new.submit':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      if (!i.params.projectId && !i.params.scratch) return { state: { ...state, launch: { kind: 'failed', message: 'プロジェクトを選んでください' } }, effects: [] };
      {
        // 詳細は、送った時点でそのプロジェクトの前回値にする。起動に失敗しても、選んだ詳細は利用者の意図なので残す。
        const r = rememberPrefs(state, i.params);
        return { state: { ...r.state, launch: { kind: 'submitting' }, newSessionSent: true }, effects: [{ kind: 'api.launch', params: i.params }, ...r.effects] };
      }
    case 'session.new.draft': return setDraft(state, { name: i.name, prompt: i.prompt });
    case 'overlay.close':
      // newSession のときだけ横取りする。
      // overlayStep の overlay.close はキューを進めるだけで、launch を idle に戻せない。
      if (state.overlay.kind !== 'newSession') return null;
      return { state: { ...state, overlay: { kind: 'none' }, launch: { kind: 'idle' } }, effects: [] };
    case 'session.resume': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.resume', sessionId: i.id }] };
    case 'session.fork': return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.fork', sessionId: i.id }] };
    case 'session.attach':
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      return { state: { ...state, launch: { kind: 'submitting' } }, effects: [{ kind: 'api.attach', sessionId: i.id }] };
    case 'session.adopt': {
      // 外のターミナルの claude を終わらせるので、押しただけでは動かさず、先に確認を出す。
      if (!i.confirmed) return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'adoptSession', sessionId: i.id } } }, effects: [] };
      if (state.launch.kind === 'submitting') return { state, effects: [] };
      const overlay = state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      // 元の claude が終わるのを待つので、開くまで数秒かかる。押したことが伝わるよう先に一言出す。
      return { state: { ...state, overlay, launch: { kind: 'submitting' } }, effects: [{ kind: 'toast', level: 'info', message: '引き取っています' }, { kind: 'api.adopt', sessionId: i.id }] };
    }
    case 'session.kill': {
      // サーバの停止はシェルタブを全部閉じてから tmux を落とす。
      // 作業中の Claude かシェルタブを巻き込むときだけ先に確認を出し、休みで巻き込むものが無ければすぐ止める。
      if (!i.confirmed && (i.working || i.shellTabs > 0)) {
        return { state: { ...state, overlay: { kind: 'confirm', confirm: { kind: 'killRun', runId: i.runId, working: i.working, shellTabs: i.shellTabs } } }, effects: [] };
      }
      const overlay = i.confirmed && state.overlay.kind === 'confirm' ? { kind: 'none' as const } : state.overlay;
      return { state: { ...state, overlay }, effects: [{ kind: 'api.killRun', runId: i.runId }] };
    }
    case 'session.openTerminalApp': return { state, effects: [{ kind: 'api.openTerminalApp', runId: i.runId, tabId: i.tabId ?? null }] };
    case 'session.openEditor': return { state, effects: [{ kind: 'api.openEditor', sessionId: i.sessionId }] };
    case 'project.openEditor': return { state, effects: [{ kind: 'api.projectOpenEditor', projectId: i.id }] };
    case 'project.openTerminalApp': return { state, effects: [{ kind: 'api.projectOpenTerminal', projectId: i.id }] };
    default: return null;
  }
}
