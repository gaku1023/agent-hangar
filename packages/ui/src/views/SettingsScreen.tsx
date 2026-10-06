import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { SettingsDto, TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import type { SaveMark } from '../mediator/types.ts';
import { costLabel, SUMMARIZER_LABEL, tokensLabel } from '../presenters/format.ts';
import { clientPlatform, muxInstallCommand, type VerifyLine } from '../presenters/readiness.ts';
import { JOIN_TOKEN_TTL_MS, type SettingsProps } from '../presenters/settings.ts';
import { isComposing } from './ime.ts';
import { PageHeading } from './PageHeading.tsx';
import { CommandLine, CopyButton } from './primitives/CommandLine.tsx';
import { Icon, type IconName } from './primitives/Icon.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { UsageBar } from './UsageBar.tsx';
import { AccountSettings } from './AccountSettings.tsx';
import { CloudUsage } from './CloudUsage.tsx';
import { Stepper } from './primitives/Stepper.tsx';
import { Switch } from './primitives/Switch.tsx';

/** 「✓ 保存しました」を出しておく長さ（設定の C1）。 */
export const SAVED_TICK_MS = 2000;

/** 設定の 5 つの群。目次（A1）と、頁の中の群の見出しが同じ表を読む。 */
export const SETTINGS_GROUPS: { id: string; title: string; subs: string[]; icon: IconName }[] = [
  { id: 'settings-must', title: '必須', subs: ['ワークスペース', 'ツール', 'Node'], icon: 'tool' },
  { id: 'settings-link', title: '連携', subs: ['MCP', 'statusline', '外のターミナル', '通知', 'アカウント'], icon: 'link' },
  { id: 'settings-summary', title: '要約器', subs: ['LM Studio', '切り替え'], icon: 'permissionAuto' },
  { id: 'settings-sync', title: '同期', subs: ['状態', 'PC', '参加トークン', 'Claude Code の設定'], icon: 'cloud' },
  { id: 'settings-info', title: '情報', subs: ['使用量', '索引', 'この PC', '会話の保持'], icon: 'info' },
];

/**
 * いま読んでいる群。頁をスクロールする枠（.main）の上端を越えた最後の群を「今」にする。
 * 目次を押したときは、その群をすぐ灯す。
 */
function useCurrentGroup(ids: string[]): [string, (id: string) => void] {
  const [cur, setCur] = useState(ids[0]!);
  const key = ids.join(' ');
  useEffect(() => {
    const first = document.getElementById(ids[0]!);
    const scroller = first?.closest<HTMLElement>('.main') ?? null;
    const onScroll = () => {
      const top = scroller ? scroller.getBoundingClientRect().top + (parseFloat(getComputedStyle(scroller).scrollPaddingTop) || 0) : 0;
      let next = ids[0]!;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top - top <= 24) next = id;
      }
      // 底まで来たら、最後の群は上端まで届かなくても今の群にする。
      if (scroller && scroller.scrollHeight > scroller.clientHeight && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) next = ids[ids.length - 1]!;
      setCur(next);
    };
    const target: HTMLElement | Window = scroller ?? window;
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => target.removeEventListener('scroll', onScroll);
    // ids は表から作るので、中身が同じなら張り直さない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return [cur, setCur];
}

/** 欄の横に「✓ 保存しました」を 2 秒出す。n が進むたびに出し直す（設定の C1）。 */
function SavedTick(props: { mark: SaveMark | undefined }) {
  const n = props.mark?.kind === 'saved' ? props.mark.n : 0;
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (n === 0) return;
    setShow(true);
    const t = setTimeout(() => setShow(false), SAVED_TICK_MS);
    return () => clearTimeout(t);
  }, [n]);
  return <span className="saved-tick" data-show={show ? 'true' : undefined} role="status" aria-live="polite"><Icon name="check" />{show ? '保存しました' : ''}</span>;
}

/**
 * 欄の下の 1 行（設定の B1）。
 * 保存を断られたときは、その理由を先に出す。
 * 準備の確かめが届く前は「確かめています」と出す。
 */
