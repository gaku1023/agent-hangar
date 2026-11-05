import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { type LaunchPrepChoice } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { NewSessionProps } from '../presenters/newSession.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { isMacClient, keyLabel } from '../keys.ts';
import { newPrepKey } from '../lib/prepKey.ts';
import { CancelPrepButton, LaunchPrepAsk, LaunchPrepBox, LaunchPrepFailed } from './LaunchPrepBox.tsx';
import { PromptComposer } from './primitives/PromptComposer.tsx';
import { composePrompt, type Attachment } from './primitives/promptComposerModel.ts';
import { InvestigateButton } from './InvestigateButton.tsx';
import { fadeIn } from './primitives/motionKit.ts';
import { useLaunchChoice } from './useLaunchChoice.tsx';

/** 初期プロンプトの欄の id。Mediator の focus の効果（runtime/focusSoon.ts の FOCUS_IDS）がこの id で探す。 */
const PROMPT_ID = 'new-session-prompt';

/**
 * 起動ダイアログ（N2）。主役は焦点の入った大きな初期プロンプトの欄で、設定はその下の札の 1 行（LaunchChips）に並ぶ。
 * 札はプロジェクト、アカウント（2 件以上のときだけ）、モデル、effort レベル、権限モード、worktree と、名前と追加ディレクトリを足す「＋」である。
 * 札の組み立て（プロジェクトの検索とまとまり、フォルダの扱い、エージェントごとの札、起動の params の組み立て）は useLaunchChoice にあり、予定のフォームと共有する。
 * ここに残るのは、初期プロンプトと添付、下書き、埋めて開いたときの種、起動前の準備、送信中と失敗の表示である。
 * 空欄と既定は params に含めない（利用者の Claude Code の設定に従わせるため）。
 * 欄と札の値はすべてここの状態で持つ。値を札に常に見せ、下書きを戻して消せるようにするためである。
 * プロジェクトを選ばなければクイックセッション（scratch）で始まり、何も選ばずに ⌘↵ で起動できる。props.scratch は開いたときにその行を選んでおくかどうかである。
 * 札の値の初期値は、選んだプロジェクトの前回値（props.prefs）にする（D1）。前回値のままなら札の下に「前回と同じ」と「既定に戻す」を出す。
 * 前回値にモデルが無ければ、設定の既定のモデル（props.defaultModel）をモデルの札の初めの値にする。「既定に戻す」もモデルはそこへ戻す。
 * 名前と初期プロンプトと添付の書きかけは、閉じるときに下書きとして送り、次に開いたときに props.draft から戻す（C1）。
 * 添付があるときの追加ディレクトリ（置き場）は、サーバが claude に渡す引数へ足す。ここでは params.addDirs に混ぜない。
 * アカウントが 2 件以上あるときだけ、プロジェクトの次に「どのアカウントで起こすか」の札を出し、送るときに選んだ id を params.account に必ず入れる。
 * 選んでもいまのアカウントは変えない（account.choose は出さない）。1 件以下のときは札も params.account も出さず、今までと変わらない。
 * 権限モードに Bypass permissions を選ぶと、札が赤い縁になり、起動のボタンが赤い「Bypass permissions で起動」になる。確認のダイアログは足さない。
 * opencode（ベータ）を設定で有効にしたとき（props.opencode）だけ、札の先頭に「エージェント」を出す。opencode を選ぶと、アカウント、モデル、effort、権限モード、worktree、追加ディレクトリの札と信頼の注記を外し、
 * モード、モデル、自動承認の札を出す。モードとモデルは、選んだ場所の一覧（opencode.options）から選ぶ。前回のエージェントと opencode のモデルは、プロジェクトごとの前回値から戻す。
 * 前回のモデルが一覧から消えていたら、デフォルトに戻す（opencodeModelChoice）。切り替えの動きは agentSwap.ts（M1）。
 * 打鍵のたびには送らない。送るたびに画面全体を描き直すことになるからである。
 * プロジェクトが未選択のまま送っても止めない。未選択の判定は Mediator が持ち、失敗のメッセージが error として戻ってくる。
 */
