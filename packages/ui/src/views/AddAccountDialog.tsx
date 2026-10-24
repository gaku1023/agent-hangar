import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ACCOUNT_LINK_GROUPS, type MessageKey } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import { homePath } from '../lib/paths.ts';
import type { AddAccountProps } from '../presenters/addAccount.ts';
import { isComposing } from './ime.ts';
import { Dialog } from './primitives/Dialog.tsx';
import { Icon } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';

/** 共有する組の見出し。中身の名前は ACCOUNT_LINK_GROUPS（サーバのリンクの一覧と同じもの）から引く。 */
const GROUP_TITLE = {
  config: 'account.add.group.config', tools: 'account.add.group.tools', memory: 'account.add.group.memory', history: 'account.add.group.history',
} as const satisfies Record<(typeof ACCOUNT_LINK_GROUPS)[number]['key'], MessageKey>;
/** 組の中の名前を、この数までは並べて、残りは「ほか N 項目」にする。 */
const SHOWN_ENTRIES = 3;
/** 分ける（共有しない）もの。見出しと、あれば名前。 */
const SEPARATE: { title: 'account.add.separate.login' | 'account.add.separate.managed' | 'account.add.separate.cache'; detail?: 'account.add.separate.loginDetail' }[] = [
  { title: 'account.add.separate.login', detail: 'account.add.separate.loginDetail' },
  { title: 'account.add.separate.managed' },
  { title: 'account.add.separate.cache' },
];

/**
 * 設定の「アカウントを足す…」のダイアログ（試作の 7 節の案 A）。
 * 名前と場所の 2 つの欄、最初の場所と共有するもの（4 つの組）と分けるもの（3 つ）の 2 列、場所の中身の知らせを 1 枚に置く。
 * 場所は、自分で打つか選ぶまでは、名前に合わせてサーバが作った候補（~/.claude-<名前>）で埋める。
 * 入力は送信するまで外へ出ないので、Mediator ではなくここに持つ。打つたびに足す前の確かめを読み、答えのうち今の欄と合うものだけを使う。
 */
export function AddAccountDialog(props: AddAccountProps) {
  const emit = useEmit();
  const t = useT();
  const [name, setName] = useState('');
  // 利用者が場所を自分で打ったか選んだか。それまでは候補で埋める。
  const [dirTouched, setDirTouched] = useState(false);
  const [dir, setDir] = useState('');
  // 開いた時点の Finder の回数。これより新しい結果だけを使う（別のダイアログで選んだ結果を当てない）。
  const pickedAtOpen = useRef(props.picked?.n ?? 0);
  const input = dirTouched ? dir : '';

  useEffect(() => { emit({ type: 'account.add.preview', name, dir: input }); }, [name, input]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const p = props.picked;
    if (!p || p.n <= pickedAtOpen.current) return;
    pickedAtOpen.current = p.n;
    setDirTouched(true);
    setDir(homePath(p.path, props.home));
  }, [props.picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 今の欄と合う答えだけを使う。打っている途中の古い答えで、場所や知らせを替えない。
  const pv = props.preview && props.preview.name === name && props.preview.input === input ? props.preview : null;
  const shownDir = dirTouched ? dir : pv ? homePath(pv.dir, props.home) : '';
  const dirLabel = pv ? homePath(pv.dir, props.home) : shownDir;
  const blocked = pv?.registeredAs != null;
  const canSubmit = name.trim() !== '' && !props.submitting && !blocked;
  const submit = () => {
    if (!canSubmit) return;
    // 候補で埋まっているときは、見せている場所（の絶対パス）をそのまま送る。答えが届く前なら、サーバが名前から決める。
    emit({ type: 'account.add', name, dir: dirTouched ? dir : pv?.dir ?? '' });
  };
  const onEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter' || isComposing(e)) return;
    e.preventDefault();
    submit();
  };
  const sep = t('common.list.separator');
  const detailOf = (entries: readonly string[]) => (entries.length <= SHOWN_ENTRIES ? entries.join(sep) : t('account.add.more', { names: entries.slice(0, 2).join(sep), n: entries.length - 2 }));
  const close = () => emit({ type: 'overlay.close' });
  const sharedTitle = t('account.add.sharedTitle', { dir: props.primaryDirLabel });
  const separateTitle = t('account.add.separateTitle');

  // 名前を打ちかけたまま背景を押し違えても失わないよう、背景では閉じない。
  return (
    <Dialog
      title={t('account.add.title')}
      icon="add"
      className="dialog-wide"
      onClose={close}
      closeOnBackdrop={false}
      footer={<>
        <span className="add-account-foot faint">{t('account.add.footnote')}</span>
        <span className="spacer" />
        <button type="button" className="btn" onClick={close}>{t('common.button.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>{t('account.add.submit')}</button>
      </>}
    >
      <div className="add-account-fields">
        <label className="field" htmlFor="add-account-name">{t('account.add.name')}
          <input id="add-account-name" className="input" data-autofocus value={name} placeholder={t('account.add.namePlaceholder')} spellCheck={false} autoComplete="off" onChange={(e) => setName(e.target.value)} onKeyDown={onEnter} />
        </label>
        {/* 欄の名前に「選ぶ…」が混ざらないよう、見出しの label は文字だけにする。 */}
        <div className="field">
          <label htmlFor="add-account-dir">{t('account.add.dir')}</label>
          <span className="add-account-dir">
            <input id="add-account-dir" className="input mono" value={shownDir} spellCheck={false} autoComplete="off" onChange={(e) => { setDirTouched(true); setDir(e.target.value); }} onKeyDown={onEnter} />
            {props.desktop && <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'account.add.pick', defaultPath: props.home })}>{t('account.add.pick')}</button>}
          </span>
        </div>
      </div>
      <div className="add-account-cols">
        <div className="add-account-col">
          <h4 className="add-account-col-h"><Icon name="link" />{sharedTitle}</h4>
          <ul aria-label={sharedTitle}>
            {ACCOUNT_LINK_GROUPS.map((g) => <li key={g.key}><span>{t(GROUP_TITLE[g.key])}</span><small className="mono">{detailOf(g.entries)}</small></li>)}
          </ul>
        </div>
        <div className="add-account-col" data-kind="separate">
          <h4 className="add-account-col-h"><Icon name="unlink" />{separateTitle}</h4>
          <ul aria-label={separateTitle}>
            {SEPARATE.map((s) => <li key={s.title}><span>{t(s.title)}</span>{s.detail && <small className="mono">{t(s.detail)}</small>}</li>)}
          </ul>
        </div>
      </div>
      {pv?.registeredAs != null ? <div className="add-account-note" data-tone="stop">{t('account.add.registered', { name: pv.registeredAs })}</div>
        : pv && pv.conflicts.length > 0 ? <div className="add-account-note" data-tone="warn">{t('account.add.conflicts', { dir: dirLabel, names: pv.conflicts.join(sep) })}</div>
          : pv?.exists ? <div className="add-account-note">{t('account.add.exists')}</div> : null}
      {props.error && <div className="error" role="alert">{props.error}</div>}
    </Dialog>
  );
}
