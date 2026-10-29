import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { Translate } from '@agent-hangar/shared';
import { approvalText, cancelledText, loggedOutText, type AccountView } from '../presenters/accounts.ts';
import type { AccountSettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { InvestigateButton } from './InvestigateButton.tsx';
import { useT } from './primitives/language.tsx';
import { Icon } from './primitives/Icon.tsx';
import { InfoTip } from './primitives/InfoTip.tsx';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';
import { collapseOut, growIn, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/**
 * 行の「ログイン」と「やめる」は、押すとすぐ同じ場所で入れ替わる。
 * 入れ替わった直後の押下（ダブルクリックの 2 回目）で打ち消し合わないよう、この間だけ押せなくする。
 * 動きのトークンの長さに合わせた値で、数値の直書きが禁じられる CSS ではなくここに 1 か所だけ置く。
 */
const SWAP_GUARD_MS = 600;

/** 選べる色の呼び名。読み上げと title に使う。知らない色は #rrggbb のまま呼ぶ。 */
const COLOR_KEYS = { '#2a57b8': 'account.colorName.blue', '#7a4a9e': 'account.colorName.purple', '#2b7048': 'account.colorName.green', '#c77a1a': 'account.colorName.orange', '#a2452f': 'account.colorName.brown' } as const;
const colorName = (t: Translate, c: string): string => (Object.hasOwn(COLOR_KEYS, c) ? t(COLOR_KEYS[c as keyof typeof COLOR_KEYS]) : c);

/**
 * 状態の文を、本体と添え書きに分ける。
 * ログイン済みは「プラン・メール」で、どちらかが無ければある方だけ。未読は空。
 * ログインし直しの途中は、「プラン・メール」を出したまま、承認の添え書きを足す。
 * 初めてのログインの途中は、承認の添え書きだけ。
 */
function stateParts(t: Translate, a: AccountView): { main: string; hint: string } {
  const who = [a.plan, a.email].filter((x): x is string => x !== null).join(t('account.settings.whoSeparator'));
  switch (a.auth) {
    case 'out': return { main: loggedOutText(t), hint: cancelledText(t, a) ?? '' };
    case 'running': return a.loggedIn ? { main: who, hint: approvalText(t, a) } : { main: '', hint: approvalText(t, a) };
    case 'in': return { main: who, hint: '' };
    case 'unknown': return { main: '', hint: '' };
  }
}

/**
 * 行の下の注意の 1 行。入るときは高さを 0 から伸ばし（growIn）、直って消えるときは畳む（collapseOut）。
 * 畳む間は、消える前の文を出し続ける。畳む間は読み上げから外す。
 */
function ProblemNote(props: { text: string | null }) {
  const last = useRef(props.text);
  if (props.text !== null) last.current = props.text;
  const note = usePresence<HTMLDivElement>(props.text !== null, (el) => (motionOn(el) ? collapseOut(el) : null));
  // 設定を開いたときに最初からある注意は、動かさない（入る動きは、あとから現れたときだけ）。
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) { first.current = false; return; }
    if (props.text !== null && note.ref.current) growIn(note.ref.current);
    // 入る向きの変わり目だけで動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.text !== null]);
  if (!note.mounted) return null;
  return <div ref={note.ref} className="account-set-problem" aria-hidden={note.leaving ? true : undefined}>{last.current}</div>;
}

/**
 * 名前をその場で直す入力欄。
 * Enter か欄を出るときに、変わっていれば保存する。Esc はやめる。
 * 変換中の Enter は確定しない。
 * Esc のあとに欄が消えるときの blur で保存しないよう、終わったかを持つ。
 */
function NameField(props: { account: AccountView; agent: Agent; onDone: () => void }) {
  const emit = useEmit();
  const t = useT();
  const a = props.account;
  const [v, setV] = useState(a.name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = v.trim();
    if (save && next !== '' && next !== a.name) emit({ type: 'account.update', accountId: a.id, name: next, ...props.agent });
    props.onDone();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  return <input ref={input} className="input account-set-input" aria-label={t('account.settings.nameFor', { name: a.name })} value={v} spellCheck={false} autoComplete="off" onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)} onKeyDown={onKey} />;
}

