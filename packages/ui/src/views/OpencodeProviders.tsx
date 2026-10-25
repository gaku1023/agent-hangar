import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useEmit } from '../action/chain.tsx';
import type { OpencodeCatalogRowProps, OpencodeLoginProps, OpencodeProviderRowProps, OpencodeProvidersProps } from '../presenters/opencodeProviders.ts';
import { useT } from './primitives/language.tsx';
import { collapseOut, growIn, markHit, motionOn } from './primitives/motionKit.ts';
import { usePresence } from './primitives/usePresence.ts';

/** ログインの進みを聞く間（ミリ秒）。 */
const LOGIN_POLL_MS = 2000;
/** OpenAI 互換のサーバーの行の、追加の一覧の中の ID。 */
const CUSTOM = ':custom';

/**
 * 開くと growIn で伸びて入り、閉じると collapseOut で畳んでから外れる箱。最初の描画で開いていても伸ばさない（設定を開いたときに動かない）。
 * 開き閉じの動きはアプリの決まった動き（motionKit）にそろえる。
 */
function Grow(props: { open: boolean; className: string; children: ReactNode; as?: 'div' | 'form'; onSubmit?: (e: FormEvent) => void }) {
  const p = usePresence<HTMLDivElement & HTMLFormElement>(props.open, (el) => (motionOn(el) ? collapseOut(el) : null));
  const was = useRef(props.open);
  useLayoutEffect(() => {
    if (props.open && !was.current && p.ref.current) growIn(p.ref.current);
    was.current = props.open;
  }, [props.open, p.ref]);
  if (!p.mounted) return null;
  return props.as === 'form'
    ? <form className={props.className} ref={p.ref} onSubmit={props.onSubmit}>{props.children}</form>
    : <div className={props.className} ref={p.ref}>{props.children}</div>;
}

/** 送った操作が、失敗せずに終わったら done を呼ぶ（欄を閉じて空にする）。 */
function useSettled(busy: boolean, error: string | null, done: () => void): () => void {
  const sent = useRef(false);
  const was = useRef(busy);
  useEffect(() => {
    if (was.current && !busy && sent.current) {
      sent.current = false;
      if (!error) done();
    }
    was.current = busy;
  });
  return () => { sent.current = true; };
}

/** つないだ先の 1 行。「モデル ID を追加」と「API キーを変更」は行の下に欄を伸ばし、「接続を解除」はすぐ送る。 */
function ProviderRow(props: { r: OpencodeProviderRowProps }) {
  const t = useT();
  const emit = useEmit();
  const r = props.r;
  const [form, setForm] = useState<'model' | 'key' | null>(null);
  const [value, setValue] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const markSent = useSettled(r.busy !== null, r.error, () => { setForm(null); setValue(''); });
  // 直前に接続した行は、伸びて入ってから地を淡く光らせる。
  useLayoutEffect(() => {
    if (r.fresh && ref.current) { growIn(ref.current); markHit(ref.current); }
    // 入った最初の描画でだけ動かす。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggle = (f: 'model' | 'key') => { setValue(''); setForm(form === f ? null : f); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim() || r.busy) return;
    markSent();
    emit(form === 'key' ? { type: 'opencode.providers.key', id: r.id, key: value } : { type: 'opencode.providers.model', id: r.id, model: value });
  };
  return (
    <div className="ocp-row" ref={ref} data-provider={r.id}>
      <div className="ocp-row-l">
        <div className="ocp-name">{r.name}</div>
        <div className="ocp-desc">{r.desc}{r.url && <>{r.desc ? ' · ' : ''}<code>{r.url}</code></>}</div>
      </div>
      <div className="ocp-acts">
        <button type="button" className="btn-link" aria-expanded={form === 'model'} onClick={() => toggle('model')}>{t('settings.opencode.providers.addModel')}</button>
        {r.canChangeKey && <button type="button" className="btn-link" aria-expanded={form === 'key'} onClick={() => toggle('key')}>{t('settings.opencode.providers.changeKey')}</button>}
        {r.canDisconnect && <button type="button" className="btn-link ocp-danger" disabled={r.busy !== null} onClick={() => emit({ type: 'opencode.providers.disconnect', id: r.id })}>{t('settings.opencode.providers.disconnect')}</button>}
      </div>
      <Grow open={form !== null} className="ocp-inline" as="form" onSubmit={submit}>
        <input className={form === 'key' ? 'input' : 'input mono'} type={form === 'key' ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)}
          aria-label={t(form === 'key' ? 'settings.opencode.providers.changeKey' : 'settings.opencode.providers.addModel')}
          placeholder={form === 'key' ? t('settings.opencode.providers.key.placeholder', { name: r.name }) : t('settings.opencode.providers.model.placeholder')} />
        <button type="submit" className="btn btn-sm btn-primary" disabled={!value.trim() || r.busy !== null}>
          {form === 'key' ? t(r.busy === 'key' ? 'settings.opencode.providers.key.connecting' : 'settings.opencode.providers.key.connect') : t('settings.opencode.providers.model.submit')}
        </button>
      </Grow>
      {r.error && <div className="ocp-err" role="alert">{r.error}</div>}
    </div>
  );
}

