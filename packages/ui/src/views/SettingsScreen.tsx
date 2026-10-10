import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Language, SettingsDto, SettingsSection, TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { SaveMark } from '../mediator/types.ts';
import { costLabel, SUMMARIZER_LABEL, tokensLabel } from '../presenters/format.ts';
import { clientPlatform, muxInstallCommand, type VerifyLine } from '../presenters/readiness.ts';
import { JOIN_TOKEN_TTL_MS, type SettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { PageHeading } from './PageHeading.tsx';
import { CommandLine, CopyButton } from './primitives/CommandLine.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { UsageBar } from './UsageBar.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { CloudUsage } from './CloudUsage.tsx';
import { ConfigSyncSection } from './ConfigSyncSection.tsx';
import { CompatSection } from './CompatSection.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Stepper } from './primitives/Stepper.tsx';
import { Switch } from './primitives/Switch.tsx';

/** 「✓ 保存しました」を出しておく長さ（設定の C1）。 */
export const SAVED_TICK_MS = 2000;

/** 目次の各行のアイコン。 */
const SECTION_ICON: Record<SettingsSection, IconName> = { general: 'general', cloud: 'cloud', integrations: 'link', summary: 'permissionAuto', tools: 'tool', info: 'info' };

/** 欄の横に「✓ 保存しました」を 2 秒出す。n が進むたびに出し直す（設定の C1）。 */
/** 外部ターミナルの選択肢の印。製品のアプリは窓の印、OS の素のターミナルはターミナルの印にする。 */
const TERMINAL_ICON: Record<TerminalApp, IconName> = { terminal: 'openTerminal', iterm: 'appWindow', windowsTerminal: 'appWindow', windowsDefault: 'openTerminal' };

function SavedTick(props: { mark: SaveMark | undefined }) {
  const t = useT();
  const n = props.mark?.kind === 'saved' ? props.mark.n : 0;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (n === 0) return;
    setShow(true);
    const timer = setTimeout(() => setShow(false), SAVED_TICK_MS);
    return () => clearTimeout(timer);
  }, [n]);
  return <span className="saved-tick" data-show={show ? 'true' : undefined} role="status" aria-live="polite"><Icon name="check" />{show ? t('settings.common.saved') : ''}</span>;
}

/**
 * 欄の下の 1 行（設定の B1）。
 * 保存を断られたときは、その理由を先に出す。
 * 準備の確かめが届く前は「確かめています」と出す。
 */
function VerifyRow(props: { line: VerifyLine | null; mark?: SaveMark | undefined; waiting?: string }) {
  const t = useT();
  if (props.mark?.kind === 'error') return <span className="verify" data-tone="ng" role="alert"><Icon name="close" />{props.mark.message}</span>;
  const l = props.line;
  if (!l) return <span className="verify" data-tone="wait">{props.waiting ?? t('settings.common.checking')}</span>;
  if (l.ok) return <span className="verify" data-tone="ok"><Icon name="check" /><span className="verify-path">{l.text}</span>{l.note && <span>（{l.note}）</span>}</span>;
  return (
    <span className="verify" data-tone={l.soft ? 'soft' : 'ng'}>
      <Icon name="close" />{l.text}
      {(l.fix || l.fixCommand) && (
        <span className="verify-fix">
          {l.fix}
          {l.fixCommand && <><code>{l.fixCommand}</code><CopyButton text={l.fixCommand} /></>}
        </span>
      )}
      {l.soft && l.note && <span className="faint">（{l.note}）</span>}
    </span>
  );
}

/**
 * パスの欄。欄を出たら保存する（保存のボタンは持たない）。
 * 値は前後の空白を落として見比べ、変わっていなければ送らない。
 * nullable の欄は、空を「指定なし」の null として送る。
 * 存在と実行権はサーバが保存の前に確かめ、断られたら理由が欄の下に出る。
 */