/** 色を選ぶ帯。5 色の点が並び、押すと保存して閉じる。いまの色を押したときは何も送らない。 */
function ColorBand(props: { account: AccountView; agent: Agent; colors: string[]; onDone: () => void }) {
  const emit = useEmit();
  const t = useT();
  const a = props.account;
  const band = useRef<HTMLDivElement>(null);
  // いまの色へフォーカスを送る（radio の作法）。
  useEffect(() => { band.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, []);
  const pick = (c: string) => {
    if (c !== a.color) emit({ type: 'account.update', accountId: a.id, color: c, ...props.agent });
    props.onDone();
  };
  return (
    <div ref={band} className="account-set-colors" role="radiogroup" aria-label={t('account.settings.colorFor', { name: a.name })} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onDone(); } }}>
      {props.colors.map((c) => (
        <button key={c} type="button" role="radio" className="account-set-color" aria-checked={c === a.color} aria-label={colorName(t, c)} title={colorName(t, c)} onClick={() => pick(c)}>
          <span className="st-dot" style={{ color: c }} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** Codex の一覧のとき、各操作に付ける印。Claude Code では空。 */
type Agent = { agent?: 'codex' };

/** アカウント 1 行。色の点、名前（と札）、置き場、状態、右端の操作。 */
function AccountRow(props: { account: AccountView; agent: Agent; colors: string[] }) {
  const emit = useEmit();
  const t = useT();
  const a = props.account;
  const ag = props.agent;
  const [editing, setEditing] = useState(false);
  const [coloring, setColoring] = useState(false);
  const { main, hint } = stateParts(t, a);
  const kind = a.auth === 'out' ? 'login' : a.auth === 'running' ? 'cancel' : null;
  const [guarded, setGuarded] = useState(false);
  const prevKind = useRef(kind);
  // 「ログイン」と「やめる」が入れ替わった直後だけ、押せなくする。
  useLayoutEffect(() => {
    const before = prevKind.current;
    prevKind.current = kind;
    if (before === null || kind === null || before === kind) { setGuarded(false); return undefined; }
    setGuarded(true);
    const timer = setTimeout(() => setGuarded(false), SWAP_GUARD_MS);
    return () => clearTimeout(timer);
  }, [kind]);
  const state = [main, hint].filter((x) => x !== '').join(' ');
  const path = a.dirLabel;
  const items: MenuItem[] = [
    { key: 'rename', label: t('account.menu.rename'), onSelect: () => { setColoring(false); setEditing(true); } },
    { key: 'color', label: t('account.menu.color'), onSelect: () => { setEditing(false); setColoring(true); } },
    // 未ログインは行に「ログイン」を直に出し、途中は「やめる」を出すので、メニューには置かない。
    ...(a.auth === 'out' || a.auth === 'running' ? [] : [{ key: 'login', label: t('account.menu.loginAgain'), onSelect: () => emit({ type: 'account.login', accountId: a.id, ...ag }) }]),
    { key: 'refresh', label: t('account.menu.refresh'), onSelect: () => emit({ type: 'account.refresh', accountId: a.id, ...ag }) },
    // 押せない項目は消さずに、理由を出す。確認は account.remove を受けた側が出す。
    { key: 'remove', label: t('account.menu.remove'), danger: true, disabled: a.primary ? t('account.menu.primaryLocked') : null, onSelect: () => emit({ type: 'account.remove', accountId: a.id, ...ag }) },
  ];
  return (
    <li className="account-set">
      <div className="account-set-row">
        <span className="st-dot account-set-dot" style={{ color: a.color }} aria-hidden="true" />
        <span className="account-set-who">
          {editing
            ? <NameField account={a} agent={ag} onDone={() => setEditing(false)} />
            : <b className="account-set-name" title={a.name}>{a.name}</b>}
          {a.current && <span className="account-set-tag" data-kind="current">{t('account.settings.current')}</span>}
        </span>
        <span className="account-set-dir mono" title={a.dir}>{path}</span>
        <span className="account-set-state" data-auth={a.auth} title={state}>
          <span className="account-set-ident">{main}</span>
          {hint !== '' && <span className="account-set-approve" data-wrap={a.auth === 'running' && a.login?.method === 'deviceCode' ? 'true' : undefined}>{hint}</span>}
        </span>
        <span className="account-set-acts">
          {a.auth === 'out' && <button type="button" className="btn btn-sm" disabled={guarded} onClick={() => emit({ type: 'account.login', accountId: a.id, ...ag })}>{t('account.settings.login')}</button>}
          {a.auth === 'running' && ag.agent === 'codex' && a.login?.method !== 'deviceCode' && <button type="button" className="btn btn-sm" disabled={guarded} onClick={() => emit({ type: 'account.login', accountId: a.id, agent: 'codex', method: 'deviceCode' })}>{t('account.login.deviceCodeButton')}</button>}
          {a.auth === 'running' && <button type="button" className="btn btn-sm" disabled={guarded} onClick={() => emit({ type: 'account.login.cancel', accountId: a.id, ...ag })}>{t('account.settings.cancel')}</button>}
          {a.linkConflicts.length > 0 && <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'linkRepair.open', agent: ag.agent === 'codex' ? 'codex' : 'claude-code', accountId: a.id })}>{t('account.repair.button')}</button>}
          {/* 修復できない注意は、エージェントに調べさせる。「修復…」が出るときは、調査は修復のダイアログの中に置く。 */}
          {a.linkConflicts.length === 0 && a.linkProblem !== null && <InvestigateButton ctx={{ op: 'accountLinks', message: a.linkProblem, agent: ag.agent === 'codex' ? 'codex' : 'claude-code', accountId: a.id }} />}
          <MenuButton label={t('account.settings.actionsFor', { name: a.name })} items={items} minWidth={240} />
        </span>
      </div>
      {coloring && <ColorBand account={a} agent={ag} colors={props.colors} onDone={() => setColoring(false)} />}
      <ProblemNote text={a.linkProblem} />
    </li>
  );
}

