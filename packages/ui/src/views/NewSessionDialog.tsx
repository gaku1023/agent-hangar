import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { LaunchParams, ProjectPlace } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { LaunchPrefs } from '../mediator/types.ts';
import { accountChoice, accountOptions, SCRATCH_CHOICE, type NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { LaunchChips, type LaunchChipValues } from './LaunchChips.tsx';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import type { ListboxAction, ListboxOption } from './primitives/listboxModel.ts';
import { CheckCard } from './primitives/OptionCard.tsx';
import { PERMISSION_BYPASS } from './primitives/permissionModel.ts';
import { PromptComposer } from './primitives/PromptComposer.tsx';
import { composePrompt, type Attachment } from './primitives/promptComposerModel.ts';

/** プロジェクトの一覧の先頭に置くクイックセッションの行。値はプロジェクトの id と重ならず、クイックセッションの前回値の鍵と同じ綴りである。 */
const SCRATCH = SCRATCH_CHOICE;
/** 新しいフォルダの行の値。プロジェクトの id ともクイックセッションとも重ならない。行は顔にだけ使い、一覧には並べない。 */
const NEW_DIR = ':new';
/** 既存のフォルダ（未登録と Finder）の行の値の頭。後ろにパスを付ける。 */
const DIR = ':dir:';
const isDir = (v: string) => v.startsWith(DIR);
/** 初期プロンプトの欄の id。Mediator の focus の効果（runtime/focusSoon.ts の FOCUS_IDS）がこの id で探す。 */
const PROMPT_ID = 'new-session-prompt';

/** 札で決める値（名前を除く）。追加ディレクトリは欄のまま 1 行 1 つの文字で持つ。 */
type Options = { model: string; effort: string; permissionMode: string; worktree: string; addDirs: string };
const DEFAULT_OPTIONS: Options = { model: '', effort: '', permissionMode: '', worktree: '', addDirs: '' };
const optionsOf = (p: LaunchPrefs | undefined): Options => ({ model: p?.model ?? '', effort: p?.effort ?? '', permissionMode: p?.permissionMode ?? '', worktree: p?.worktree ?? '', addDirs: p?.addDirs?.join('\n') ?? '' });
const dirsOf = (text: string): string[] => text.split('\n').map((d) => d.trim()).filter(Boolean);
const sameOptions = (a: Options, b: Options): boolean => a.model.trim() === b.model.trim() && a.effort === b.effort && a.permissionMode === b.permissionMode && a.worktree.trim() === b.worktree.trim() && dirsOf(a.addDirs).join('\n') === dirsOf(b.addDirs).join('\n');
/** 既定でない値が 1 つでもあるか。「前回と同じ」は、既定だけの前回値には出さない。 */
const hasNonDefault = (o: Options): boolean => !!(o.model.trim() || o.effort || o.permissionMode || o.worktree.trim() || dirsOf(o.addDirs).length);

/**
 * 起動ダイアログ（N2）。主役は焦点の入った大きな初期プロンプトの欄で、設定はその下の札の 1 行（LaunchChips）に並ぶ。
 * 札はプロジェクト、アカウント（2 件以上のときだけ）、モデル、effort レベル、権限モード、worktree と、名前と追加ディレクトリを足す「＋」である。
 * 空欄と既定は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * 欄と札の値はすべてここの状態で持つ。値を札に常に見せ、下書きを戻して消せるようにするためである。
 * プロジェクトを選ばなければクイックセッション（scratch）で始まり、何も選ばずに ⌘↵ で起動できる。props.scratch は開いたときにその行を選んでおくかどうかである。
 * 札の値の初期値は、選んだプロジェクトの前回値（props.prefs）にする（D1）。前回値のままなら札の下に「前回と同じ」と「既定に戻す」を出す。
 * 名前と初期プロンプトと添付の書きかけは、閉じるときに下書きとして送り、次に開いたときに props.draft から戻す（C1）。
 * 添付があるときの追加ディレクトリ（置き場）は、サーバが claude に渡す引数へ足す。ここでは params.addDirs に混ぜない。
 * アカウントが 2 件以上あるときだけ、プロジェクトの次に「どのアカウントで起こすか」の札を出し、送るときに選んだ id を params.account に必ず入れる。
 * 選んでもいまのアカウントは変えない（account.choose は出さない）。1 件以下のときは札も params.account も出さず、今までと変わらない。
 * 権限モードに Bypass permissions を選ぶと、札が赤い縁になり、起動のボタンが赤い「Bypass permissions で起動」になる。確認のダイアログは足さない。
 * 打鍵のたびには送らない。送るたびに画面全体を描き直すことになるからである。
 * プロジェクトが未選択のまま送っても止めない。未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const t = useT();
  const [choice, setChoice] = useState(() => {
    // サーバも scratch を projectId より優先する。選んでいない（一覧に無い id を含む）ときはクイックセッションである。
    if (props.scratch) return SCRATCH;
    return props.projectId && props.projects.some((p) => p.id === props.projectId) ? props.projectId : SCRATCH;
  });
  const scratch = choice === SCRATCH;
  const newDir = choice === NEW_DIR;
  const dirPath = isDir(choice) ? choice.slice(DIR.length) : null;
  // 未登録の一覧に載っているのはプロジェクトの親フォルダ直下のフォルダだけなので、載っていなければ外か深い階層である。
  const outside = dirPath !== null && !props.dirs.some((d) => d.path === dirPath);
  const root = props.workspaceRoot ?? '~/workspace';
  const title = newDir ? t('newSession.title.newDir') : dirPath ? t('newSession.title.dir') : t('newSession.title.default');
  // 新しいフォルダの名前と git init。名前は「『語』を新しいフォルダとして作る」で選んだときの語を入れる。
  const [newName, setNewName] = useState('');
  const [gitInit, setGitInit] = useState(true);
  // Finder で選んだ、未登録の一覧に無いフォルダ（親フォルダの外か深い階層）。行を持たないので、ここで覚えて行を足す。
  const [extraDir, setExtraDir] = useState<string | null>(null);
  // 開いた時点の Finder の回数。これより新しい結果だけを使う。別のダイアログで選んだ結果が当たらないようにするためである。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);
  // @ の候補はプロジェクトのフォルダを探すので、クイックセッションとパスの無いプロジェクトでは渡さない。/ の候補は自分のスキルだけになる。
  const assistProject = scratch || !choice ? null : props.projects.find((p) => p.id === choice)?.path ? choice : null;
  const [name, setName] = useState(props.draft?.name ?? '');
  const [prompt, setPrompt] = useState(props.draft?.prompt ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(props.draft?.attachments ?? []);
  // 置き場へ送っている最中の添付の数。終わるまで起動させない（添付が抜けたまま起動しないため）。
  const [uploading, setUploading] = useState(0);
  // 開いたときに下書きを戻したか。「破棄」を押すまで見出しに札を出す。
  const [restored, setRestored] = useState(props.draft !== null);
  // 札の値の初期値は、選んだプロジェクトの前回値にする（D1）。
  // 利用者が札に触れる前にプロジェクトを選び直したら、そのプロジェクトの前回値に入れ替える。触れた後は、自分で選んだ値を残す。
  const [detail, setDetail] = useState(() => optionsOf(props.prefs[choice]));
  const [touched, setTouched] = useState(false);
  // 失敗の文言は、その送信の結果である。プロジェクトを選び直したら古い文言は出さず、送り直したらまた出す。
  // 同じ文言が続けて返ることがあるので、文言ではなく「選び直した時点の文言」を覚えて比べる。
  const [staleError, setStaleError] = useState<string | null>(null);
  const choose = (value: string) => {
    setChoice(value);
    setStaleError(props.error);
    if (touched) return;
    setDetail(optionsOf(props.prefs[value]));
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
  const resetDetail = () => { setTouched(true); setDetail(DEFAULT_OPTIONS); };
  const { model, effort, permissionMode, worktree, addDirs } = detail;
  // アカウントは、利用者が選んだ id だけを覚える。選んでいなければ、いまのアカウント（選べなければ選べる最初の 1 件）。
  // 選んだ id が一覧から消えたとき、選べなくなったときも、同じ規則でいまのアカウントへ戻る。
  const [pickedAccount, setPickedAccount] = useState<string | null>(null);
  const account = props.accounts ? accountChoice(props.accounts, pickedAccount) : null;
  // 開いたときに 1 回、認証と使用量を読み直させる。
  const hasAccounts = props.accounts !== null;
  useEffect(() => { if (hasAccounts) emit({ type: 'accounts.load' }); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 閉じるとき（どの経路で閉じても、ダイアログは外される）に、書きかけを下書きとして送る。
  // 起動を送った後に外されたときは、起動し終えたので送らない（Mediator が下書きを消す）。
  const latest = useRef({ name, prompt, attachments, submitting: props.submitting, emit });
  latest.current = { name, prompt, attachments, submitting: props.submitting, emit };
  const gone = useRef(false);
  useEffect(() => {
    gone.current = false;
    return () => {
      gone.current = true;
      const l = latest.current;
      if (!l.submitting) l.emit({ type: 'session.new.draft', name: l.name, prompt: l.prompt, attachments: l.attachments });
    };
  }, []);
  // 送っている最中に閉じられても添付を失わない。外された後に送り終えたものは、Mediator の下書きへ添付だけを足す。
  // 閉じるときの名前と本文で下書きを置き換えない。閉じた後に開き直して書いた下書きや、起動して消えた下書きを、古い中身で蘇らせたり上書きしたりするからである。
  // 起動を送った後に外されたときは、Mediator が下書きを消すので送らない。
  const changeAttachments = (next: Attachment[]) => {
    setAttachments(next);
    const l = latest.current;
    const before = new Set(l.attachments.map((a) => a.path));
    l.attachments = next;
    // 外された後に着いた分だけを送る（全部ではない。閉じるときの下書きにすでに入っているものは足し直さない）。
    const arrived = next.filter((a) => !before.has(a.path));
    if (gone.current && !l.submitting && arrived.length) l.emit({ type: 'session.new.draft.attach', attachments: arrived });
  };

  const discardDraft = () => {
    setName('');
    setPrompt('');
    setAttachments([]);
    setRestored(false);
    emit({ type: 'session.new.draft', name: '', prompt: '', attachments: [] });
    document.getElementById(PROMPT_ID)?.focus();
  };

  const submit = () => {
    if (props.submitting || uploading > 0) return;
    setStaleError(null);
    const params: LaunchParams = {};
    let place: ProjectPlace | undefined;
    // クイックセッションはプロジェクトを持たず、サーバが使い捨てのディレクトリを作る。
    if (scratch) params.scratch = true;
    // 新しいフォルダと未登録のフォルダは、Mediator がプロジェクトを作ってから起動する。
    else if (newDir) place = { kind: 'newDir', name: newName.trim(), gitInit };
    else if (dirPath) place = { kind: 'dir', path: dirPath };
    else if (choice) params.projectId = choice;
    // 開いてから送るまでにいまのアカウントが変わっても、選んだとおりに起こすため、いまのアカウントと同じでも入れる。
    if (account !== null) params.account = account;
    if (name.trim()) params.name = name.trim();
    // 添付は、本文の後にパスを足して渡す。起動の API は変えない（promptComposerModel.ts の composePrompt）。
    // 添付の置き場を claude に渡す --add-dir はサーバが足すので、ここでは addDirs に混ぜない。
    const text = composePrompt(prompt, attachments);
    if (text) params.prompt = text;
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
  // 一覧を開いている間の Esc と Enter は、Listbox と Popover が止めるのでここまで来ない。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    if (e.metaKey || e.ctrlKey) { e.preventDefault(); submit(); return; }
    if ((e.target as HTMLElement).tagName === 'TEXTAREA') return;
    // 札、ボタン、チェックの Enter は、その部品の操作である。起動には使わない。
    if ((e.target as HTMLElement).closest('button, [role="checkbox"]')) return;
    e.preventDefault();
    submit();
  };

  const recent = new Set(props.recentIds);
  const options: ListboxOption[] = [
    { value: SCRATCH, label: t('newSession.project.quick'), sub: t('newSession.project.quickSub'), subKind: 'prose', icon: 'scratch' },
    ...props.projects.map((p) => ({ value: p.id, label: p.name, sub: p.path ?? undefined, meta: p.lastActivity || undefined, status: p.status })),
    ...props.dirs.map((d) => ({ value: DIR + d.path, label: d.name, sub: d.path, icon: 'folder' as const, tag: t('newSession.project.unregistered'), searchOnly: true })),
    ...(extraDir ? [{ value: DIR + extraDir, label: extraDir.split('/').pop() || extraDir, sub: extraDir, icon: 'folder' as const, hidden: true }] : []),
    { value: NEW_DIR, label: newName.trim() || t('newSession.project.newFolderChip'), faceSub: t('newSession.project.newFolderPath', { path: `${root}/${newName.trim()}` }), icon: 'folderPlus', hidden: true },
  ];
  // 作れない名前。APFS は大文字小文字を区別しないので、小文字で比べる。
  const names = new Set([...props.takenNames, ...props.projects.map((p) => p.name), ...props.dirs.map((d) => d.name)].map((n) => n.toLowerCase()));
  const taken = (q: string) => names.has(q.toLowerCase());
  const actions = (q: string): ListboxAction[] => {
    const word = q.trim();
    const first: ListboxAction = word && !taken(word)
      ? { value: 'new', label: t('newSession.project.newFolderNamed', { name: word }), sub: `${root}/${word}`, icon: 'folderPlus' }
      : { value: 'new', label: t('newSession.project.newFolder'), icon: 'folderPlus' };
    return props.desktop ? [first, { value: 'finder', label: t('newSession.project.other'), sub: 'Finder', icon: 'folderOpen' }] : [first];
  };
  const onAction = (value: string, q: string) => {
    if (value === 'finder') { emit({ type: 'folder.pick' }); return; }
    const word = q.trim();
    if (word && !taken(word)) setNewName(word);
    choose(NEW_DIR);
  };
  const groups = [{ title: t('newSession.project.groupQuick'), values: [SCRATCH] }, { title: t('newSession.project.groupRecent'), values: props.recentIds }, { title: t('newSession.project.groupAll'), values: props.projects.filter((p) => !recent.has(p.id)).map((p) => p.id) }];
  const chosen = options.find((o) => o.value === choice);

  // 前回値のままなら、札の下に「前回と同じ」と出どころを言い、「既定に戻す」を添える（D1）。
  const prev = props.prefs[choice];
  const sameAsPrev = !!prev && hasNonDefault(detail) && sameOptions(detail, optionsOf(prev));
  const bypass = permissionMode === PERMISSION_BYPASS;

  const onChips = (patch: Partial<LaunchChipValues>) => {
    const { name: nextName, ...rest } = patch;
    if (nextName !== undefined) setName(nextName);
    if (Object.keys(rest).length) { setTouched(true); setDetail((o) => ({ ...o, ...rest })); }
  };
  const projectChip = (
    <Listbox id="new-session-project" label={t('newSession.project.label')} value={choice || null} options={options} groups={groups} onChange={choose} actions={actions} onAction={onAction}
      searchPlaceholder={t('newSession.project.search')} minWidth={360} align="start" faceClassName="set-chip" faceProps={{ 'data-tone': 'default' }}
      renderFace={(sel) => <><Icon name={sel?.icon ?? 'folder'} /><span className="set-chip-value">{sel?.label ?? ''}</span><Icon name="chevronDown" /></>} />
  );

  const close = () => emit({ type: 'overlay.close' });
  // 書きかけを背景の押し違いで失わないよう、背景では閉じない。
  return (
    <Dialog
      title={title}
      titleAside={restored && (
        <>
          <span className="draft-tag"><Icon name="edit" />{t('newSession.draft.tag')}</span>
          <button type="button" className="linkish" aria-label={t('newSession.draft.discard')} onClick={discardDraft}><Icon name="discard" />{t('newSession.draft.discardShort')}</button>
        </>
      )}
      className="dialog-wide dialog-new-session"
      onClose={close}
      closeOnBackdrop={false}
      onKeyDown={onKeyDown}
      footer={<>
        <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>
        <span className="spacer" />
        {scratch && <span className="dialog-hint">{t('newSession.hint.quick')}</span>}
        <button type="button" className={`btn ${bypass ? 'btn-danger-fill' : 'btn-primary'}`} disabled={props.submitting || uploading > 0} aria-keyshortcuts="Meta+Enter" onClick={submit}>
          {props.submitting ? t('newSession.button.starting') : uploading > 0 ? t('newSession.button.uploading') : <>{bypass ? t('newSession.button.startBypass') : t('newSession.button.start')}<span className="kc" aria-hidden="true">⌘↵</span></>}
        </button>
      </>}
    >
      {/* 欄は箱（枠と道具の段）を持つので、label は欄の外に置く。見える文字の代わりは案内（placeholder）が言う。 */}
      <div className="field">
        <label className="sr-only" htmlFor={PROMPT_ID}>{t('newSession.prompt.label')}</label>
        <PromptComposer id={PROMPT_ID} hero placeholder={t('newSession.prompt.placeholder')} value={prompt} onChange={setPrompt} projectId={assistProject} attachments={attachments} onAttachmentsChange={changeAttachments} onPendingChange={setUploading} />
      </div>
      <LaunchChips
        lead={projectChip}
        account={props.accounts && account !== null ? { value: account, options: accountOptions(props.accounts), onChange: setPickedAccount } : undefined}
        values={{ model, effort, permissionMode, worktree, addDirs, name }}
        onChange={onChips}
        previousPermission={prev ? prev.permissionMode ?? '' : undefined}
      />
      {sameAsPrev && (
        <div className="prev-line">
          <span className="prev-tag">{t('newSession.prev.tag')}</span>
          <span className="faint">{t('newSession.prev.note', { name: chosen?.label ?? '' })}</span>
          <button type="button" className="linkish prev-reset" onClick={resetDetail}><Icon name="reset" />{t('newSession.prev.reset')}</button>
        </div>
      )}
      {scratch && <div className="faint">{t('newSession.note.quick')}</div>}
      {newDir && (
        <>
          <label className="field" htmlFor="new-session-dir-name">{t('newSession.newDir.nameLabel')}
            <input id="new-session-dir-name" className="input mono" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t('newSession.newDir.namePlaceholder')} />
          </label>
          <div className="faint">{t('newSession.newDir.note', { path: `${root}/${newName.trim()}` })}</div>
          <CheckCard label={t('newSession.newDir.gitInit')} description={t('newSession.newDir.gitInitNote')} icon="gitInit" checked={gitInit} onChange={setGitInit} />
        </>
      )}
      {dirPath && <div className="faint">{outside ? t('newSession.dir.outside') : t('newSession.dir.unregistered', { path: dirPath })}</div>}
      <div className="faint">{t('newSession.note.trust')}</div>
      {props.error && props.error !== staleError && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