function PathField(props: { field: keyof SettingsDto; label: string; value: string | null; nullable: boolean; placeholder?: string; line: VerifyLine | null; mark: SaveMark | undefined; hideLabel?: boolean; children?: ReactNode }) {
  const emit = useEmit();
  const saved = props.value ?? '';
  const [v, setV] = useState(saved);
  // サーバが整えた値（~ を直したパスなど）を欄に映す。
  useEffect(() => { setV(saved); }, [saved]);
  const save = () => {
    const next = v.trim();
    if (next === saved.trim()) { if (v !== saved) setV(saved); return; }
    emit({ type: 'settings.update', patch: { [props.field]: props.nullable && next === '' ? null : next }, field: props.field });
  };
  return (
    <div className="field path-field">
      {!props.hideLabel && <span aria-hidden="true">{props.label}</span>}
      <span className="inrow">
        <input className="input mono" aria-label={props.label} value={v} placeholder={props.placeholder} spellCheck={false} autoComplete="off"
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); save(); } }} />
        <SavedTick mark={props.mark} />
      </span>
      <VerifyRow line={props.line} mark={props.mark} />
      {props.children}
    </div>
  );
}

/** 札（✓ 登録済み、まだです）。形でも分け、色だけに頼らない。 */
function Badge(props: { ok: boolean | null; yes: string; no: string }) {
  if (props.ok === null) return null;
  return <span className="badge" data-tone={props.ok ? 'ok' : 'warn'}><Icon name={props.ok ? 'check' : 'alert'} />{props.ok ? props.yes : props.no}</span>;
}

/** 参加トークン（設定の E2）。トークンとコピー、減る棒と「あと N 秒で消えます」。 */
function JoinToken(props: { token: string; expiresAt: number | null }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const leftMs = props.expiresAt === null ? JOIN_TOKEN_TTL_MS : Math.max(0, props.expiresAt - now);
  const left = Math.ceil(leftMs / 1000);
  return (
    <div className="tok">
      <div className="tok-line">
        <span className="tok-val mono">{props.token}</span>
        <CopyButton text={props.token} name={t('settings.cloud.token.name')} label={t('settings.cloud.token.copy')} />
      </div>
      <div className="tbar" data-low={left <= 10 ? 'true' : undefined} role="progressbar" aria-label={t('settings.cloud.token.bar')} aria-valuemin={0} aria-valuemax={JOIN_TOKEN_TTL_MS / 1000} aria-valuenow={left}>
        <i style={{ width: `${(leftMs / JOIN_TOKEN_TTL_MS) * 100}%` }} />
      </div>
      <small>{t('settings.cloud.token.note', { n: left })}</small>
    </div>
  );
}

/**
 * 設定画面（S1）。
 * 左の目次で 6 つの節（一般、クラウド同期、連携、要約エンジン、ツール、情報）を切り替え、右は選んだ節だけを出す。
 * 目次の各行は、節の名前と今の状態の 1 行を持つ。
 * 開いている節は URL の `at` が決める（props.section）ので、戻ると進むで節も戻り、目次の灯りは URL に従う。
 * パスの欄は欄を出たら保存し、欄の横に「✓ 保存しました」、欄の下に検証の 1 行を出す（C1 と B1）。
 * 保持する状態は入力途中の値だけで、保存は settings.update を出す。
 */