/** 始めたログイン。ブラウザで開く URL と、opencode の案内（デバイスのコードなど）を出す。コードを入れる型なら欄を出す。 */
function LoginPanel(props: { l: OpencodeLoginProps }) {
  const t = useT();
  const emit = useEmit();
  const l = props.l;
  const [code, setCode] = useState('');
  return (
    <div className="ocp-login" data-state={l.state}>
      {l.instructions && <div className="ocp-login-ins mono">{l.instructions}</div>}
      <div className="ocp-login-row">
        {l.url && <a className="btn btn-sm btn-primary" href={l.url} target="_blank" rel="noreferrer noopener">{t('settings.opencode.providers.login.open')}</a>}
        <span className="ocp-login-note" aria-live="polite">{l.note}</span>
        <button type="button" className="btn-link" onClick={() => emit({ type: 'opencode.providers.login.cancel' })}>{t('settings.opencode.providers.login.cancel')}</button>
      </div>
      {l.mode === 'code' && l.state === 'pending' && (
        <form className="ocp-inline" onSubmit={(e) => { e.preventDefault(); if (code.trim()) emit({ type: 'opencode.providers.login.code', code }); }}>
          <input className="input mono" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder={t('settings.opencode.providers.login.code')} aria-label={t('settings.opencode.providers.login.code')} />
          <button type="submit" className="btn btn-sm" disabled={!code.trim() || l.busy}>{t('settings.opencode.providers.login.send')}</button>
        </form>
      )}
      {l.error && <div className="ocp-err" role="alert">{l.error}</div>}
    </div>
  );
}

/** 追加の一覧の 1 行。選ぶと下に API キーの欄（無ければログインのボタン）が伸びる。 */
function CatalogRow(props: { c: OpencodeCatalogRowProps; selected: boolean; onSelect: () => void; login: OpencodeLoginProps | null }) {
  const t = useT();
  const emit = useEmit();
  const c = props.c;
  const [key, setKey] = useState('');
  const markSent = useSettled(c.busy, c.error, () => setKey(''));
  return (
    <>
      <button type="button" className="ocp-arow" aria-selected={props.selected} aria-expanded={props.selected} onClick={props.onSelect}>
        <span className="ocp-arow-n">{c.name}</span>
        {c.side && <span className="ocp-arow-k">{c.side}</span>}
      </button>
      <Grow open={props.selected} className="ocp-connect">
        {c.key ? (
          <form className="ocp-inline" onSubmit={(e) => { e.preventDefault(); if (!key.trim() || c.busy) return; markSent(); emit({ type: 'opencode.providers.key', id: c.id, key }); }}>
            <input className="input" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={t('settings.opencode.providers.key.placeholder', { name: c.name })} aria-label={t('settings.opencode.providers.key.placeholder', { name: c.name })} />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!key.trim() || c.busy}>{t(c.busy ? 'settings.opencode.providers.key.connecting' : 'settings.opencode.providers.key.connect')}</button>
          </form>
        ) : c.login && !props.login ? (
          <div className="ocp-inline">
            <button type="button" className="btn btn-sm btn-primary" disabled={c.busy} onClick={() => emit({ type: 'opencode.providers.login', id: c.id, method: c.login!.id })}>{t('settings.opencode.providers.login.start')}</button>
            <span className="ocp-hint">{c.login.label}</span>
          </div>
        ) : null}
        {props.login && <LoginPanel l={props.login} />}
        {c.error && <div className="ocp-err" role="alert">{c.error}</div>}
      </Grow>
    </>
  );
}

/** OpenAI 互換のサーバーの欄（名前、URL、API キー（任意））。モデルは /v1/models から取る。 */
function CustomForm(props: { open: boolean; busy: boolean; error: string | null; configPath: string }) {
  const t = useT();
  const emit = useEmit();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const markSent = useSettled(props.busy, props.error, () => { setName(''); setUrl(''); setKey(''); });
  const ready = name.trim() !== '' && url.trim() !== '' && !props.busy;
  return (
    <Grow open={props.open} className="ocp-cform" as="form" onSubmit={(e) => { e.preventDefault(); if (!ready) return; markSent(); emit({ type: 'opencode.providers.custom', name, url, ...(key.trim() ? { apiKey: key } : {}) }); }}>
      <label className="field">{t('settings.opencode.providers.custom.name')}<input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field">{t('settings.opencode.providers.custom.url')}<input className="input mono" value={url} spellCheck={false} placeholder="http://192.168.0.10:8000/v1" onChange={(e) => setUrl(e.target.value)} /></label>
      <label className="field">{t('settings.opencode.providers.custom.key')}<input className="input" type="password" autoComplete="off" value={key} placeholder={t('settings.opencode.providers.custom.keyPlaceholder')} onChange={(e) => setKey(e.target.value)} /></label>
      <div className="ocp-hint">{t('settings.opencode.providers.custom.note', { path: props.configPath })}</div>
      {props.error && <div className="ocp-err" role="alert">{props.error}</div>}
      <div><button type="submit" className="btn btn-sm btn-primary" disabled={!ready}>{t(props.busy ? 'settings.opencode.providers.custom.submitting' : 'settings.opencode.providers.custom.submit')}</button></div>
    </Grow>
  );
}