function VerifyRow(props: { line: VerifyLine | null; mark?: SaveMark | undefined; waiting?: string }) {
  if (props.mark?.kind === 'error') return <span className="verify" data-tone="ng" role="alert"><Icon name="close" />{props.mark.message}</span>;
  const l = props.line;
  if (!l) return <span className="verify" data-tone="wait">{props.waiting ?? '確かめています'}</span>;
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
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const leftMs = props.expiresAt === null ? JOIN_TOKEN_TTL_MS : Math.max(0, props.expiresAt - now);
  const left = Math.ceil(leftMs / 1000);
  return (
    <div className="tok">
      <div className="tok-line">
        <span className="tok-val mono">{props.token}</span>
        <CopyButton text={props.token} name="参加トークン" label="コピー" />
      </div>
      <div className="tbar" data-low={left <= 10 ? 'true' : undefined} role="progressbar" aria-label="参加トークンが消えるまで" aria-valuemin={0} aria-valuemax={JOIN_TOKEN_TTL_MS / 1000} aria-valuenow={left}>
        <i style={{ width: `${(leftMs / JOIN_TOKEN_TTL_MS) * 100}%` }} />
      </div>
      <small>{`あと ${left} 秒で消えます。持つ人は全セッションを読み書きできます。1Password などに写してください。`}</small>
    </div>
  );
}

/** 群の見出しと中身。見出しは目次と同じ表から作る。 */
function Group(props: { id: string; todo?: number; children: ReactNode }) {
  const g = SETTINGS_GROUPS.find((x) => x.id === props.id)!;
  return (
    <div className="settings-group" id={g.id} aria-labelledby={`${g.id}-h`} role="group">
      <h2 className="settings-group-h" id={`${g.id}-h`}>{g.title}<span>{g.subs.join('、')}</span>{props.todo ? <span className="badge" data-tone="warn"><Icon name="alert" />直すもの {props.todo} 件</span> : null}</h2>
      {props.children}
    </div>
  );
}

/**
 * 設定画面。
 * 1 枚の長い頁のまま 5 つの群に分け、左に固定の目次を置く（設定の A1）。
 * パスの欄は欄を出たら保存し、欄の横に「✓ 保存しました」、欄の下に検証の 1 行を出す（C1 と B1）。
 * 保持する状態は入力途中の値だけで、保存は settings.update を出す。
 */