export function NewSessionDialog(props: NewSessionProps) {
  const emit = useEmit();
  const t = useT();
  // 失敗の文言は、その送信の結果である。プロジェクトを選び直したら古い文言は出さず、送り直したらまた出す。
  // 同じ文言が続けて返ることがあるので、文言ではなく「選び直した時点の文言」を覚えて比べる。
  const [staleError, setStaleError] = useState<string | null>(null);
  // 埋めて開いたとき（「エージェントで調査…」）は、下書きの代わりに依頼の文を入れる。下書きは読まず、閉じても書かない（残したまま次に戻す）。
  const seed = props.seed ?? null;
  const draft = seed ? null : props.draft;
  const lc = useLaunchChoice({
    data: props, projectId: props.projectId, scratch: props.scratch, dir: props.dir ?? null, freshWorktree: props.worktree === true,
    agent: props.agent, pickModel: props.pickModel === true, seed, name: draft?.name ?? '', onChoose: () => setStaleError(props.error),
  });
  const { name, setName, blocked } = lc;
  const [prompt, setPrompt] = useState(seed?.request ?? draft?.prompt ?? '');
  const [attachments, setAttachments] = useState<Attachment[]>(draft?.attachments ?? []);
  // 置き場へ送っている最中の添付の数。終わるまで起動させない（添付が抜けたまま起動しないため）。
  const [uploading, setUploading] = useState(0);
  // 開いたときに下書きを戻したか。「破棄」を押すまで見出しに札を出す。
  const [restored, setRestored] = useState(draft !== null);

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
      if (!l.submitting && !seed) l.emit({ type: 'session.new.draft', name: l.name, prompt: l.prompt, attachments: l.attachments });
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
    if (gone.current && !l.submitting && !seed && arrived.length) l.emit({ type: 'session.new.draft.attach', attachments: arrived });
  };

  const discardDraft = () => {
    setName('');
    setPrompt('');
    setAttachments([]);
    setRestored(false);
    emit({ type: 'session.new.draft', name: '', prompt: '', attachments: [] });
    document.getElementById(PROMPT_ID)?.focus();
  };

  // answer は、準備が止まって聞かれたことへの答え（LaunchPrepChoice）。同じ詳細に添え、新しい鍵で送り直す。
  const submit = (answer?: LaunchPrepChoice) => {
    if (props.submitting || uploading > 0 || blocked) return;
    setStaleError(null);
    const { params, place } = lc.build();
    // 添付は、本文の後にパスを足して渡す。起動の API は変えない（promptComposerModel.ts の composePrompt）。
    // 添付の置き場を claude に渡す --add-dir はサーバが足すので、ここでは addDirs に混ぜない。
    // 埋めて開いたときは、依頼の文の後にエラーの引用を足す。
    const text = composePrompt(seed ? [prompt.trim(), seed.quote].filter(Boolean).join('\n\n') : prompt, attachments);
    if (text) params.prompt = text;
    if (params.agent === 'opencode') {
      // 起動前の準備（ローカルのモデルを載せる）の進みを受け取る鍵。送るたびに新しく作る。
      params.prepKey = newPrepKey();
      if (answer) params.prepChoice = answer;
    }
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

  // 埋めて開いたときは、埋めた欄を薄れから現す（試作の動き。ダイアログの pop に重ねる）。
  useLayoutEffect(() => {
    const box = seed ? document.getElementById(PROMPT_ID)?.closest<HTMLElement>('.pc-box') : null;
    if (box) fadeIn(box);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => emit({ type: 'overlay.close' });
  // 起動前の準備。進みの箱は準備が走っている間（送信中）だけ、問いの札は止まっている間（送信中でない）だけ、失敗の札は準備が失敗した後の失敗の文があるときだけ出す。
  // 準備の進みが無い起動（Claude Code、ローカルでないモデル）は、どれも出さず今までの見た目のままである。
  const prep = props.prep ?? null;
  const preparing = props.submitting && prep !== null && prep.phase === 'running';
  const asking = !props.submitting && prep?.ask ? prep.ask : null;
  const errorShown = props.error && props.error !== staleError ? props.error : null;
  const failure = !props.submitting && prep?.failure != null && errorShown !== null ? prep.failure || errorShown : null;
  // 書きかけを背景の押し違いで失わないよう、背景では閉じない。
  return (
    <Dialog
      title={t(lc.titleKey)}
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
        {preparing && prep && <CancelPrepButton onClick={() => emit({ type: 'launchPrep.cancel', key: prep.key })} />}
        <button type="button" className={`btn ${lc.bypass ? 'btn-danger-fill' : 'btn-primary'}`} disabled={props.submitting || uploading > 0 || blocked} aria-keyshortcuts={isMacClient() ? 'Meta+Enter' : 'Control+Enter'} onClick={() => submit()}>
          {preparing ? t('launchPrep.button.preparing') : props.submitting ? t('newSession.button.starting') : uploading > 0 ? t('newSession.button.uploading') : <>{lc.bypass ? t('newSession.button.startBypass') : t('newSession.button.start')}<span className="kc" aria-hidden="true">{keyLabel('⌘↵')}</span></>}
        </button>
      </>}
    >
      {/* 欄は箱（枠と道具の段）を持つので、label は欄の外に置く。見える文字の代わりは案内（placeholder）が言う。 */}
      <div className="field">
        <label className="sr-only" htmlFor={PROMPT_ID}>{t('newSession.prompt.label')}</label>
        <PromptComposer id={PROMPT_ID} hero placeholder={t('newSession.prompt.placeholder')} value={prompt} onChange={setPrompt} projectId={lc.assistProject} attachments={attachments} onAttachmentsChange={changeAttachments} onPendingChange={setUploading} {...(seed ? { quote: seed.quote, quoteTone: seed.tone } : {})} />
      </div>
      {lc.chips}
      {lc.notes}
      {errorShown !== null && failure === null && (
        <div className="error" role="alert">
          {errorShown}
          {props.errorRepair
            ? <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'linkRepair.open', ...props.errorRepair! })}>{t('account.repair.button')}</button>
            : <div className="err-acts"><InvestigateButton ctx={{ op: 'launch', message: errorShown, agent: lc.agent, ...(lc.account !== null ? { accountId: lc.account } : {}) }} /></div>}
        </div>
      )}
      <LaunchPrepAsk ask={asking} onChoose={submit} />
      <LaunchPrepFailed reason={failure} title={failure !== null ? prep?.failureTitle ?? null : null} />
      <LaunchPrepBox open={preparing} view={prep} />
    </Dialog>
  );
}
