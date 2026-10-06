import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useEmit } from '../intent/chain.tsx';
import { APPROVE_TEXT, LOGGED_OUT_TEXT, homePath, type AccountView } from '../presenters/accounts.ts';
import type { AccountSettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { MenuButton, type MenuItem } from './primitives/MenuButton.tsx';

/**
 * 行の「ログイン」と「やめる」は、押すとすぐ同じ場所で入れ替わる。
 * 入れ替わった直後の押下（ダブルクリックの 2 回目）で打ち消し合わないよう、この間だけ押せなくする。
 * 動きのトークンの長さに合わせた値で、数値の直書きが禁じられる CSS ではなくここに 1 か所だけ置く。
 */
const SWAP_GUARD_MS = 600;

/** 選べる色の呼び名。読み上げと title に使う。知らない色は #rrggbb のまま呼ぶ。 */
const COLOR_NAMES: Record<string, string> = { '#2a57b8': '青', '#7a4a9e': '紫', '#2b7048': '緑', '#c77a1a': '橙', '#a2452f': '赤茶' };
const colorName = (c: string) => COLOR_NAMES[c] ?? c;

/**
 * 状態の文を、本体と添え書きに分ける。
 * ログイン済みは「プラン・メール」で、どちらかが無ければある方だけ。未読は空。
 * ログインし直しの途中は、「プラン・メール」を出したまま、承認の添え書きを足す。
 * 初めてのログインの途中は、承認の添え書きだけ。
 */
function stateParts(a: AccountView): { main: string; hint: string } {
  const who = [a.plan, a.email].filter((x): x is string => x !== null).join('・');
  switch (a.auth) {
    case 'out': return { main: LOGGED_OUT_TEXT, hint: '' };
    case 'running': return a.loggedIn ? { main: who, hint: APPROVE_TEXT } : { main: '', hint: APPROVE_TEXT };
    case 'in': return { main: who, hint: '' };
    case 'unknown': return { main: '', hint: '' };
  }
}

/**
 * 名前をその場で直す入力欄。
 * Enter か欄を出るときに、変わっていれば保存する。Esc はやめる。
 * 変換中の Enter は確定しない。
 * Esc のあとに欄が消えるときの blur で保存しないよう、終わったかを持つ。
 */
function NameField(props: { account: AccountView; onDone: () => void }) {
  const emit = useEmit();
  const a = props.account;
  const [v, setV] = useState(a.name);
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = v.trim();
    if (save && next !== '' && next !== a.name) emit({ type: 'account.update', accountId: a.id, name: next });
    props.onDone();
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  return <input ref={input} className="input account-set-input" aria-label={`${a.name}の名前`} value={v} spellCheck={false} autoComplete="off" onChange={(e) => setV(e.target.value)} onBlur={() => finish(true)} onKeyDown={onKey} />;
}

/** 色を選ぶ帯。5 色の点が並び、押すと保存して閉じる。いまの色を押したときは何も送らない。 */
function ColorBand(props: { account: AccountView; colors: string[]; onDone: () => void }) {
  const emit = useEmit();
  const a = props.account;
  const band = useRef<HTMLDivElement>(null);
  // いまの色へフォーカスを送る（radio の作法）。
  useEffect(() => { band.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus(); }, []);
  const pick = (c: string) => {
    if (c !== a.color) emit({ type: 'account.update', accountId: a.id, color: c });
    props.onDone();
  };
  return (
    <div ref={band} className="account-set-colors" role="radiogroup" aria-label={`${a.name}の色`} onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); props.onDone(); } }}>
      {props.colors.map((c) => (
        <button key={c} type="button" role="radio" className="account-set-color" aria-checked={c === a.color} aria-label={colorName(c)} title={colorName(c)} onClick={() => pick(c)}>
          <span className="st-dot" style={{ color: c }} aria-hidden="true" />
        </button>
      ))}
    </div>
  );
}

