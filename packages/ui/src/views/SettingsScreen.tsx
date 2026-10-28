import { Fragment, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AUTO_DONE_IDLE_DAYS, type AutoDoneIdleDays, type Language, type SettingsDto, type SettingsField, type SettingsSection, type SummaryEngine, type TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../action/chain.tsx';
import type { SaveMark } from '../mediator/types.ts';
import { costLabel, tokensLabel } from '../presenters/format.ts';
import { clientPlatform, muxInstallCommand, notifyBlockedKey, type VerifyLine } from '../presenters/readiness.ts';
import type { IntegrationCard, SettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { MuxSection } from './MuxSection.tsx';
import { EditorSettings } from './EditorSettings.tsx';
import { InjectionSettings } from './InjectionSettings.tsx';
import { ModelPicker } from './ModelPicker.tsx';
import { PageHeading } from './PageHeading.tsx';
import { CommandLine, CopyButton } from './primitives/CommandLine.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { InfoTip } from './primitives/InfoTip.tsx';
import { useT } from './primitives/language.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { markHit } from './primitives/motionKit.ts';
import { revealWithin } from './primitives/revealWithin.ts';
import { Segmented } from './primitives/Segmented.tsx';
import { UsageBar } from './UsageBar.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { CloudUsage } from './CloudUsage.tsx';
import { CloudAddButton, CloudAddPc, CloudJoinSteps, CloudLeaveBand, CloudPcTable, CloudPhones, CloudRevokedBand, Strip } from './CloudMember.tsx';
import { CloudRecoveryButton, CloudRecoveryKey } from './CloudRecoveryKey.tsx';
import { ConfigSyncSection } from './ConfigSyncSection.tsx';
import { CompatSection } from './CompatSection.tsx';
import { CodexSection } from './CodexSection.tsx';
import { CodexAccountsSettings } from './CodexAccountsSettings.tsx';
import { AgentIcon } from './primitives/AgentIcon.tsx';
import { OpencodeSection } from './OpencodeSection.tsx';
import { UpdateSection } from './UpdateSection.tsx';
import { SetupGuideCard } from './SetupGuideCard.tsx';
import { SetRow } from './primitives/SetRow.tsx';
import { Stepper } from './primitives/Stepper.tsx';
import { Switch } from './primitives/Switch.tsx';

/** 「✓ 保存しました」を出しておく長さ（設定の C1）。 */
export const SAVED_TICK_MS = 2000;

/** 目次の各行のアイコン。 */
const SECTION_ICON: Record<SettingsSection, IconName> = { general: 'general', sessions: 'sessions', summary: 'permissionAuto', environment: 'tool', cloud: 'cloud', usage: 'usage', agentClaude: 'agent', agentCodex: 'agent', agentOpencode: 'agent', about: 'info' };

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
function PathField(props: { field: keyof SettingsDto; label: string; info?: ReactNode; value: string | null; nullable: boolean; placeholder?: string; line: VerifyLine | null; mark: SaveMark | undefined; hideLabel?: boolean; quiet?: boolean; pick?: { desktop: boolean; picked: { path: string; n: number } | null }; children?: ReactNode }) {
  const emit = useEmit();
  const t = useT();
  const saved = props.value ?? '';
  const [v, setV] = useState(saved);
  // サーバが整えた値（~ を直したパスなど）を欄に映す。
  useEffect(() => { setV(saved); }, [saved]);
  // 「選ぶ…」（Finder）。押した後に殻が返した選択だけを、この欄の値として保存する（ほかのダイアログで選んだものは当てない）。
  const pickedSeen = useRef(props.pick?.picked?.n ?? 0);
  const waiting = useRef(false);
  const picked = props.pick?.picked;
  useEffect(() => {
    if (!picked || picked.n <= pickedSeen.current) return;
    pickedSeen.current = picked.n;
    if (!waiting.current) return;
    waiting.current = false;
    setV(picked.path);
    emit({ type: 'settings.update', patch: { [props.field]: picked.path }, field: props.field });
  }, [picked?.n]);   // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    const next = v.trim();
    if (next === saved.trim()) { if (v !== saved) setV(saved); return; }
    emit({ type: 'settings.update', patch: { [props.field]: props.nullable && next === '' ? null : next }, field: props.field });
  };
  return (
    <div className="field path-field" id={`settings-field-${props.field}`}>
      {!props.hideLabel && (props.info
        ? <span className="path-field-label"><span aria-hidden="true">{props.label}</span><InfoTip label={props.label}>{props.info}</InfoTip></span>
        : <span aria-hidden="true">{props.label}</span>)}
      <span className="inrow">
        <input className="input mono" aria-label={props.label} value={v} placeholder={props.placeholder} spellCheck={false} autoComplete="off"
          onChange={(e) => setV(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => { if (e.key === 'Enter' && !isComposing(e)) { e.preventDefault(); save(); } }} />
        {props.pick?.desktop && <button type="button" className="btn" aria-label={t('home.band.actionFor', { action: t('settings.tools.parent.pick'), name: props.label })} onClick={() => { waiting.current = true; emit({ type: 'folder.pick' }); }}>{t('settings.tools.parent.pick')}</button>}
        <SavedTick mark={props.mark} />
      </span>
      {/* quiet は、空にできる欄が空のとき（作成場所）。確かめる中身が無いので行を出さない。保存の失敗だけは出す。 */}
      {(!props.quiet || props.mark?.kind === 'error') && <VerifyRow line={props.line} mark={props.mark} />}
      {props.children}
    </div>
  );
}

/** 準備の帯が指す欄と、それを包む要素の id。パスの欄は PathField の外箱、互換は節そのもの。 */
const FIELD_BOX: Record<SettingsField, string> = { workspace: 'settings-field-workspaceRoot', tmux: 'settings-field-tmuxPath', claude: 'settings-field-claudePath', compat: 'settings-compat', editor: 'settings-field-editor', opencode: 'settings-opencode', codex: 'settings-codex' };

/** 札（✓ 登録済み、まだです）。形でも分け、色だけに頼らない。 */
function Badge(props: { ok: boolean | null; yes: string; no: string }) {
  if (props.ok === null) return null;
  return <span className="badge" data-tone={props.ok ? 'ok' : 'warn'}><Icon name={props.ok ? 'check' : 'alert'} />{props.ok ? props.yes : props.no}</span>;
}

/**
 * 連携の札の書き込みの段（試作の連携 A）。
 * 殻の中では、書き込む先とバックアップの添え書きをボタンの横に常に出し、コマンドは「ターミナルで行うとき」に畳む。
 * ボタンは殻に頼むだけで、書く中身は殻の承認の窓が見せ、承認されたときだけ書く（D9）。
 * ブラウザでは書き込まないので、ボタンを出さずに、その旨とコマンドを出す。
 */
function IntegrationWrite(props: { card: IntegrationCard; desktop: boolean; extra?: ReactNode }) {
  const t = useT();
  const emit = useEmit();
  const { card } = props;
  if (!props.desktop) {
    return (
      <>
        <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.browserNote')}</div>
        <CommandLine command={card.command} />
        {props.extra}
      </>
    );
  }
  const a = card.action;
  return (
    <>
      <div className="integ-write">
        {card.file && <div className="faint integ-dest"><span>{t('settings.integrations.writesTo', { path: card.file })}</span><span>{t('settings.integrations.backupNote')}</span></div>}
        {a && <button type="button" className={a.primary ? 'btn btn-sm btn-primary' : 'btn btn-sm'} disabled={a.disabled} aria-busy={a.running || undefined} onClick={() => emit({ type: 'setup.run', target: a.target })}>{a.label}</button>}
      </div>
      <details className="cp-more integ-terminal">
        <summary><Icon name="chevron" />{t('settings.integrations.terminal')}</summary>
        <div className="cp-more-body"><CommandLine command={card.command} />{props.extra}</div>
      </details>
    </>
  );
}

/**
 * 設定画面（S1）。
 * 左の目次で 8 つの節（一般、セッション、要約、連携、環境、クラウド同期、使用量、Hangar について）を切り替え、右は選んだ節だけを出す。
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
  const [claudeModel, setClaudeModel] = useState(props.summaryClaudeModel);
  // API キーは書いたときだけ送る。保存済みのキーは画面に来ないので、欄はいつも空から始める。
  const [apiKey, setApiKey] = useState('');
  const [cap, setCap] = useState(String(props.summaryHourlyCap));
  const [capError, setCapError] = useState(false);
  // 同期していない人が押した方の、ターミナルで打つコマンド。
  const [cloudCommand, setCloudCommand] = useState<'start' | 'join' | null>(null);
  // サーバが正規化した値を入力欄に反映する。
  useEffect(() => { setLmUrl(props.lmStudioUrl); }, [props.lmStudioUrl]);
  useEffect(() => { setLmModel(props.lmStudioModel ?? ''); }, [props.lmStudioModel]);
  useEffect(() => { setClaudeModel(props.summaryClaudeModel); }, [props.summaryClaudeModel]);
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
  const engine = props.summaryEngine;
  // 1 時間の上限の欄は、Claude を使うとき（Claude を選んだか、OpenAI 互換で切り替えを入れているとき）だけ出す。
  const usesClaude = engine === 'claude' || (engine === 'openai' && props.summaryFallback);
  // 1 時間の上限は 1 以上 200 以下の整数だけを受け付ける。
  // 空のまま送ると 0 になって、Claude での要約が黙って止まってしまう。
  // 数字でない文字は NaN になるので、これも送らない。
  const capNumber = cap.trim() === '' ? Number.NaN : Number(cap);
  const capValid = Number.isInteger(capNumber) && capNumber >= 1 && capNumber <= 200;
  // サーバが保存する形にそろえてから送る。
  // URL は前後の空白と末尾の / を落とし、モデル名は trim して空なら未設定に寄せる。
  // 整えずに送ると、落とされた結果が元と同じときに props が動かない。
  // すると欄には整える前の文字列が残り、保存ボタンも押せたままになる。
  const lmUrlValue = lmUrl.trim().replace(/\/+$/, '');
  const lmModelValue = lmModel.trim() || null;
  const apiKeyValue = apiKey.trim();
  const saveSummarizer = () => {
    if (!capValid) { setCapError(true); return; }
    setCapError(false);
    if (engine === 'claude') {
      emit({ type: 'settings.update', patch: { summaryClaudeModel: claudeModel, summaryHourlyCap: capNumber }, field: 'summarizer' });
      return;
    }
    // 欄も整えた形に直す。押せない理由が欄から読めるようにする。書いたキーは欄に残さない。
    setLmUrl(lmUrlValue);
    setLmModel(lmModelValue ?? '');
    setApiKey('');
    emit({ type: 'settings.update', patch: { lmStudioUrl: lmUrlValue, lmStudioModel: lmModelValue, summaryHourlyCap: capNumber, ...(apiKeyValue ? { summaryApiKey: apiKeyValue } : {}) }, field: 'summarizer' });
  };
  // 選んだエンジンの欄をまとめて送るので、1 つでも変わっていれば押せる。
  // 読めない上限（空や小数）は capNumber が NaN になるため、ここでは必ず「変わっている」側に入る。
  // 押せないと、1 から 200 までの整数を入れてくださいという案内を出す道が無くなってしまう。
  const summarizerDirty = engine === 'claude'
    ? claudeModel !== props.summaryClaudeModel || capNumber !== props.summaryHourlyCap
    : lmUrlValue !== props.lmStudioUrl || lmModelValue !== props.lmStudioModel || apiKeyValue !== '' || (props.summaryFallback && capNumber !== props.summaryHourlyCap);
  // 保存済みのモデルが一覧に無くても（宛先が落ちているときなど）、顔から名前を消さない。
  const models = props.summarizerModels ?? [];
  const modelNames = lmModel && !models.includes(lmModel) ? [lmModel, ...models] : models;
  const modelOptions = [{ value: '', label: t('settings.summary.modelAuto') }, ...modelNames.map((m) => ({ value: m, label: m }))];
  // OpenAI 互換の URL の欄の下の 1 行。モデルの一覧が取れたかで、つながったかを言う。
  const lmLine: VerifyLine | null = props.summarizerModels === null ? null
    : props.summarizerModels.length === 0 ? { ok: false, soft: false, text: t('settings.summary.offline'), note: null, fix: null, fixCommand: null }
      : { ok: true, soft: false, text: t('settings.summary.connected'), note: t('settings.summary.models', { n: props.summarizerModels.length }), fix: null, fixCommand: null };
  const engineName = (id: string) => (id === 'claude-headless' ? t('settings.summary.engine.claude.name') : id === 'lmstudio' ? t('settings.summary.engine.openai.name') : id);

  // 節を切り替えたら、頁をスクロールする枠の先頭へ戻す。前の節の途中の位置から始めない。
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    root.current?.closest<HTMLElement>('.main')?.scrollTo?.({ top: 0 });
  }, [props.section]);

  // ヘッダのアカウントの設定から来たときは、セッションの節のアカウントの位置が見える所へ移る。
  // 節は一覧が届いてから出るので、出たときにも見直す。
  const showAccounts = props.accounts.list.length > 0;
  useEffect(() => {
    if (props.focus !== 'accounts' || props.section !== 'agentClaude' || !showAccounts) return;
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('settings-accounts')?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  }, [props.focus, props.section, showAccounts]);

  // ホームの準備の帯の「設定を開く」から来たときは、直す欄が見える所へ移り、淡い黄で一瞬目立たせる（検索から跳んだ行と同じ動き）。
  // パスの欄は入力欄へフォーカスも置く。互換の節は入力欄が無いので、移って目立たせるだけにする。
  // 節は目次から切り替えるとここへ入らない（focus が欄の名前でなくなる）。
  useEffect(() => {
    if (props.focus === null || props.focus === 'accounts' || props.focus === 'unsent') return;
    const box = document.getElementById(FIELD_BOX[props.focus]);
    if (!box) return;
    const scroller = box.closest<HTMLElement>('.main');
    if (scroller) revealWithin(scroller, box);
    markHit(box);
    box.querySelector<HTMLElement>('input')?.focus({ preventScroll: true });
  }, [props.focus, props.section]);

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
  const todo = props.section === 'environment' ? props.todo.must : props.section === 'agentClaude' ? props.todo.link : 0;

  const general = (
    <section aria-label={cur.title}>
      <SetRow title={t('settings.general.language.title')} info={t('settings.general.language.desc')}
        control={<Segmented label={t('settings.general.language.title')} value={props.language.value} options={[{ value: 'ja', label: t('settings.general.language.ja') }, { value: 'en', label: t('settings.general.language.en') }]} onChange={(v) => setNow({ language: v as Language })} />} />
      {/* 入力待ちを OS の通知で知らせる。直すものの数には入れない（無くても動くため）。 */}
      {/* 何をするかは ⓘ に畳み、行には許可が要るときの案内だけを出す。 */}
      <SetRow title={t('settings.general.notify.title')} info={t('settings.general.notify.desc')}
        desc={!props.notify.available ? t('settings.general.notify.unavailable')
          : props.notify.blocked ? t(notifyBlockedKey(clientPlatform(), 'settings'))
            // まだ OS に尋ねていない間は、その旨と［許可する］を添える。押すと始める前の確認の行と同じ道（notify.set の on）で尋ねる。
            : props.notify.ask ? (
              <div className="notify-ask" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>{t('settings.general.notify.notAsked')}</span>
                <button type="button" className="btn btn-sm" onClick={() => emit({ type: 'notify.set', on: true })}>{t('home.ready.notify.allow')}</button>
              </div>
            ) : undefined}
        control={<Switch label={t('settings.general.notify.title')} checked={props.notify.on} disabled={!props.notify.available} onChange={(next) => emit({ type: 'notify.set', on: next })} />} />
      {/* 切り替えた時点で保存する。iTerm2 は初回に macOS の自動化の許可ダイアログが出るので、その案内は行に常に出す。選択肢は画面を開いている OS のものだけ。 */}
      <SetRow title={t('settings.general.terminal.title')} desc={props.terminalDescAlways ? props.terminalDesc : undefined} info={props.terminalDescAlways ? undefined : props.terminalDesc}
        control={<Segmented label={t('settings.general.terminal.title')} value={props.terminalApp} options={props.terminalOptions.map((o) => ({ ...o, lead: <Icon name={TERMINAL_ICON[o.value]} /> }))} onChange={(v) => setNow({ terminalApp: v as TerminalApp })} />} />
      {/* エディタ。ターミナルアプリと同じく好みで選ぶものなので、その下に置く（試作の 1-1 の A）。 */}
      <EditorSettings editor={props.editor} mark={props.save.editor} open={props.focus === 'editor'} />
    </section>
  );
  // 新しいセッションを起動するときの既定（2026-10-25 の並び替えで、連携とツールの節から集めた）。どれも選んだ時点で保存する。
  const newSession = (
    <section aria-label={cur.title}>
      <h3 className="h2">{t('settings.sessions.new.title')}</h3>
      {/* 作成場所は任意（2026-10-13、試作の 4 節 3a の案 A）。空を許し、デスクトップでは Finder でも選べる。 */}
      <SetRow title={t('settings.tools.parent.title')} info={t('settings.tools.parent.desc')} control={null}
        below={<PathField field="workspaceRoot" label={t('settings.tools.parent.title')} hideLabel value={props.workspaceRoot} nullable={false} placeholder={t('settings.tools.parent.placeholder')} quiet={props.workspaceRoot === ''} pick={props.workspacePick} line={props.verify.workspace} mark={props.save.workspaceRoot} />} />
    </section>
  );
  // Claude Code の新しいセッションの既定（2026-10-28 に、セッションの節から Claude Code の節へ移した）。どれも選んだ時点で保存する。
  const claudeDefaults = (
    <section aria-label={t('settings.agents.claude.new.title')}>
      <h3 className="h2">{t('settings.agents.claude.new.title')}</h3>
      <SetRow title={t('settings.label.defaultModel')} info={t('settings.integrations.inject.model.desc')}
        control={<ModelPicker label={t('settings.label.defaultModel')} value={props.injection.defaultModel} withDefault onChange={(m) => setNow({ defaultModel: m })} />} />
      {/* 起動のときに claude へ付ける --remote-control（試作 B1）。 */}
      <SetRow title={t('settings.label.remoteControl')} info={t('settings.integrations.inject.remoteControl.desc')}
        control={<Switch label={t('settings.label.remoteControl')} checked={props.injection.remoteControl} onChange={(next) => setNow({ remoteControl: next })} />} />
    </section>
  );
  // hangar が claude への指示ではなく自分で行うこと（試作の 5 節の案 A）。押した時点で保存する。次の見回りから効く。
  const self = (
    <section>
      <h3 className="h2">{t('settings.general.self.title')}</h3>
      <SetRow title={t('settings.general.autoDone.title')} info={t('settings.general.autoDone.desc')}
        control={<Switch label={t('settings.general.autoDone.title')} checked={props.self.autoDone} onChange={(next) => setNow({ autoDone: next })} />} />
      {/* 長く動いていない会話の日数（試作の案 A）。上のスイッチを切っている間は効かないので、選べなくする。 */}
      <SetRow title={t('settings.general.autoDoneIdle.title')} info={t('settings.general.autoDoneIdle.desc')}
        control={<Segmented label={t('settings.general.autoDoneIdle.title')} value={String(props.self.autoDoneIdleDays)} disabled={!props.self.autoDone}
          options={AUTO_DONE_IDLE_DAYS.map((d) => ({ value: String(d), label: d === 0 ? t('settings.general.autoDoneIdle.never') : t('settings.general.autoDoneIdle.days', { days: d }) }))}
          onChange={(v) => setNow({ autoDoneIdleDays: Number(v) as AutoDoneIdleDays })} />} />
      <SetRow title={t('settings.general.autoPark.title')} info={t('settings.general.autoPark.desc')}
        control={<Switch label={t('settings.general.autoPark.title')} checked={props.self.autoPark} onChange={(next) => setNow({ autoPark: next })} />} />
    </section>
  );

  // Claude Code の保持期間。押しても保存せず、差分を見せる確認を開く。hangar が Claude Code の設定を書くのはここだけである。
  const retention = props.retention && (
    <section>
        <SetRow title={t('settings.general.retention.title')}
          info={<>{t('settings.general.retention.desc')}{props.retention.syncNote && ` ${t('settings.general.retention.syncNote')}`}</>}
          control={props.retention.writable
            ? <Segmented label={t('settings.general.retention.period')} value={String(props.retention.days)} options={props.retention.options} onChange={(v) => { if (Number(v) !== props.retention!.days) emit({ type: 'retention.edit', days: Number(v), from: 'settings' }); }} />
            : <span className="muted">{props.retention.valueLabel}<span className="faint">（{props.retention.reason}）</span></span>}
          below={props.retention.bar ? <UsageBar {...props.retention.bar} /> : undefined} />
    </section>
  );

  const cloudOff = !props.cloud.configured;
  const member = props.cloud.member;
  const cloud = (
    <>
      <section aria-label={cur.title}>
        {/* 上級者向けのベータ。始めるのに要るものを、同期していてもいなくても頭で言う（試作の 5 節の案 A）。 */}
        <p className="muted-p cloud-beta-lead">{t('settings.cloud.betaLead')}</p>
        {cloudOff && (
          <>
            {/* 古い形式の cloud.json で同期を止めている PC（0.9.0）。「この PC だけで使用しています」は事実と違うので、代わりに再構築を案内する。
                参加コードでの参加は再構築の手順の中で使うので、下のボタンはそのまま出す。 */}
            {props.cloud.legacy ? (
              <>
                <Strip tone="warn" role="alert">
                  <p><b>{t('settings.cloud.legacy.title')}</b></p>
                  <p>{t('settings.cloud.legacy.body')}</p>
                  <p>{t('settings.cloud.legacy.steps')}</p>
                  <p><a href={props.cloud.legacy.docUrl} target="_blank" rel="noreferrer"><Icon name="externalLink" />{t('settings.cloud.legacy.doc')}</a></p>
                </Strip>
                <CommandLine command={props.cloud.legacy.statusCommand} />
              </>
            ) : <p className="muted-p">{t('settings.cloud.off.lead')}</p>}
            {/* 殻の中では、参加コードでの参加を節の中の段で行う（試作 B2）。クラウドの用意はターミナルのまま。 */}
            {member?.desktop ? (
              <>
                <div className="btns">
                  <button type="button" className="btn btn-primary" aria-pressed={cloudCommand === 'join'} onClick={() => setCloudCommand('join')}>{t('cloudMember.join.button')}</button>
                  <button type="button" className="btn" aria-pressed={cloudCommand === 'start'} onClick={() => setCloudCommand('start')}><Icon name="cloud" />{t('settings.cloud.off.start')}</button>
                </div>
                {cloudCommand === 'join' && <CloudJoinSteps m={member} onClose={() => setCloudCommand(null)} />}
                {cloudCommand === 'start' && <><div className="faint" style={{ marginTop: 8 }}>{t('settings.cloud.off.runStart')}</div><CommandLine command={props.commands.setupCloud} /></>}
              </>
            ) : (
              <>
                <div className="btns">
                  <button type="button" className="btn btn-primary" aria-pressed={cloudCommand === 'start'} onClick={() => setCloudCommand('start')}><Icon name="cloud" />{t('settings.cloud.off.start')}</button>
                  <button type="button" className="btn" aria-pressed={cloudCommand === 'join'} onClick={() => setCloudCommand('join')}>{t('settings.cloud.off.join')}</button>
                </div>
                {cloudCommand === 'start' && <><div className="faint" style={{ marginTop: 8 }}>{t('settings.cloud.off.runStart')}</div><CommandLine command={props.commands.setupCloud} /></>}
                {cloudCommand === 'join' && <><div className="faint" style={{ marginTop: 8 }}>{t('settings.cloud.off.runJoin')}</div><CommandLine command={props.commands.join} /></>}
              </>
            )}
          </>
        )}
        {!cloudOff && (
          <>
            {/* ほかの PC で、この PC の参加が解除されたとき（0.4.0）。 */}
            {member?.revoked && <CloudRevokedBand m={member} joinCommand={props.commands.join} />}
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
              {/* 「PC を追加」（試作 A1）。押すと参加コードを発行し、下に欄を開く。解除されている間は出さない。 */}
              {member && !member.revoked && <CloudAddButton m={member} />}
              {/* 「リカバリーキーを再発行」（試作 D2 の「リカバリーキーを表示」を再発行にしたもの）。押すと確認を経て、下に欄を開く。 */}
              {member && !member.revoked && <CloudRecoveryButton m={member} />}
            </div>
            {member && !member.revoked && <CloudAddPc m={member} />}
            {member && !member.revoked && <CloudRecoveryKey m={member} />}
            {/* 小見出し「PC」の表（試作 cloud-e2e の E2）。Worker の一覧から、参加日、最終同期、解除を出す。IP と所在地は出さない。 */}
            {/* 表の下に小見出し「スマホ」とスマホの表、「スマホを接続」（試作 A1、E2）。解除されている間は出さない。 */}
            {member ? <><CloudPcTable m={member} heading={t('settings.cloud.computers')} />{!member.revoked && <CloudPhones m={member} />}</> : (
              <>
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
          </>
        )}
      </section>
      {/* Claude Code の設定の同期（作り直した実装）。送る一覧と適用のダイアログは Root が開く。 */}
      <ConfigSyncSection cfg={props.configSync} cloudOff={cloudOff} />
      {/* 使用量と費用。同期している人にだけ出す（試作 usage-merged.html の「置き場所」）。 */}
      {!cloudOff && props.cloud.usage && <CloudUsage {...props.cloud.usage} />}
      {/* この PC の参加を解除（0.4.0）。節の末尾に、ほかの PC の解除から離して置く。 */}
      {!cloudOff && member && !member.revoked && <CloudLeaveBand m={member} />}
    </>
  );

  // 各エージェントの節（2026-10-28 の組み直し）。節の見出しの絵と札は、ページの見出しが出す。
  const lead = (key: 'settings.agents.claude.lead' | 'settings.agents.codex.lead' | 'settings.agents.opencode.lead') => <p className="muted-p agent-lead">{t(key)}</p>;
  const agentClaude = (
    <>
      {lead('settings.agents.claude.lead')}
      {showAccounts && <AccountSettings {...props.accounts} />}
      {claudeDefaults}
      <InjectionSettings injection={props.injection} />
      {retention}
      {/* 互換のずれは利用者が直せるものではないので、todo には数えない（目次の状態も要修正にしない）。 */}
      <CompatSection compat={props.compat} />
      <section>
        <h3 className="h2">{t('settings.integrations.statusline.title')}<InfoTip label={t('settings.integrations.statusline.title')}>{t('settings.integrations.statusline.note')}</InfoTip><Badge ok={props.statusline ? props.statusline.installed : null} yes={t('settings.integrations.statusline.yes')} no={t('settings.integrations.statusline.no')} /></h3>
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
            {/* 殻の中では、書き込む先としてボタンの横に出す。 */}
            {!props.integrations.desktop && <div className="faint mono">{props.statusline.scriptPath}</div>}
          </>
        )}
        {/* 追記されるスニペットの宛先はこのコマンドの --port で決まる。 */}
        {/* 既定の 4177 のまま追記すると、別のポートで動かしているサーバには届かない。ボタンは殻のポートを渡すので、添えるのはコマンドの側だけである。 */}
        <IntegrationWrite card={props.integrations.statusline} desktop={props.integrations.desktop} extra={<div className="faint" style={{ marginTop: 4 }}>{t('settings.integrations.statusline.port')}</div>} />
      </section>
      {/* 包みは zsh のもので、Windows では作らない。Windows のサーバでは節ごと出さない。 */}
      {props.shell.available && <section>
        <h3 className="h2">
          {t('settings.integrations.shell.title')}
          <InfoTip label={t('settings.integrations.shell.title')}>{t('settings.integrations.shell.desc')}{' '}{t('settings.integrations.shell.adopt')}</InfoTip>
          <Badge ok={props.shell.state === null ? null : props.shell.state === 'on'} yes={t('settings.integrations.shell.yes')} no={t('settings.integrations.shell.no')} />
        </h3>
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
        {/* 殻の中では、ボタンで殻に頼む。書くのは殻の承認の窓を経た CLI で、サーバと画面は書かない（D9）。 */}
        {props.integrations.desktop && (props.shell.state === 'off' || props.shell.state === 'on') && (
          <>
            {props.shell.state === 'on' && <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.installedHintApp')}</div>}
            <IntegrationWrite card={props.integrations.shell} desktop />
          </>
        )}
        {/* ブラウザでは書き込まない。入れるのは CLI で、承認を求めてバックアップを取る。 */}
        {!props.integrations.desktop && props.shell.state === 'off' && (
          <>
            <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.installHint', { zshrc: props.shell.zshrc })}</div>
            <CommandLine command={props.shell.command} />
          </>
        )}
        {!props.integrations.desktop && props.shell.state === 'on' && <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.installedHint', { uninstall: props.shell.uninstallCommand })}</div>}
        {props.shell.state === 'unsupported' && <div className="faint" style={{ marginTop: 8 }}>{t('settings.integrations.shell.noTmux', { install: muxInstallCommand(clientPlatform()) })}</div>}
      </section>}
      <section>
        <h3 className="h2">{t('settings.integrations.mcp.title')}<InfoTip label={t('settings.integrations.mcp.title')}>{t('settings.integrations.mcp.desc')}</InfoTip><Badge ok={props.mcpRegistered} yes={t('settings.integrations.mcp.yes')} no={t('settings.integrations.mcp.no')} /></h3>
        <IntegrationWrite card={props.integrations.mcp} desktop={props.integrations.desktop} />
      </section>
      {/* セットアップのすゝめ（試作の案 C）。連携の最後に置き、Claude Code に貼る一言を見せる。写しが取れていなければ出さない。 */}
      {props.setupGuide && <SetupGuideCard {...props.setupGuide} />}
      <section>
        <h3 className="h2">{t('settings.tools.paths.title')}</h3>
        <PathField field="claudePath" label={t('settings.tools.claude')} value={props.claudePath} nullable placeholder={t('settings.tools.claudePlaceholder')} line={props.verify.claude} mark={props.save.claudePath} />
      </section>
    </>
  );
  const agentCodex = (
    <>
      {lead('settings.agents.codex.lead')}
      <CodexAccountsSettings accounts={props.codexAccounts} />
      {/* Codex（ベータ、C4 の案 A）。 */}
      <CodexSection o={props.codex} showTitle={false} />
      <section>
        <h3 className="h2">{t('settings.tools.paths.title')}</h3>
        <PathField field="codexPath" label={t('settings.tools.codex')} info={t('settings.tools.agentPathDesc')} value={props.codexPath} nullable placeholder={t('settings.tools.codexPlaceholder')} line={null} mark={props.save.codexPath} />
      </section>
    </>
  );
  const agentOpencode = (
    <>
      {lead('settings.agents.opencode.lead')}
      {/* opencode（ベータ、試作の D1）。 */}
      <OpencodeSection o={props.opencode} providers={props.opencodeProviders} showTitle={false} />
      <section>
        <h3 className="h2">{t('settings.tools.paths.title')}</h3>
        <PathField field="opencodePath" label={t('settings.tools.opencode')} info={t('settings.tools.agentPathDesc')} value={props.opencodePath} nullable placeholder={t('settings.tools.opencodePlaceholder')} line={null} mark={props.save.opencodePath} />
      </section>
    </>
  );

  // 1 時間の上限の欄。Claude を選んだときと、OpenAI 互換で切り替えを入れているときに出す。
  const capRow = (
    <>
      <SetRow title={t('settings.summary.cap.title')} desc={t('settings.summary.cap.desc')}
        control={<><Stepper label={t('settings.summary.cap.title')} value={cap} min={1} max={200} onChange={(v) => { setCap(v); setCapError(false); }} /><span className="faint">{t('settings.summary.cap.unit')}</span></>} />
      {capError && <div className="error" role="alert" style={{ marginTop: 4 }}>{t('settings.summary.cap.error')}</div>}
    </>
  );
  const claudeDetail = (
    <div className="sum-detail">
      <SetRow title={t('settings.label.summaryClaudeModel')} info={t('settings.summary.claudeAccount')}
        control={<ModelPicker label={t('settings.label.summaryClaudeModel')} value={claudeModel} onChange={(m) => { if (m) setClaudeModel(m); }} />} />
      {capRow}
    </div>
  );
  const openaiDetail = (
    <div className="sum-detail">
      <div className="grid2">
        <div className="field"><span aria-hidden="true">{t('settings.summary.url')}</span>
          <input className="input mono" aria-label={t('settings.summary.url')} value={lmUrl} onChange={(e) => setLmUrl(e.target.value)} />
          <VerifyRow line={lmLine} waiting={t('settings.common.loading')} />
        </div>
        <div className="field"><span aria-hidden="true">{t('settings.summary.model')}</span>
          <Listbox label={t('settings.summary.model')} value={lmModel} options={modelOptions} onChange={setLmModel} searchPlaceholder={t('settings.summary.modelSearch')} />
        </div>
      </div>
      <div className="field sum-key"><span aria-hidden="true">{t('settings.summary.apiKey')}</span>
        <span className="inrow">
          <input className="input mono" type="password" aria-label={t('settings.summary.apiKey')} value={apiKey} autoComplete="off" spellCheck={false}
            placeholder={props.summaryApiKeySet ? t('settings.summary.apiKeySaved') : t('settings.summary.apiKeyPlaceholder')} onChange={(e) => setApiKey(e.target.value)} />
          {props.summaryApiKeySet && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNow({ summaryApiKey: null })}>{t('settings.summary.apiKeyClear')}</button>}
        </span>
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
      {props.allowExternalSummarizer && <div className="error" role="alert">{t('settings.summary.external.warn', { url: props.lmStudioUrl || t('settings.summary.external.thisDestination') })}</div>}
      <SetRow title={t('settings.summary.fallback')} desc={t('settings.summary.fallbackDesc')}
        control={<Switch label={t('settings.summary.fallback')} checked={props.summaryFallback} onChange={(next) => setNow({ summaryFallback: next })} />} />
      {props.summaryFallback && capRow}
    </div>
  );
  // 要約エンジンの選択肢（試作 3 節の推す案 A）。エディタと同じラジオの行で、選んだ行のすぐ下にその行の欄だけを開く。
  const engines: { id: SummaryEngine; icon: IconName; detail: ReactNode }[] = [
    { id: 'off', icon: 'minus', detail: null },
    { id: 'claude', icon: 'agent', detail: claudeDetail },
    { id: 'openai', icon: 'link', detail: openaiDetail },
  ];
  const pickEngine = (id: SummaryEngine) => { if (id !== engine) setNow({ summaryEngine: id }); };
  const summary = (
    <section aria-label={cur.title}>
      <div className="editor-choices" role="radiogroup" aria-label={t('settings.label.summaryEngine')}>
        {engines.map((e) => (
          <Fragment key={e.id}>
            <div className="editor-choice sum-choice" role="radio" aria-checked={engine === e.id} tabIndex={engine === e.id ? 0 : -1}
              onClick={() => pickEngine(e.id)}
              onKeyDown={(ev) => { if (ev.key === ' ' || ev.key === 'Enter') { ev.preventDefault(); pickEngine(e.id); } }}>
              <span className="editor-radio" aria-hidden="true" />
              <span className="editor-tile" aria-hidden="true"><Icon name={e.icon} /></span>
              <span className="editor-choice-main">
                <span className="editor-choice-name">{t(`settings.summary.engine.${e.id}.name`)}</span>
                {e.id !== 'off' && <span className="sum-choice-desc">{t(`settings.summary.engine.${e.id}.desc`)}</span>}
              </span>
              {e.id === 'openai' && engine === 'openai' && props.summarizerModels !== null
                ? <span className="badge" data-tone={props.summarizerModels.length > 0 ? 'ok' : 'warn'}><Icon name={props.summarizerModels.length > 0 ? 'check' : 'alert'} />{props.summarizerModels.length > 0 ? t('settings.summary.connected') : t('settings.summary.offline')}</span>
                : <span />}
            </div>
            {engine === e.id && e.detail}
          </Fragment>
        ))}
      </div>
      {engine !== 'off' && (
        <>
          <div className="btns">
            <button className="btn btn-primary" disabled={!summarizerDirty} onClick={saveSummarizer}>{t('settings.common.save')}</button>
            <SavedTick mark={props.save.summarizer} />
            <button className="btn" onClick={() => emit({ type: 'summarizer.test' })}>{t('settings.summary.test')}</button>
          </div>
          {props.save.summarizer?.kind === 'error' && <div className="error" role="alert" style={{ marginTop: 4 }}>{props.save.summarizer.message}</div>}
          {props.summarizerTest?.ok === true && (
            <div style={{ marginTop: 4 }}>
              <div className="muted">{t('settings.summary.testOk', { engine: engineName(props.summarizerTest.id), ms: props.summarizerTest.ms })}</div>
              <div className="faint">{props.summarizerTest.summary.oneLiner}</div>
            </div>
          )}
          {props.summarizerTest?.ok === false && (
            <ul className="faint" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
              {props.summarizerTest.tried.map((x) => <li key={x.id}>{engineName(x.id)}: {x.message}</li>)}
            </ul>
          )}
        </>
      )}
    </section>
  );

  // パスの例と Node を探す順の説明は、画面を開いている PC の OS の形で出す。
  const win = clientPlatform() === 'win32';
  const environment = (
    <>
      {props.mux && <MuxSection mux={props.mux} />}
      <section>
        <h3 className="h2">{t('settings.tools.paths.title')}</h3>
        <div className="grid2">
          <PathField field="tmuxPath" label={t('settings.tools.tmux')} value={props.tmuxPath} nullable placeholder={t('settings.tools.tmuxPlaceholder', { install: muxInstallCommand(clientPlatform()) })} line={props.verify.tmux} mark={props.save.tmuxPath} />
          <PathField field="nodePath" label={t('settings.tools.node')} info={t(win ? 'settings.tools.nodeNoteWindows' : 'settings.tools.nodeNote')} value={props.nodePath} nullable placeholder={t(win ? 'settings.tools.nodePlaceholderWindows' : 'settings.tools.nodePlaceholder')} line={props.verify.node} mark={props.save.nodePath} />
          {/* git は設定の欄が無いので、見つけた場所と版だけを読むだけの行で出す。 */}
          <div className="field path-field" id="settings-field-git">
            <span>{t('settings.tools.git')}<InfoTip label={t('settings.tools.git')}>{t('settings.tools.gitDesc')}</InfoTip></span>
            <VerifyRow line={props.verify.git} />
          </div>
        </div>
      </section>
      <section>
        <h3 className="h2">{t('settings.info.index.title')}</h3>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono muted">{props.indexLabel}</span>
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => emit({ type: 'index.rebuild' })}>{t('settings.info.index.rebuild')}</button>
        </div>
        <div className="faint mono" style={{ marginTop: 4 }}>{t('settings.info.index.source', { dir: props.indexSource })}</div>
        <div className="faint" style={{ marginTop: 4 }}>{t('settings.info.index.note')}</div>
      </section>
      {/* まとめて登録（0.6.1 の「フォルダの中から」を含む）。 */}
      <section>
        <SetRow title={t('settings.tools.register.title')}
          control={<>
            <button type="button" className="btn" onClick={() => emit({ type: 'project.candidates.open' })}>{t('settings.tools.register.action')}</button>
            <button type="button" className="btn" onClick={() => emit({ type: 'project.candidates.open', source: 'folder' })}>{t('settings.tools.register.folder')}</button>
          </>} />
      </section>
    </>
  );

  const usage = (
    <>
      <section aria-label={cur.title}>
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
    </>
  );
  // 「Hangar について」。前例（Chrome、Obsidian、Docker Desktop）どおり、バージョンと更新を同じ所に置き、目次の一番下にする。
  const about = (
    <>
      {/* ブラウザでは更新の段を持たないので、バージョンだけを同じ行の形で出す。 */}
      {props.update.supported ? <UpdateSection update={props.update} /> : (
        <section>
          <SetRow title={t('settings.toc.version', { version: props.version })} desc={props.update.unsupported} control={null} />
        </section>
      )}
      <section>
        <h3 className="h2">{t('settings.info.thisPc.title')}</h3>
        <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
      </section>
    </>
  );

  const body: Record<SettingsSection, ReactNode> = {
    general,
    sessions: <>{newSession}{self}</>,
    summary, environment, cloud, usage, agentClaude, agentCodex, agentOpencode, about,
  };

  return (
    <div ref={root} className="screen settings-screen">
      <PageHeading title={t('settings.heading.title')} />
      <div className="settings-layout">
        <nav className="settings-toc" aria-label={t('settings.toc.label')} onKeyDown={onTocKey}>
          {props.toc.map((r, i) => (
            <Fragment key={r.id}>
              {r.group && props.toc[i - 1]?.group !== r.group && <div className="settings-toc-group" role="presentation">{t(`settings.toc.group.${r.group}`)}</div>}
              <button type="button" className="settings-toc-item" aria-current={props.section === r.id ? 'page' : undefined} aria-label={r.label} tabIndex={props.section === r.id ? 0 : -1} onClick={() => go(r.id)}>
              {r.agent ? <AgentIcon kind={r.agent} decorative /> : <Icon name={SECTION_ICON[r.id]} />}
              <span className="settings-toc-text">
                <span className="settings-toc-t">{r.title}{r.beta && <span className="tag-beta">{t('settings.toc.beta')}</span>}</span>
                <span className="settings-toc-s" data-tone={r.tone}>{r.state}</span>
              </span>
              </button>
            </Fragment>
          ))}
        </nav>
        <div className="settings-page">
          <div className="settings-group" id={`settings-${props.section}`} role="group" aria-labelledby={`settings-${props.section}-h`}>
            <h2 className="settings-group-h" id={`settings-${props.section}-h`}>
              {cur.agent && <AgentIcon kind={cur.agent} decorative />}
              {cur.title}
              {cur.beta && cur.agent && <span className="tag-beta">{t('settings.toc.beta')}</span>}
              {props.section === 'summary' && <InfoTip label={cur.title}>{t('settings.summary.lead')}</InfoTip>}
              {props.section === 'cloud' && <span className="badge" data-tone={props.cloud.badge.tone}>{props.cloud.badge.text}</span>}
              {props.section === 'about' && props.update.supported && props.update.badge && <span className="badge" data-tone={props.update.badge.tone}>{props.update.badge.text}</span>}
              {todo > 0 && <span className="badge" data-tone="warn"><Icon name="alert" />{t('settings.fix.count', { n: todo })}</span>}
            </h2>
            {body[props.section]}
          </div>
        </div>
      </div>
    </div>
  );
}