export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const [group, setGroup] = useCurrentGroup(SETTINGS_GROUPS.map((g) => g.id));
  const [lmUrl, setLmUrl] = useState(props.lmStudioUrl);
  const [lmModel, setLmModel] = useState(props.lmStudioModel ?? '');
  const [cap, setCap] = useState(String(props.summaryHourlyCap));
  const [capError, setCapError] = useState(false);
  // サーバが正規化した値を入力欄に反映する。
  useEffect(() => { setLmUrl(props.lmStudioUrl); }, [props.lmStudioUrl]);
  useEffect(() => { setLmModel(props.lmStudioModel ?? ''); }, [props.lmStudioModel]);
  useEffect(() => { setCap(String(props.summaryHourlyCap)); }, [props.summaryHourlyCap]);
  useEffect(() => { setCapError(false); }, [props.summaryHourlyCap]);
  // 外部の要約器をオンにする前の確かめの帯。オンにするまでは、スイッチもオフのままにする。
  const [confirmExternal, setConfirmExternal] = useState(false);
  useEffect(() => { if (props.allowExternalSummarizer) setConfirmExternal(false); }, [props.allowExternalSummarizer]);
  // 帯が開いたら、やめるへフォーカスを送る。閉じるときは、開いたスイッチへ戻す。
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
  // 要約器は 3 項目をまとめて送るので、1 つでも変わっていれば押せる。
  // 読めない上限（空や小数）は capNumber が NaN になるため、ここでは必ず「変わっている」側に入る。
  // 押せないと、1 から 200 までの整数を入れてくださいという案内を出す道が無くなってしまう。
  const summarizerDirty = lmUrlValue !== props.lmStudioUrl || lmModelValue !== props.lmStudioModel || capNumber !== props.summaryHourlyCap;
  // 保存済みのモデルが一覧に無くても（LM Studio が落ちているときなど）、顔から名前を消さない。
  const models = props.summarizerModels ?? [];
  const modelNames = lmModel && !models.includes(lmModel) ? [lmModel, ...models] : models;
  const modelOptions = [{ value: '', label: '自動（最初のモデル）' }, ...modelNames.map((m) => ({ value: m, label: m }))];
  // LM Studio の URL の欄の下の 1 行。モデルの一覧が取れたかで、つながったかを言う。
  const lmLine: VerifyLine | null = props.summarizerModels === null ? null
    : props.summarizerModels.length === 0 ? { ok: false, soft: false, text: 'LM Studio に繋がりません', note: null, fix: null, fixCommand: null }
      : { ok: true, soft: false, text: 'つながりました', note: `モデル ${props.summarizerModels.length} 個`, fix: null, fixCommand: null };
  const slideTo = (id: string) => {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(id)?.scrollIntoView?.({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
  };
  const go = (id: string) => {
    setGroup(id);
    slideTo(id);
  };
  // ヘッダの「アカウントの設定」から来たときは、アカウントの節が見える位置へ移る。
  // 節は一覧が届いてから出るので、出たときにも見直す。
  const showAccounts = props.accounts.list.length > 0;
  useEffect(() => {
    if (props.focus !== 'accounts' || !showAccounts) return;
    setGroup('settings-link');
    slideTo('settings-accounts');
    // slideTo と setGroup は毎回作り直されるので、依存には入れない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus, showAccounts]);
  const todoOf = (id: string) => (id === 'settings-must' ? props.todo.must : id === 'settings-link' ? props.todo.link : 0);
  return (
    <div className="screen settings-screen">
      <PageHeading title="設定" />
      <div className="settings-layout">
        <nav className="settings-toc" aria-label="設定の目次">
          {SETTINGS_GROUPS.map((g) => (
            <div key={g.id} className="settings-toc-group">
              <button type="button" className="settings-toc-item" aria-current={group === g.id ? 'true' : undefined} onClick={() => go(g.id)}>
                <Icon name={g.icon} />{g.title}
                {todoOf(g.id) > 0 && <span className="settings-toc-dot" role="img" aria-label={`直すもの ${todoOf(g.id)} 件`} />}
              </button>
              {g.subs.map((s) => <span key={s} className="settings-toc-sub">{s}</span>)}
            </div>
          ))}
        </nav>
        <div className="settings-page">
          <Group id="settings-must" todo={props.todo.must}>
            <section>
              <h3 className="h2">ワークスペース</h3>
              <PathField field="workspaceRoot" label="ワークスペースのルート" hideLabel value={props.workspaceRoot} nullable={false} line={props.verify.workspace} mark={props.save.workspaceRoot} />
              <div className="faint" style={{ marginTop: 4 }}>直下のディレクトリのうち、Claude のセッションがあるものをプロジェクトとして登録します。</div>
            </section>
            <section>
              <h3 className="h2">ツール</h3>
              <div className="grid2">
                <PathField field="tmuxPath" label="tmux のパス" value={props.tmuxPath} nullable placeholder={`${muxInstallCommand(clientPlatform())} のあとにパスを入れてください`} line={props.verify.tmux} mark={props.save.tmuxPath} />
                <div className="field">
                  <span aria-hidden="true">ターミナルアプリ</span>
                  {/* 切り替えた時点で保存する。iTerm2 は初回に macOS の自動化の許可ダイアログが出る。 */}
                  <Segmented label="ターミナルアプリ" value={props.terminalApp} options={[{ value: 'terminal', label: 'Terminal.app', lead: <Icon name="openTerminal" /> }, { value: 'iterm', label: 'iTerm2', lead: <Icon name="appWindow" /> }]} onChange={(v) => setNow({ terminalApp: v as TerminalApp })} />
                </div>
                <PathField field="claudePath" label="claude のパス" value={props.claudePath} nullable placeholder="claude コマンドの絶対パス" line={props.verify.claude} mark={props.save.claudePath} />
                <PathField field="codePath" label="code のパス" value={props.codePath} nullable placeholder="VS Code の code コマンド" line={props.verify.code} mark={props.save.codePath} />
              </div>
              <div className="faint" style={{ marginTop: 4 }}>iTerm2 は AppleScript で開くため、初回に macOS の自動化の許可ダイアログが出ます。失敗したときは Terminal.app で開きます。</div>
            </section>
            <section>
              <h3 className="h2">Node</h3>
              <PathField field="nodePath" label="Node のパス" value={props.nodePath} nullable placeholder="/opt/homebrew/bin/node" line={props.verify.node} mark={props.save.nodePath} />
              <div className="faint" style={{ marginTop: 4 }}>デスクトップアプリが同梱のサーバを動かす Node です。空なら /opt/homebrew/bin/node、/usr/local/bin/node、nvm の順に探します。同梱サーバと同じメジャー版の Node が必要です。</div>
            </section>
          </Group>
          <Group id="settings-link" todo={props.todo.link}>
            <section>
              <h3 className="h2">MCP<Badge ok={props.mcpRegistered} yes="登録済み" no="まだ登録されていません" /></h3>
              <div className="muted">Claude Code の user スコープに hangar の MCP サーバを登録すると、どのセッションからも検索と要約が使えます。ターミナルで次を実行してください。</div>
              <CommandLine command={props.commands.mcp} />
            </section>
            <section>
              <h3 className="h2">statusline<Badge ok={props.statusline ? props.statusline.installed : null} yes="追記済み" no="まだです" /></h3>
              {props.statusline === null && <div className="faint">読み込んでいます</div>}
              {props.statusline && props.statusline.scriptPath === null && (
                <>
                  <div className="muted">statusline の設定が見つかりません</div>
                  <div className="faint" style={{ marginTop: 4 }}>Claude Code の /statusline でスクリプトを作ってから、下のコマンドを実行してください。</div>
                </>
              )}
              {props.statusline?.scriptPath && (
                <>
                  <div className="muted">{props.statusline.installed ? '追記済みです' : 'まだ追記されていません'}</div>
                  <div className="faint mono">{props.statusline.scriptPath}</div>
                </>
              )}
              <div className="faint" style={{ marginTop: 4 }}>ヘッダーの使用率のゲージは、この追記からだけ届きます。追記はターミナルで行い、この画面からは書き換えません。</div>
              <CommandLine command={props.commands.statusline} />
              {/* 追記されるスニペットの宛先はこのコマンドの --port で決まる。 */}
              {/* 既定の 4177 のまま追記すると、別のポートで動かしているサーバには届かない。 */}
              <div className="faint" style={{ marginTop: 4 }}>{'サーバが 4177 以外で動いているときは --port <番号> を付けてください。'}</div>
            </section>
            <section>
              <h3 className="h2">外のターミナル<Badge ok={props.shell.state === null ? null : props.shell.state === 'on'} yes="この PC は導入済み" no="この PC は未導入" /></h3>
              <div className="muted">VS Code などのターミナルで起動した claude も、hangar のターミナルで開けるようにします。~/.zshrc に 1 行を足し、claude を hangar の tmux の中で起こしてすぐつなぐ形に包みます。利用上限に当たっても、上限が戻れば Claude Code が自分で続けます。hangar が動いていないときは素の claude を起動します。</div>
              {props.shell.devices.length > 0 && (
                <div className="list" style={{ marginTop: 8 }}>
                  {props.shell.devices.map((d) => (
                    <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto', cursor: 'default' }}>
                      <span>{d.name}{d.self && <span className="faint"> この PC</span>}</span>
                      <span className={d.label === '入っています' ? undefined : 'faint'}>{d.label}</span>
                    </div>
                  ))}
                </div>
              )}
              {props.shell.state === null && <div className="faint" style={{ marginTop: 4 }}>読み込んでいます</div>}
              {/* 利用者のファイルは UI から書き換えない（statusline と同じ）。入れるのは CLI で、承諾を求めて控えを取る。 */}
              {props.shell.state === 'off' && (
                <>
                  <div className="faint" style={{ marginTop: 8 }}>この PC に入れるには、ターミナルで次を実行してください。足す行を見せて承諾を求め、足す前に {props.shell.zshrc} の控えを取ります。</div>
                  <CommandLine command={props.shell.command} />
                </>
              )}
              {props.shell.state === 'on' && <div className="faint" style={{ marginTop: 8 }}>新しく開いたターミナルから効きます。1 回だけ包まずに起動するときは command claude、外すときは {props.shell.uninstallCommand} です。</div>}
              {props.shell.state === 'unsupported' && <div className="faint" style={{ marginTop: 8 }}>この PC では tmux が見つかりません。{muxInstallCommand(clientPlatform())} で入れるか、上の「tmux のパス」を入れてください。</div>}
              <div className="faint" style={{ marginTop: 4 }}>入れていないときも、外のターミナルで入力待ちか休みの claude は「hangar で引き取る」で開けます。</div>
            </section>
            {/* 入力待ちを OS の通知で知らせる。直すものの数には入れない（無くても動くため）。 */}
            <section>
              <h3 className="h2">通知</h3>
              <div className="settings-row settings-switch-row"><span>通知を受け取る</span>
                <Switch label="通知を受け取る" checked={props.notify.on} disabled={!props.notify.available} onChange={(next) => emit({ type: 'notify.set', on: next })} />
              </div>
              <div className="faint">hangar が背面にあるとき、入力待ちになったセッションを通知で知らせます。押すとそのセッションのターミナルへ移ります。</div>
              {!props.notify.available && <div className="faint" style={{ marginTop: 4 }}>この環境では通知を出せません。ブラウザで拒んだときは、ブラウザの設定でこのページの通知を許可してください。</div>}
              {props.notify.available && props.notify.blocked && <div className="faint" style={{ marginTop: 4 }}>通知が切られています。システム設定の「通知」で Hangar を許可してください。許可して Hangar に戻ると、受け取るに戻ります。戻らないときは、このスイッチを入れ直してください。</div>}
            </section>
            {/* アカウントの追加の入口はここだけ。1 件でも出す。届く前（一覧が空）は出さない。 */}
            {showAccounts && <AccountSettings {...props.accounts} />}
          </Group>
          <Group id="settings-summary">
            <section>
              <h3 className="h2">要約器</h3>
              <div className="grid2">
                <div className="field"><span aria-hidden="true">LM Studio の URL</span>
                  <input className="input mono" aria-label="LM Studio の URL" value={lmUrl} onChange={(e) => setLmUrl(e.target.value)} />
                  <VerifyRow line={lmLine} waiting="読み込んでいます" />
                </div>
                <div className="field"><span aria-hidden="true">モデル</span>
                  <Listbox label="モデル" value={lmModel} options={modelOptions} onChange={setLmModel} searchPlaceholder="モデルを探す" />
                </div>
              </div>
              <div ref={externalRow} className="settings-row settings-switch-row"><span>外部の要約器を許す</span>
                <Switch label="外部の要約器を許す" checked={props.allowExternalSummarizer} onChange={(next) => { if (next) setConfirmExternal(true); else setNow({ allowExternalSummarizer: false }); }} />
              </div>
              <div className="faint">127.0.0.1 と localhost 以外の宛先へ本文を送れるようにします。</div>
              {confirmExternal && !props.allowExternalSummarizer && (
                <div className="confirm-strip" role="group" aria-label="外部の要約器を許すかの確かめ">
                  {/* 送られる先は保存済みの URL。欄を書き換えただけでは宛先は変わらない。 */}
                  <span>会話の本文（利用者の発言とアシスタントの応答）が {props.lmStudioUrl} へ送られます。</span>
                  <span className="spacer" />
                  <button ref={cancelExternal} className="btn" onClick={closeConfirm}>やめる</button>
                  <button className="btn btn-primary" onClick={() => { closeConfirm(); setNow({ allowExternalSummarizer: true }); }}>許す</button>
                </div>
              )}
              {props.allowExternalSummarizer && <div className="error" role="alert" style={{ marginTop: 4 }}>会話の本文（利用者の発言とアシスタントの応答）が {props.lmStudioUrl || 'この宛先'} へ送られます。宛先を確かめてください。</div>}
              <div className="settings-row settings-switch-row"><span>LM Studio が使えないとき Claude へ切り替える</span>
                <Switch label="LM Studio が使えないとき Claude へ切り替える" checked={props.summaryFallback} onChange={(next) => setNow({ summaryFallback: next })} />
              </div>
              <div className="settings-row"><span>1 時間の上限</span>
                <Stepper label="1 時間の上限" value={cap} min={1} max={200} onChange={(v) => { setCap(v); setCapError(false); }} />
                <span className="faint">件。1 から 200 まで。週の使用率が 80% を超えたら切り替えません。</span>
              </div>
              {capError && <div className="error" role="alert" style={{ marginTop: 4 }}>1 から 200 までの整数を入れてください</div>}
              <div className="settings-row">
                <button className="btn btn-primary" disabled={!summarizerDirty} onClick={saveSummarizer}>要約器の設定を保存</button>
                <SavedTick mark={props.save.summarizer} />
                <button className="btn" onClick={() => emit({ type: 'summarizer.test' })}>要約器を試す</button>
              </div>
              {props.save.summarizer?.kind === 'error' && <div className="error" role="alert" style={{ marginTop: 4 }}>{props.save.summarizer.message}</div>}
              {props.summarizerTest?.ok === true && (
                <div style={{ marginTop: 4 }}>
                  <div className="muted">{SUMMARIZER_LABEL[props.summarizerTest.id] ?? props.summarizerTest.id} で成功しました（{props.summarizerTest.ms} ミリ秒）</div>
                  <div className="faint">{props.summarizerTest.summary.oneLiner}</div>
                </div>
              )}
              {props.summarizerTest?.ok === false && (
                <ul className="faint" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {props.summarizerTest.tried.map((t) => <li key={t.id}>{SUMMARIZER_LABEL[t.id] ?? t.id}: {t.message}</li>)}
                </ul>
              )}
            </section>
          </Group>
          <Group id="settings-sync">
            <section>
              <h3 className="h2">クラウド同期</h3>
              {!props.cloud.configured && <div className="faint">hangar setup cloud か hangar join &lt;token&gt; で始められます</div>}
              {props.cloud.configured && (
                <>
                  <div className="mono muted">{props.cloud.url}</div>
                  <div className="faint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
                    <span>状態 {props.cloud.stateLabel}</span>
                    <span>最後の受信 {props.cloud.lastPullAt}</span>
                    <span>未送信 {props.cloud.pending} 件</span>
                    {/* 本文は 60 秒に 20 件ずつしか流れない。件数が出ていないと、進んでいるのか止まっているのか読めない。 */}
                    {props.cloud.sweepPending !== null && <span>未送信の本文 {props.cloud.sweepPending} 件</span>}
                  </div>
                  {/* 送れなかった本文は 30 分ごとに送り直すので放っておけば回復する。回復するまでのあいだ、ここでだけ確かめられる。 */}
                  {props.cloud.skipped.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      <div className="error" role="alert">送れなかった本文 {props.cloud.skipped.length} 件。30 分ごとに送り直します。</div>
                      <ul className="faint mono" style={{ margin: '4px 0 0', paddingLeft: 16, wordBreak: 'break-all' }}>
                        {props.cloud.skipped.map((k) => <li key={k.key}>{k.key}: {k.message}（{k.attempts} 回）</li>)}
                      </ul>
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                    <button className="btn" title={props.cloud.paused ? '一時停止のまま、1 回だけ同期する' : undefined} onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
                    <button className="btn" onClick={() => emit({ type: 'sync.pause', paused: !props.cloud.paused })}>{props.cloud.paused ? '同期を再開' : '同期を一時停止'}</button>
                    {/* 参加トークンは全セッションの読み書き権を持つ秘密なので、押すまで取りに行かない。 */}
                    {/* 出したあとはランタイムが 120 秒で store から消すので、props が null に戻ればこのボタンの姿に戻る。 */}
                    {props.cloud.joinToken === null && <button className="btn" onClick={() => emit({ type: 'sync.joinToken.show' })}>参加トークンを表示</button>}
                  </div>
                  {props.cloud.joinToken !== null && <JoinToken token={props.cloud.joinToken} expiresAt={props.cloud.joinTokenExpiresAt} />}
                  {/* 使用量と費用。操作ボタンの下、PC の一覧の上に置く（試作 usage-merged.html の「置き場所」）。 */}
                  {props.cloud.usage && <CloudUsage {...props.cloud.usage} />}
                  <div className="list" style={{ marginTop: 8 }}>
                    {props.cloud.devices.map((d) => (
                      <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto auto', cursor: 'default' }}>
                        <span>{d.name}{d.self && <span className="faint"> この PC</span>}</span>
                        <span className="faint">{d.platform}</span>
                        <span className="faint">{d.lastSeen}</span>
                      </div>
                    ))}
                  </div>
                  <div className="settings-row settings-switch-row"><span>Claude Code の設定を同期する</span>
                    <Switch label="Claude Code の設定を同期する" checked={props.cloud.syncClaudeConfig} onChange={(next) => emit({ type: 'settings.update', patch: { syncClaudeConfig: next } })} />
                  </div>
                  <div className="faint" style={{ marginTop: 4 }}>CLAUDE.md、settings.json、statusline のスクリプト、skills、memory、projects の memory を PC の間で合わせます。</div>
                  {/* 利用者の決定 2。~/.claude を書き換える前に必ず控えを取り、何を書き換えたかを後から読めるようにする。 */}
                  <div className="faint">~/.claude に書き込むので、取り込む前に内容を確認します。上書きの前の控えは ~/.agent-hangar/backups/claude-config/&lt;日時&gt;/ に残ります。</div>
                  {props.cloud.syncClaudeConfig && <div className="faint">{props.cloud.configConfirmed ? '取り込みを確認済みです。' : 'まだ取り込みを確認していません。確認するまで ~/.claude には書き込みません。'}</div>}
                  <button className="btn" style={{ marginTop: 8 }} disabled={!props.cloud.syncClaudeConfig} onClick={() => emit({ type: 'sync.config.preview' })}>取り込み内容を確認</button>
                </>
              )}
            </section>
          </Group>
          <Group id="settings-info">
            <section>
              <h3 className="h2">使用量</h3>
              {props.usageAggregate === null && <div className="faint">使用量を読み込んでいます</div>}
              {props.usageAggregate && (
                <div className="grid2">
                  <table className="mini"><caption className="faint">直近 30 日</caption>
                    <thead><tr><th>日</th><th className="cell-right">入力</th><th className="cell-right">出力</th><th className="cell-right">件</th></tr></thead>
                    <tbody>{props.usageAggregate.days.map((d) => <tr key={d.day}><td className="mono">{d.day}</td><td className="mono cell-right">{tokensLabel(d.inputTokens)}</td><td className="mono cell-right">{tokensLabel(d.outputTokens)}</td><td className="mono cell-right">{d.sessions}</td></tr>)}</tbody>
                  </table>
                  <table className="mini"><caption className="faint">プロジェクト別</caption>
                    <thead><tr><th>名前</th><th className="cell-right">トークン</th><th className="cell-right">コスト</th><th className="cell-right">件</th></tr></thead>
                    <tbody>{props.usageAggregate.projects.map((p) => <tr key={p.projectId ?? 'none'}><td>{p.name}</td><td className="mono cell-right">{tokensLabel(p.inputTokens + p.outputTokens)}</td><td className="mono cell-right">{costLabel(p.costUsd)}</td><td className="mono cell-right">{p.sessions}</td></tr>)}</tbody>
                  </table>
                </div>
              )}
              <div className="faint" style={{ marginTop: 4 }}>コストは statusline が渡した値の合計です。渡されていないセッションは含みません。</div>
              {/* コストの供給源は cost.total_cost_usd で、そのセッションの走り全体の累計である。 */}
              {/* 日ごとの内訳が無いので、期間で切り分けられない。 */}
              <div className="faint">トークン数は期間のとおりですが、推定コストはそのセッションの走り全体の累計です。</div>
            </section>
            <section>
              <h3 className="h2">索引</h3>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <span className="mono muted">{props.indexLabel}</span>
                <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => emit({ type: 'index.rebuild' })}>索引を作り直す</button>
              </div>
              <div className="faint mono" style={{ marginTop: 4 }}>読み取り元 {props.claudeDir}</div>
              <div className="faint" style={{ marginTop: 4 }}>読み取り元を変えたときは、再起動後に反映されます。</div>
            </section>
            <section>
              <h3 className="h2">この PC</h3>
              <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
              <div className="faint mono">agent-hangar {props.version}</div>
            </section>
            {/* Claude Code の保持期間。押しても保存せず、差分を見せる確認を開く。hangar が Claude Code の設定を書くのはここだけである。 */}
            {props.retention && (
              <section>
                <h3 className="h2">会話の保持</h3>
                <div className="settings-row">
                  <span>保持期間<span className="faint">（Claude Code の cleanupPeriodDays）</span></span>
                  {props.retention.writable
                    ? <Segmented label="保持期間" value={String(props.retention.days)} options={props.retention.options} onChange={(v) => { if (Number(v) !== props.retention!.days) emit({ type: 'retention.edit', days: Number(v), from: 'settings' }); }} />
                    : <span className="muted">{props.retention.valueLabel}<span className="faint">（{props.retention.reason}）</span></span>}
                </div>
                {props.retention.bar && <UsageBar {...props.retention.bar} />}
                <div className="faint" style={{ marginTop: 4 }}>変えるときは、差分を確かめてから書き込みます。{props.retention.syncNote && '値は設定の同期で他の PC にも届きます。'}</div>
              </section>
            )}
          </Group>
        </div>
      </div>
    </div>
  );
}
