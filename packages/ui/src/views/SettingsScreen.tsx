import { useEffect, useRef, useState } from 'react';
import type { SettingsDto, TerminalApp } from '@agent-hangar/shared';
import { useEmit } from '../intent/chain.tsx';
import { costLabel, tokensLabel } from '../presenters/format.ts';
import type { SettingsProps } from '../presenters/settings.ts';
import { PageHeading } from './PageHeading.tsx';
import { Icon } from './primitives/Icon.tsx';
import { Listbox } from './primitives/Listbox.tsx';
import { Segmented } from './primitives/Segmented.tsx';
import { UsageBar } from './UsageBar.tsx';
import { Stepper } from './primitives/Stepper.tsx';
import { Switch } from './primitives/Switch.tsx';

/** 設定画面。保持する状態は入力途中の値だけで、保存で settings.update を出す。 */
export function SettingsScreen(props: SettingsProps) {
  const emit = useEmit();
  const [ws, setWs] = useState(props.workspaceRoot);
  const [tmuxPath, setTmuxPath] = useState(props.tmuxPath ?? '');
  const [codePath, setCodePath] = useState(props.codePath ?? '');
  const [claudePath, setClaudePath] = useState(props.claudePath ?? '');
  const [lmUrl, setLmUrl] = useState(props.lmStudioUrl);
  const [lmModel, setLmModel] = useState(props.lmStudioModel ?? '');
  const [cap, setCap] = useState(String(props.summaryHourlyCap));
  const [nodePath, setNodePath] = useState(props.nodePath);
  const [capError, setCapError] = useState(false);
  // サーバが正規化した値、たとえば tmux の絶対パスを入力欄に反映する。
  useEffect(() => { setWs(props.workspaceRoot); }, [props.workspaceRoot]);
  useEffect(() => { setTmuxPath(props.tmuxPath ?? ''); }, [props.tmuxPath]);
  useEffect(() => { setCodePath(props.codePath ?? ''); }, [props.codePath]);
  useEffect(() => { setClaudePath(props.claudePath ?? ''); }, [props.claudePath]);
  useEffect(() => { setLmUrl(props.lmStudioUrl); }, [props.lmStudioUrl]);
  useEffect(() => { setLmModel(props.lmStudioModel ?? ''); }, [props.lmStudioModel]);
  useEffect(() => { setCap(String(props.summaryHourlyCap)); }, [props.summaryHourlyCap]);
  useEffect(() => { setNodePath(props.nodePath); }, [props.nodePath]);
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
    emit({ type: 'settings.update', patch: { lmStudioUrl: lmUrlValue, lmStudioModel: lmModelValue, summaryHourlyCap: capNumber } });
  };

  // 変えた項目だけを送る。
  const toolsPatch: Partial<SettingsDto> = {};
  const tmux = tmuxPath.trim() || null;
  const code = codePath.trim() || null;
  const claude = claudePath.trim() || null;
  if (tmux !== props.tmuxPath) toolsPatch.tmuxPath = tmux;
  if (code !== props.codePath) toolsPatch.codePath = code;
  if (claude !== props.claudePath) toolsPatch.claudePath = claude;
  // 空の patch はサーバが 400 にして、英語のエラートーストになってしまう。
  const toolsDirty = Object.keys(toolsPatch).length > 0;
  // 4 つの保存ボタンは、どれも「変えたときだけ押せる」で揃える。
  // 何も変えずに押せると patch が飛び、何もしていないのに「設定を保存しました」と出る。
  // 見比べるのは、押したときに実際に送る値である。
  // パスの欄は送る前に前後の空白を落とすので、空白を足しただけでは変更にならない。
  const wsDirty = ws !== props.workspaceRoot;
  const nodeValue = nodePath.trim() || null;
  const nodeDirty = nodeValue !== (props.nodePath || null);
  // 要約器は 3 項目をまとめて送るので、1 つでも変わっていれば押せる。
  // 読めない上限（空や小数）は capNumber が NaN になるため、ここでは必ず「変わっている」側に入る。
  // 押せないと、1 から 200 までの整数を入れてくださいという案内を出す道が無くなってしまう。
  const summarizerDirty = lmUrlValue !== props.lmStudioUrl || lmModelValue !== props.lmStudioModel || capNumber !== props.summaryHourlyCap;
  // 保存済みのモデルが一覧に無くても（LM Studio が落ちているときなど）、顔から名前を消さない。
  const models = props.summarizerModels ?? [];
  const modelNames = lmModel && !models.includes(lmModel) ? [lmModel, ...models] : models;
  const modelOptions = [{ value: '', label: '自動（最初のモデル）' }, ...modelNames.map((m) => ({ value: m, label: m }))];
  return (
    <div className="screen settings-screen" style={{ maxWidth: 720 }}>
      <PageHeading title="設定" />
      <section>
        <h2 className="h2">ワークスペース</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="ワークスペースのルート" value={ws} onChange={(e) => setWs(e.target.value)} />
          <button className="btn btn-primary" disabled={!wsDirty} onClick={() => emit({ type: 'settings.update', patch: { workspaceRoot: ws } })}>保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>直下のディレクトリのうち、Claude のセッションがあるものをプロジェクトとして登録します。</div>
      </section>
      <section>
        <h2 className="h2">ツール</h2>
        <div className="grid2">
          <label className="field">tmux のパス
            <input className="input mono" aria-label="tmux のパス" value={tmuxPath} onChange={(e) => setTmuxPath(e.target.value)} placeholder="見つかりません。brew install tmux のあとにパスを入れてください" />
          </label>
          <div className="field">
            <span aria-hidden="true">ターミナルアプリ</span>
            {/* 切り替えた時点で保存する。iTerm2 は初回に macOS の自動化の許可ダイアログが出る。 */}
            <Segmented label="ターミナルアプリ" value={props.terminalApp} options={[{ value: 'terminal', label: 'Terminal.app', lead: <Icon name="openTerminal" /> }, { value: 'iterm', label: 'iTerm2', lead: <Icon name="appWindow" /> }]} onChange={(v) => setNow({ terminalApp: v as TerminalApp })} />
          </div>
          <label className="field">code のパス
            <input className="input mono" aria-label="code のパス" value={codePath} onChange={(e) => setCodePath(e.target.value)} placeholder="VS Code の code コマンド" />
          </label>
          <label className="field">claude のパス
            <input className="input mono" aria-label="claude のパス" value={claudePath} onChange={(e) => setClaudePath(e.target.value)} placeholder="見つかりません。claude コマンドの絶対パスを入れてください" />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={!toolsDirty} onClick={() => emit({ type: 'settings.update', patch: toolsPatch })}>ツールの設定を保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>iTerm2 は AppleScript で開くため、初回に macOS の自動化の許可ダイアログが出ます。失敗したときは Terminal.app で開きます。</div>
      </section>
      <section>
        <h2 className="h2">MCP</h2>
        <div className="muted">Claude Code の user スコープに hangar の MCP サーバを登録すると、どのセッションからも検索と要約が使えます。ターミナルで次を実行してください。</div>
        <pre className="mono" style={{ margin: '8px 0 0' }}>{props.mcpInstallCommand}</pre>
      </section>
      <section>
        <h2 className="h2">statusline</h2>
        {props.statusline === null && <div className="faint">読み込んでいます</div>}
        {props.statusline && props.statusline.scriptPath === null && (
          <>
            <div className="muted">statusLine の設定が見つかりません</div>
            <div className="faint" style={{ marginTop: 4 }}>Claude Code の /statusline でスクリプトを作ってから、下のコマンドを実行してください。</div>
          </>
        )}
        {props.statusline?.scriptPath && (
          <>
            <div className="muted">{props.statusline.installed ? '追記済みです' : 'まだ追記されていません'}</div>
            <div className="faint mono">{props.statusline.scriptPath}</div>
          </>
        )}
        <div className="faint" style={{ marginTop: 4 }}>使用量ゲージはこの追記だけが供給源です。追記は端末から行い、UI からは書き換えません。</div>
        <pre className="mono snippet">{props.statuslineCommand}</pre>
        {/* 追記されるスニペットの宛先はこのコマンドの --port で決まる。 */}
        {/* 既定の 4177 のまま追記すると、別のポートで動かしているサーバには届かない。 */}
        <div className="faint" style={{ marginTop: 4 }}>{'サーバが 4177 以外で動いているときは --port <番号> を付けてください。'}</div>
      </section>
      <section>
        <h2 className="h2">外のターミナル</h2>
        <div className="muted">VS Code などのターミナルで起動した claude も、hangar のターミナルで開けるようにします。~/.zshrc に 1 行を足し、claude を Claude のバックグラウンドで起こしてすぐつなぐ形に包みます。</div>
        {props.shell.devices.length > 0 && (
          <div className="list" style={{ marginTop: 8 }}>
            {props.shell.devices.map((d) => (
              <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto', cursor: 'default' }}>
                <span>{d.name}{d.self && <span className="faint"> この端末</span>}</span>
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
            <pre className="mono snippet">{props.shell.command}</pre>
          </>
        )}
        {props.shell.state === 'on' && <div className="faint" style={{ marginTop: 8 }}>新しく開いたターミナルから効きます。1 回だけ包まずに起動するときは command claude、外すときは {props.shell.uninstallCommand} です。</div>}
        {props.shell.state === 'unsupported' && <div className="faint" style={{ marginTop: 8 }}>この PC の Claude Code ではバックグラウンドを使えません。claude update で新しくするか、管理設定でバックグラウンドが切られていないかを確かめてください。</div>}
        <div className="faint" style={{ marginTop: 4 }}>入れていないときも、外のターミナルで入力待ちか休みの claude は「hangar で引き取る」で開けます。</div>
      </section>
      <section>
        <h2 className="h2">要約器</h2>
        <div className="grid2">
          <label className="field"><span>LM Studio の URL</span>
            <input className="input mono" aria-label="LM Studio の URL" value={lmUrl} onChange={(e) => setLmUrl(e.target.value)} />
          </label>
          <div className="field"><span aria-hidden="true">モデル</span>
            <Listbox label="モデル" value={lmModel} options={modelOptions} onChange={setLmModel} searchPlaceholder="モデルを探す" />
          </div>
        </div>
        {props.summarizerModels === null && <div className="faint" style={{ marginTop: 4 }}>読み込んでいます</div>}
        {props.summarizerModels?.length === 0 && <div className="faint" style={{ marginTop: 4 }}>LM Studio に繋がりません</div>}
        <div ref={externalRow} className="settings-row settings-switch-row"><span>手元の外にある要約器を許す</span>
          <Switch label="外部の要約器を許す" checked={props.allowExternalSummarizer} onChange={(next) => { if (next) setConfirmExternal(true); else setNow({ allowExternalSummarizer: false }); }} />
        </div>
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
          <Switch label="Claude へ切り替える" checked={props.summaryFallback} onChange={(next) => setNow({ summaryFallback: next })} />
        </div>
        <div className="settings-row"><span>1 時間の上限</span>
          <Stepper label="1 時間の上限" value={cap} min={1} max={200} onChange={(v) => { setCap(v); setCapError(false); }} />
          <span className="faint">件。1 から 200 まで。7 日の使用率が 80% を超えたら切り替えません。</span>
        </div>
        {capError && <div className="error" role="alert" style={{ marginTop: 4 }}>1 から 200 までの整数を入れてください</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <button className="btn btn-primary" disabled={!summarizerDirty} onClick={saveSummarizer}>要約器の設定を保存</button>
          <button className="btn" onClick={() => emit({ type: 'summarizer.test' })}>要約器を試す</button>
        </div>
        {props.summarizerTest?.ok === true && (
          <div style={{ marginTop: 4 }}>
            <div className="muted">{props.summarizerTest.id} で成功しました（{props.summarizerTest.ms} ミリ秒）</div>
            <div className="faint">{props.summarizerTest.summary.oneLiner}</div>
          </div>
        )}
        {props.summarizerTest?.ok === false && (
          <ul className="faint" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {props.summarizerTest.tried.map((t) => <li key={t.id}>{t.id}: {t.message}</li>)}
          </ul>
        )}
      </section>
      <section>
        <h2 className="h2">クラウド同期</h2>
        {!props.cloud.configured && <div className="faint">hangar setup cloud か hangar join &lt;token&gt; で始められます</div>}
        {props.cloud.configured && (
          <>
            <div className="mono muted">{props.cloud.url}</div>
            <div className="faint" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 4 }}>
              <span>状態 {props.cloud.state}</span>
              <span>最終 pull {props.cloud.lastPullAt}</span>
              <span>未送信 {props.cloud.pending} 件</span>
              {/* 本文は 60 秒に 20 件ずつしか流れない。件数が出ていないと、進んでいるのか止まっているのか読めない。 */}
              {props.cloud.sweepPending !== null && <span>未送信の本文 {props.cloud.sweepPending} 件</span>}
            </div>
            {/* 諦めた本文は 30 分ごとに試し直すので放っておけば回復する。回復するまでのあいだ、ここでだけ確かめられる。 */}
            {props.cloud.skipped.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <div className="error" role="alert">諦めた本文 {props.cloud.skipped.length} 件。30 分ごとに試し直します。</div>
                <ul className="faint mono" style={{ margin: '4px 0 0', paddingLeft: 16, wordBreak: 'break-all' }}>
                  {props.cloud.skipped.map((k) => <li key={k.key}>{k.key}: {k.message}（{k.attempts} 回）</li>)}
                </ul>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <button className="btn" onClick={() => emit({ type: 'sync.now' })}>今すぐ同期</button>
              <button className="btn" onClick={() => emit({ type: 'sync.pause', paused: !props.cloud.paused })}>{props.cloud.paused ? '同期を再開' : '一時停止'}</button>
              {/* 参加トークンは全セッションの読み書き権を持つ秘密なので、押すまで取りに行かない。 */}
              {/* 出したあとはランタイムが 120 秒で store から消すので、props が null に戻ればこのボタンの姿に戻る。 */}
              {props.cloud.joinToken === null && <button className="btn" onClick={() => emit({ type: 'sync.joinToken.show' })}>参加トークンを表示</button>}
            </div>
            {props.cloud.joinToken !== null && (
              <div style={{ marginTop: 8 }}>
                <div className="mono" style={{ wordBreak: 'break-all' }}>{props.cloud.joinToken}</div>
                <div className="faint">このトークンを持つ人は、あなたのセッションを読み書きできます。渡す相手に気をつけてください。</div>
                <div className="faint">120 秒で自動的に消えます。1Password などに写してください。</div>
              </div>
            )}
            <div className="list" style={{ marginTop: 8 }}>
              {props.cloud.devices.map((d) => (
                <div key={d.id} className="row" style={{ gridTemplateColumns: '1fr auto auto', cursor: 'default' }}>
                  <span>{d.name}{d.self && <span className="faint"> この端末</span>}</span>
                  <span className="faint">{d.platform}</span>
                  <span className="faint">{d.lastSeen}</span>
                </div>
              ))}
            </div>
            <div className="settings-row settings-switch-row"><span>Claude Code の設定を同期する</span>
              <Switch label="Claude Code の設定を同期する" checked={props.cloud.syncClaudeConfig} onChange={(next) => emit({ type: 'settings.update', patch: { syncClaudeConfig: next } })} />
            </div>
            <div className="faint" style={{ marginTop: 4 }}>CLAUDE.md、settings.json、statusline のスクリプト、skills、memory、projects の memory を端末間で合わせます。</div>
            {/* 利用者の決定 2。~/.claude を書き換える前に必ず控えを取り、何を書き換えたかを後から読めるようにする。 */}
            <div className="faint">~/.claude に書き込むので、取り込む前に内容を確認します。上書きの前の控えは ~/.agent-hangar/backups/claude-config/&lt;日時&gt;/ に残ります。</div>
            {props.cloud.syncClaudeConfig && <div className="faint">{props.cloud.configConfirmed ? '取り込みを確認済みです。' : 'まだ取り込みを確認していません。確認するまで ~/.claude には書き込みません。'}</div>}
            <button className="btn" style={{ marginTop: 8 }} disabled={!props.cloud.syncClaudeConfig} onClick={() => emit({ type: 'sync.config.preview' })}>取り込み内容を確認</button>
          </>
        )}
      </section>
      <section>
        <h2 className="h2">使用量</h2>
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
      {/* Claude Code の保持期間。押しても保存せず、差分を見せる確認を開く。hangar が Claude Code の設定を書くのはここだけである。 */}
      {props.retention && (
        <section>
          <h2 className="h2">会話の保持</h2>
          <div className="settings-row">
            <span>保持期間<span className="faint">（Claude Code の cleanupPeriodDays）</span></span>
            {props.retention.writable
              ? <Segmented label="保持期間" value={String(props.retention.days)} options={props.retention.options} onChange={(v) => { if (Number(v) !== props.retention!.days) emit({ type: 'retention.edit', days: Number(v), from: 'settings' }); }} />
              : <span className="muted">{props.retention.valueLabel}<span className="faint">（{props.retention.reason}）</span></span>}
          </div>
          {props.retention.bar && <UsageBar {...props.retention.bar} />}
          <div className="faint" style={{ marginTop: 4 }}>変えるときは、差分を確かめてから書き込みます。{props.retention.syncNote && '値は設定の同期でほかの PC にも届きます。'}</div>
        </section>
      )}
      <section>
        <h2 className="h2">索引</h2>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span className="mono muted">{props.index.phase === 'idle' ? `${props.sessionCount} セッション、${props.projectCount} プロジェクト` : `${props.index.phase} ${props.index.done} / ${props.index.total}`}</span>
          <button className="btn" onClick={() => emit({ type: 'index.rebuild' })}>索引を作り直す</button>
        </div>
        <div className="faint mono" style={{ marginTop: 4 }}>読み取り元 {props.claudeDir}</div>
        <div className="faint" style={{ marginTop: 4 }}>読み取り元を変えたときは、再起動後に反映されます。</div>
      </section>
      <section>
        <h2 className="h2">この端末</h2>
        <div className="mono muted">{props.device?.name}<span className="faint"> {props.device?.id}</span></div>
        <div className="faint mono">agent-hangar {props.version}</div>
      </section>
      <section>
        <h2 className="h2">デスクトップアプリ</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <input className="input mono" style={{ flex: 1 }} aria-label="Node のパス" placeholder="/opt/homebrew/bin/node" value={nodePath} onChange={(e) => setNodePath(e.target.value)} />
          <button className="btn" disabled={!nodeDirty} onClick={() => emit({ type: 'settings.update', patch: { nodePath: nodeValue } })}>Node のパスを保存</button>
        </div>
        <div className="faint" style={{ marginTop: 4 }}>空なら /opt/homebrew/bin/node、/usr/local/bin/node、nvm の順に探します。同梱サーバと同じメジャー版の Node が必要です。</div>
      </section>
    </div>
  );
}