/** アカウント 1 行。色の点、名前（と札）、置き場、状態、右端の操作。 */
function AccountRow(props: { account: AccountView; colors: string[] }) {
  const emit = useEmit();
  const a = props.account;
  const [editing, setEditing] = useState(false);
  const [coloring, setColoring] = useState(false);
  const { main, hint } = stateParts(a);
  const kind = a.auth === 'out' ? 'login' : a.auth === 'running' ? 'cancel' : null;
  const [guarded, setGuarded] = useState(false);
  const prevKind = useRef(kind);
  // 「ログイン」と「やめる」が入れ替わった直後だけ、押せなくする。
  useLayoutEffect(() => {
    const before = prevKind.current;
    prevKind.current = kind;
    if (before === null || kind === null || before === kind) { setGuarded(false); return undefined; }
    setGuarded(true);
    const t = setTimeout(() => setGuarded(false), SWAP_GUARD_MS);
    return () => clearTimeout(t);
  }, [kind]);
  const state = [main, hint].filter((x) => x !== '').join(' ');
  const path = homePath(a.dir);
  const items: MenuItem[] = [
    { key: 'rename', label: '名前を変える', onSelect: () => { setColoring(false); setEditing(true); } },
    { key: 'color', label: '色を変える', onSelect: () => { setEditing(false); setColoring(true); } },
    // 未ログインは行に「ログイン」を直に出し、途中は「やめる」を出すので、メニューには置かない。
    ...(a.auth === 'out' || a.auth === 'running' ? [] : [{ key: 'login', label: 'ログインし直す', onSelect: () => emit({ type: 'account.login', accountId: a.id }) }]),
    { key: 'refresh', label: '状態を読み直す', onSelect: () => emit({ type: 'account.refresh', accountId: a.id }) },
    // 押せない項目は消さずに、理由を出す。確認は account.remove を受けた側が出す。
    { key: 'remove', label: '一覧から外す', danger: true, disabled: a.primary ? '最初のアカウントは外せません' : null, onSelect: () => emit({ type: 'account.remove', accountId: a.id }) },
  ];
  return (
    <li className="account-set">
      <div className="account-set-row">
        <span className="st-dot account-set-dot" style={{ color: a.color }} aria-hidden="true" />
        <span className="account-set-who">
          {editing
            ? <NameField account={a} onDone={() => setEditing(false)} />
            : <b className="account-set-name" title={a.name}>{a.name}</b>}
          {a.current && <span className="account-set-tag" data-kind="current">いま</span>}
        </span>
        <span className="account-set-dir mono" title={a.dir}>{path}</span>
        <span className="account-set-state" data-auth={a.auth} title={state}>
          <span className="account-set-ident">{main}</span>
          {hint !== '' && <span className="account-set-approve">{hint}</span>}
        </span>
        <span className="account-set-acts">
          {a.auth === 'out' && <button type="button" className="btn btn-sm" disabled={guarded} onClick={() => emit({ type: 'account.login', accountId: a.id })}>ログイン</button>}
          {a.auth === 'running' && <button type="button" className="btn btn-sm" disabled={guarded} onClick={() => emit({ type: 'account.login.cancel', accountId: a.id })}>やめる</button>}
          <MenuButton label={`${a.name}の操作`} items={items} minWidth={240} />
        </span>
      </div>
      {coloring && <ColorBand account={a} colors={props.colors} onDone={() => setColoring(false)} />}
      {a.linkProblem !== null && <div className="account-set-problem">{a.linkProblem}</div>}
    </li>
  );
}

/**
 * 設定の「アカウント」の節。
 * アカウントの一覧と、行ごとの操作（名前、色、ログイン、読み直し、外す）、末尾の追加の欄を持つ。
 * 切り替えは別の画面（ヘッダ、新規セッション）のもので、ここは登録の入口である。
 * hangar はログインの中身を読まず、ログインは account.login を出すだけ。
 * 保持する状態は、名前を直している行、色の帯を開いている行、追加の欄の入力だけ。
 */
export function AccountSettings(props: AccountSettingsProps) {
  const emit = useEmit();
  const [name, setName] = useState('');
  const next = name.trim();
  const add = () => {
    if (next === '') return;
    emit({ type: 'account.add', name: next });
    setName('');
  };
  return (
    <section id="settings-accounts" className="account-set-section" aria-labelledby="settings-accounts-h">
      <h3 className="h2" id="settings-accounts-h">アカウント</h3>
      <div className="muted">Claude Code のアカウントを足すと、設定・スキル・履歴は共有したまま、ログインだけを切り替えられます。hangar はログインの中身を読みません。</div>
      <ul className="list account-set-list" aria-label="アカウントの一覧">
        {props.list.map((a) => <AccountRow key={a.id} account={a} colors={props.colors} />)}
      </ul>
      <div className="account-set-add">
        <input className="input" aria-label="アカウントの名前" placeholder="名前（例：大学）" value={name} spellCheck={false} autoComplete="off"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); add(); } }} />
        <button type="button" className="btn btn-primary" disabled={next === ''} onClick={add}>追加してログイン</button>
      </div>
      <div className="faint account-set-help">ブラウザが開くので、足したいアカウントで承認してください。終わると、ここにメールアドレスが出ます。</div>
    </section>
  );
}