export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  const [lmUrl, setLmUrl] = useState(props.lmStudioUrl);
  const [lmModel, setLmModel] = useState(props.lmStudioModel ?? '');
  const [cap, setCap] = useState(String(props.summaryHourlyCap));
  const [capError, setCapError] = useState(false);
  // 同期していない人が押した方の、ターミナルで打つコマンド。
  const [cloudCommand, setCloudCommand] = useState<'start' | 'join' | null>(null);
  // サーバが正規化した値を入力欄に反映する。
  useEffect(() => { setLmUrl(props.lmStudioUrl); }, [props.lmStudioUrl]);
  useEffect(() => { setLmModel(props.lmStudioModel ?? ''); }, [props.lmStudioModel]);
  useEffect(() => { setCap(String(props.summaryHourlyCap)); }, [props.summaryHourlyCap]);
  useEffect(() => { setCapError(false); }, [props.summaryHourlyCap]);
  // 外部の要約エンジンを許可する前の確かめの帯。許可するまでは、スイッチもオフのままにする。
  const [confirmExternal, setConfirmExternal] = useState(false);
  useEffect(() => { if (props.allowExternalSummarizer) setConfirmExternal(false); }, [props.allowExternalSummarizer]);
  // 帯が開いたら、キャンセルへフォーカスを送る。閉じるときは、開いたスイッチへ戻す。
  const externalRow = useRef<HTMLDivElement>(null);
  const cancelExternal = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (confirmExternal) cancelExternal.current?.focus(); }, [confirmExternal]);
  const closeConfirm = () => {
    setConfirmExternal(false);
    externalRow.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  };
  const setNow = (patch: Partial<SettingsDto>) => emit({ type: 'settings.update', patch });
  // 1 時間の上限は 1 以上 200 以下の整数だけを受け付ける。
  // 空のまま送ると 0 になって、Claude への切り替えが黙って止まってしまう。
  // 数字でない文字は NaN になるので、これも送らない。
  const capNumber = cap.trim() === '' ? Number.NaN : Number(cap);
  const capValid = Number.isInteger(capNumber) && capNumber >= 1 && capNumber <= 200;
  // サーバが保存する形にそろえてから送る。
  // URL は前後の空白と末尾の / を落とし、モデル名は trim して空なら未設定に寄せる。
  // 整えずに送ると、落とされた結果が元と同じときに props が動かない。
  // すると欄には整える前の文字列が残り、保存ボタンも押せたままになる。
  const lmUrlValue = lmUrl.trim().replace(/\/+$/, '');
  const lmModelValue = lmModel.trim() || null;
  const saveSummarizer = () => {
    if (!capValid) { setCapError(true); return; }
    setCapError(false);
    // 欄も整えた形に直す。押せない理由が欄から読めるようにする。
    setLmUrl(lmUrlValue);
    setLmModel(lmModelValue ?? '');
    emit({ type: 'settings.update', patch: { lmStudioUrl: lmUrlValue, lmStudioModel: lmModelValue, summaryHourlyCap: capNumber }, field: 'summarizer' });
  };
  // 要約エンジンは 3 項目をまとめて送るので、1 つでも変わっていれば押せる。
  // 読めない上限（空や小数）は capNumber が NaN になるため、ここでは必ず「変わっている」側に入る。
  // 押せないと、1 から 200 までの整数を入れてくださいという案内を出す道が無くなってしまう。
  const summarizerDirty = lmUrlValue !== props.lmStudioUrl || lmModelValue !== props.lmStudioModel || capNumber !== props.summaryHourlyCap;
  // 保存済みのモデルが一覧に無くても（LM Studio が落ちているときなど）、顔から名前を消さない。
  const models = props.summarizerModels ?? [];
  const modelNames = lmModel && !models.includes(lmModel) ? [lmModel, ...models] : models;
  const modelOptions = [{ value: '', label: t('settings.summary.modelAuto') }, ...modelNames.map((m) => ({ value: m, label: m }))];
  // LM Studio の URL の欄の下の 1 行。モデルの一覧が取れたかで、つながったかを言う。
  const lmLine: VerifyLine | null = props.summarizerModels === null ? null
    : props.summarizerModels.length === 0 ? { ok: false, soft: false, text: t('settings.summary.offline'), note: null, fix: null, fixCommand: null }
      : { ok: true, soft: false, text: t('settings.summary.connected'), note: t('settings.summary.models', { n: props.summarizerModels.length }), fix: null, fixCommand: null };

  // 節を切り替えたら、頁をスクロールする枠の先頭へ戻す。前の節の途中の位置から始めない。
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    root.current?.closest<HTMLElement>('.main')?.scrollTo?.({ top: 0 });
  }, [props.section]);

  // ヘッダのアカウントの設定から来たときは、連携の節のアカウントの位置が見える所へ移る。
  // 節は一覧が届いてから出るので、出たときにも見直す。
  const showAccounts = props.accounts.list.length > 0;
  useEffect(() => {
    if (props.focus !== 'accounts' || props.section !== 'integrations' || !showAccounts) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('settings-accounts')?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [props.focus, props.section, showAccounts]);

  const go = (to: SettingsSection) => { if (to !== props.section) emit({ type: 'nav.go', to: { name: 'settings', at: to } }); };
  // 目次は 1 本の道として、上下で行を移る。選ぶのは Enter と Space（押す）で、移るだけでは URL を増やさない。
  const onTocKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.metaKey || e.ctrlKey) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('.settings-toc-item')];
    const i = rows.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  };

  const cur = props.toc.find((r) => r.id === props.section)!;
  const todo = props.section === 'tools' ? props.todo.must : props.section === 'integrations' ? props.todo.link : 0;

  const general = (
    <section aria-label={cur.title}>
      <SetRow title={t('settings.general.language.title')} desc={t('settings.general.language.desc')}
        control={<Segmented label={t('settings.general.language.title')} value={props.language.value} options={[{ value: 'ja', label: t('settings.general.language.ja') }, { value: 'en', label: t('settings.general.language.en') }]} onChange={(v) => setNow({ language: v as Language })} />} />
      {/* 入力待ちを OS の通知で知らせる。直すものの数には入れない（無くても動くため）。 */}
      <SetRow title={t('settings.general.notify.title')}
        desc={<>
          {t('settings.general.notify.desc')}
          {!props.notify.available && <div style={{ marginTop: 4 }}>{t('settings.general.notify.unavailable')}</div>}
          {props.notify.available && props.notify.blocked && <div style={{ marginTop: 4 }}>{t('settings.general.notify.blocked')}</div>}
        </>}
        control={<Switch label={t('settings.general.notify.title')} checked={props.notify.on} disabled={!props.notify.available} onChange={(next) => emit({ type: 'notify.set', on: next })} />} />
      {/* 切り替えた時点で保存する。iTerm2 は初回に macOS の自動化の許可ダイアログが出る。選択肢は画面を開いている OS のものだけ。 */}
      <SetRow title={t('settings.general.terminal.title')} desc={props.terminalDesc}
        control={<Segmented label={t('settings.general.terminal.title')} value={props.terminalApp} options={props.terminalOptions.map((o) => ({ ...o, lead: <Icon name={TERMINAL_ICON[o.value]} /> }))} onChange={(v) => setNow({ terminalApp: v as TerminalApp })} />} />
      {/* Claude Code の保持期間。押しても保存せず、差分を見せる確認を開く。hangar が Claude Code の設定を書くのはここだけである。 */}
      {props.retention && (
        <SetRow title={t('settings.general.retention.title')}
          desc={<>{t('settings.general.retention.desc')}{props.retention.syncNote && ` ${t('settings.general.retention.syncNote')}`}</>}
          control={props.retention.writable
            ? <Segmented label={t('settings.general.retention.period')} value={String(props.retention.days)} options={props.retention.options} onChange={(v) => { if (Number(v) !== props.retention!.days) emit({ type: 'retention.edit', days: Number(v), from: 'settings' }); }} />
            : <span className="muted">{props.retention.valueLabel}<span className="faint">（{props.retention.reason}）</span></span>}
          below={props.retention.bar ? <UsageBar {...props.retention.bar} /> : undefined} />
      )}
    </section>
  );

  const cloudOff = !props.cloud.configured;
  const cloud = (
    <>
      <section aria-label={cur.title}>
        {cloudOff && (
          <>
            <p className="muted-p">{t('settings.cloud.off.lead')}</p>
            <div className="btns">
              <button type="button" className="btn btn-primary" aria-pressed={cloudCommand === 'start'} onClick={() => setCloudCommand('start')}><Icon name="cloud" />{t('settings.cloud.off.start')}</button>
              <button type="button" className="btn" aria-pressed={cloudCommand === 'join'} onClick={() => setCloudCommand('join')}>{t('settings.cloud.off.join')}</button>
            </div>
            {cloudCommand === null && <div className="faint" style={{ marginTop: 8 }}>{t('settings.cloud.off.note')}</div>}
            {cloudCommand === 'start' && <><div className="faint" style={{ marginTop: 8 }}>{t('settings.cloud.off.runStart')}</div><CommandLine command="hangar setup cloud" /></>}
            {cloudCommand === 'join' && <><div className="faint" style={{ marginTop: 8 }}>{t('settings.cloud.off.runJoin')}</div><CommandLine command="hangar join <token>" /></>}
          </>
        )}
        {!cloudOff && (
          <>
            <div className="stat">
              <span>{t('settings.cloud.state')} {props.cloud.stateLabel}</span>
              <span>{t('settings.cloud.lastReceived')} {props.cloud.lastPullAt}</span>
              <span>{t('settings.cloud.unsentChanges')} {t('settings.cloud.count', { n: props.cloud.pending })}</span>
              {/* 本文は 60 秒に 20 件ずつしか流れない。件数が出ていないと、進んでいるのか止まっているのか読めない。 */}
              {props.cloud.sweepPending !== null && <span>{t('settings.cloud.unsentTranscripts')} {t('settings.cloud.count', { n: props.cloud.sweepPending })}</span>}
            </div>
            <div className="mono faint" style={{ marginTop: 4 }}>{props.cloud.url}</div>
            {/* 送信に失敗したトランスクリプトは 30 分ごとに送り直すので放っておけば回復する。回復するまでのあいだ、ここでだけ確かめられる。 */}
            {props.cloud.skipped.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="error" role="alert">{t('settings.cloud.failed', { n: props.cloud.skipped.length })}</div>
                <ul className="faint mono" style={{ margin: '4px 0 0', paddingLeft: 16, wordBreak: 'break-all' }}>
                  {props.cloud.skipped.map((k) => <li key={k.key}>{t('settings.cloud.failedItem', { key: k.key, message: k.message, attempts: k.attempts })}</li>)}
                </ul>
              </div>
            )}
            <div className="btns">
              <button className="btn" disabled={props.cloud.once} title={props.cloud.paused && !props.cloud.once ? t('settings.cloud.syncOnceTitle') : undefined} onClick={() => emit({ type: 'sync.now' })}>{props.cloud.once ? t('settings.cloud.syncing') : t('settings.cloud.syncNow')}</button>
              {/* 上限で退いている間は、利用者は止めていないので切り替えを出さず、今すぐ同期だけにする（試作の Q4 の案 B）。
                  一時停止中に版で止まっている間も出さない。再開しても、互換の版が合うまで同期できないからである。
                  更新するのがこの PC かクラウドの Worker かは、error の文（CompatError の message）がそのまま言う。 */}
              {!props.cloud.limited && !(props.cloud.paused && props.cloud.state === 'error') && <button className="btn" onClick={() => emit({ type: 'sync.pause', paused: !props.cloud.paused })}>{props.cloud.paused ? t('settings.cloud.resume') : t('settings.cloud.pause')}</button>}
              {/* 参加トークンは全セッションの読み書き権を持つ秘密なので、押すまで取りに行かない。 */}
              {/* 出したあとはランタイムが 120 秒で store から消すので、props が null に戻ればこのボタンの姿に戻る。 */}
              {props.cloud.joinToken === null && <button className="btn" onClick={() => emit({ type: 'sync.joinToken.show' })}>{t('settings.cloud.showToken')}</button>}
            </div>
            {props.cloud.joinToken !== null && <JoinToken token={props.cloud.joinToken} expiresAt={props.cloud.joinTokenExpiresAt} />}
            <h4 className="sub-h">{t('settings.cloud.computers')}<span className="n">{props.cloud.devices.length}</span></h4>
            <div className="list flat">
              {props.cloud.devices.map((d) => (
                <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto auto', cursor: 'default' }}>
                  <span>{d.name}{d.self && <span className="faint"> {t('settings.cloud.thisPc')}</span>}</span>
                  <span className="faint">{d.platform}</span>
                  <span className="faint">{d.lastSeen}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
      {/* Claude Code の設定の同期（作り直した実装）。送る一覧と適用のダイアログは Root が開く。 */}
      <ConfigSyncSection cfg={props.configSync} cloudOff={cloudOff} />
      {/* 使用量と費用。同期している人にだけ出す（試作 usage-merged.html の「置き場所」）。 */}
      {!cloudOff && props.cloud.usage && <CloudUsage {...props.cloud.usage} />}
    </>
  );

  const integrations = (
    <>
      {/* 互換のずれは利用者が直せるものではないので、todo には数えない（目次の状態も要修正にしない）。 */}
      <CompatSection compat={props.compat} />
      <section>
        <h3 className="h2">{t('settings.integrations.mcp.title')}<Badge ok={props.mcpRegistered} yes={t('settings.integrations.mcp.yes')} no={t('settings.integrations.mcp.no')} /></h3>
        <div className="muted">{t('settings.integrations.mcp.desc')}</div>
        <CommandLine command={props.commands.mcp} />
      </section>
      <section>
        <h3 className="h2">{t('settings.integrations.statusline.title')}<Badge ok={props.statusline ? props.statusline.installed : null} yes={t('settings.integrations.statusline.yes')} no={t('settings.integrations.statusline.no')} /></h3>
        {props.statusline === null && <div className="faint">{t('settings.common.loading')}</div>}
        {props.statusline && props.statusline.scriptPath === null && (
          <>
            <div className="muted">{t('settings.integrations.statusline.missing')}</div>
            <div className="faint" style={{ marginTop: 4 }}>{t('settings.integrations.statusline.missingHint')}</div>
          </>
        )}
        {props.statusline?.scriptPath && (
          <>
            <div className="muted">{props.statusline.installed ? t('settings.integrations.statusline.installed') : t('settings.integrations.statusline.notInstalled')}</div>
            <div className="faint mono">{props.statusline.scriptPath}</div>
          </>
        )}
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.integrations.statusline.note')}</div>
        <CommandLine command={props.commands.statusline} />
        {/* 追記されるスニペットの宛先はこのコマンドの --port で決まる。 */}
        {/* 既定の 4177 のまま追記すると、別のポートで動かしているサーバには届かない。 */}
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.integrations.statusline.port')}</div>
      </section>
      {/* 包みは zsh のもので、Windows では作らない。Windows のサーバでは節ごと出さない。 */}
      {props.shell.available && <section>
        <h3 className="h2">{t('settings.integrations.shell.title')}<Badge ok={props.shell.state === null ? null : props.shell.state === 'on'} yes={t('settings.integrations.shell.yes')} no={t('settings.integrations.shell.no')} /></h3>
        <div className="muted">{t('settings.integrations.shell.desc')}</div>
        {props.shell.devices.length > 0 && (
          <div className="list" style={{ marginTop: 8 }}>
            {props.shell.devices.map((d) => (
              <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto', cursor: 'default' }}>
                <span>{d.name}{d.self && <span className="faint"> {t('settings.integrations.shell.thisPc')}</span>}</span>
                <span className={d.state === 'on' ? undefined : 'faint'}>{d.label}</span>
              </div>
            ))}
          </div>
        )}
        {props.shell.state === null && <div className="faint" style={{ marginTop: 4 }}>{t('settings.common.loading')}</div>}
        {/* 利用者のファイルは UI から書き換えない（ステータスラインと同じ）。入れるのは CLI で、承諾を求めて控えを取る。 */}
        {props.shell.state === 'off' && (
          <>
            <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.installHint', { zshrc: props.shell.zshrc })}</div>
            <CommandLine command={props.shell.command} />
          </>
        )}
        {props.shell.state === 'on' && <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.installedHint', { uninstall: props.shell.uninstallCommand })}</div>}
        {props.shell.state === 'unsupported' && <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.noTmux', { install: muxInstallCommand(clientPlatform()) })}</div>}
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.integrations.shell.adopt')}</div>
      </section>}
      {/* アカウントの追加の入口はここだけ。1 件でも出す。届く前（一覧が空）は出さない。 */}
      {showAccounts && <AccountSettings {...props.accounts} />}
    </>
  );

  const summary = (
    <section aria-label={cur.title}>
      <div className="grid2">
        <div className="field"><span aria-hidden="true">{t('settings.summary.url')}</span>
          <input className="input mono" aria-label={t('settings.summary.url')} value={lmUrl} onChange={(e) => setLmUrl(e.target.value)} />
          <VerifyRow line={lmLine} waiting={t('settings.common.loading')} />
        </div>
        <div className="field"><span aria-hidden="true">{t('settings.summary.model')}</span>
          <Listbox label={t('settings.summary.model')} value={lmModel} options={modelOptions} onChange={setLmModel} searchPlaceholder={t('settings.summary.modelSearch')} />
        </div>
      </div>
      <div ref={externalRow}>
        <SetRow title={t('settings.summary.external.title')} desc={t('settings.summary.external.desc')}
          control={<Switch label={t('settings.summary.external.title')} checked={props.allowExternalSummarizer} onChange={(next) => { if (next) setConfirmExternal(true); else setNow({ allowExternalSummarizer: false }); }} />} />
      </div>
      {confirmExternal && !props.allowExternalSummarizer && (
        <div className="confirm-strip" role="group" aria-label={t('settings.summary.external.confirmLabel')}>
          {/* 送られる先は保存済みの URL。欄を書き換えただけでは宛先は変わらない。 */}
          <span>{t('settings.summary.external.confirm', { url: props.lmStudioUrl })}</span>
          <span className="spacer" />
          <button ref={cancelExternal} className="btn" onClick={closeConfirm}>{t('common.button.cancel')}</button>
          <button className="btn btn-primary" onClick={() => { closeConfirm(); setNow({ allowExternalSummarizer: true }); }}>{t('settings.summary.external.allow')}</button>
        </div>
      )}
      {props.allowExternalSummarizer && <div className="error" role="alert" style={{ marginTop: 4 }}>{t('settings.summary.external.warn', { url: props.lmStudioUrl || t('settings.summary.external.thisDestination') })}</div>}
      <SetRow title={t('settings.summary.fallback')}
        control={<Switch label={t('settings.summary.fallback')} checked={props.summaryFallback} onChange={(next) => setNow({ summaryFallback: next })} />} />
      <SetRow title={t('settings.summary.cap.title')} desc={t('settings.summary.cap.desc')}
        control={<><Stepper label={t('settings.summary.cap.title')} value={cap} min={1} max={200} onChange={(v) => { setCap(v); setCapError(false); }} /><span className="faint">{t('settings.summary.cap.unit')}</span></>} />
      {capError && <div className="error" role="alert" style={{ marginTop: 4 }}>{t('settings.summary.cap.error')}</div>}
      <div className="btns">
        <button className="btn btn-primary" disabled={!summarizerDirty} onClick={saveSummarizer}>{t('settings.common.save')}</button>
        <SavedTick mark={props.save.summarizer} />
        <button className="btn" onClick={() => emit({ type: 'summarizer.test' })}>{t('settings.summary.test')}</button>
      </div>
      {props.save.summarizer?.kind === 'error' && <div className="error" role="alert" style={{ marginTop: 4 }}>{props.save.summarizer.message}</div>}
      {props.summarizerTest?.ok === true && (
        <div style={{ marginTop: 4 }}>
          <div className="muted">{t('settings.summary.testOk', { engine: SUMMARIZER_LABEL[props.summarizerTest.id] ?? props.summarizerTest.id, ms: props.summarizerTest.ms })}</div>
          <div className="faint">{props.summarizerTest.summary.oneLiner}</div>
        </div>
      )}
      {props.summarizerTest?.ok === false && (
        <ul className="faint" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
          {props.summarizerTest.tried.map((x) => <li key={x.id}>{SUMMARIZER_LABEL[x.id] ?? x.id}: {x.message}</li>)}
        </ul>
      )}
    </section>
  );

  const tools = (
    <>
      <section>
        <h3 className="h2">{t('settings.tools.parent.title')}</h3>
        <PathField field="workspaceRoot" label={t('settings.tools.parent.title')} hideLabel value={props.workspaceRoot} nullable={false} line={props.verify.workspace} mark={props.save.workspaceRoot} />
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.tools.parent.desc')}</div>
      </section>
      <section>
        <h3 className="h2">{t('settings.tools.paths.title')}</h3>
        <div className="grid2">
          <PathField field="tmuxPath" label={t('settings.tools.tmux')} value={props.tmuxPath} nullable placeholder={t('settings.tools.tmuxPlaceholder', { install: muxInstallCommand(clientPlatform()) })} line={props.verify.tmux} mark={props.save.tmuxPath} />
          <PathField field="claudePath" label={t('settings.tools.claude')} value={props.claudePath} nullable placeholder={t('settings.tools.claudePlaceholder')} line={props.verify.claude} mark={props.save.claudePath} />
          <PathField field="codePath" label={t('settings.tools.code')} value={props.codePath} nullable placeholder={t('settings.tools.codePlaceholder')} line={props.verify.code} mark={props.save.codePath} />
          <PathField field="nodePath" label={t('settings.tools.node')} value={props.nodePath} nullable placeholder="/opt/homebrew/bin/node" line={props.verify.node} mark={props.save.nodePath} />
        </div>
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.tools.nodeNote')}</div>
      </section>
    </>
  );

  const info = (
    <>
      <section>
        <h3 className="h2">{t('settings.info.usage.title')}</h3>
        {props.usageAggregate === null && <div className="faint">{t('settings.info.usage.loading')}</div>}
        {props.usageAggregate && (
          <div className="grid2">
            <table className="mini"><caption className="faint">{t('settings.info.usage.last30')}</caption>
              <thead><tr><th>{t('settings.info.usage.day')}</th><th className="cell-right">{t('settings.info.usage.input')}</th><th className="cell-right">{t('settings.info.usage.output')}</th><th className="cell-right">{t('settings.info.usage.count')}</th></tr></thead>
              <tbody>{props.usageAggregate.days.map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="mono cell-right">{tokensLabel(d.inputTokens)}</td><td className="mono cell-right">{tokensLabel(d.outputTokens)}</td><td className="mono cell-right">{d.sessions}</td></tr>)}</tbody>
            </table>
            <table className="mini"><caption className="faint">{t('settings.info.usage.byProject')}</caption>
              <thead><tr><th>{t('settings.info.usage.name')}</th><th className="cell-right">{t('settings.info.usage.tokens')}</th><th className="cell-right">{t('settings.info.usage.cost')}</th><th className="cell-right">{t('settings.info.usage.count')}</th></tr></thead>
              <tbody>{props.usageAggregate.projects.map((p) => <tr key={p.projectId ?? 'none'}><td>{p.name}</td><td className="mono cell-right">{tokensLabel(p.inputTokens + p.outputTokens)}</td><td className="mono cell-right">{costLabel(p.costUsd)}</td><td className="mono cell-right">{p.sessions}</td></tr>)}</tbody>
            </table>
          </div>
        )}
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.info.usage.noteCost')}</div>
        {/* コストの供給源は cost.total_cost_usd で、そのセッションの走り全体の累計である。 */}
        {/* 日ごとの内訳が無いので、期間で切り分けられない。 */}
        <div className="faint">{t('settings.info.usage.noteTotal')}</div>
      </section>
      <section>
        <h3 className="h2">{t('settings.info.index.title')}</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono muted">{props.indexLabel}</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => emit({ type: 'index.rebuild' })}>{t('settings.info.index.rebuild')}</button>
        </div>
        <div className="faint mono" style={{ marginTop: 4 }}>{t('settings.info.index.source', { dir: props.claudeDir })}</div>
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.info.index.note')}</div>
      </section>
      <section>
        <h3 className="h2">{t('settings.info.thisPc.title')}</h3>
        <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
        <div className="faint mono">agent-hangar {props.version}</div>
      </section>
    </>
  );

  const body: Record<SettingsSection, ReactNode> = { general, cloud, integrations, summary, tools, info };

  return (
    <div ref={root} className="screen settings-screen">
      <PageHeading title={t('settings.heading.title')} />
      <div className="settings-layout">
        <nav className="settings-toc" aria-label={t('settings.toc.label')} onKeyDown={onTocKey}>
          {props.toc.map((r) => (
            <button key={r.id} type="button" className="settings-toc-item" aria-current={props.section === r.id ? 'page' : undefined} aria-label={r.label} tabIndex={props.section === r.id ? 0 : -1} onClick={() => go(r.id)}>
              <Icon name={SECTION_ICON[r.id]} />
              <span className="settings-toc-text">
                <span className="settings-toc-t">{r.title}</span>
                <span className="settings-toc-s" data-tone={r.tone}>{r.state}</span>
              </span>
            </button>
          ))}
        </nav>
        <div className="settings-page">
          <div className="settings-group" id={`settings-${props.section}`} role="group" aria-labelledby={`settings-${props.section}-h`}>
            <h2 className="settings-group-h" id={`settings-${props.section}-h`}>
              {cur.title}
              {props.section === 'cloud' && <span className="badge" data-tone={props.cloud.badge.tone}>{props.cloud.badge.text}</span>}
              {todo > 0 && <span className="badge" data-tone="warn"><Icon name="alert" />{t('settings.fix.count', { n: todo })}</span>}
            </h2>
            {body[props.section]}
          </div>
        </div>
      </div>
    </div>
  );
}