/**
 * 設定の「連携 › opencode › プロバイダー」（試作 model-picker.html の設定の面）。opencode を有効にしたときだけ、opencode の面の下に出る。
 * 出たときに一覧を読み、ログインの途中は数秒おきに進みを聞き、終わったら一覧を読み直す。
 * 「＋ プロバイダーを追加」の一覧と、行の下の欄は growIn で伸び、collapseOut で畳む。接続した行は伸びて入り、地を淡く光らせる。
 */
export function OpencodeProviders(props: { p: OpencodeProvidersProps }) {
  const t = useT();
  const emit = useEmit();
  const p = props.p;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => { emit({ type: 'opencode.providers.load' }); }, [emit]);
  const loginState = p.login?.state ?? null;
  useEffect(() => {
    if (loginState !== 'pending') return;
    const timer = setInterval(() => emit({ type: 'opencode.providers.login.poll' }), LOGIN_POLL_MS);
    return () => clearInterval(timer);
  }, [loginState, emit]);
  useEffect(() => { if (loginState === 'complete') emit({ type: 'opencode.providers.load' }); }, [loginState, emit]);
  // 追加の一覧から接続できたら、一覧を閉じる（新しい行が上に入る）。
  const ids = p.rows.map((r) => r.id).join('\n');
  const before = useRef(ids);
  useEffect(() => {
    if (before.current !== ids && p.rows.some((r) => r.fresh)) { setOpen(false); setSelected(null); setQ(''); }
    before.current = ids;
  }, [ids, p.rows]);
  const needle = q.trim().toLowerCase();
  const shown = p.catalog.filter((c) => !needle || c.name.toLowerCase().includes(needle) || c.id.includes(needle));
  const rec = shown.filter((c) => c.recommended);
  const rest = shown.filter((c) => !c.recommended);
  const customShown = !needle || 'openai'.includes(needle) || t('settings.opencode.providers.custom.title').toLowerCase().includes(needle);
  const pick = (id: string) => setSelected(selected === id ? null : id);
  const row = (c: OpencodeCatalogRowProps) => <CatalogRow key={c.id} c={c} selected={selected === c.id} onSelect={() => pick(c.id)} login={p.login?.id === c.id ? p.login : null} />;
  return (
    <div className="ocp" id="settings-opencode-providers">
      {p.back && <button type="button" className="btn-link ocp-back" onClick={() => emit({ type: 'opencode.providers.back' })}>{t('settings.opencode.providers.back')}</button>}
      <div className="ocp-h">
        <span className="ocp-title">{t('settings.opencode.providers.title')}</span>
        <span className="ocp-note">{t('settings.opencode.providers.note')}</span>
      </div>
      {p.status === 'loading' && <div className="ocp-empty">{t('settings.common.loading')}</div>}
      {p.status === 'failed' && (
        <div className="ocp-empty" data-tone="warn">
          {t('settings.opencode.providers.failed')}
          {p.failure && <span className="ocp-hint"> {p.failure}</span>}
          {' '}<button type="button" className="btn-link" onClick={() => emit({ type: 'opencode.providers.load' })}>{t('settings.opencode.providers.reload')}</button>
        </div>
      )}
      {p.rows.length > 0 && <div className="ocp-list">{p.rows.map((r) => <ProviderRow key={r.id} r={r} />)}</div>}
      {p.status === 'ready' && (
        <button type="button" className="ocp-add" aria-expanded={open} onClick={() => { setOpen(!open); setSelected(null); setQ(''); }}>
          {open ? '－' : '＋'} {t('settings.opencode.providers.add')}
        </button>
      )}
      <Grow open={open && p.status === 'ready'} className="ocp-adder">
        <input className="input ocp-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('settings.opencode.providers.search', { n: String(p.total) })} aria-label={t('settings.opencode.providers.search', { n: String(p.total) })} />
        <div className="ocp-alist">
          {rec.length > 0 && <div className="ocp-pick-h">{t('settings.opencode.providers.recommended')}</div>}
          {rec.map(row)}
          {rest.length > 0 && <div className="ocp-pick-h">{t('settings.opencode.providers.others')}</div>}
          {rest.map(row)}
          {!shown.length && !customShown && <div className="ocp-empty">{t('settings.opencode.providers.noMatch')}</div>}
        </div>
        {customShown && (
          <>
            <button type="button" className="ocp-arow ocp-custom" aria-selected={selected === CUSTOM} aria-expanded={selected === CUSTOM} onClick={() => pick(CUSTOM)}>
              <span className="ocp-arow-n">{t('settings.opencode.providers.custom.title')}</span>
              <span className="ocp-arow-k">{t('settings.opencode.providers.custom.side')}</span>
            </button>
            <CustomForm open={selected === CUSTOM} busy={p.custom.busy} error={p.custom.error} configPath={p.configPath} />
          </>
        )}
      </Grow>
    </div>
  );
}