/**
 * 設定の「アカウント」の節。
 * アカウントの一覧と、行ごとの操作（名前、色、ログイン、読み直し、外す）、末尾の「アカウントを足す…」を持つ。
 * 足すのはダイアログ（AddAccountDialog）で、名前と場所を決め、共有するものと分けるものを見せてから登録する。
 * 切り替えは別の画面（ヘッダ、新規セッション）のもので、ここは登録の入口である。
 * hangar はログインの中身を読まず、ログインは account.login を出すだけ。
 * 保持する状態は、名前を直している行と、色の帯を開いている行だけ。
 */
export function AccountSettings(props: AccountSettingsProps & { agent?: 'codex' }) {
  const emit = useEmit();
  const t = useT();
  // agent が codex のときは Codex のアカウントの一覧。操作はすべて agent を付けて出す。
  const ag: Agent = props.agent === 'codex' ? { agent: 'codex' } : {};
  const codex = props.agent === 'codex';
  const heading = t(codex ? 'account.settings.codexHeading' : 'account.settings.heading');
  const id = codex ? 'settings-codex-accounts' : 'settings-accounts';
  return (
    <section id={id} className="account-set-section" aria-labelledby={`${id}-h`}>
      <h3 className="h2"><span id={`${id}-h`}>{heading}</span><InfoTip label={heading}>{t(codex ? 'account.settings.codexLead' : 'account.settings.lead')}</InfoTip></h3>
      <ul className="list account-set-list" aria-label={t('account.settings.listAria')}>
        {props.list.map((a) => <AccountRow key={a.id} account={a} agent={ag} colors={props.colors} />)}
      </ul>
      <div className="account-set-add">
        <button type="button" className="btn" onClick={() => emit({ type: 'account.add.open', ...ag })}><Icon name="add" />{t('account.settings.addButton')}</button>
      </div>
    </section>
  );
}
