import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LaunchParams, ProjectPlace } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { LaunchPrefs } from '../mediator/types.ts';
import { SCRATCH_CHOICE, type NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { ChoiceChips } from './primitives/Chip.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Fold } from './primitives/Fold.tsx';
import { Icon } from './primitives/Icon.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import type { ListboxAction, ListboxOption } from './primitives/listboxModel.ts';
import { CheckCard, OptionCards, type OptionCardItem } from './primitives/OptionCard.tsx';
import { Segmented } from './primitives/Segmented.tsx';

// 値は claude --help の --model の別名、--effort と --permission-mode の選択肢に合わせる。
// 空の値は「既定」で、params に含めず利用者の Claude Code の設定に従わせる。
const MODELS = [{ value: '', label: '既定' }, { value: 'fable', label: 'fable' }, { value: 'opus', label: 'opus' }, { value: 'sonnet', label: 'sonnet' }, { value: 'haiku', label: 'haiku' }];
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSIONS: OptionCardItem[] = [
  { value: '', label: '既定', description: 'Claude Code の設定に従う', icon: 'permissionDefault' },
  { value: 'manual', label: '都度たずねる', description: '編集もコマンドも確認する', code: 'manual', icon: 'permissionManual' },
  { value: 'acceptEdits', label: '編集は任せる', description: 'ファイルの編集は確認しない', code: 'acceptEdits', icon: 'permissionAcceptEdits' },
  { value: 'plan', label: '計画だけ', description: '読むだけで何も変えない', code: 'plan', icon: 'permissionPlan' },
  { value: 'auto', label: '自動', description: '安全なものは自動で許す', code: 'auto', icon: 'permissionAuto' },
  { value: 'dontAsk', label: 'たずねずに断る', description: '許可済みのもの以外は断る', code: 'dontAsk', icon: 'permissionDontAsk' },
  { value: 'bypassPermissions', label: '確認なし', description: 'すべて確認せずに実行する', code: 'bypassPermissions', icon: 'permissionBypass', danger: true },
];

/** effort の強さを 5 段の棒で添える。既定には付けない。 */
function EffortBars(props: { level: number }) {
  return <span className="effort-bars">{[1, 2, 3, 4, 5].map((i) => <i key={i} data-on={i <= props.level ? 'true' : undefined} />)}</span>;
}
const EFFORT_OPTIONS = EFFORTS.map((e, i) => ({ value: e, label: e || '既定', lead: e ? <EffortBars level={i} /> : undefined }));

/** プロジェクトの一覧の先頭に置くスクラッチの行。値はプロジェクトの id と重ならず、スクラッチの前回値の鍵と同じ綴りである。 */
const SCRATCH = SCRATCH_CHOICE;
const SCRATCH_OPTION: ListboxOption = { value: SCRATCH, label: 'スクラッチ', sub: '名前は決めずに始めて、あとでプロジェクトに昇格できる', subKind: 'prose', faceSub: '~/.agent-hangar/scratch/<日時>/', icon: 'scratch' };
/** 新しいフォルダの行の値。プロジェクトの id ともスクラッチとも重ならない。行は顔にだけ使い、一覧には並べない。 */
const NEW_DIR = ':new';
/** 既存のフォルダ（未登録と Finder）の行の値の頭。後ろにパスを付ける。 */
const DIR = ':dir:';
const isDir = (v: string) => v.startsWith(DIR);

/** 詳細の欄の値。追加ディレクトリは欄のまま 1 行 1 つの文字で持つ。 */
type Options = { model: string; effort: string; permissionMode: string; worktree: string; addDirs: string };
const DEFAULT_OPTIONS: Options = { model: '', effort: '', permissionMode: '', worktree: '', addDirs: '' };
const optionsOf = (p: LaunchPrefs | undefined): Options => ({ model: p?.model ?? '', effort: p?.effort ?? '', permissionMode: p?.permissionMode ?? '', worktree: p?.worktree ?? '', addDirs: p?.addDirs?.join('\n') ?? '' });
const dirsOf = (text: string): string[] => text.split('\n').map((d) => d.trim()).filter(Boolean);
const sameOptions = (a: Options, b: Options): boolean => a.model.trim() === b.model.trim() && a.effort === b.effort && a.permissionMode === b.permissionMode && a.worktree.trim() === b.worktree.trim() && dirsOf(a.addDirs).join('\n') === dirsOf(b.addDirs).join('\n');

/** 詳細の見出しに並べる、既定でない値。区切りは読点にする。 */
function optionParts(o: Options): string[] {
  const dirs = dirsOf(o.addDirs).length;
  return [o.model.trim(), o.effort, PERMISSIONS.find((p) => p.value && p.value === o.permissionMode)?.label ?? '', o.worktree.trim() && `worktree ${o.worktree.trim()}`, dirs ? `追加ディレクトリ ${dirs} 件` : ''].filter(Boolean);
}

/**
 * 起動ダイアログ。必須はプロジェクトだけで、空欄と既定は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * 欄はすべてここの状態で持つ。詳細の見出しに選んだ値を送信の前から出し、下書きを戻して消せるようにするためである。
 * スクラッチはプロジェクトの一覧の先頭の 1 行として選ぶ。props.scratch は開いたときにその行を選んでおくかどうかである。
 * 詳細の初期値は、選んだプロジェクトの前回値（props.prefs）にする（D1）。
 * 名前と初期プロンプトの書きかけは、閉じるときに下書きとして送り、次に開いたときに props.draft から戻す（C1）。
 * 打鍵のたびには送らない。送るたびに画面全体を描き直すことになるからである。
 * プロジェクトが未選択のまま送っても止めない。未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const [choice, setChoice] = useState(() => {
    // サーバも scratch を projectId より優先する。
    if (props.scratch) return SCRATCH;
    return props.projectId && props.projects.some((p) => p.id === props.projectId) ? props.projectId : '';
  });
  const scratch = choice === SCRATCH;
  const newDir = choice === NEW_DIR;
  const dirPath = isDir(choice) ? choice.slice(DIR.length) : null;
  // 未登録の一覧に載っているのはワークスペース直下のフォルダだけなので、載っていなければ外か深い階層である。
  const outside = dirPath !== null && !props.dirs.some((d) => d.path === dirPath);
  const root = props.workspaceRoot ?? '~/workspace';
  const title = scratch ? 'スクラッチで始める' : newDir ? '新しいフォルダで始める' : dirPath ? 'フォルダを登録して始める' : '新しいセッション';
  // 新しいフォルダの名前と git init。名前は「『語』を新しいフォルダとして作る」で選んだときの語を入れる。
  const [newName, setNewName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  // Finder で選んだ、未登録の一覧に無いフォルダ（ワークスペースの外か深い階層）。行を持たないので、ここで覚えて行を足す。
  const [extraDir, setExtraDir] = useState<string | null>(null);
  // 開いた時点の Finder の回数。これより新しい結果だけを使う。別のダイアログで選んだ結果が当たらないようにするためである。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);
  const [name, setName] = useState(props.draft?.name ?? '');
  const [prompt, setPrompt] = useState(props.draft?.prompt ?? '');
  // 開いたときに下書きを戻したか。「消す」を押すまで見出しに札を出す。
  const [restored, setRestored] = useState(props.draft !== null);
  // 詳細の初期値は、選んだプロジェクトの前回値にする（D1）。
  // 利用者が詳細に触れる前にプロジェクトを選び直したら、そのプロジェクトの前回値に入れ替える。触れた後は、自分で選んだ値を残す。
  const [detail, setDetail] = useState(() => optionsOf(props.prefs[choice]));
  const [touched, setTouched] = useState(false);
  // 値を外から入れ替えた回数。model の択一は「ほか」の欄を開いたかを自分で覚えるので、入れ替えたら作り直す。
  const [replaced, setReplaced] = useState(0);
  const setOption = <K extends keyof Options>(key: K) => (value: Options[K]) => { setTouched(true); setDetail((o) => ({ ...o, [key]: value })); };
  // 失敗の文言は、その送信の結果である。プロジェクトを選び直したら古い文言は出さず、送り直したらまた出す。
  // 同じ文言が続けて返ることがあるので、文言ではなく「選び直した時点の文言」を覚えて比べる。
  const [staleError, setStaleError] = useState<string | null>(null);
  const choose = (value: string) => {
    setChoice(value);
    setStaleError(props.error);
    if (touched) return;
    setDetail(optionsOf(props.prefs[value]));
    setReplaced((n) => n + 1);
  };
  useEffect(() => {
    const p = props.picked;
    if (!p || p.n <= pickedAtOpen.current) return;
    pickedAtOpen.current = p.n;
    const known = props.projects.find((x) => x.path === p.path);
    if (known) { choose(known.id); return; }
    if (!props.dirs.some((d) => d.path === p.path)) setExtraDir(p.path);
    choose(DIR + p.path);
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // 作れた後に起動だけが失敗した。押し直しで二重に作らないよう、作ったプロジェクトを選び直す。
    if (props.createdProjectId) setChoice(props.createdProjectId);
  }, [props.createdProjectId]);
  const resetDetail = () => { setTouched(true); setDetail(DEFAULT_OPTIONS); setReplaced((n) => n + 1); };
  const { model, effort, permissionMode, worktree, addDirs } = detail;
  const nameInput = useRef<HTMLInputElement>(null);

  // 閉じるとき（どの経路で閉じても、ダイアログは外される）に、書きかけを下書きとして送る。
  // 起動を送った後に外されたときは、起動し終えたので送らない（Mediator が下書きを消す）。
  const latest = useRef({ name, prompt, submitting: props.submitting, emit });
  latest.current = { name, prompt, submitting: props.submitting, emit };
  useEffect(() => () => {
    const l = latest.current;
    if (!l.submitting) l.emit({ type: 'session.new.draft', name: l.name, prompt: l.prompt });
  }, []);

  const discardDraft = () => {
    setName('');
    setPrompt('');
    setRestored(false);
    emit({ type: 'session.new.draft', name: '', prompt: '' });
    nameInput.current?.focus();
  };

  const submit = () => {
    if (props.submitting) return;
    setStaleError(null);
    const params: LaunchParams = {};
    let place: ProjectPlace | undefined;
    // スクラッチはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (scratch) params.scratch = true;
    // 新しいフォルダと未登録のフォルダは、Mediator がプロジェクトを作ってから起動する。
    else if (newDir) place = { kind: 'newDir', name: newName.trim(), gitInit };
    else if (dirPath) place = { kind: 'dir', path: dirPath };
    else if (choice) params.projectId = choice;
    if (name.trim()) params.name = name.trim();
    if (prompt.trim()) params.prompt = prompt.trim();
    if (model.trim()) params.model = model.trim();
    if (effort) params.effort = effort;
    if (permissionMode) params.permissionMode = permissionMode;
    if (worktree.trim()) params.worktree = worktree.trim();
    const dirs = dirsOf(addDirs);
    if (dirs.length) params.addDirs = dirs;
    emit({ type: 'session.new.submit', params, ...(place ? { place } : {}) });
  };

  // ⌘Enter（Ctrl+Enter でも）はどこからでも起動する。初期プロンプトの欄の中でも起動できるようにするためである。
  // 素の Enter は、テキストエリアでは改行、ほかの欄では起動にする。Esc は殻が受けて閉じる。
  // 変換中の Enter は確定のための打鍵なので、起動に使わない。
  // 一覧を開いている間の Esc と Enter は、Listbox が止めるのでここまで来ない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    // 選択の部品、ボタン、詳細の見出しの Enter は、その部品の操作である。起動には使わない。
    if ((e.target as HTMLElement).closest('button, summary, [role="radio"]')) return;
    e.preventDefault();
    submit();
  };

  const recent = new Set(props.recentIds);
  const options: ListboxOption[] = [
    SCRATCH_OPTION,
    ...props.projects.map((p) => ({ value: p.id, label: p.name, sub: p.path ?? undefined, meta: p.lastActivity || undefined, status: p.status })),
    ...props.dirs.map((d) => ({ value: DIR + d.path, label: d.name, sub: d.path, icon: 'folder' as const, tag: '未登録', searchOnly: true })),
    ...(extraDir ? [{ value: DIR + extraDir, label: extraDir.split('/').pop() || extraDir, sub: extraDir, icon: 'folder' as const, hidden: true }] : []),
    { value: NEW_DIR, label: newName.trim() || '新しいフォルダ', faceSub: `${root}/${newName.trim()}（新しく作る）`, icon: 'folderPlus', hidden: true },
  ];
  // 作れない名前。APFS は大文字小文字を区別しないので、小文字で比べる。
  const names = new Set([...props.takenNames, ...props.projects.map((p) => p.name), ...props.dirs.map((d) => d.name)].map((n) => n.toLowerCase()));
  const taken = (t: string) => names.has(t.toLowerCase());
  const actions = (q: string): ListboxAction[] => {
    const t = q.trim();
    const first: ListboxAction = t && !taken(t)
      ? { value: 'new', label: `「${t}」を新しいフォルダとして作る`, sub: `${root}/${t}`, icon: 'folderPlus' }
      : { value: 'new', label: '新しいフォルダを作る…', icon: 'folderPlus' };
    return props.desktop ? [first, { value: 'finder', label: 'ほかの場所を選ぶ…', sub: 'Finder', icon: 'folderOpen' }] : [first];
  };
  const onAction = (value: string, q: string) => {
    if (value === 'finder') { emit({ type: 'folder.pick' }); return; }
    const t = q.trim();
    if (t && !taken(t)) setNewName(t);
    choose(NEW_DIR);
  };
  const groups = [{ title: 'すぐ始める', values: [SCRATCH] }, { title: '最近', values: props.recentIds }, { title: 'すべて', values: props.projects.filter((p) => !recent.has(p.id)).map((p) => p.id) }];
  const parts = optionParts(detail);
  // 前回値のままなら、畳んだままでも「前回と同じ」と中身が読めるようにし、「既定に戻す」を添える（D1）。
  // 既定に戻すは詳細の見出しの中にあるので、押しても詳細を開閉しない。
  const prev = props.prefs[choice];
  const sameAsPrev = !!prev && parts.length > 0 && sameOptions(detail, optionsOf(prev));
  // 区切りに全角空白を使わない。読み上げと試験の正規化で空白が詰められ、見た目と一致しなくなるため。
  const foldSummary = sameAsPrev
    ? (
      <>
        <span className="prev-tag">前回と同じ</span>
        <span className="prev-sum">{parts.join('、')}</span>
        <button type="button" className="linkish prev-reset" onClick={(e) => { e.preventDefault(); e.stopPropagation(); resetDetail(); }}><Icon name="reset" />既定に戻す</button>
      </>
    )
    : parts.length ? `詳細（${parts.join('、')}）` : '詳細（model、effort、permission mode、worktree、追加ディレクトリ）';

  const close = () => emit({ type: 'overlay.close' });
  // 書きかけを背景の押し違いで失わないよう、背景では閉じない。
  return (
    <Dialog
      title={title}
      titleAside={restored && (
        <>
          <span className="draft-tag"><Icon name="edit" />下書き</span>
          <button type="button" className="linkish" aria-label="下書きを消す" onClick={discardDraft}><Icon name="discard" />消す</button>
        </>
      )}
      className="dialog-wide"
      onClose={close}
      closeOnBackdrop={false}
      onKeyDown={onKeyDown}
      footer={<>
        <button type="button" className="btn" onClick={close}>やめる</button>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" disabled={props.submitting} aria-keyshortcuts="Meta+Enter" onClick={submit}>
          {props.submitting ? '起動しています' : <>起動<span className="kc" aria-hidden="true">⌘↵</span></>}
        </button>
      </>}
    >
      <div className="field">
        <span aria-hidden="true">プロジェクト</span>
        <Listbox id="new-session-project" label="プロジェクト" value={choice || null} options={options} groups={groups} onChange={choose} actions={actions} onAction={onAction} showSubInFace searchPlaceholder="名前かパスで探す" minWidth={360} />
      </div>
      {scratch && <div className="faint">~/.agent-hangar/scratch/ の下に日時のディレクトリを作って起動します。後からプロジェクトに昇格できます。</div>}
      {newDir && (
        <>
          <label className="field" htmlFor="new-session-dir-name">フォルダの名前
            <input id="new-session-dir-name" className="input mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="ワークスペースに作るディレクトリの名前" />
          </label>
          <div className="faint">{root}/{newName.trim()} を作り、プロジェクトに登録して起動します</div>
          <CheckCard label="git init する" description="空のリポジトリを作ってから起動します" icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      )}
      {dirPath && <div className="faint">{outside ? 'ワークスペースの外のフォルダです。この PC でのパスだけを覚えます。ほかの PC では、開いたときに場所を聞きます' : `${dirPath} はまだプロジェクトではありません。起動すると登録します`}</div>}
      <label className="field" htmlFor="new-session-name">名前（任意）
        <input ref={nameInput} id="new-session-name" className="input" data-autofocus value={name} onChange={(e) => setName(e.target.value)} placeholder="一覧での表示名" />
      </label>
      <label className="field" htmlFor="new-session-prompt">初期プロンプト（任意）
        <textarea id="new-session-prompt" className="input" rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <Fold summary={foldSummary}>
        <div className="launch-options">
          <span className="launch-option-label" aria-hidden="true">model</span>
          <ChoiceChips key={replaced} label="model" value={model} options={MODELS} onChange={setOption('model')} other={{ label: 'ほか', placeholder: 'model の名前' }} />
          <span className="launch-option-label" aria-hidden="true">effort</span>
          <div><Segmented label="effort" value={effort} options={EFFORT_OPTIONS} onChange={setOption('effort')} size="xs" /></div>
          <span className="launch-option-label launch-option-label-top" aria-hidden="true">permission mode</span>
          <div>
            <OptionCards label="permission mode" value={permissionMode} options={PERMISSIONS} onChange={setOption('permissionMode')} />
            {permissionMode === 'bypassPermissions' && <div className="error launch-danger">ファイルの削除やコマンドも、確認せずに実行します</div>}
          </div>
        </div>
        <label className="field" htmlFor="new-session-worktree">worktree
          <input id="new-session-worktree" className="input mono" value={worktree} onChange={(e) => setOption('worktree')(e.target.value)} placeholder="空なら通常の作業ディレクトリ" />
        </label>
        <label className="field" htmlFor="new-session-add-dirs">追加ディレクトリ（1 行 1 つ）
          <textarea id="new-session-add-dirs" className="input mono" rows={2} value={addDirs} onChange={(e) => setOption('addDirs')(e.target.value)} />
        </label>
      </Fold>
      <div className="faint">新しいディレクトリでは Claude が信頼確認のダイアログを出します。起動したあとにターミナルで答えてください。</div>
      {props.error && props.error !== staleError && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
